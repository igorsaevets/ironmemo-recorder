/**
 * webm-demux.js — the smallest EBML walker that gets Opus packets out of what Chrome's
 * MediaRecorder writes, truncated or not.
 *
 * WHY THIS EXISTS (ADR-004)
 * -------------------------
 * The MediaStream Recording spec promises a playable result only for the COMPLETE set of
 * blobs of a FINISHED recording. What a crash leaves behind is neither: a byte string cut
 * at an arbitrary point, with live-mode (unknown-size) Segment and Clusters, no Duration,
 * no Cues — and, for rolling_finalized, several such strings each starting with its own
 * EBML header. ffmpeg reads such a string up to the last complete SimpleBlock (measured
 * 2026-09-07, I1 truncation test), but "ffmpeg copes" is not a file format. Recovery pulls
 * the Opus packets out and hands them to our own Ogg muxer, which knows where every packet
 * sits on the timeline.
 *
 * WHAT IT READS
 *   EBML header (0x1A45DFA3) — skipped; a SECOND header inside one buffer means two
 *     concatenated recordings: the walk stops there and reports `secondHeaderAt`.
 *   Segment (0x18538067) / Cluster (0x1F43B675) — descended into (unknown size allowed).
 *   Tracks → TrackEntry → CodecID (0x86), CodecPrivate (0x63A2, = OpusHead), TrackNumber (0xD7),
 *     Audio → SamplingFrequency (0xB5), Channels (0x9F).
 *   Info → TimecodeScale (0x2AD7B1, default 1 000 000 ns = 1 ms).
 *   Cluster Timecode (0xE7), SimpleBlock (0xA3), BlockGroup (0xA0) → Block (0xA1).
 * Everything else is skipped by size. A truncated element (size runs past the end) ends
 * the walk with `stoppedBecause: 'truncated'`; nothing after it is trusted.
 *
 * WHAT IT DOES NOT DO: lacing (Chrome does not lace Opus), multiple tracks (we record one
 * per file), EBML CRC/Void semantics, seeking. It is a validator's demuxer, not a player's.
 */

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, Cluster: 0x1F43B675, Info: 0x1549A966, TimecodeScale: 0x2AD7B1,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, CodecID: 0x86, CodecPrivate: 0x63A2,
  Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
  Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, Duration: 0x4489, Cues: 0x1C53BB6B,
};
const DESCEND = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Info, ID.BlockGroup]);

/** EBML element id: 1–4 bytes, marker bits kept (that is how ids are quoted). */
function readId(b, off) {
  const first = b[off];
  let len = 1, mask = 0x80;
  while (len <= 4 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 4 || off + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = (v * 256) + b[off + i];
  return { id: v, len };
}

/** EBML size vint: marker bits stripped; all-ones = unknown size. */
function readSize(b, off) {
  if (off >= b.length) return null;
  const first = b[off];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8 || off + len > b.length) return null;
  let v = first & (mask - 1);
  let allOnes = v === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[off + i]; if (b[off + i] !== 0xff) allOnes = false; }
  return { size: v, len, unknown: allOnes };
}

function readUint(b, off, len) { let v = 0; for (let i = 0; i < len; i++) v = v * 256 + b[off + i]; return v; }
function readFloat(b, off, len) {
  const dv = new DataView(b.buffer, b.byteOffset + off, len);
  return len === 4 ? dv.getFloat32(0) : len === 8 ? dv.getFloat64(0) : null;
}

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{blocks: Array<{timeMs:number, data:Uint8Array, keyframe:boolean, cluster:number}>,
 *            codecPrivate: Uint8Array|null, codecId: string|null, trackNumber: number|null,
 *            sampleRate: number|null, channels: number|null, timecodeScale: number,
 *            duration: number|null, clusters: number, bytesConsumed: number, headers: number,
 *            secondHeaderAt: number|null, stoppedBecause: string, hasCues: boolean}}
 */
export function demuxWebmOpus(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const out = { blocks: [], codecPrivate: null, codecId: null, trackNumber: null, sampleRate: null, channels: null,
                timecodeScale: 1_000_000, duration: null, clusters: 0, bytesConsumed: 0, headers: 0, secondHeaderAt: null,
                stoppedBecause: 'end', hasCues: false, elements: 0 };
  let off = 0, clusterTc = 0;
  // Stack of [endOffset] for known-size masters so that we know when a Cluster ends; unknown-size
  // masters (what MediaRecorder writes) simply end when the next sibling id appears.
  while (off < b.length) {
    const idr = readId(b, off);
    if (!idr) { out.stoppedBecause = 'truncated id'; break; }
    const szr = readSize(b, off + idr.len);
    if (!szr) { out.stoppedBecause = 'truncated size'; break; }
    const hdr = off + idr.len + szr.len;
    const id = idr.id;
    out.elements++;
    if (id === ID.EBML) {
      out.headers++;
      if (out.headers > 1) { out.secondHeaderAt = off; out.stoppedBecause = 'second EBML header'; break; }
      if (szr.unknown || hdr + szr.size > b.length) { out.stoppedBecause = 'truncated EBML header'; break; }
      off = hdr + szr.size; out.bytesConsumed = off; continue;
    }
    if (DESCEND.has(id) || szr.unknown) {
      if (id === ID.Cluster) out.clusters++;
      off = hdr; out.bytesConsumed = off;   // enter the master; children follow
      continue;
    }
    if (hdr + szr.size > b.length) { out.stoppedBecause = 'truncated'; break; }
    const payload = b.subarray(hdr, hdr + szr.size);
    switch (id) {
      case ID.TimecodeScale: out.timecodeScale = readUint(payload, 0, payload.length); break;
      case ID.Duration: out.duration = readFloat(payload, 0, payload.length); break;
      case ID.TrackNumber: out.trackNumber ??= readUint(payload, 0, payload.length); break;
      case ID.CodecID: out.codecId ??= new TextDecoder().decode(payload); break;
      case ID.CodecPrivate: out.codecPrivate ??= new Uint8Array(payload); break;
      case ID.SamplingFrequency: out.sampleRate ??= readFloat(payload, 0, payload.length); break;
      case ID.Channels: out.channels ??= readUint(payload, 0, payload.length); break;
      case ID.Timecode: clusterTc = readUint(payload, 0, payload.length); break;
      case ID.Cues: out.hasCues = true; break;
      case ID.SimpleBlock:
      case ID.Block: {
        // track number (vint), int16 relative timecode, flags, then the frame (no lacing).
        const tn = readSize(payload, 0);
        if (!tn || tn.len + 3 > payload.length) break;
        const rel = new DataView(payload.buffer, payload.byteOffset + tn.len, 2).getInt16(0);
        const flags = payload[tn.len + 2];
        const lacing = (flags >> 1) & 0x03;
        if (lacing !== 0) { out.lacedBlocks = (out.lacedBlocks ?? 0) + 1; break; }
        const data = payload.subarray(tn.len + 3);
        const timeMs = (clusterTc + rel) * out.timecodeScale / 1_000_000;
        out.blocks.push({ timeMs, data, keyframe: !!(flags & 0x80), cluster: out.clusters, track: tn.size });
        break;
      }
      default: break;
    }
    off = hdr + szr.size; out.bytesConsumed = off;
  }
  return out;
}

/** Sum of Opus packet durations in a demux result, in 48 kHz samples (needs opusPacketSamples). */
export function blocksDurationSamples(blocks, opusPacketSamples) {
  let n = 0;
  for (const blk of blocks) n += opusPacketSamples(blk.data);
  return n;
}
