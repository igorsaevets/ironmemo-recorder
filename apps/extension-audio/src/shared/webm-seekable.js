/**
 * webm-seekable.js — make a MediaRecorder WebM seekable in desktop players.
 *
 * Chrome's MediaRecorder writes a live stream: the Segment and every Cluster have unknown
 * size, Info has no Duration and there are no Cues. Players then show no length and cannot
 * seek. Measured 2026-10-19 on a 1 h 03 min recording from the owner's Google Meet call:
 * 752 clusters ~5 s apart, all unknown-size, ffprobe duration N/A, MPC-HC could not seek.
 *
 * This rebuilds only the header — Segment with a known size, SeekHead, Info + Duration,
 * Tracks, Cues (one CuePoint per Cluster that holds a block) — and fills each Cluster's size
 * in place (Chrome writes it as an 8-byte unknown-size field, so offsets do not move). Audio
 * bytes are not re-encoded or reordered. The source Blob is read once, in windows, so a long
 * recording is never loaded into memory whole; the result is a Blob made of slices of the source.
 *
 * Only the shape Chrome writes is rewritten: one stream, one track, SimpleBlocks without
 * lacing. Anything else returns `changed: false` and the caller keeps the original bytes —
 * an unseekable file is better than a shorter one (P300-23b: a second EBML header, a Void
 * or Tags after a known-size cluster, a cluster without a timecode used to cut the output
 * short and still report success). The only bytes ever dropped are an element cut off by
 * the end of the file (a recording that stopped mid-write), reported as `droppedTailBytes`.
 *
 * Never let this block a download: callers fall back to the original Blob on any error.
 */

import { opusPacketSamples } from './ogg-opus.js';

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Info: 0x1549A966,
  Tracks: 0x1654AE6B, Cues: 0x1C53BB6B, Cluster: 0x1F43B675, Tags: 0x1254C367,
  Chapters: 0x1043A770, Attachments: 0x1941A469, Void: 0xEC,
  Duration: 0x4489, TimecodeScale: 0x2AD7B1, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0,
  TrackEntry: 0xAE, TrackNumber: 0xD7, CodecID: 0x86,
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

/** SimpleBlock head: track number (a VINT), signed 16-bit timecode, flags. */
async function blockHead(r, h) {
  const n = Math.min(h.size, HEADER_MAX);
  if (!r.has(h.data, n)) await r.load(h.data, n);
  const b = r.view(h.data, n);
  const tn = sizeAt(b, 0, b.length);
  if (!tn || tn.size == null || tn.len + 3 > b.length) return null;
  return { track: tn.size, rel: (b[tn.len] << 8 | b[tn.len + 1]) << 16 >> 16, flags: b[tn.len + 2], headLen: tn.len + 3 };
}

/** Children of a master element's payload, or null if one of them cannot be read. */
function children(b, start, end) {
  const out = [];
  for (let p = start; p < end;) {
    const i = idAt(b, p, end - p); const s = i && sizeAt(b, p + i.len, end - p - i.len);
    if (!i || !s || s.size == null || p + i.len + s.len + s.size > end) return null;
    out.push({ id: i.id, off: p, data: p + i.len + s.len, size: s.size, end: p + i.len + s.len + s.size });
    p += i.len + s.len + s.size;
  }
  return out;
}

// ── EBML writing ──
const idBytes = (id) => { const out = []; let v = id; while (v > 0) { out.unshift(v & 0xFF); v = Math.floor(v / 256); } return out; };
const size8 = (n) => { const out = [0x01]; for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xFF); return out; };
const uint8b = (n) => { const out = []; for (let i = 7; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xFF); return out; };
const uintMin = (n) => { const out = []; let v = n; do { out.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0); return out; };
/** A size field of exactly `len` bytes, or null when `n` does not fit (all ones means «unknown»). */
const sizeFixed = (n, len) => {
  if (n >= 2 ** (7 * len) - 1) return null;
  const out = []; let v = n; for (let i = 0; i < len; i++) { out.unshift(v % 256); v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
};
const el = (id, body) => [...idBytes(id), ...(body.length <= 126 ? [0x80 | body.length] : size8(body.length)), ...body];
const elFixed = (id, body) => [...idBytes(id), ...size8(body.length), ...body]; // size field always 8 bytes
const float64 = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return [...new Uint8Array(d.buffer)]; };

const SEEKHEAD_BYTES = 75; // 4 id + 8 size + 3 × Seek(21)

const keep = (blob, reason) => ({ blob, changed: false, reason });

/**
 * @param {Blob} blob   one MediaRecorder WebM stream (one EBML header)
 * @param {{windowBytes?: number}} [opts]
 * @returns {Promise<{blob: Blob, changed: boolean, reason?: string, clusters?: number, cues?: number,
 *                    durationMs?: number, patchedClusters?: number, droppedTailBytes?: number}>}
 */
export async function makeWebmSeekable(blob, { windowBytes = 8 << 20 } = {}) {
  const r = new BlobReader(blob, windowBytes);
  const ebml = await header(r, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size == null) return keep(blob, 'not an EBML file');
  const ebmlEnd = ebml.data + ebml.size;
  const seg = await header(r, ebmlEnd);
  if (!seg || seg.id !== ID.Segment) return keep(blob, 'no Segment');
  if (seg.size != null && seg.data + seg.size < blob.size) return keep(blob, 'data after the Segment');
  const segEnd = seg.size == null ? blob.size : Math.min(blob.size, seg.data + seg.size);
  const atEof = (p) => blob.size - p < HEADER_MAX; // a header that did not parse here was cut off

  let info = null, tracks = null, hasCues = false, hasDuration = false, timecodeScale = 1_000_000;
  let trackNumber = null, opus = false;
  const clusters = [];  // { off, sizeOff, sizeLen, unknown, declaredEnd, tc, first, end }
  let lastBlock = null, prevBlockTime = null; // { t, payloadOff, size }
  let off = seg.data, clustersEnd = null, truncated = false;

  while (off < segEnd) {
    const h = await header(r, off);
    if (!h) { if (atEof(off)) { truncated = true; break; } return keep(blob, `unreadable element at byte ${off}`); }
    if (h.id === ID.EBML) return keep(blob, 'a second EBML header (two streams)');
    if (h.id === ID.Cluster) {
      if (trackNumber == null) return keep(blob, 'a cluster before Tracks');
      const c = { off: h.off, sizeOff: h.sizeOff, sizeLen: h.sizeLen, unknown: h.size == null,
                  declaredEnd: h.size == null ? null : h.data + h.size, tc: null, first: null };
      const end = c.unknown ? segEnd : Math.min(segEnd, c.declaredEnd);
      let p = h.data;
      while (p < end) {
        const ch = await header(r, p);
        if (!ch) { if (atEof(p)) { truncated = true; break; } return keep(blob, `unreadable element in the cluster at byte ${h.off}`); }
        if (c.unknown && (LEVEL1.has(ch.id) || ch.id === ID.EBML)) break; // the next top-level element ends this cluster
        if (ch.size == null) return keep(blob, 'an unknown-size element inside a cluster');
        if (ch.data + ch.size > end) {
          if (end === blob.size) { truncated = true; break; }                // cut off by the end of the file
          return keep(blob, `an element runs past its cluster at byte ${ch.off}`);
        }
        if (ch.id === ID.Timecode) {
          if (c.tc != null || c.first != null) return keep(blob, 'a cluster timecode after its blocks');
          c.tc = uint(await payload(r, ch), 0, ch.size);
        } else if (ch.id === ID.SimpleBlock) {
          if (c.tc == null) return keep(blob, 'a block before its cluster timecode');
          const b = await blockHead(r, ch);
          if (!b || b.track !== trackNumber) return keep(blob, 'a block of another track');
          if (b.flags & 0x06) return keep(blob, 'laced blocks');
          const t = c.tc + b.rel;
          if (c.first == null) c.first = t;
          if (lastBlock) prevBlockTime = lastBlock.t;
          lastBlock = { t, payloadOff: ch.data + b.headLen, size: ch.size - b.headLen };
        } else if (ch.id === ID.BlockGroup) {
          return keep(blob, 'BlockGroup blocks');
        } // Void, CRC-32 and other children are copied as they are
        p = ch.data + ch.size;
      }
      if (c.tc == null) { if (truncated) break; return keep(blob, `a cluster without a timecode at byte ${h.off}`); }
      c.end = p;
      clusters.push(c);
      clustersEnd = p;
      if (truncated) break;
      off = p;
      continue;
    }
    if (h.size == null) return keep(blob, `an unknown-size element 0x${h.id.toString(16)} outside the clusters`);
    if (h.data + h.size > segEnd) {
      if (clusters.length && segEnd === blob.size) { truncated = true; break; }
      return keep(blob, `element 0x${h.id.toString(16)} runs past the end`);
    }
    if (clusters.length) {
      // Padding between clusters stays inside the copied range; anything else would be lost.
      if (h.id !== ID.Void) return keep(blob, `element 0x${h.id.toString(16)} after the clusters`);
    } else if (h.id === ID.Info) {
      info = await payload(r, h);
      const kids = children(info, 0, info.length);
      if (!kids) return keep(blob, 'unreadable Info');
      for (const k of kids) {
        if (k.id === ID.Duration) hasDuration = true;
        if (k.id === ID.TimecodeScale) timecodeScale = uint(info, k.data, k.size);
      }
      info = { bytes: info, kids };
    } else if (h.id === ID.Tracks) {
      if (!r.has(h.off, h.data - h.off + h.size)) await r.load(h.off, h.data - h.off + h.size);
      tracks = r.view(h.off, h.data - h.off + h.size).slice();
      const entries = (children(tracks, h.data - h.off, tracks.length) ?? []).filter((k) => k.id === ID.TrackEntry);
      if (entries.length !== 1) return keep(blob, `${entries.length} tracks`);
      const kids = children(tracks, entries[0].data, entries[0].end) ?? [];
      const tn = kids.find((k) => k.id === ID.TrackNumber), codec = kids.find((k) => k.id === ID.CodecID);
      if (!tn) return keep(blob, 'no TrackNumber');
      trackNumber = uint(tracks, tn.data, tn.size);
      opus = !!codec && String.fromCharCode(...tracks.subarray(codec.data, codec.data + codec.size)).replace(/\0+$/, '') === 'A_OPUS';
    } else if (h.id === ID.Cues) {
      hasCues = true;
    } else if (h.id === ID.Tags || h.id === ID.Chapters || h.id === ID.Attachments) {
      return keep(blob, `element 0x${h.id.toString(16)} this rewrite would drop`);
    } // an old SeekHead is rebuilt; Void and CRC-32 are not needed
    off = h.data + h.size;
  }

  if (!info || !tracks || !clusters.length) return keep(blob, 'no Info/Tracks/Cluster');
  if (!lastBlock) return keep(blob, 'no audio blocks');
  if (hasCues && hasDuration && seg.size != null && !clusters.some((c) => c.unknown)) return keep(blob, 'already seekable');

  // Duration = end of the last block: its time + its Opus packet length, or + the interval
  // before it for another codec (Chrome's PCM blocks are evenly spaced).
  let lastLen = 0;
  if (opus && lastBlock.size > 0) {
    const n = Math.min(lastBlock.size, 2);
    if (!r.has(lastBlock.payloadOff, n)) await r.load(lastBlock.payloadOff, n);
    const samples = opusPacketSamples(r.view(lastBlock.payloadOff, n));
    if (samples > 0 && samples <= 5760) lastLen = samples / 48000 * 1e9 / timecodeScale; // RFC 6716: ≤ 120 ms
  }
  if (!lastLen && prevBlockTime != null) lastLen = Math.max(0, lastBlock.t - prevBlockTime);
  const durationTicks = lastBlock.t + lastLen;
  if (!(durationTicks > 0)) return keep(blob, 'zero duration');

  // Info without any old Duration, plus ours.
  const infoBody = [];
  for (const k of info.kids) if (k.id !== ID.Duration) infoBody.push(...info.bytes.subarray(k.off, k.end));
  infoBody.push(...el(ID.Duration, float64(durationTicks)));
  const infoEl = elFixed(ID.Info, infoBody);

  const cued = clusters.filter((c) => c.first != null);
  const trackBytes = uintMin(trackNumber);
  const cuePointBytes = 26 + trackBytes.length; // 27 for track numbers up to 255
  const cuesLen = 12 + cued.length * cuePointBytes;
  const posInfo = SEEKHEAD_BYTES, posTracks = posInfo + infoEl.length, posCues = posTracks + tracks.length;
  const posClusters = posCues + cuesLen;
  const firstCluster = clusters[0].off;

  const seek = (id, pos) => el(0x4DBB, [...el(0x53AB, idBytes(id)), ...el(0x53AC, uint8b(pos))]);
  const seekHead = elFixed(ID.SeekHead, [...seek(ID.Info, posInfo), ...seek(ID.Tracks, posTracks), ...seek(ID.Cues, posCues)]);
  if (seekHead.length !== SEEKHEAD_BYTES) throw new Error(`SeekHead is ${seekHead.length} bytes, expected ${SEEKHEAD_BYTES}`);

  const cues = new Uint8Array(cuesLen);
  cues.set([...idBytes(ID.Cues), ...size8(cuesLen - 12)], 0);
  let q = 12;
  for (const c of cued) {
    // CueTime is the time of the first block the cue lands on (cluster time + its relative time).
    const cp = el(0xBB, [...el(0xB3, uint8b(Math.max(0, c.first))),
                         ...el(0xB7, [...el(0xF7, trackBytes), ...el(0xF1, uint8b(posClusters + (c.off - firstCluster)))])]);
    if (cp.length !== cuePointBytes) throw new Error(`CuePoint is ${cp.length} bytes, expected ${cuePointBytes}`);
    cues.set(cp, q); q += cp.length;
  }

  // Clusters: copy, filling each unknown size (and the size of one cut short) in place.
  const patches = [];
  for (const c of clusters) {
    if (!c.unknown && c.declaredEnd === c.end) continue;
    const field = sizeFixed(c.end - (c.sizeOff + c.sizeLen), c.sizeLen);
    if (!field) return keep(blob, `cluster size does not fit its ${c.sizeLen}-byte field`);
    patches.push([c, field]);
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

  const parts = [pre, cues];
  let from = firstCluster;
  for (const [c, field] of patches) {
    parts.push(blob.slice(from, c.sizeOff), new Uint8Array(field));
    from = c.sizeOff + c.sizeLen;
  }
  parts.push(blob.slice(from, clustersEnd));
  const out = new Blob(parts, { type: blob.type || 'audio/webm' });
  return { blob: out, changed: true, clusters: clusters.length, cues: cued.length, patchedClusters: patches.length,
           durationMs: durationTicks * timecodeScale / 1e6, droppedTailBytes: blob.size - clustersEnd };
}
