/**
 * capture-worker.js — the WebCodecs recording pipeline, one Worker for all roles.
 *
 *   MediaStreamTrackProcessor.readable (transferred from the offscreen document)
 *     → AudioData  →  AudioEncoder (Opus)  →  OggOpusMuxer  →  OPFS sync access handle
 *
 * WHY A WORKER (decided before building, as the I1 prompt demanded)
 * -----------------------------------------------------------------
 * OPFS `createSyncAccessHandle` exists only in Workers, and it is the only OPFS
 * write path whose bytes are durable before `close()`: `createWritable()` on the
 * main thread writes to a swap file that is swapped in on close — a crash before
 * close loses EVERYTHING written. For a recorder whose whole point is surviving a
 * crash, that rules the main-thread path out. Measured in this offscreen context
 * on 2026-09-07 (feasibility-*.json): open 1.4–1.8 ms, write+flush ≈ 500 MB/s.
 *
 * The encoder lives here too: AudioEncoder is available in workers (measured),
 * and keeping decode-time work off the offscreen main thread keeps the
 * AudioContext passthrough (what the user hears) unaffected by disk stalls.
 *
 * TIMELINE AND DRIFT (what every number here means)
 * -------------------------------------------------
 * Per role we keep four independent clocks and never mix them up:
 *   frames     — input samples received, at the track's own sample rate. This IS
 *                the source device's clock: frames / sampleRate = media time.
 *   granule    — samples encoded, always in 48 kHz units (Opus/Ogg convention).
 *   timestamp  — AudioData.timestamp (µs). Chrome derives it from capture time
 *                (measured: 100 µs jitter on the fake device), so it is a clock
 *                reading, not a sample count. Gaps between consecutive timestamps
 *                larger than a frame are DISCONTINUITIES (dropped or inserted
 *                audio) and are counted, not hidden.
 *   wall/mono  — Date.now() and performance.now() at first and last frame.
 *                performance.now() may stop during system sleep; Date.now() does
 *                not. A checkpoint where the two deltas disagree is a CLOCK_JUMP.
 * Drift of a source against the wall clock = media time − wall time.
 * Drift between two sources = difference of their media times at the same
 * checkpoint instant, minus the same difference at the first checkpoint. The
 * checkpoint snapshot is taken for all roles in one synchronous step, so the
 * comparison is between counters read at the same instant (±1 frame = ±10 ms).
 *
 * MESSAGES (main → worker): PROBE, OPEN_SESSION, OPEN_ROLE, REOPEN_ROLE,
 *   CLOSE_ROLE, PAUSE, RESUME, EVENT, WRITE_REPORT, STOP.
 * MESSAGES (worker → main): PROBE_RESULT, SESSION_OPENED, ROLE_OPENED,
 *   ROLE_CLOSED, PROGRESS, ERROR, REPORT_WRITTEN, STOPPED.
 */

import { OggOpusMuxer, parseOpusHead, opusPacketSamples, silenceFillerFor } from '../shared/ogg-opus.js';

const CHECKPOINT_MS = 10_000;     // consistent multi-role snapshot cadence
const JOURNAL_EVERY_PAGES = 5;    // one journal line per N pages per role
// Discontinuity = cumulative deviation of AudioData.timestamp from the sample
// count, re-anchored after each event. Per-frame deltas are NOT used for this:
// the AudioContext destination track (compatibility_mix) delivers 480-frame
// chunks whose timestamps advance in 128-frame render quanta, so consecutive
// deltas jitter by ±2.7 ms without any audio being lost (measured 2026-09-07,
// smoke-mic/journal.jsonl: 350 "discontinuities" of +2.1…+2.7 ms in 28 s while
// the cumulative timestamp span matched the frame count within 1.2 ms). The
// per-frame jitter is still recorded, as jitter.
const DISCONTINUITY_US = 20_000;  // cumulative |timestamp − expected| that counts as lost/inserted audio
const CLOCK_JUMP_MS = 1_500;      // wall − mono disagreement that means "slept"
const FED_SETTLE_MS = 150;        // input fed longer ago than this and still unencoded = swallowed by the encoder
// Frozen input (I2): a role whose track is still `live` but delivers no AudioData. Seen for real on
// 2026-09-07 when the Windows Audio service hung (long-4h/journal.jsonl): the mix froze for good,
// the status stayed `recording`. Checked every second against `source.frozenInputTimeoutMs`.
// When frames come back, the gap is filled with silence up to FROZEN_FILL_MAX_MS so the assets
// stay on one timeline (a plain timestamp jump is only filled up to 5 s — see onAudioData).
const FROZEN_CHECK_MS = 1_000;
const FROZEN_FILL_MAX_MS = 600_000;

let session = null;
const roles = new Map();

self.onmessage = (e) => {
  handle(e.data).catch((err) => {
    self.postMessage({ type: 'ERROR', error: String(err?.message ?? err), during: e.data?.type });
  });
};

async function handle(msg) {
  switch (msg?.type) {
    case 'PROBE':         return self.postMessage({ type: 'PROBE_RESULT', result: await probe() });
    case 'OPEN_SESSION':  return openSession(msg);
    case 'OPEN_ROLE':     return openRole(msg);
    case 'OPEN_SYNTH_ROLE': return openSynthRole(msg);
    case 'SYNTH_DROP': { const r = roles.get(msg.role); if (r?.synthetic) { r.synthDropUntil = Date.now() + (msg.ms ?? 300); } return; }
    case 'FREEZE_INPUT': {
      // Test hook (I2): drop every AudioData of the role for `ms` — from the pipeline's point of
      // view this is exactly "track live, no frames" (the audiosrv hang), without touching a device.
      const r = roles.get(msg.role);
      if (!r) throw new Error(`FREEZE_INPUT: unknown role ${msg.role}`);
      r.freezeUntil = performance.now() + (msg.ms ?? 5000);
      journal({ t: 'debug_freeze_input', role: msg.role, ms: msg.ms ?? 5000 });
      return;
    }
    case 'REOPEN_ROLE':   return reopenRole(msg);
    case 'CLOSE_ROLE':    return closeRole(msg.role, msg.reason ?? 'closed');
    case 'PAUSE':         return setPaused(true, msg);
    case 'RESUME':        return setPaused(false, msg);
    case 'EVENT':         return journal({ t: 'event', ...msg.event });
    case 'WRITE_REPORT':  return writeReport(msg.report, msg.final);
    case 'STOP':          return stopAll(msg);
    case 'CLOSE_SESSION': return closeSession();
    default: throw new Error(`unknown worker message: ${msg?.type}`);
  }
}

// ──────────────────────────────────────────────────────────── session ──

async function openSession({ sessionId, t0, opts = {}, settingsSnapshot = null }) {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle('sessions', { create: true });
  const dir = await sessions.getDirectoryHandle(sessionId, { create: true });
  const jfh = await dir.getFileHandle('journal.jsonl', { create: true });
  const jh = await jfh.createSyncAccessHandle();
  session = {
    id: sessionId, dir, journalHandle: jh, journalSize: jh.getSize(),
    t0, opts: { flushIntervalMs: 1000, journalEnabled: true, fillGapsWithSilence: true, muxerGapFillMs: 40, fillInputDrops: true,
                frozenInputTimeoutMs: 3000, ...opts },
    settingsSnapshot,
    lastCheckpoint: null, checkpoints: 0, clockJumps: [],
    flushTimer: null, checkpointTimer: null, frozenTimer: null,
    openedWall: Date.now(), openedMono: performance.now(),
    fatal: null, journalFailed: false,
  };
  journal({ t: 'session_open', sessionId, t0, opts: session.opts, workerTimeOrigin: performance.timeOrigin });
  session.flushTimer = setInterval(() => { for (const r of roles.values()) flushRole(r).catch(reportErr(r.role)); },
                                   session.opts.flushIntervalMs);
  session.checkpointTimer = setInterval(checkpoint, CHECKPOINT_MS);
  session.frozenTimer = setInterval(frozenCheck, FROZEN_CHECK_MS);
  self.postMessage({ type: 'SESSION_OPENED', ok: true, sessionId });
}

const reportErr = (role) => (e) => self.postMessage({ type: 'ERROR', role, error: String(e?.message ?? e) });

function journal(entry) {
  if (!session?.opts.journalEnabled) return;
  const line = JSON.stringify({ wall: Date.now(), mono: Math.round(performance.now() * 10) / 10, ...entry }) + '\n';
  const bytes = new TextEncoder().encode(line);
  try {
    session.journalHandle.write(bytes, { at: session.journalSize });
    session.journalSize += bytes.length;
    session.journalHandle.flush();
  } catch (e) {
    // Report once: a full disk makes every line fail, and the ERROR channel must not
    // drown the FATAL that follows from the media write.
    if (!session.journalFailed) {
      session.journalFailed = true;
      self.postMessage({ type: 'ERROR', error: `journal: ${String(e?.message ?? e)}` });
    }
  }
}

/**
 * A media write failed (quota exceeded, disk full, handle gone). Recording cannot continue
 * honestly: the page is lost and every next page would be too. Report once, let the
 * offscreen document stop the session; finalizeRole() keeps whatever is on disk.
 * First version (I1) only posted ERROR and went on — the file silently stopped growing
 * while the status said `recording`. That is the failure ADR-004 must never allow.
 */
function fatal(r, e, during) {
  const name = e?.name ?? 'Error';
  const entry = { role: r?.role ?? null, name, error: String(e?.message ?? e), during, fileBytes: r?.fileBytes ?? null, wall: Date.now() };
  journal({ t: 'write_failed', ...entry });
  if (session && !session.fatal) {
    session.fatal = entry;
    self.postMessage({ type: 'FATAL', ...entry });
  }
}

// ─────────────────────────────────────────────────────────────── roles ──

async function openRole({ role, readable, encoder, expected = {}, muxer = {}, downmix = false }) {
  if (!session) throw new Error('OPEN_ROLE before OPEN_SESSION');
  if (roles.has(role)) throw new Error(`role ${role} already open`);
  const fh = await session.dir.getFileHandle(`${role}.opus`, { create: true });
  const handle = await fh.createSyncAccessHandle();
  const r = {
    role, readable, reader: null, encoder: null, muxer: null, handle, fileBytes: handle.getSize(),
    encoderRequest: encoder, encoderApplied: null, encoderSupported: null, expected, downmix,
    inputChannels: null, downmixed: false,
    muxerOpts: muxer, opusHead: null, opusHeadSource: null,
    sampleRate: null, channels: null, format: null,
    frames: 0, pausedFrames: 0, framesTotal: 0, framesPerChunkSeen: new Set(),
    firstTs: null, lastTs: null, prevTs: null, prevFrames: 0, lastFrameNumberOfFrames: 0,
    anchorTs: null, anchorFrames: 0, maxJitterUs: 0,
    firstWall: null, firstMono: null, lastWall: null, lastMono: null,
    discontinuities: 0, discontinuityUsSum: 0, maxDiscontinuityUs: 0, firstDiscontinuities: [],
    packets: 0, encodedBytes: 0, pages: 0, pagesSinceJournal: 0, chunkDurationsSeen: new Set(),
    firstChunkTs: null, lastChunkTs: null, lastChunkDuration: null,
    silenceFilled48k: 0, gaps: [], paused: false, closed: false, ended: false, endedReason: null,
    openedWall: Date.now(), openedMono: performance.now(), opened: null,
    pageIntervalsMs: [], lastPageMono: null,
    fillerPackets: 0, fillerSamples48k: 0, fillerEvents: 0, dropFillSamples48k: 0, dropFillEvents: 0, fedLog: [],
    frozen: false, frozenSinceMono: null, frozenEvents: 0, frozenTotalMs: 0, frozenFillSamples48k: 0, freezeUntil: null, writeFailed: false,
    stopRequested: false, readerDone: null,
  };
  roles.set(role, r);
  journal({ t: 'role_open', role, fileBytesAtOpen: r.fileBytes, expected, encoderRequest: encoder });
  startReader(r, readable);
}

/**
 * Synthetic source: AudioData generated at wall-clock pace at `sampleRate`
 * (speech-like sawtooth + AM + 2 s pause per 5 s). Every 10 ms tick emits as
 * many frames as Date.now() says are due, so the frame count tracks the wall
 * clock exactly and any divergence between granule and frames is the encoder's
 * resampler, not the generator. Used for the 44.1 kHz case (no such device here).
 */
async function openSynthRole({ role, sampleRate, encoder }) {
  if (!session) throw new Error('OPEN_SYNTH_ROLE before OPEN_SESSION');
  if (roles.has(role)) throw new Error(`role ${role} already open`);
  const fh = await session.dir.getFileHandle(`${role}.opus`, { create: true });
  const handle = await fh.createSyncAccessHandle();
  const r = {
    role, readable: null, reader: null, encoder: null, muxer: null, handle, fileBytes: handle.getSize(),
    encoderRequest: encoder, encoderApplied: null, encoderSupported: null, expected: { sampleRate, synthetic: true }, downmix: false,
    inputChannels: 1, downmixed: false, muxerOpts: { comments: ['IRONMEMO_SYNTHETIC=1'] }, opusHead: null, opusHeadSource: null,
    sampleRate: null, channels: null, format: null,
    frames: 0, pausedFrames: 0, framesTotal: 0, framesPerChunkSeen: new Set(),
    firstTs: null, lastTs: null, prevTs: null, prevFrames: 0, lastFrameNumberOfFrames: 0,
    anchorTs: null, anchorFrames: 0, maxJitterUs: 0,
    firstWall: null, firstMono: null, lastWall: null, lastMono: null,
    discontinuities: 0, discontinuityUsSum: 0, maxDiscontinuityUs: 0, firstDiscontinuities: [],
    packets: 0, encodedBytes: 0, pages: 0, pagesSinceJournal: 0, chunkDurationsSeen: new Set(),
    firstChunkTs: null, lastChunkTs: null, lastChunkDuration: null,
    silenceFilled48k: 0, gaps: [], paused: false, closed: false, ended: false, endedReason: null,
    openedWall: Date.now(), openedMono: performance.now(), opened: null,
    pageIntervalsMs: [], lastPageMono: null, synthetic: true,
    fillerPackets: 0, fillerSamples48k: 0, fillerEvents: 0, dropFillSamples48k: 0, dropFillEvents: 0, fedLog: [],
    frozen: false, frozenSinceMono: null, frozenEvents: 0, frozenTotalMs: 0, frozenFillSamples48k: 0, freezeUntil: null, writeFailed: false,
    stopRequested: false, readerDone: null,
  };
  roles.set(role, r);
  journal({ t: 'role_open', role, synthetic: true, sampleRate, encoderRequest: encoder });
  const t0 = Date.now();
  let generated = 0;
  const tick = async () => {
    if (r.closed) return;
    const due = Math.floor((Date.now() - t0) / 1000 * sampleRate);
    const n = due - generated;
    if (n <= 0) return;
    // Test hook: simulate an INPUT DROP — time passes, frames do not arrive (timestamp jumps).
    if (r.synthDropUntil && Date.now() < r.synthDropUntil) { generated = due; return; }
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tSec = (generated + i) / sampleRate;
      const on = (tSec % 5) < 3;
      buf[i] = on ? 0.25 * (2 * ((165 * tSec) % 1) - 1) * (0.65 + 0.35 * Math.sin(2 * Math.PI * 4.5 * tSec)) : 0;
    }
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 1,
                               timestamp: Math.round(generated / sampleRate * 1e6), data: buf });
    generated += n;
    await onAudioData(r, ad);
  };
  r.synthTimer = setInterval(() => { tick().catch(reportErr(role)); }, 10);
  r.reader = { cancel: async () => { clearInterval(r.synthTimer); r.ended = true; r.endedReason = 'synth_stopped'; } };
}

/** Device returned: continue the SAME file. Fill the gap with encoded silence so both assets keep one timeline. */
async function reopenRole({ role, readable, gapMs = null }) {
  const r = roles.get(role);
  if (!r) throw new Error(`REOPEN_ROLE: unknown role ${role}`);
  if (!r.ended) throw new Error(`REOPEN_ROLE: role ${role} is still reading`);
  const now = Date.now();
  const gap = gapMs ?? (r.lastWall ? now - r.lastWall : 0);
  let filled = 0;
  if (session.opts.fillGapsWithSilence && r.encoder && r.sampleRate && gap > 0) {
    filled = feedSilence(r, gap);
  }
  r.gaps.push({ atWall: r.lastWall, resumedWall: now, gapMs: gap, silenceFrames: filled });
  journal({ t: 'role_reopen', role, gapMs: gap, silenceFrames: filled, filled: filled > 0 });
  r.ended = false; r.endedReason = null;
  startReader(r, readable);
  self.postMessage({ type: 'ROLE_REOPENED', role, gapMs: gap, silenceFrames: filled });
}

/** Silence for a dropped-input gap: `n` frames at the input rate, timestamped BEFORE the frame that revealed the gap. */
function feedDropSilence(r, n, nextTimestamp) {
  const rate = r.sampleRate, ch = r.channels;
  const step = Math.round(rate / 50);
  let done = 0;
  let ts = nextTimestamp - Math.round(n / rate * 1e6);
  while (done < n) {
    const k = Math.min(step, n - done);
    const sil = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: k, numberOfChannels: ch,
                                timestamp: ts, data: new Float32Array(k * ch) });
    try { r.encoder.encode(sil); } finally { sil.close(); }
    ts += Math.round(k / rate * 1e6);
    done += k;
  }
  r.frames += n;                 // the timeline now contains these frames
  noteFed(r);
  r.dropFillSamples48k += Math.round(n * 48000 / rate);
  r.dropFillEvents++;
}

/** Remember when each cumulative input position was handed to the encoder (bounded log). */
function noteFed(r) {
  r.fedLog.push({ mono: performance.now(), cum48k: Math.round(r.frames * 48000 / r.sampleRate) });
  if (r.fedLog.length > 400) r.fedLog.splice(0, r.fedLog.length - 400);
}

function feedSilence(r, gapMs) {
  const rate = r.sampleRate, ch = r.channels;
  const total = Math.round(gapMs / 1000 * rate);
  const step = Math.round(rate / 50); // 20 ms
  let done = 0;
  let ts = (r.lastTs ?? 0) + Math.round(r.lastFrameNumberOfFrames / rate * 1e6);
  while (done < total) {
    const n = Math.min(step, total - done);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch,
                               timestamp: ts, data: new Float32Array(n * ch) });
    r.encoder.encode(ad); ad.close();
    ts += Math.round(n / rate * 1e6);
    done += n;
  }
  r.silenceFilled48k += Math.round(total * 48000 / rate);
  r.lastTs = ts; r.lastFrameNumberOfFrames = 0; r.prevTs = null; r.anchorTs = null; // next real frame re-anchors
  return total;
}

function startReader(r, readable) {
  r.reader = readable.getReader();
  r.readerDone = (async () => {
    try {
      for (;;) {
        const { value: ad, done } = await r.reader.read();
        if (done) break;
        await onAudioData(r, ad);
      }
      r.ended = true; r.endedReason ??= 'stream_done';
      journal({ t: 'role_stream_done', role: r.role, frames: r.frames });
    } catch (e) {
      r.ended = true; r.endedReason = `read_error: ${String(e?.message ?? e)}`;
      journal({ t: 'role_read_error', role: r.role, error: r.endedReason });
      self.postMessage({ type: 'ERROR', role: r.role, error: r.endedReason });
    }
  })();
}

async function onAudioData(r, ad) {
  const wall = Date.now(), mono = performance.now();
  try {
    // After STOP was requested for the session, every role ignores further frames from the
    // same instant — otherwise roles finalised later keep recording while the earlier ones
    // are flushed (measured 2026-09-08, smoke-wc-none: the mix ended 260 ms after the mic).
    if (r.stopRequested) return;
    // Test hook: a frozen input delivers nothing — not even a timestamp. Drop the frame here,
    // before any counter sees it, so the detector below is exercised the way a real stall is.
    if (r.freezeUntil !== null) {
      if (mono < r.freezeUntil) return;
      r.freezeUntil = null;
    }
    if (r.encoder === null) await configureEncoder(r, ad);
    if (r.encoder === null) return; // unsupported — reported, frames dropped

    // Frames are back after a detected freeze: the gap is filled below even when it is
    // longer than the 5 s limit of an ordinary timestamp jump (the other roles kept going).
    let resumedAfterFreeze = false;
    if (r.frozen) {
      r.frozen = false; resumedAfterFreeze = true;
      const frozenMs = Math.round(mono - r.frozenSinceMono);
      r.frozenTotalMs += frozenMs;
      journal({ t: 'input_resumed', role: r.role, frozenMs, atFrame: r.framesTotal, timestamp: ad.timestamp });
      self.postMessage({ type: 'INPUT_RESUMED', role: r.role, frozenMs });
    }

    // Per-frame jitter (informational) and cumulative discontinuity (the real signal).
    if (r.prevTs !== null) {
      const jitter = ad.timestamp - (r.prevTs + Math.round(r.prevFrames / r.sampleRate * 1e6));
      if (Math.abs(jitter) > Math.abs(r.maxJitterUs)) r.maxJitterUs = jitter;
    }
    if (r.anchorTs === null) { r.anchorTs = ad.timestamp; r.anchorFrames = r.framesTotal; }
    const expected = r.anchorTs + Math.round((r.framesTotal - r.anchorFrames) / r.sampleRate * 1e6);
    const dev = ad.timestamp - expected;
    if (Math.abs(dev) > DISCONTINUITY_US) {
      r.discontinuities++;
      r.discontinuityUsSum += dev;
      if (Math.abs(dev) > Math.abs(r.maxDiscontinuityUs)) r.maxDiscontinuityUs = dev;
      if (r.firstDiscontinuities.length < 20) r.firstDiscontinuities.push({ atFrame: r.framesTotal, timestamp: ad.timestamp, deltaUs: dev, wall });
      journal({ t: 'discontinuity', role: r.role, atFrame: r.framesTotal, deltaUs: dev, timestamp: ad.timestamp });
      r.anchorTs = ad.timestamp; r.anchorFrames = r.framesTotal; // re-anchor after the jump
      // Input DROP (timestamp ran ahead, frames did not): feed silence of the missing
      // length so this asset stays aligned with the others. Measured 2026-09-07
      // (accept-4h): 11 × 23 ms drops on the tab track = 268 ms between assets in 4 h.
      // Jumps > 5 s are not filled here — that is a device loss / sleep, handled by
      // the track policies and journaled — unless the freeze detector had already
      // flagged this role, in which case the whole gap (≤ FROZEN_FILL_MAX_MS) is filled.
      const limitUs = resumedAfterFreeze ? FROZEN_FILL_MAX_MS * 1000 : 5_000_000;
      if (session?.opts.fillInputDrops && r.encoder && !r.paused && dev > 0 && dev <= limitUs) {
        const n = Math.round(dev / 1e6 * r.sampleRate);
        const before48k = r.dropFillSamples48k;
        feedDropSilence(r, n, ad.timestamp);
        if (resumedAfterFreeze) r.frozenFillSamples48k += r.dropFillSamples48k - before48k;
        journal({ t: 'drop_filled', role: r.role, deltaUs: dev, frames: n, samples48k: r.dropFillSamples48k - before48k, afterFreeze: resumedAfterFreeze });
      }
    }
    r.prevTs = ad.timestamp; r.prevFrames = ad.numberOfFrames;
    r.framesTotal += ad.numberOfFrames;
    if (r.firstTs === null) { r.firstTs = ad.timestamp; r.firstWall = wall; r.firstMono = mono; }
    r.lastTs = ad.timestamp; r.lastWall = wall; r.lastMono = mono; r.lastFrameNumberOfFrames = ad.numberOfFrames;
    r.framesPerChunkSeen.add(ad.numberOfFrames);

    if (r.paused) { r.pausedFrames += ad.numberOfFrames; return; }
    r.frames += ad.numberOfFrames;
    noteFed(r);
    if (r.downmixed) {
      const mono = downmixToMono(ad);
      try { r.encoder.encode(mono); } finally { mono.close(); }
    } else {
      r.encoder.encode(ad);
    }
  } finally {
    ad.close();
  }
}

/** Average all channels into one f32-planar AudioData (tab tracks arrive as stereo at the output rate). */
function downmixToMono(ad) {
  const n = ad.numberOfFrames, ch = ad.numberOfChannels;
  const acc = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
    for (let i = 0; i < n; i++) acc[i] += tmp[i];
  }
  if (ch > 1) for (let i = 0; i < n; i++) acc[i] /= ch;
  return new AudioData({ format: 'f32-planar', sampleRate: ad.sampleRate, numberOfFrames: n, numberOfChannels: 1,
                         timestamp: ad.timestamp, data: acc });
}

async function configureEncoder(r, ad) {
  r.sampleRate = ad.sampleRate; r.inputChannels = ad.numberOfChannels; r.format = ad.format;
  r.downmixed = !!r.downmix && ad.numberOfChannels > 1;
  r.channels = r.downmixed ? 1 : ad.numberOfChannels;
  const req = r.encoderRequest ?? {};
  const config = {
    codec: 'opus', sampleRate: ad.sampleRate, numberOfChannels: r.channels,
    bitrate: req.bitrate ?? 48000, bitrateMode: req.bitrateMode ?? 'variable',
    ...(req.opus ? { opus: req.opus } : {}),
  };
  let sup;
  try { sup = await AudioEncoder.isConfigSupported(config); }
  catch (e) { sup = { supported: false, error: String(e?.message ?? e) }; }
  r.encoderSupported = sup.supported;
  r.encoderApplied = sup.config ?? null;
  if (!sup.supported) {
    journal({ t: 'encoder_unsupported', role: r.role, config, error: sup.error ?? null });
    self.postMessage({ type: 'ROLE_OPENED', role: r.role, ok: false,
      error: `AudioEncoder does not support ${JSON.stringify(config)}${sup.error ? ': ' + sup.error : ''}` });
    r.encoder = null;
    return;
  }
  const enc = new AudioEncoder({
    output: (chunk, meta) => onChunk(r, chunk, meta),
    error: (e) => {
      journal({ t: 'encoder_error', role: r.role, error: String(e?.message ?? e) });
      self.postMessage({ type: 'ERROR', role: r.role, error: `AudioEncoder: ${String(e?.message ?? e)}` });
    },
  });
  enc.configure(config);
  r.encoder = enc;
  r.opened = { wall: Date.now(), mono: performance.now() };
  journal({ t: 'encoder_configured', role: r.role, requested: config, applied: r.encoderApplied,
            input: { sampleRate: r.sampleRate, channels: r.inputChannels, format: r.format, framesPerChunk: ad.numberOfFrames, downmixedToMono: r.downmixed } });
  self.postMessage({
    type: 'ROLE_OPENED', role: r.role, ok: true,
    applied: { encoderRequested: config, encoderApplied: r.encoderApplied,
               input: { sampleRate: r.sampleRate, channels: r.inputChannels, format: r.format, framesPerChunk: ad.numberOfFrames, downmixedToMono: r.downmixed },
               firstFrame: { timestamp: ad.timestamp, wall: Date.now() } },
  });
}

function onChunk(r, chunk, meta) {
  if (r.muxer === null) {
    let head = null, source = 'constructed';
    const d = meta?.decoderConfig;
    if (d?.description) {
      head = d.description instanceof ArrayBuffer ? new Uint8Array(d.description)
           : new Uint8Array(d.description.buffer, d.description.byteOffset, d.description.byteLength);
      head = new Uint8Array(head); // own copy
      source = 'encoder.decoderConfig.description';
    }
    r.opusHead = head ? parseOpusHead(head) : null;
    r.opusHeadSource = source;
    r.muxer = new OggOpusMuxer({
      channels: r.channels, preSkip: r.opusHead?.preSkip ?? 312, inputSampleRate: r.sampleRate,
      opusHead: head,
      comments: [
        `ENCODER=Chrome AudioEncoder (WebCodecs)`,
        `IRONMEMO_SESSION=${session?.id ?? ''}`, `IRONMEMO_ROLE=${r.role}`,
        `IRONMEMO_INPUT_RATE=${r.sampleRate}`, ...(r.muxerOpts.comments ?? []),
      ],
    });
    // Header pages go to disk immediately: a crash one second in still leaves a
    // decodable (empty) file, and the pre-skip is on disk before any audio.
    for (const p of r.muxer.headerPages()) writeBytes(r, p);
    journal({ t: 'muxer_start', role: r.role, opusHead: r.opusHead, opusHeadSource: source, fileBytes: r.fileBytes });
  }
  const buf = new Uint8Array(chunk.byteLength);
  chunk.copyTo(buf);
  const samples48k = opusPacketSamples(buf);
  // Keep the file on the INPUT timeline. With Opus DTX Chrome's AudioEncoder skips
  // whole frames during silence AND numbers the chunks it does emit sequentially
  // (chunk.timestamp = previous + duration, measured 2026-09-07: 3 s of input with
  // 1.5 s of silence came out as 89 chunks ending at 1.76 s), so neither packet
  // durations nor chunk timestamps can place packets — only the count of input
  // frames handed to the encoder can. When that count runs ahead of the written
  // position by ≥ muxerGapFillMs (beyond one frame of encoder latency), insert
  // zero-length frames (1 byte each) until the file catches up. Same mechanism
  // covers any other frame the encoder swallows.
  if (r.firstChunkTs === null) r.firstChunkTs = chunk.timestamp;
  fillTimelineGap(r, buf, false);
  r.muxer.addPacket(buf, samples48k);
  r.lastToc = buf.subarray(0, 1);
  r.packets++; r.encodedBytes += buf.length;
  r.chunkDurationsSeen.add(chunk.duration ?? null);
  if (r.firstChunkTs === null) r.firstChunkTs = chunk.timestamp;
  r.lastChunkTs = chunk.timestamp; r.lastChunkDuration = chunk.duration ?? null;
}

/** Insert silence fillers until the muxer position reaches the input frame count (minus one frame of latency). */
function fillTimelineGap(r, tocSource, atEnd) {
  const fillMs = session?.opts.muxerGapFillMs ?? 0;
  if (!(fillMs > 0) || !r.muxer || !r.sampleRate) return 0;
  // Only input fed at least FED_SETTLE_MS ago counts: the encoder emits within ~20 ms, so
  // anything older and still missing was swallowed (DTX). A burst fed just now (drop-fill
  // silence, device-gap silence) must not be counted twice — measured 2026-09-07 (synthdrop):
  // the first version filled a 300 ms drop with silence AND then again with 14 filler packets.
  let expected48k;
  if (atEnd) expected48k = Math.round(r.frames * 48000 / r.sampleRate);
  else {
    // Frames still queued in the encoder are pending, not swallowed — never fill over them.
    // The settle-time rule alone misfired 2026-09-08 (smoke-wc-none): during STOP the worker
    // was busy finalising other roles, the mix encoder emitted late, and 198 ms of fillers
    // doubled a 188 ms drop-fill that was merely waiting in the queue.
    if (r.encoder && r.encoder.encodeQueueSize > 0) return 0;
    const cutoff = performance.now() - FED_SETTLE_MS;
    let settled = null;
    for (let i = r.fedLog.length - 1; i >= 0; i--) if (r.fedLog[i].mono <= cutoff) { settled = r.fedLog[i].cum48k; break; }
    if (settled === null) return 0;
    expected48k = settled;
  }
  const position48k = r.muxer.granule + r.muxer.pendingSamples;
  const gap = expected48k - position48k;
  if (gap < fillMs * 48) return 0;
  const filler = silenceFillerFor(tocSource ?? r.lastToc ?? new Uint8Array([0xf8]));
  const step = opusPacketSamples(filler) || 960;
  const k = Math.floor(gap / step);
  if (k <= 0) return 0;
  for (let i = 0; i < k; i++) r.muxer.addPacket(filler, step);
  r.fillerPackets += k; r.fillerSamples48k += k * step; r.fillerEvents++;
  if (r.fillerEvents <= 50 || r.fillerEvents % 100 === 0) journal({ t: 'gap_filled', role: r.role, gapMs: Math.round(gap / 48), packets: k, atEnd, fillerEvents: r.fillerEvents });
  return k;
}

function writeBytes(r, bytes) {
  // write() then flush(): the byte count advances only after BOTH succeeded. A page that
  // failed to reach the disk is not counted, not journaled, and makes the session fatal.
  try {
    const n = r.handle.write(bytes, { at: r.fileBytes });
    if (n !== bytes.length) throw Object.assign(new Error(`short write: ${n} of ${bytes.length} bytes`), { name: 'ShortWriteError' });
    r.handle.flush();
  } catch (e) {
    r.writeFailed = true;
    fatal(r, e, 'write_page');
    throw e;
  }
  r.fileBytes += bytes.length;
}

async function flushRole(r, { eos = false } = {}) {
  if (!r.muxer || r.closed || r.writeFailed) return;
  const page = r.muxer.flushPage({ eos });
  if (!page) return;
  writeBytes(r, page);
  r.pages++;
  const mono = performance.now();
  if (r.lastPageMono !== null && r.pageIntervalsMs.length < 100000) r.pageIntervalsMs.push(Math.round(mono - r.lastPageMono));
  r.lastPageMono = mono;
  if (++r.pagesSinceJournal >= JOURNAL_EVERY_PAGES || eos) {
    r.pagesSinceJournal = 0;
    journal({ t: 'page', role: r.role, pages: r.pages, fileBytes: r.fileBytes, granule: r.muxer.granule,
              frames: r.frames, packets: r.packets, eos });
  }
}

function setPaused(paused, msg = {}) {
  for (const r of roles.values()) {
    if (r.paused === paused) continue;
    r.paused = paused;
    journal({ t: paused ? 'pause' : 'resume', role: r.role, frames: r.frames, pausedFrames: r.pausedFrames, granule: r.muxer?.granule ?? 0 });
  }
  self.postMessage({ type: paused ? 'PAUSED' : 'RESUMED' });
}

async function closeRole(role, reason) {
  const r = roles.get(role);
  if (!r || r.closed) return;
  await finalizeRole(r, reason);
  self.postMessage({ type: 'ROLE_CLOSED', role, stats: roleStats(r) });
}

async function finalizeRole(r, reason) {
  if (r.closed) return;
  r.closed = true;
  r.stopRequested = true;
  try { await r.reader?.cancel(); } catch {}
  // Let an in-flight onAudioData finish before flushing: a frame encoded after flush()
  // would land after the tail fillers and double-count the timeline.
  if (r.readerDone) await Promise.race([r.readerDone, new Promise((res) => setTimeout(res, 500))]);
  if (r.encoder) {
    try { await r.encoder.flush(); } catch (e) { journal({ t: 'encoder_flush_error', role: r.role, error: String(e?.message ?? e) }); }
    try { r.encoder.close(); } catch {}
  }
  if (r.muxer && !r.writeFailed) fillTimelineGap(r, null, true); // tail silence the encoder never emitted (DTX)
  r.closed = false;
  try { await flushRole(r, { eos: true }); } catch (e) { journal({ t: 'eos_write_error', role: r.role, error: String(e?.message ?? e) }); }
  r.closed = true;
  try { r.handle.flush(); } catch {}
  try { r.handle.close(); } catch (e) { journal({ t: 'handle_close_error', role: r.role, error: String(e?.message ?? e) }); }
  journal({ t: 'role_close', role: r.role, reason, ...roleStats(r) });
}

/** Once a second: a role whose reader is alive but has delivered nothing for longer than the timeout is frozen. */
function frozenCheck() {
  if (!session) return;
  const timeout = session.opts.frozenInputTimeoutMs;
  if (!(timeout > 0)) return;
  const now = performance.now();
  for (const r of roles.values()) {
    if (r.frozen || r.paused || r.ended || r.closed || r.encoder === null || r.lastMono === null) continue;
    const silentMs = now - r.lastMono;
    if (silentMs < timeout) continue;
    r.frozen = true; r.frozenSinceMono = r.lastMono; r.frozenEvents++;
    journal({ t: 'input_frozen', role: r.role, silentMs: Math.round(silentMs), lastWall: r.lastWall, lastTs: r.lastTs, frames: r.frames, timeoutMs: timeout });
    self.postMessage({ type: 'INPUT_FROZEN', role: r.role, silentMs: Math.round(silentMs), timeoutMs: timeout });
  }
}

// ──────────────────────────────────────────────── checkpoints & stats ──

function roleStats(r) {
  // Media time on the asset's timeline: real frames + silence inserted for device gaps
  // (the file really contains those samples). Paused frames are added back for the
  // wall-clock comparison only.
  const silenceFrames = r.sampleRate ? r.silenceFilled48k * r.sampleRate / 48000 : 0;
  const mediaSec = r.sampleRate ? (r.frames + silenceFrames) / r.sampleRate : 0;
  const wallSec = r.firstWall != null && r.lastWall != null ? (r.lastWall - r.firstWall) / 1000 + (r.lastFrameNumberOfFrames / (r.sampleRate || 1)) : null;
  const tsSec = r.firstTs != null && r.lastTs != null ? (r.lastTs - r.firstTs) / 1e6 + (r.lastFrameNumberOfFrames / (r.sampleRate || 1)) : null;
  const elapsedSec = r.opened ? (Date.now() - r.opened.wall) / 1000 : null;
  return {
    role: r.role, sampleRate: r.sampleRate, channels: r.channels, inputChannels: r.inputChannels, downmixedToMono: r.downmixed, format: r.format,
    frames: r.frames, pausedFrames: r.pausedFrames, framesPerChunkSeen: [...r.framesPerChunkSeen],
    mediaSec: round(mediaSec, 4),
    wallSpanSec: wallSec == null ? null : round(wallSec, 4),
    timestampSpanSec: tsSec == null ? null : round(tsSec, 4),
    // media time minus wall time between first and last frame: negative = source
    // delivered fewer samples than the wall clock implies (dropped audio or slow clock).
    driftVsWallMs: wallSec == null ? null : round((mediaSec + r.pausedFrames / (r.sampleRate || 1) - wallSec) * 1000, 2),
    driftVsTimestampMs: tsSec == null ? null : round((r.frames / (r.sampleRate || 1) + r.pausedFrames / (r.sampleRate || 1) - tsSec) * 1000, 2),
    silenceFrames: Math.round(silenceFrames),
    firstTs: r.firstTs, lastTs: r.lastTs, firstWall: r.firstWall, lastWall: r.lastWall, firstMono: r.firstMono, lastMono: r.lastMono,
    discontinuities: r.discontinuities, discontinuityUsSum: r.discontinuityUsSum, maxDiscontinuityUs: r.maxDiscontinuityUs,
    firstDiscontinuities: r.firstDiscontinuities, maxJitterUs: r.maxJitterUs,
    packets: r.packets, granule48k: r.muxer?.granule ?? 0, encodedBytes: r.encodedBytes, fileBytes: r.fileBytes, pages: r.pages,
    effectiveKbps: mediaSec > 0 ? round((r.encodedBytes * 8) / mediaSec / 1000, 2) : null,
    chunkDurationsSeenUs: [...r.chunkDurationsSeen],
    firstChunkTs: r.firstChunkTs, lastChunkTs: r.lastChunkTs,
    granuleSec: r.muxer ? round(r.muxer.granule / 48000, 4) : null,
    // encoded 48 kHz samples vs input frames converted to 48 kHz: the encoder's
    // internal resampler (44.1 k → 48 k) must keep these equal within one packet.
    // fillers stand in for input frames the encoder swallowed, so they are NOT subtracted;
    // device-gap silence was fed as extra AudioData outside `frames`, so it is.
    granuleMinusInput48k: r.muxer && r.sampleRate ? Math.round(r.muxer.granule - r.frames * 48000 / r.sampleRate - r.silenceFilled48k) : null,
    silenceFilled48k: r.silenceFilled48k, gaps: r.gaps,
    fillerPackets: r.fillerPackets, fillerSamples48k: r.fillerSamples48k, fillerEvents: r.fillerEvents,
    fillerSec: round(r.fillerSamples48k / 48000, 3),
    dropFillSamples48k: r.dropFillSamples48k, dropFillEvents: r.dropFillEvents, dropFillSec: round(r.dropFillSamples48k / 48000, 3),
    frozen: r.frozen, frozenEvents: r.frozenEvents, frozenTotalMs: r.frozenTotalMs + (r.frozen ? Math.round(performance.now() - r.frozenSinceMono) : 0),
    frozenFillSec: round(r.frozenFillSamples48k / 48000, 3), writeFailed: r.writeFailed,
    encoderRequested: r.encoderRequest, encoderApplied: r.encoderApplied, encoderSupported: r.encoderSupported,
    opusHead: r.opusHead, opusHeadSource: r.opusHeadSource,
    pageIntervalMs: summarize(r.pageIntervalsMs),
    paused: r.paused, ended: r.ended, endedReason: r.endedReason, closed: r.closed, elapsedSec: elapsedSec == null ? null : round(elapsedSec, 1),
  };
}

function summarize(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1), mean: round(s.reduce((a, b) => a + b, 0) / s.length, 1) };
}

const round = (v, d) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;

/** One consistent snapshot of every role's counters, taken synchronously. */
function checkpoint() {
  if (!session) return;
  const wall = Date.now(), mono = performance.now();
  const snap = {};
  for (const r of roles.values()) {
    snap[r.role] = { frames: r.frames, pausedFrames: r.pausedFrames, sampleRate: r.sampleRate, granule48k: r.muxer?.granule ?? 0,
                     silenceFrames: r.sampleRate ? Math.round(r.silenceFilled48k * r.sampleRate / 48000) : 0,
                     lastTs: r.lastTs, lastWall: r.lastWall, fileBytes: r.fileBytes, packets: r.packets,
                     discontinuities: r.discontinuities, ended: r.ended, paused: r.paused, frozen: r.frozen,
                     mediaSec: r.sampleRate ? round(r.frames / r.sampleRate, 4) : null };
  }
  const cp = { t: 'checkpoint', n: ++session.checkpoints, wall, mono: round(mono, 1), roles: snap };
  if (session.lastCheckpoint) {
    const dw = wall - session.lastCheckpoint.wall, dm = mono - session.lastCheckpoint.mono;
    cp.wallDeltaMs = dw; cp.monoDeltaMs = round(dm, 1);
    if (Math.abs(dw - dm) > CLOCK_JUMP_MS) {
      const j = { t: 'clock_jump', wall, wallDeltaMs: dw, monoDeltaMs: round(dm, 1), disagreementMs: round(dw - dm, 1) };
      session.clockJumps.push(j);
      journal(j);
    }
  }
  session.lastCheckpoint = cp;
  journal(cp);
  self.postMessage({ type: 'PROGRESS', checkpoint: cp, roles: Object.fromEntries([...roles.values()].map((r) => [r.role, roleStats(r)])),
                     clockJumps: session.clockJumps.length });
}

// ───────────────────────────────────────────────────── report & stop ──

async function writeReport(report, final = false) {
  if (!session) throw new Error('no session');
  // Always answer REPORT_WRITTEN — a full disk must not turn into a 10 s timeout on STOP.
  try {
    const fh = await session.dir.getFileHandle('capture-report.json', { create: true });
    const h = await fh.createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(report, null, 2));
      h.truncate(0); h.write(bytes, { at: 0 }); h.flush();
    } finally { h.close(); }
    journal({ t: final ? 'report_final' : 'report_initial', bytes: JSON.stringify(report).length });
    self.postMessage({ type: 'REPORT_WRITTEN', final, ok: true });
  } catch (e) {
    journal({ t: 'report_write_error', final, error: String(e?.message ?? e) });
    self.postMessage({ type: 'REPORT_WRITTEN', final, ok: false, error: String(e?.message ?? e) });
  }
}

async function stopAll() {
  if (!session) { self.postMessage({ type: 'STOPPED', result: null }); return; }
  clearInterval(session.flushTimer); clearInterval(session.checkpointTimer); clearInterval(session.frozenTimer);
  // One stop instant for every role: frames arriving after this line are ignored by all of them.
  const stopWall = Date.now();
  for (const r of roles.values()) r.stopRequested = true;
  checkpoint();
  const stats = {};
  for (const r of roles.values()) { await finalizeRole(r, session.fatal ? 'stop_after_fatal' : 'stop'); stats[r.role] = roleStats(r); }
  const result = {
    sessionId: session.id, roles: stats, checkpoints: session.checkpoints, clockJumps: session.clockJumps,
    journalBytes: session.journalSize, openedWall: session.openedWall, stopWall, closedWall: Date.now(), fatal: session.fatal,
  };
  journal({ t: 'session_stopped', ...result });
  // The session (journal + directory) stays open: the offscreen document writes
  // the FINAL capture-report.json after it has our stats, then sends CLOSE_SESSION.
  // (First version nulled the session here — measured 2026-09-07: every final
  // report timed out with "no session" and all reports on disk said final:false.)
  session.stopped = true;
  self.postMessage({ type: 'STOPPED', result });
}

function closeSession() {
  if (!session) { self.postMessage({ type: 'SESSION_CLOSED' }); return; }
  journal({ t: 'session_close', journalBytes: session.journalSize });
  try { session.journalHandle.flush(); session.journalHandle.close(); } catch {}
  session = null; roles.clear();
  self.postMessage({ type: 'SESSION_CLOSED' });
}

// ─────────────────────────────────────────────────────────────── probe ──

async function probe() {
  const out = {
    ok: true,
    apis: {
      AudioEncoder: typeof AudioEncoder !== 'undefined', AudioDecoder: typeof AudioDecoder !== 'undefined',
      AudioData: typeof AudioData !== 'undefined', MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor !== 'undefined',
      storageGetDirectory: !!navigator.storage?.getDirectory, performanceMemory: !!performance.memory,
    },
    opfs: { syncAccessHandle: false, error: null },
  };
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('__worker_probe__', { create: true });
    const fh = await dir.getFileHandle('probe.bin', { create: true });
    const t0 = performance.now();
    const h = await fh.createSyncAccessHandle();
    const openMs = performance.now() - t0;
    const buf = new Uint8Array(64 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 255;
    const t1 = performance.now();
    let written = 0;
    for (let k = 0; k < 16; k++) written += h.write(buf, { at: written });
    h.flush();
    const writeMs = performance.now() - t1;
    const size = h.getSize();
    const tail = new Uint8Array(1024);
    h.read(tail, { at: size - 1024 });
    let okContent = true;
    for (let i = 0; i < 1024; i++) if (tail[i] !== ((size - 1024 + i) & 255)) { okContent = false; break; }
    h.truncate(0); h.flush(); h.close();
    await dir.removeEntry('probe.bin').catch(() => {});
    await root.removeEntry('__worker_probe__', { recursive: true }).catch(() => {});
    out.opfs = { syncAccessHandle: true, error: null, openMs: Math.round(openMs * 100) / 100, wrote: written,
                 sizeAfter: size, contentOk: okContent, writeFlushMBps: Math.round((written / 1e6) / (writeMs / 1000) * 10) / 10 };
  } catch (e) {
    out.ok = false; out.opfs = { syncAccessHandle: false, error: String(e?.message ?? e) };
  }
  if (typeof AudioEncoder !== 'undefined') {
    try { out.opusInWorker = (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000 })).supported; }
    catch (e) { out.opusInWorker = `error: ${String(e?.message ?? e)}`; }
  }
  return out;
}
