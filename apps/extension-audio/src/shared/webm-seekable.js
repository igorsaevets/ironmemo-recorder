/**
 * webm-seekable.js — make a MediaRecorder WebM seekable in desktop players.
 *
 * Chrome's MediaRecorder writes a live stream: the Segment and every Cluster have unknown
 * size, Info has no Duration and there are no Cues. Players then show no length and cannot
 * seek. Measured 2026-10-19 on a 1 h 03 min recording from the owner's Google Meet call:
 * 752 clusters ~5 s apart, all unknown-size, ffprobe duration N/A, MPC-HC could not seek.
 *
 * This rebuilds only the header — Segment with a known size, SeekHead, Info + Duration,
 * Tracks, Cues (one CuePoint per Cluster) — and fills each Cluster's size in place (Chrome
 * writes it as an 8-byte unknown-size field, so offsets do not move). Audio bytes are not
 * re-encoded or reordered. The source Blob is read once, in windows, so a long recording
 * is never loaded into memory whole; the result is a Blob made of slices of the source.
 *
 * Never let this block a download: callers fall back to the original Blob on any error.
 */

import { opusPacketSamples } from './ogg-opus.js';

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Info: 0x1549A966,
  Tracks: 0x1654AE6B, Cues: 0x1C53BB6B, Cluster: 0x1F43B675, Tags: 0x1254C367,
  Chapters: 0x1043A770, Attachments: 0x1941A469,
  Duration: 0x4489, TimecodeScale: 0x2AD7B1, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0,
  TrackEntry: 0xAE, TrackNumber: 0xD7,
};
const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Cluster, ID.Tags, ID.Chapters, ID.Attachments]);
const HEADER_MAX = 12; // 4-byte id + 8-byte size

/** Windowed reader over a Blob: one `arrayBuffer()` per window, sequential access. */
class BlobReader {
  constructor(blob, windowBytes) { this.blob = blob; this.win = windowBytes; this.start = 0; this.buf = new Uint8Array(0); }
  has(off, n) { return off >= this.start && off + n <= this.start + this.buf.length; }
  async load(off, n) {
    const end = Math.min(this.blob.size, off + Math.max(n, this.win));
    this.buf = new Uint8Array(await this.blob.slice(off, end).arrayBuffer());
    this.start = off;
  }
  at(off) { return this.buf[off - this.start]; }
  view(off, n) { return this.buf.subarray(off - this.start, off - this.start + n); }
}

function idAt(b, o, avail) {
  const first = b[o];
  const len = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (!len || len > avail) return null;
  let v = 0; for (let i = 0; i < len; i++) v = v * 256 + b[o + i];
  return { id: v, len };
}

function sizeAt(b, o, avail) {
  const first = b[o];
  let len = 0; for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) { len = i + 1; break; }
  if (!len || len > avail) return null;
  let v = first & (0xFF >> len), allOnes = v === (0xFF >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 0xFF) allOnes = false; }
  return { size: allOnes ? null : v, len };
}

const uint = (b, o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; };

/** Element header at `off`, or null at EOF / on a truncated header. */
async function header(r, off) {
  if (off >= r.blob.size) return null;
  if (!r.has(off, HEADER_MAX)) await r.load(off, HEADER_MAX);
  const avail = r.start + r.buf.length - off;
  const b = r.buf, o = off - r.start;
  const idr = idAt(b, o, avail); if (!idr) return null;
  const szr = sizeAt(b, o + idr.len, avail - idr.len); if (!szr) return null;
  return { id: idr.id, off, sizeOff: off + idr.len, sizeLen: szr.len, size: szr.size, data: off + idr.len + szr.len };
}

async function payload(r, h) {
  if (!r.has(h.data, h.size)) await r.load(h.data, h.size);
  return r.view(h.data, h.size).slice();
}

// ── EBML writing ──
const idBytes = (id) => { const out = []; let v = id; while (v > 0) { out.unshift(v & 0xFF); v = Math.floor(v / 256); } return out; };
const size8 = (n) => { const out = [0x01]; for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xFF); return out; };
const uint8b = (n) => { const out = []; for (let i = 7; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xFF); return out; };
const el = (id, body) => [...idBytes(id), ...(body.length <= 126 ? [0x80 | body.length] : size8(body.length)), ...body];
const elFixed = (id, body) => [...idBytes(id), ...size8(body.length), ...body]; // size field always 8 bytes
const float64 = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return [...new Uint8Array(d.buffer)]; };

const SEEKHEAD_BYTES = 75; // 4 id + 8 size + 3 × Seek(21)
const CUEPOINT_BYTES = 27;

/**
 * @param {Blob} blob   one MediaRecorder WebM stream (one EBML header)
 * @param {{windowBytes?: number}} [opts]
 * @returns {Promise<{blob: Blob, changed: boolean, reason?: string, clusters?: number,
 *                    durationMs?: number, patchedClusters?: number, droppedTailBytes?: number}>}
 */
export async function makeWebmSeekable(blob, { windowBytes = 8 << 20 } = {}) {
  const r = new BlobReader(blob, windowBytes);
  const ebml = await header(r, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size == null) return { blob, changed: false, reason: 'not an EBML file' };
  const ebmlEnd = ebml.data + ebml.size;
  const seg = await header(r, ebmlEnd);
  if (!seg || seg.id !== ID.Segment) return { blob, changed: false, reason: 'no Segment' };
  const segEnd = seg.size == null ? blob.size : Math.min(blob.size, seg.data + seg.size);

  let info = null, tracks = null, hasCues = false, hasDuration = false, timecodeScale = 1_000_000, trackNumber = 1;
  const clusters = [];  // { off, sizeOff, sizeLen, unknown, tc }
  let lastBlock = null; // { tc, payloadOff, size }
  let off = seg.data, clustersEnd = null;

  while (off < segEnd) {
    const h = await header(r, off);
    if (!h || h.id === ID.EBML) break;          // EOF, truncated tail, or a second stream
    if (h.id === ID.Cluster) {
      const c = { off: h.off, sizeOff: h.sizeOff, sizeLen: h.sizeLen, unknown: h.size == null, tc: null };
      const end = h.size == null ? segEnd : Math.min(segEnd, h.data + h.size);
      let p = h.data, complete = h.data;
      while (p < end) {
        const ch = await header(r, p);
        if (!ch) break;
        if (h.size == null && (LEVEL1.has(ch.id) || ch.id === ID.EBML)) break;
        if (ch.size == null || ch.data + ch.size > end) break; // truncated block: cut here
        if (ch.id === ID.Timecode) c.tc = uint((await payload(r, ch)), 0, ch.size);
        else if (ch.id === ID.SimpleBlock && c.tc != null) lastBlock = { tc: c.tc, payloadOff: ch.data, size: ch.size };
        p = ch.data + ch.size; complete = p;
      }
      if (c.tc == null) break;                    // a cluster without a timecode: stop before it
      c.end = complete;
      clusters.push(c);
      clustersEnd = complete;
      if (complete < end && h.size != null) break; // known-size cluster cut short: file is truncated
      off = complete;
      continue;
    }
    if (clusters.length) break;                   // anything after the clusters (Cues, Tags) is dropped
    if (h.size == null || h.data + h.size > segEnd) break;
    if (h.id === ID.Info) {
      info = await payload(r, h);
      for (let p = 0; p < info.length;) {
        const i = idAt(info, p, info.length - p); const s = i && sizeAt(info, p + i.len, info.length - p - i.len);
        if (!i || !s || s.size == null) break;
        if (i.id === ID.Duration) hasDuration = true;
        if (i.id === ID.TimecodeScale) timecodeScale = uint(info, p + i.len + s.len, s.size);
        p += i.len + s.len + s.size;
      }
    } else if (h.id === ID.Tracks) {
      if (!r.has(h.off, h.data - h.off + h.size)) await r.load(h.off, h.data - h.off + h.size);
      tracks = r.view(h.off, h.data - h.off + h.size).slice();
      const tn = findFirst(tracks, h.data - h.off, tracks.length, [ID.TrackEntry, ID.TrackNumber]);
      if (tn) trackNumber = uint(tracks, tn.data, tn.size);
    } else if (h.id === ID.Cues) {
      hasCues = true;
    }
    off = h.data + h.size;
  }

  if (!info || !tracks || !clusters.length) return { blob, changed: false, reason: 'no Info/Tracks/Cluster' };
  if (hasCues && hasDuration) return { blob, changed: false, reason: 'already seekable' };

  // Duration = end of the last block (its time + its Opus packet length).
  let durationTicks = clusters.at(-1).tc;
  if (lastBlock) {
    if (!r.has(lastBlock.payloadOff, lastBlock.size)) await r.load(lastBlock.payloadOff, lastBlock.size);
    const pb = r.view(lastBlock.payloadOff, lastBlock.size);
    const tn = sizeAt(pb, 0, pb.length);
    if (tn && tn.len + 4 <= pb.length) {
      const rel = (pb[tn.len] << 8 | pb[tn.len + 1]) << 16 >> 16;
      const samples = opusPacketSamples(pb.subarray(tn.len + 3)) || 960;
      durationTicks = lastBlock.tc + rel + samples / 48000 * 1e9 / timecodeScale;
    }
  }

  // Info without any old Duration, plus ours.
  const infoBody = [];
  for (let p = 0; p < info.length;) {
    const i = idAt(info, p, info.length - p); const s = sizeAt(info, p + i.len, info.length - p - i.len);
    const n = i.len + s.len + s.size;
    if (i.id !== ID.Duration) infoBody.push(...info.subarray(p, p + n));
    p += n;
  }
  infoBody.push(...el(ID.Duration, float64(durationTicks)));
  const infoEl = elFixed(ID.Info, infoBody);

  const cuesLen = 12 + clusters.length * CUEPOINT_BYTES;
  const posInfo = SEEKHEAD_BYTES, posTracks = posInfo + infoEl.length, posCues = posTracks + tracks.length;
  const posClusters = posCues + cuesLen;
  const firstCluster = clusters[0].off;

  const seek = (id, pos) => el(0x4DBB, [...el(0x53AB, idBytes(id)), ...el(0x53AC, uint8b(pos))]);
  const seekHead = elFixed(ID.SeekHead, [...seek(ID.Info, posInfo), ...seek(ID.Tracks, posTracks), ...seek(ID.Cues, posCues)]);

  const cues = new Uint8Array(cuesLen);
  cues.set([...idBytes(ID.Cues), ...size8(cuesLen - 12)], 0);
  let q = 12;
  for (const c of clusters) {
    const cp = el(0xBB, [...el(0xB3, uint8b(c.tc)),
                         ...el(0xB7, [...el(0xF7, [trackNumber]), ...el(0xF1, uint8b(posClusters + (c.off - firstCluster)))])]);
    cues.set(cp, q); q += cp.length;
  }

  const clusterBytes = clustersEnd - firstCluster;
  const segBody = posClusters + clusterBytes;
  const ebmlHeader = await blob.slice(0, ebmlEnd).arrayBuffer();
  const pre = new Uint8Array(ebmlEnd + 4 + 8 + seekHead.length + infoEl.length + tracks.length);
  let w = 0;
  pre.set(new Uint8Array(ebmlHeader), w); w += ebmlEnd;
  pre.set([...idBytes(ID.Segment), ...size8(segBody)], w); w += 12;
  pre.set(seekHead, w); w += seekHead.length;
  pre.set(infoEl, w); w += infoEl.length;
  pre.set(tracks, w);

  // Clusters: copy, filling each unknown 8-byte size field in place.
  const parts = [pre, cues];
  let from = firstCluster, patched = 0;
  for (const c of clusters) {
    if (c.unknown && c.sizeLen === 8) {
      parts.push(blob.slice(from, c.sizeOff), new Uint8Array(size8(c.end - (c.sizeOff + 8))));
      from = c.sizeOff + 8; patched++;
    }
  }
  parts.push(blob.slice(from, clustersEnd));
  const out = new Blob(parts, { type: blob.type || 'audio/webm' });
  return { blob: out, changed: true, clusters: clusters.length, patchedClusters: patched,
           durationMs: durationTicks * timecodeScale / 1e6, droppedTailBytes: blob.size - clustersEnd };
}

/** First element along an id path inside a buffer (masters must have known sizes). */
function findFirst(b, start, end, path) {
  let p = start;
  while (p < end) {
    const i = idAt(b, p, end - p); const s = i && sizeAt(b, p + i.len, end - p - i.len);
    if (!i || !s || s.size == null) return null;
    const data = p + i.len + s.len;
    if (i.id === path[0]) return path.length === 1 ? { data, size: s.size } : findFirst(b, data, data + s.size, path.slice(1));
    p = data + s.size;
  }
  return null;
}
