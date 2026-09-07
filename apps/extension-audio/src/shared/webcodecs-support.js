/**
 * webcodecs-support.js — does THIS context (offscreen document) actually have
 * what the WebCodecs recording path needs?
 *
 * Measured, not assumed. The I1 prompt lists three pitfalls that would each
 * change the architecture if they bite:
 *   1. AudioEncoder may behave differently in an offscreen document;
 *   2. MediaStreamTrackProcessor may be missing in the offscreen context;
 *   3. OPFS createSyncAccessHandle works only inside a Worker.
 * This module answers all three with numbers and error strings, and it is what
 * the recorder consults before switching to the WebCodecs engine. A silent
 * fallback to MediaRecorder would distort every measurement, so a failed probe
 * is reported, never papered over.
 */

export const OPUS_PROBE_CONFIGS = [
  { id: 'opus-48k-voip-20ms-vbr', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000,
    bitrateMode: 'variable', opus: { application: 'voip', complexity: 9, frameDuration: 20000, usedtx: false, useinbandfec: false } },
  { id: 'opus-48k-cbr', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000, bitrateMode: 'constant' },
  { id: 'opus-44k1', sampleRate: 44100, numberOfChannels: 1, bitrate: 48000 },
  { id: 'opus-96k', sampleRate: 96000, numberOfChannels: 1, bitrate: 48000 },
  { id: 'opus-16k', sampleRate: 16000, numberOfChannels: 1, bitrate: 24000 },
  { id: 'opus-60ms', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000, opus: { frameDuration: 60000 } },
  { id: 'opus-10ms', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000, opus: { frameDuration: 10000 } },
  { id: 'opus-audio-app', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000, opus: { application: 'audio' } },
  { id: 'opus-lowdelay-app', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000, opus: { application: 'lowdelay' } },
  { id: 'opus-dtx-fec', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000, opus: { usedtx: true, useinbandfec: true } },
  { id: 'opus-stereo', sampleRate: 48000, numberOfChannels: 2, bitrate: 64000 },
];

export async function probeAudioEncoderConfigs() {
  if (typeof AudioEncoder === 'undefined') return { available: false, results: [] };
  const results = [];
  for (const c of OPUS_PROBE_CONFIGS) {
    const { id, ...cfg } = c;
    const config = { codec: 'opus', ...cfg };
    try {
      const r = await AudioEncoder.isConfigSupported(config);
      // `r.config` is the browser's echo of what it recognised. Keys we sent
      // and it dropped are keys it does not honour — that is the readback.
      results.push({ id, requested: config, supported: r.supported, resolved: r.config ?? null,
        droppedKeys: diffKeys(config, r.config ?? {}) });
    } catch (e) {
      results.push({ id, requested: config, supported: false, error: String(e?.message ?? e) });
    }
  }
  return { available: true, results };
}

function diffKeys(sent, got) {
  const out = [];
  for (const k of Object.keys(sent)) {
    if (!(k in got)) out.push(k);
    else if (k === 'opus' && sent.opus && typeof got.opus === 'object') {
      for (const ok of Object.keys(sent.opus)) if (!(ok in got.opus)) out.push(`opus.${ok}`);
    }
  }
  return out;
}

/**
 * Encode one second of synthetic audio and report what the encoder emits:
 * chunk durations, sizes, timestamps, and whether decoderConfig carries an
 * Opus identification header (`description`). The muxer needs pre-skip from
 * that header; if Chrome does not provide it we must construct it ourselves.
 */
export async function probeAudioEncoderOutput({
  sampleRate = 48000, numberOfChannels = 1, bitrate = 48000, seconds = 1,
  opus = { application: 'voip', frameDuration: 20000 }, bitrateMode = 'variable',
  silence = false,
} = {}) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return { ok: false, error: 'AudioEncoder/AudioData missing' };
  }
  const chunks = [];
  let decoderConfig = null, error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig && !decoderConfig) {
        const d = meta.decoderConfig;
        decoderConfig = {
          codec: d.codec, sampleRate: d.sampleRate, numberOfChannels: d.numberOfChannels,
          descriptionBytes: d.description ? d.description.byteLength : null,
          descriptionHex: d.description ? toHex(d.description) : null,
        };
      }
      chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration, byteLength: chunk.byteLength });
    },
    error: (e) => { error = String(e?.message ?? e); },
  });
  const config = { codec: 'opus', sampleRate, numberOfChannels, bitrate, bitrateMode, opus };
  const sup = await AudioEncoder.isConfigSupported(config);
  if (!sup.supported) return { ok: false, error: 'isConfigSupported=false', config };
  enc.configure(config);

  // 10 ms frames, like a getUserMedia track delivers them.
  const frameLen = Math.round(sampleRate / 100);
  const total = Math.round(sampleRate * seconds);
  let phase = 0;
  const t0 = performance.now();
  for (let done = 0; done < total; done += frameLen) {
    const n = Math.min(frameLen, total - done);
    const buf = new Float32Array(n * numberOfChannels);
    if (!silence) {
      for (let i = 0; i < n; i++) {
        const v = 0.25 * (2 * ((165 * (done + i) / sampleRate) % 1) - 1);
        for (let ch = 0; ch < numberOfChannels; ch++) buf[ch * n + i] = v;
      }
    }
    const ad = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels,
      timestamp: Math.round((done / sampleRate) * 1e6), data: buf,
    });
    enc.encode(ad);
    ad.close();
  }
  try { await enc.flush(); } catch (e) { error ??= String(e?.message ?? e); }
  const wallMs = performance.now() - t0;
  enc.close();

  const bytes = chunks.reduce((a, c) => a + c.byteLength, 0);
  const durations = [...new Set(chunks.map((c) => c.duration))];
  return {
    ok: !error, error, config, decoderConfig,
    chunks: chunks.length, bytes, distinctDurationsUs: durations,
    firstChunks: chunks.slice(0, 4), lastChunk: chunks.at(-1) ?? null,
    effectiveKbps: Math.round((bytes * 8) / seconds / 1000),
    wallMs: Math.round(wallMs),
  };
}

function toHex(buf) {
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Spawn the capture worker in PROBE mode: does the worker see AudioEncoder,
 * can it open an OPFS sync access handle, write, flush and read the size back?
 */
export function probeWorker(workerUrl) {
  return new Promise((resolve) => {
    let w;
    const timer = setTimeout(() => { try { w?.terminate(); } catch {} resolve({ ok: false, error: 'worker probe timeout 10s' }); }, 10000);
    try {
      w = new Worker(workerUrl, { type: 'module' });
    } catch (e) {
      clearTimeout(timer);
      return resolve({ ok: false, error: `new Worker: ${String(e?.message ?? e)}` });
    }
    w.onerror = (e) => { clearTimeout(timer); resolve({ ok: false, error: `worker error: ${e.message}` }); w.terminate(); };
    w.onmessage = (e) => { if (e.data?.type === 'PROBE_RESULT') { clearTimeout(timer); resolve(e.data.result); w.terminate(); } };
    w.postMessage({ type: 'PROBE' });
  });
}

/**
 * Pull AudioData from a live track for `ms` milliseconds through
 * MediaStreamTrackProcessor and report format, sample rate, frame sizes and
 * timestamp behaviour. This is the primitive the whole WebCodecs path stands on.
 */
export async function probeTrackProcessor(track, ms = 1000) {
  if (typeof MediaStreamTrackProcessor === 'undefined') return { available: false };
  let proc, reader;
  try {
    proc = new MediaStreamTrackProcessor({ track });
    reader = proc.readable.getReader();
  } catch (e) {
    return { available: true, ok: false, error: `constructor/reader: ${String(e?.message ?? e)}` };
  }
  const frames = [];
  const t0 = performance.now();
  let total = 0, first = null, last = null, formats = new Set(), rates = new Set(), chans = new Set();
  try {
    while (performance.now() - t0 < ms) {
      const { value, done } = await reader.read();
      if (done) break;
      const ad = value;
      if (first === null) first = { timestamp: ad.timestamp, mono: performance.now(), wall: Date.now() };
      last = { timestamp: ad.timestamp, mono: performance.now(), wall: Date.now(), numberOfFrames: ad.numberOfFrames };
      total += ad.numberOfFrames;
      formats.add(ad.format); rates.add(ad.sampleRate); chans.add(ad.numberOfChannels);
      if (frames.length < 6) frames.push({ timestamp: ad.timestamp, numberOfFrames: ad.numberOfFrames, duration: ad.duration });
      ad.close();
    }
  } catch (e) {
    return { available: true, ok: false, error: `read: ${String(e?.message ?? e)}`, framesSeen: total };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const rate = [...rates][0] ?? null;
  const monoElapsed = last && first ? (last.mono - first.mono) : null;
  const tsElapsed = last && first ? (last.timestamp - first.timestamp) / 1000 : null;
  return {
    available: true, ok: true,
    formats: [...formats], sampleRates: [...rates], channels: [...chans],
    totalFrames: total, firstFrames: frames,
    // If timestamps are sample-derived, tsElapsed ≈ (total - lastFrames)/rate; if
    // clock-derived, tsElapsed ≈ monoElapsed. Both numbers are reported.
    monoElapsedMs: monoElapsed == null ? null : Math.round(monoElapsed * 10) / 10,
    timestampElapsedMs: tsElapsed == null ? null : Math.round(tsElapsed * 10) / 10,
    framesElapsedMs: rate ? Math.round(((total - (last?.numberOfFrames ?? 0)) / rate) * 1e4) / 10 : null,
  };
}

/** One call that runs everything the WebCodecs path depends on. */
export async function runWebCodecsFeasibility({ workerUrl, track = null, tabTrack = null } = {}) {
  const out = {
    at: new Date().toISOString(),
    context: { isWorker: typeof importScripts === 'function', href: globalThis.location?.href ?? null },
    apis: {
      AudioEncoder: typeof AudioEncoder !== 'undefined',
      AudioDecoder: typeof AudioDecoder !== 'undefined',
      AudioData: typeof AudioData !== 'undefined',
      EncodedAudioChunk: typeof EncodedAudioChunk !== 'undefined',
      MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor !== 'undefined',
      MediaStreamTrackGenerator: typeof MediaStreamTrackGenerator !== 'undefined',
      Worker: typeof Worker !== 'undefined',
      AudioWorklet: typeof AudioWorkletNode !== 'undefined',
      performanceMemory: !!performance.memory,
      storageGetDirectory: !!navigator.storage?.getDirectory,
    },
  };
  out.encoderConfigs = await probeAudioEncoderConfigs();
  out.encoderOutput48k = await probeAudioEncoderOutput({ sampleRate: 48000 });
  out.encoderOutput44k1 = await probeAudioEncoderOutput({ sampleRate: 44100 });
  out.encoderOutputSilenceDtx = await probeAudioEncoderOutput({ sampleRate: 48000, silence: true, opus: { application: 'voip', frameDuration: 20000, usedtx: true } });
  out.encoderOutputSilenceNoDtx = await probeAudioEncoderOutput({ sampleRate: 48000, silence: true, opus: { application: 'voip', frameDuration: 20000, usedtx: false } });
  if (workerUrl) out.worker = await probeWorker(workerUrl);
  if (track) out.micTrackProcessor = await probeTrackProcessor(track, 1000);
  if (tabTrack) out.tabTrackProcessor = await probeTrackProcessor(tabTrack, 1000);
  return out;
}
