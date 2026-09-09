/**
 * recovery.js — what happens to a session that never received STOP.
 *
 * Runs in a Worker (recovery-worker.js): it needs createSyncAccessHandle to repair files in
 * place and AudioDecoder to prove that the result decodes end to end. The same module is
 * driven by the lab page (test bench) and by the offscreen document (RECOVER message, at
 * browser start when the service worker finds an orphaned session).
 *
 * WHAT "ORPHANED" MEANS HERE — capture-report.json says `final: false` (or is missing) and
 * the journal has no session_stopped / session_close line. Both engines write the report
 * twice (initial, final), so this is a property of the files, not of chrome.storage.
 *
 * PER ENGINE
 *   webcodecs (<role>.opus): every Ogg page was flushed when written, so the file is valid
 *     up to the last complete page. Repair = truncate a trailing partial page (if any) and
 *     append an EOS page carrying the last granule. Nothing is re-encoded or re-muxed.
 *   mediarecorder (<role>.<segment>.<seq>.part): parts of one segment are concatenated
 *     (they are one live WebM stream), packets are pulled out (webm-demux.js) and muxed into
 *     <role>.recovered.opus with the Ogg muxer. Segments are placed on the session timeline
 *     by their journaled start wall time; a gap between segments is filled with 1-byte
 *     silence packets, an overlap is trimmed. Device-loss gaps (device_gap) are filled the
 *     same way. The parts are left untouched.
 *
 * WHAT IS VERIFIED — every produced or repaired .opus is demuxed and decoded by AudioDecoder;
 * `ok` means decodedFrames ≥ lastGranule − preSkip, exactly the I1 criterion. The report
 * (recovery.json) states seconds on disk, not "recovered" — the word belongs to ADR-004's
 * table, which is filled from these numbers.
 */

import { OggOpusMuxer, demuxOggOpus, decodeOggOpusFully, opusPacketSamples, silenceFillerFor, parseOpusHead } from './ogg-opus.js';
import { demuxWebmOpus } from './webm-demux.js';

const OPUS_RATE = 48000;

// ───────────────────────────────────────────────────────────── inventory ──

async function sessionsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('sessions', { create: true });
}

async function readJson(dir, name) {
  try { const f = await (await dir.getFileHandle(name)).getFile(); return JSON.parse(await f.text()); }
  catch { return null; }
}

async function readJournal(dir) {
  try {
    const f = await (await dir.getFileHandle('journal.jsonl')).getFile();
    const text = await f.text();
    const out = [];
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { out.push({ t: '<unparsable>', raw: line.slice(0, 80) }); } }
    return out;
  } catch { return []; }
}

/** One session: files, engine, whether it ended cleanly. */
export async function inspectSession(sid) {
  const dir = await (await sessionsDir()).getDirectoryHandle(sid);
  const files = [];
  for await (const [name, fh] of dir.entries()) {
    if (fh.kind !== 'file') continue;
    const f = await fh.getFile();
    files.push({ name, size: f.size, lastModified: f.lastModified });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const report = await readJson(dir, 'capture-report.json');
  const journal = await readJournal(dir);
  const engine = report?.engine ?? (files.some((f) => f.name.endsWith('.part')) ? 'mediarecorder' : files.some((f) => f.name.endsWith('.opus')) ? 'webcodecs' : null);
  const stoppedLine = journal.find((j) => j.t === 'session_stopped' || j.t === 'session_close' || j.event === 'session_stopped');
  const recovered = await readJson(dir, 'recovery.json');
  return {
    session: sid, engine, files, bytes: files.reduce((a, f) => a + f.size, 0),
    reportFinal: report?.final ?? null, reportFound: !!report,
    stoppedInJournal: !!stoppedLine, journalLines: journal.length,
    orphaned: !(report?.final === true) && !stoppedLine,
    startedAt: report?.timeline?.t0Wall ?? journal[0]?.wall ?? null,
    recoveredAt: recovered?.at ?? null, recovery: recovered,
    _dir: dir, _journal: journal, _report: report,
  };
}

export async function scanSessions() {
  const out = [];
  const sessions = await sessionsDir();
  for await (const [sid, h] of sessions.entries()) {
    if (h.kind !== 'directory') continue;
    const s = await inspectSession(sid);
    delete s._dir; delete s._journal; delete s._report;
    out.push(s);
  }
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out;
}

// ─────────────────────────────────────────────────────── Ogg (webcodecs) ──

/** Truncate a trailing partial page and append an EOS page. In place, via a sync handle. */
async function finalizeOgg(dir, name, demux, fileSize) {
  const fh = await dir.getFileHandle(name);
  const h = await fh.createSyncAccessHandle();
  try {
    const lastPage = readLastPageHeader(h, demux.bytesConsumed);
    const serial = demux.serial ?? lastPage?.serial ?? 0;
    const seq = (lastPage?.seq ?? demux.pages - 1) + 1;
    const truncatedBytes = fileSize - demux.bytesConsumed;
    if (truncatedBytes > 0) h.truncate(demux.bytesConsumed);
    // An empty page with the last granule and the EOS flag: what stopAll() would have written.
    const m = new OggOpusMuxer({ serial });
    m.pageSeq = seq; m.granule = demux.lastGranule; m.headersDone = true;
    const eos = m.flushPage({ eos: true });
    h.write(eos, { at: demux.bytesConsumed });
    h.flush();
    return { truncatedBytes, eosBytes: eos.length, eosSeq: seq, serial, sizeAfter: h.getSize() };
  } finally { h.close(); }
}

/** Header fields of the last complete page before `end` (serial, seq) — scanned backwards. */
function readLastPageHeader(h, end) {
  const win = Math.min(end, 70_000);
  const buf = new Uint8Array(win);
  h.read(buf, { at: end - win });
  // Find the last 'OggS' whose page ends exactly at `end`.
  for (let i = win - 27; i >= 0; i--) {
    if (buf[i] !== 0x4f || buf[i + 1] !== 0x67 || buf[i + 2] !== 0x67 || buf[i + 3] !== 0x53) continue;
    const nseg = buf[i + 26];
    if (i + 27 + nseg > win) continue;
    let body = 0; for (let k = 0; k < nseg; k++) body += buf[i + 27 + k];
    if (i + 27 + nseg + body !== win) continue;
    const dv = new DataView(buf.buffer, i, 27);
    return { serial: dv.getUint32(14, true), seq: dv.getUint32(18, true), granule: Number(dv.getBigUint64(6, true)) };
  }
  return null;
}

async function processOgg(dir, file, opts, log) {
  const t0 = performance.now();
  const f = await (await dir.getFileHandle(file.name)).getFile();
  const buf = new Uint8Array(await f.arrayBuffer());
  const before = demuxOggOpus(buf);
  const r = {
    file: file.name, engine: 'webcodecs', bytes: f.size,
    before: { pages: before.pages, packets: before.packets.length, bytesConsumed: before.bytesConsumed, stoppedBecause: before.stoppedBecause,
              lastGranule: before.lastGranule, crcErrors: before.crcErrors, gaps: before.gaps.length, preSkip: before.opusHead?.preSkip ?? null },
    trailingBytes: f.size - before.bytesConsumed, hadEos: before.stoppedBecause === 'eos',
    secondsOnDisk: before.opusHead ? Math.max(0, before.lastGranule - before.opusHead.preSkip) / OPUS_RATE : 0,
    action: 'none', repair: null, decode: null, ms: 0,
  };
  if (!before.opusHead) { r.error = 'no OpusHead — file unreadable'; r.ms = Math.round(performance.now() - t0); return r; }
  if (opts.remux && !r.hadEos) {
    r.repair = await finalizeOgg(dir, file.name, before, f.size);
    r.action = r.trailingBytes > 0 ? 'truncate+eos' : 'eos';
    log(`${file.name}: truncated ${r.repair.truncatedBytes} B, EOS appended (seq ${r.repair.eosSeq})`);
  }
  if (opts.validate) {
    const f2 = await (await dir.getFileHandle(file.name)).getFile();
    const buf2 = await f2.arrayBuffer();
    const d = await decodeOggOpusFully(buf2);
    r.decode = { decodedFrames: d.decodedFrames, expectedSamples: d.expectedSamples, ok: d.ok, error: d.decodeError,
                 stoppedBecause: d.demux.stoppedBecause, pages: d.demux.pages, packets: d.demux.packets, crcErrors: d.demux.crcErrors };
    r.secondsDecoded = d.decodedFrames / OPUS_RATE;
  }
  r.ms = Math.round(performance.now() - t0);
  return r;
}

// ─────────────────────────────────────────────── WebM parts (mediarecorder) ──

function parsePartName(name) {
  // <role>.<segment:3>.<seq:6>.part  (I2)   |   <role>.<seq:6>.part  (I0/I1, single segment)
  let m = /^(.+)\.(\d{3})\.(\d{6})\.part$/.exec(name);
  if (m) return { role: m[1], segment: +m[2], seq: +m[3] };
  m = /^(.+)\.(\d{6})\.part$/.exec(name);
  if (m) return { role: m[1], segment: 0, seq: +m[2] };
  return null;
}

async function concatParts(dir, parts) {
  const chunks = [];
  let total = 0;
  for (const p of parts) {
    const f = await (await dir.getFileHandle(p.name)).getFile();
    const b = new Uint8Array(await f.arrayBuffer());
    chunks.push(b); total += b.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function writeFileSync(dir, name, bytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  try { h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); return h.getSize(); } finally { h.close(); }
}

/**
 * All parts of one role → one Ogg/Opus on the session timeline.
 * Timeline origin = the role's first segment_start.startWall (journal); packet position =
 * segment offset (wall) + block time inside the segment. Gaps ≥ muxerGapFillMs get silence
 * fillers; packets that would land before the current position (overlap) are dropped.
 */
async function processWebmRole(dir, role, parts, journal, opts, log) {
  const t0 = performance.now();
  const bySeg = new Map();
  for (const p of parts) { const k = p.segment; (bySeg.get(k) ?? bySeg.set(k, []).get(k)).push(p); }
  const segments = [...bySeg.keys()].sort((a, b) => a - b);
  const segStart = new Map();
  for (const j of journal) if (j.event === 'segment_start' && j.role === role) segStart.set(j.segment, j.startWall);
  const handovers = journal.filter((j) => j.event === 'segment_handover' && j.role === role);
  const deviceGaps = journal.filter((j) => j.event === 'device_gap' && j.role === role);
  const origin = segStart.get(segments[0]) ?? null;
  const fillMs = opts.muxerGapFillMs ?? 40;

  const r = { role, engine: 'mediarecorder', parts: parts.length, segments: segments.length, segmentsDetail: [],
              packets: 0, fillerPackets: 0, fillerSamples: 0, trimmedPackets: 0, trimmedSamples: 0,
              secondsOnDisk: 0, action: 'none', outFile: null, decode: null, timelineOrigin: origin, handovers: handovers.length,
              deviceGaps: deviceGaps.map((g) => ({ gapMs: g.gapMs, segment: g.segment })), ms: 0 };

  let muxer = null, head = null, lastToc = null, pending = 0, totalSamples = 0;
  const pageEvery = OPUS_RATE; // one page per second of audio
  const pages = [];
  const emit = () => { const p = muxer.flushPage(); if (p) pages.push(p); pending = 0; };

  for (const seg of segments) {
    const list = bySeg.get(seg).sort((a, b) => a.seq - b.seq);
    const buf = await concatParts(dir, list);
    const d = demuxWebmOpus(buf);
    const segDurSamples = d.blocks.reduce((a, b) => a + opusPacketSamples(b.data), 0);
    const info = { segment: seg, parts: list.length, bytes: buf.length, blocks: d.blocks.length, clusters: d.clusters,
                   stoppedBecause: d.stoppedBecause, bytesConsumed: d.bytesConsumed, hasDuration: d.duration != null, hasCues: d.hasCues,
                   codecId: d.codecId, codecPrivate: !!d.codecPrivate, firstBlockMs: d.blocks[0]?.timeMs ?? null,
                   lastBlockMs: d.blocks.at(-1)?.timeMs ?? null, secondsInBlocks: segDurSamples / OPUS_RATE,
                   startWall: segStart.get(seg) ?? null, offsetMs: null, fillerBefore: 0, trimmed: 0 };
    r.secondsOnDisk += info.secondsInBlocks;
    if (!d.blocks.length) { r.segmentsDetail.push(info); continue; }
    if (!muxer) {
      const oh = d.codecPrivate ? parseOpusHead(d.codecPrivate) : null;
      head = oh ? d.codecPrivate : null;
      muxer = new OggOpusMuxer({ channels: oh?.channels ?? d.channels ?? 1, preSkip: oh?.preSkip ?? 312,
                                 inputSampleRate: oh?.inputSampleRate ?? d.sampleRate ?? 48000, opusHead: head,
                                 comments: ['ENCODER=Chrome MediaRecorder (remuxed by IronMemo recovery)', `IRONMEMO_ROLE=${role}`,
                                            `IRONMEMO_SOURCE_PARTS=${parts.length}`, `IRONMEMO_SOURCE_SEGMENTS=${segments.length}`] });
      for (const p of muxer.headerPages()) pages.push(p);
      r.opusHead = oh;
    }
    // Where this segment starts on the session timeline.
    let offsetMs;
    if (origin != null && segStart.get(seg) != null) offsetMs = segStart.get(seg) - origin;
    else offsetMs = (muxer.granule + pending) / OPUS_RATE * 1000; // no journal: butt-join
    info.offsetMs = offsetMs;
    const base = d.blocks[0].timeMs;
    let firstOfSegment = true;
    for (const blk of d.blocks) {
      const n = opusPacketSamples(blk.data);
      if (!n) continue;
      const target = Math.round((offsetMs + (blk.timeMs - base)) / 1000 * OPUS_RATE);
      const pos = muxer.granule + pending;
      const gap = target - pos;
      // Inside a segment block times are regular: fill only real holes (≥ muxerGapFillMs).
      // At a segment boundary the hole is known exactly from the journal and is SMALL but
      // systematic — measured 2026-09-08 (smoke-roll-none): Chrome's MediaRecorder encodes
      // Opus in 60 ms frames and drops the incomplete last frame on stop(), so every handover
      // loses ~26–30 ms even with the start-then-stop overlap. Left unfilled, that drift
      // accumulates (240 handovers of 60 s segments in 4 h ≈ 7 s), so at a boundary any gap
      // of at least half a filler is rounded to whole fillers.
      const filler = lastToc ? silenceFillerFor(lastToc) : null;
      const step = filler ? (opusPacketSamples(filler) || 960) : 960;
      const threshold = firstOfSegment ? step / 2 : fillMs * OPUS_RATE / 1000;
      if (gap >= threshold && filler) {
        const k = firstOfSegment ? Math.round(gap / step) : Math.floor(gap / step);
        for (let i = 0; i < k; i++) { muxer.addPacket(filler, step); pending += step; if (pending >= pageEvery) emit(); }
        r.fillerPackets += k; r.fillerSamples += k * step; info.fillerBefore += k;
        if (firstOfSegment) info.boundaryGapMs = Math.round(gap / OPUS_RATE * 1000);
        firstOfSegment = false;
      } else if (gap < -n / 2) {
        firstOfSegment = false;
        // Overlap: this packet ends before the position we already reached — drop it.
        r.trimmedPackets++; r.trimmedSamples += n; info.trimmed++;
        continue;
      } else if (firstOfSegment) {
        info.boundaryGapMs = Math.round(gap / OPUS_RATE * 1000);
        firstOfSegment = false;
      }
      muxer.addPacket(blk.data, n); pending += n; r.packets++; totalSamples += n;
      lastToc = blk.data.subarray(0, 1);
      if (pending >= pageEvery) emit();
    }
    r.segmentsDetail.push(info);
  }
  if (!muxer) { r.error = 'no decodable blocks in any part'; r.ms = Math.round(performance.now() - t0); return r; }
  const last = muxer.flushPage({ eos: true }); if (last) pages.push(last);
  const total = pages.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of pages) { out.set(p, o); o += p.length; }
  r.outFile = `${role}.recovered.opus`;
  r.outBytes = total; r.action = 'remux';
  r.secondsMuxed = muxer.granule / OPUS_RATE;
  if (opts.remux) {
    await writeFileSync(dir, r.outFile, out);
    log(`${role}: ${r.packets} packets from ${parts.length} parts / ${segments.length} segments → ${r.outFile} (${total} B, fillers ${r.fillerPackets}, trimmed ${r.trimmedPackets})`);
  }
  if (opts.validate) {
    const d = await decodeOggOpusFully(out.buffer);
    r.decode = { decodedFrames: d.decodedFrames, expectedSamples: d.expectedSamples, ok: d.ok, error: d.decodeError,
                 stoppedBecause: d.demux.stoppedBecause, pages: d.demux.pages, packets: d.demux.packets };
    r.secondsDecoded = d.decodedFrames / OPUS_RATE;
  }
  r.ms = Math.round(performance.now() - t0);
  return r;
}

// ───────────────────────────────────────────────────────────────── driver ──

/**
 * @param {string} sid
 * @param {{remux?: boolean, validate?: boolean, muxerGapFillMs?: number, force?: boolean}} opts
 * @param {(msg: string) => void} log
 */
export async function recoverSession(sid, opts = {}, log = () => {}) {
  const o = { remux: true, validate: true, muxerGapFillMs: 40, force: false, ...opts };
  const t0 = performance.now();
  const s = await inspectSession(sid);
  const dir = s._dir, journal = s._journal;
  const result = { kind: 'ironmemo-recovery', version: 1, session: sid, at: new Date().toISOString(), engine: s.engine,
                   orphaned: s.orphaned, reportFinal: s.reportFinal, stoppedInJournal: s.stoppedInJournal, opts: o, perRole: {}, ms: 0 };
  if (!s.orphaned && !o.force) {
    result.skipped = 'session ended cleanly (capture-report final:true or session_stopped in journal)';
    result.ms = Math.round(performance.now() - t0);
    return result;
  }
  if (s.engine === 'webcodecs') {
    for (const f of s.files) {
      if (!f.name.endsWith('.opus') || f.name.endsWith('.recovered.opus')) continue;
      const role = f.name.replace(/\.opus$/, '');
      result.perRole[role] = await processOgg(dir, f, o, log);
    }
    // Journal vs disk: the journal's last `page` line per role must not claim more bytes than the file has.
    result.journalCheck = journalVsDiskOgg(journal, s.files, result.perRole);
  } else if (s.engine === 'mediarecorder') {
    const byRole = new Map();
    for (const f of s.files) {
      const p = parsePartName(f.name);
      if (!p) continue;
      (byRole.get(p.role) ?? byRole.set(p.role, []).get(p.role)).push({ ...p, name: f.name, size: f.size });
    }
    for (const [role, parts] of byRole) {
      result.perRole[role] = await processWebmRole(dir, role, parts, journal, o, log);
    }
    result.journalCheck = journalVsDiskParts(journal, s.files);
  } else {
    result.error = 'engine unknown — no .opus and no .part files';
  }
  result.ms = Math.round(performance.now() - t0);
  result.ok = Object.values(result.perRole).every((r) => !r.error && (!o.validate || r.decode?.ok));
  if (o.remux) {
    try { await writeFileSync(dir, 'recovery.json', new TextEncoder().encode(JSON.stringify(result, null, 2))); }
    catch (e) { result.writeError = String(e?.message ?? e); }
  }
  return result;
}

/** Ogg path: last journaled page per role vs the file. Bytes claimed > bytes on disk = the silent failure ADR-004 forbids. */
function journalVsDiskOgg(journal, files, perRole) {
  const out = {};
  for (const [role, r] of Object.entries(perRole)) {
    const last = [...journal].reverse().find((j) => j.t === 'page' && j.role === role);
    const file = files.find((f) => f.name === `${role}.opus`);
    const sizeBeforeRepair = r.bytes;
    out[role] = last ? {
      journaledPages: last.pages, journaledBytes: last.fileBytes, journaledGranule: last.granule,
      fileBytesBeforeRepair: sizeBeforeRepair, pagesOnDisk: r.before.pages, granuleOnDisk: r.before.lastGranule,
      bytesConsumedOnDisk: r.before.bytesConsumed,
      journalAhead: last.fileBytes > sizeBeforeRepair,              // journal claims bytes the disk does not have
      diskAheadOfJournal: r.before.bytesConsumed > last.fileBytes,  // normal: pages written after the last journal line (every 5th page is journaled)
      consistent: last.fileBytes <= sizeBeforeRepair && last.granule <= r.before.lastGranule,
    } : { journaledPages: 0, note: 'no page line in journal', consistent: true, fileFound: !!file };
  }
  return out;
}

/** MR path: every journaled part must exist with the journaled size; parts on disk without a journal line are allowed (crash after close, before the journal rewrite). */
function journalVsDiskParts(journal, files) {
  const disk = new Map(files.filter((f) => f.name.endsWith('.part')).map((f) => [f.name, f.size]));
  const lines = journal.filter((j) => j.event === 'part' || (j.file && j.bytes != null));
  let missing = 0, sizeMismatch = 0;
  const problems = [];
  for (const j of lines) {
    const sz = disk.get(j.file);
    if (sz == null) { missing++; if (problems.length < 10) problems.push({ file: j.file, journaledBytes: j.bytes, onDisk: null }); }
    else if (sz !== j.bytes) { sizeMismatch++; if (problems.length < 10) problems.push({ file: j.file, journaledBytes: j.bytes, onDisk: sz }); }
  }
  const journaled = new Set(lines.map((j) => j.file));
  const unjournaled = [...disk.keys()].filter((n) => !journaled.has(n));
  return { journaledParts: lines.length, partsOnDisk: disk.size, missingOnDisk: missing, sizeMismatch, unjournaledOnDisk: unjournaled.length,
           consistent: missing === 0 && sizeMismatch === 0, problems, unjournaled: unjournaled.slice(0, 10) };
}

export async function recoverAll(opts = {}, log = () => {}) {
  const list = await scanSessions();
  const out = [];
  for (const s of list) {
    if (!s.orphaned && !opts.force) continue;
    if (s.recoveredAt && !opts.force) { out.push({ session: s.session, skipped: 'already has recovery.json', at: s.recoveredAt }); continue; }
    out.push(await recoverSession(s.session, opts, log));
  }
  return out;
}
