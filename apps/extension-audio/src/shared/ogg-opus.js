/**
 * ogg-opus.js — a minimal, dependency-free Ogg muxer and demuxer for Opus.
 *
 * WHY WRITE THIS INSTEAD OF TAKING A LIBRARY (ADR-002 has the full reasoning)
 * ---------------------------------------------------------------------------
 * Ogg is a 27-byte page header, a segment table, a CRC-32 and the packets.
 * Opus-in-Ogg (RFC 7845) adds two header packets. The whole format fits in a
 * few hundred lines and never changes. A dependency would bring a build step
 * (ADR-001 has none), a licence to track and an abandonment risk — for code
 * that is smaller than the dependency's README.
 *
 * WHAT THE MUXER GUARANTEES
 *   - Every page is self-delimiting ("OggS" capture pattern + CRC), so a reader
 *     can resynchronise after any truncation point and loses at most the last
 *     partial page. That is the property ADR-004 wants to measure, not assume.
 *   - Granule positions are absolute 48 kHz sample counts (RFC 7845 §4),
 *     independent of the encoder's input rate, plus the pre-skip from OpusHead.
 *   - `flushPage()` emits whatever packets are buffered as one page, so the
 *     caller decides the durability granularity (I1: one page per ~1 s).
 *
 * WHAT IT DOES NOT DO
 *   - No seeking index (Ogg has none; players scan).
 *   - No packet spanning across pages beyond what the segment table needs
 *     (packets > 255 bytes are lacing-split; packets > 65 025 bytes would span
 *     pages — Opus at ≤ 510 kbps with 60 ms frames stays far below).
 *
 * The demuxer exists for validation: it walks pages, checks CRCs, reassembles
 * packets and reports where a file stops being readable. It feeds
 * EncodedAudioChunk objects to an AudioDecoder for an end-to-end decode test
 * that counts samples instead of trusting a duration field.
 */

// ─────────────────────────────────────────────────────── CRC-32 (Ogg) ──
// Ogg uses polynomial 0x04c11db7, no reflection, no initial value, no final XOR.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc32(bytes, crc = 0) {
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

const OGGS = [0x4f, 0x67, 0x67, 0x53];
const OPUS_RATE = 48000;

// ───────────────────────────────────────────────────────── header packets ──

/**
 * OpusHead (RFC 7845 §5.1). `preSkip` is the encoder's algorithmic delay in
 * 48 kHz samples — Chrome's AudioEncoder reports it through
 * decoderConfig.description (measured 2026-09-07: 312 samples). `inputSampleRate`
 * is informational: the original rate before the encoder's internal resampler.
 */
export function buildOpusHead({ channels = 1, preSkip = 312, inputSampleRate = 48000, outputGain = 0 } = {}) {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  b[8] = 1;                       // version
  b[9] = channels;                // channel count
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputSampleRate, true);
  dv.setInt16(16, outputGain, true);
  b[18] = 0;                      // channel mapping family 0 (mono/stereo)
  return b;
}

export function parseOpusHead(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const magic = String.fromCharCode(...b.subarray(0, 8));
  if (magic !== 'OpusHead') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    version: b[8], channels: b[9], preSkip: dv.getUint16(10, true),
    inputSampleRate: dv.getUint32(12, true), outputGain: dv.getInt16(16, true), mappingFamily: b[18],
  };
}

/** OpusTags (RFC 7845 §5.2). Vendor string + key=value comments. */
export function buildOpusTags(vendor = 'IronMemo Recorder', comments = []) {
  const enc = new TextEncoder();
  const v = enc.encode(vendor);
  const cs = comments.map((c) => enc.encode(c));
  const len = 8 + 4 + v.length + 4 + cs.reduce((a, c) => a + 4 + c.length, 0);
  const b = new Uint8Array(len);
  const dv = new DataView(b.buffer);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  let o = 8;
  dv.setUint32(o, v.length, true); o += 4; b.set(v, o); o += v.length;
  dv.setUint32(o, cs.length, true); o += 4;
  for (const c of cs) { dv.setUint32(o, c.length, true); o += 4; b.set(c, o); o += c.length; }
  return b;
}

// ─────────────────────────────────────────────────────────────── muxer ──

export class OggOpusMuxer {
  /**
   * @param {object} o
   * @param {number} o.channels
   * @param {number} o.preSkip        48 kHz samples, from OpusHead
   * @param {number} o.inputSampleRate
   * @param {Uint8Array|null} o.opusHead  verbatim header from the encoder, if any
   * @param {string[]} o.comments      OpusTags key=value lines (manifest pointers)
   * @param {number} o.serial          Ogg bitstream serial (random 32-bit)
   */
  constructor({ channels = 1, preSkip = 312, inputSampleRate = 48000, opusHead = null,
                comments = [], serial = (Math.random() * 0xffffffff) >>> 0 } = {}) {
    this.serial = serial;
    this.pageSeq = 0;
    // 48 kHz samples encoded so far. RFC 7845 §4: granulepos counts decoded samples
    // INCLUDING the pre-skip ones at the start; players subtract pre-skip themselves.
    // (First version added preSkip on top — measured 2026-09-07: ffmpeg and
    // AudioDecoder both returned granule − preSkip samples, i.e. 312 fewer than
    // the file claimed. Fixed; see smoke-mic/summary.json.)
    this.granule = 0;
    this.preSkip = preSkip;
    this.pending = [];       // packets buffered for the next page
    this.pendingBytes = 0;
    this.pendingSamples = 0; // 48 kHz samples queued but not yet in a page (position = granule + pendingSamples)
    this.packets = 0;
    this.bytesOut = 0;
    this.headersDone = false;
    this.opusHead = opusHead ?? buildOpusHead({ channels, preSkip, inputSampleRate });
    this.opusTags = buildOpusTags('IronMemo Recorder (WebCodecs AudioEncoder, Chrome)', comments);
  }

  /** Header pages: OpusHead alone on the BOS page, OpusTags on its own page. */
  headerPages() {
    this.headersDone = true;
    const p1 = this._page([this.opusHead], { bos: true, granule: 0 });
    const p2 = this._page([this.opusTags], { granule: 0 });
    return [p1, p2];
  }

  /**
   * Queue one Opus packet. `samples48k` = packet duration in 48 kHz samples
   * (960 for 20 ms). Returns nothing; call flushPage() to get bytes.
   */
  addPacket(bytes, samples48k) {
    if (!this.headersDone) throw new Error('headerPages() first');
    this.pending.push({ bytes, samples48k });
    this.pendingBytes += bytes.length;
    this.pendingSamples += samples48k;
    this.packets++;
  }

  /** Emit buffered packets as one page (or null if nothing pending). */
  flushPage({ eos = false } = {}) {
    if (!this.pending.length) {
      if (!eos) return null;
      // EOS with nothing pending: an empty page carrying the final granule.
      return this._page([], { eos: true, granule: this.granule });
    }
    // Split if the segment table would overflow (255 lacing values per page).
    const pages = [];
    let batch = [], lacing = 0;
    for (const p of this.pending) {
      const need = Math.floor(p.bytes.length / 255) + 1;
      if (lacing + need > 255) { pages.push(batch); batch = []; lacing = 0; }
      batch.push(p); lacing += need;
    }
    if (batch.length) pages.push(batch);
    this.pending = []; this.pendingBytes = 0; this.pendingSamples = 0;

    const out = [];
    pages.forEach((batch, i) => {
      for (const p of batch) this.granule += p.samples48k;
      const last = i === pages.length - 1;
      out.push(this._page(batch.map((p) => p.bytes), { eos: eos && last, granule: this.granule }));
    });
    return out.length === 1 ? out[0] : concat(out);
  }

  _page(packets, { bos = false, eos = false, granule = 0 } = {}) {
    const lacing = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) { lacing.push(255); n -= 255; }
      lacing.push(n);
    }
    if (lacing.length > 255) throw new Error('too many segments for one page');
    const body = packets.reduce((a, p) => a + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + body);
    const dv = new DataView(page.buffer);
    page.set(OGGS, 0);
    page[4] = 0;                                   // stream structure version
    page[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0); // header type (no continuation)
    dv.setBigUint64(6, BigInt(granule), true);
    dv.setUint32(14, this.serial, true);
    dv.setUint32(18, this.pageSeq++, true);
    dv.setUint32(22, 0, true);                     // CRC placeholder
    page[26] = lacing.length;
    page.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of packets) { page.set(p, o); o += p.length; }
    dv.setUint32(22, oggCrc32(page), true);
    this.bytesOut += page.length;
    return page;
  }
}

function concat(arrays) {
  const len = arrays.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

// ─────────────────────────────────────────────────────────────── demuxer ──

/**
 * Walk an Ogg byte buffer page by page. Tolerates truncation: stops at the
 * first page whose header or body runs past the end, or whose CRC mismatches,
 * and reports where and why. Returns packets (with granule of the page they
 * end on) so the caller can decode them.
 */
export function demuxOggOpus(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = { pages: 0, packets: [], opusHead: null, opusTags: null, lastGranule: 0,
                bytesConsumed: 0, stoppedBecause: null, crcErrors: 0, gaps: [], serial: null };
  let off = 0, carry = null, expectSeq = null;
  while (off + 27 <= b.length) {
    if (!(b[off] === 0x4f && b[off + 1] === 0x67 && b[off + 2] === 0x67 && b[off + 3] === 0x53)) {
      // Resync: scan for the next capture pattern.
      const next = findOggS(b, off + 1);
      out.gaps.push({ at: off, skipped: next < 0 ? b.length - off : next - off });
      if (next < 0) { out.stoppedBecause = 'no further OggS'; break; }
      off = next; carry = null; continue;
    }
    const nseg = b[off + 26];
    const hdrLen = 27 + nseg;
    if (off + hdrLen > b.length) { out.stoppedBecause = 'truncated segment table'; break; }
    let body = 0;
    for (let i = 0; i < nseg; i++) body += b[off + 27 + i];
    if (off + hdrLen + body > b.length) { out.stoppedBecause = 'truncated page body'; break; }

    const page = b.subarray(off, off + hdrLen + body);
    const crcStored = dv.getUint32(off + 22, true);
    const copy = new Uint8Array(page); copy[22] = copy[23] = copy[24] = copy[25] = 0;
    if (oggCrc32(copy) !== crcStored) {
      out.crcErrors++;
      out.stoppedBecause = `crc mismatch at page ${out.pages}`;
      break;
    }
    const flags = b[off + 5];
    const granule = Number(dv.getBigUint64(off + 6, true));
    const serial = dv.getUint32(off + 14, true);
    const seq = dv.getUint32(off + 18, true);
    out.serial ??= serial;
    if (expectSeq !== null && seq !== expectSeq) out.gaps.push({ at: off, seqExpected: expectSeq, seqGot: seq });
    expectSeq = seq + 1;

    // Reassemble packets from lacing values.
    let p = off + hdrLen;
    let cur = (flags & 0x01) && carry ? carry : [];
    for (let i = 0; i < nseg; i++) {
      const l = b[off + 27 + i];
      cur.push(b.subarray(p, p + l)); p += l;
      if (l < 255) {
        const pkt = cur.length === 1 ? cur[0] : concat(cur);
        cur = [];
        if (!out.opusHead) out.opusHead = parseOpusHead(pkt);
        else if (!out.opusTags) out.opusTags = { bytes: pkt.length };
        else out.packets.push({ data: pkt, pageGranule: granule, page: out.pages });
      }
    }
    carry = cur.length ? cur : null;
    if (granule !== -1 && granule > out.lastGranule) out.lastGranule = granule;
    out.pages++;
    off += hdrLen + body;
    out.bytesConsumed = off;
    if (flags & 0x04) { out.stoppedBecause = 'eos'; break; }
  }
  if (!out.stoppedBecause) out.stoppedBecause = off >= b.length ? 'end of data (no eos flag)' : 'trailing bytes < header';
  return out;
}

function findOggS(b, from) {
  for (let i = from; i + 3 < b.length; i++) {
    if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) return i;
  }
  return -1;
}

/**
 * A silence filler: the TOC of a real packet with code 0 and NO frame data
 * (RFC 6716 §3.2.2: zero-length frame = "lost frame", the decoder runs packet
 * loss concealment → near-silence). Measured 2026-09-07 with ffmpeg 9.0: 100 such
 * packets decoded as 100 × 20 ms with peak 78/32767. One byte per 20 ms = 0.4 kbps.
 * Used to keep the Ogg timeline on the wall clock across Opus DTX gaps (the encoder
 * emits nothing for ~400 ms at a time) and dropped input.
 */
export function silenceFillerFor(packet) {
  return new Uint8Array([packet[0] & 0xfc]);
}

/**
 * Duration of one Opus packet in 48 kHz samples, from its TOC byte
 * (RFC 6716 §3.1). Needed when a page carries several packets and the
 * granule tells only where the last one ends.
 */
export function opusPacketSamples(pkt) {
  if (!pkt.length) return 0;
  const toc = pkt[0];
  const config = toc >> 3;
  const code = toc & 0x03;
  let frameSamples;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 0x03];       // SILK NB/MB/WB: 10/20/40/60 ms
  else if (config < 16) frameSamples = [480, 960][config & 0x01];              // Hybrid: 10/20 ms
  else frameSamples = [120, 240, 480, 960][config & 0x03];                     // CELT: 2.5/5/10/20 ms
  let frames;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else frames = pkt.length > 1 ? (pkt[1] & 0x3f) : 0;
  return frameSamples * frames;
}

/**
 * Decode every packet through WebCodecs AudioDecoder and count output frames.
 * The number that matters for "decodes end to end": decodedFrames vs the
 * granule-derived expectation. Runs in any context that has AudioDecoder.
 */
export async function decodeOggOpusFully(buf, { onProgress = null } = {}) {
  const d = demuxOggOpus(buf);
  const res = { demux: { pages: d.pages, packets: d.packets.length, bytesConsumed: d.bytesConsumed,
                         stoppedBecause: d.stoppedBecause, crcErrors: d.crcErrors, gaps: d.gaps.length,
                         opusHead: d.opusHead, lastGranule: d.lastGranule },
                // playable samples = last granulepos − pre-skip (RFC 7845 §4.1)
                expectedSamples: d.opusHead ? Math.max(0, d.lastGranule - d.opusHead.preSkip) : null,
                decodedFrames: 0, decodedSampleRate: null, decodeError: null, ok: false };
  if (!d.opusHead || !d.packets.length) { res.decodeError = 'no OpusHead or no packets'; return res; }
  if (typeof AudioDecoder === 'undefined') { res.decodeError = 'AudioDecoder unavailable'; return res; }

  const head = buildOpusHead(d.opusHead);
  const config = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: d.opusHead.channels, description: head };
  const sup = await AudioDecoder.isConfigSupported(config);
  if (!sup.supported) { res.decodeError = 'AudioDecoder.isConfigSupported=false'; return res; }

  let frames = 0, err = null, rate = null;
  const dec = new AudioDecoder({
    output: (ad) => { frames += ad.numberOfFrames; rate ??= ad.sampleRate; ad.close(); },
    error: (e) => { err = String(e?.message ?? e); },
  });
  dec.configure(config);
  let ts = 0;
  // No intermediate flush(): measured 2026-09-07 (smoke-wc) — after every flush the
  // decoder treats the next chunk as a stream start and trims pre-skip (312 samples)
  // again, so the count came out 312 short per flush. Backpressure via decodeQueueSize.
  for (let i = 0; i < d.packets.length; i++) {
    const p = d.packets[i];
    const n = opusPacketSamples(p.data);
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts / OPUS_RATE * 1e6), data: p.data }));
    ts += n;
    if (dec.decodeQueueSize > 400) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
    if (i % 5000 === 4999) onProgress?.(i + 1, d.packets.length);
    if (err) break;
  }
  try { await dec.flush(); } catch (e) { err ??= String(e?.message ?? e); }
  dec.close();
  res.decodedFrames = frames;
  res.decodedSampleRate = rate;
  res.decodeError = err;
  // Decoder output includes pre-skip samples; allow one packet of slack.
  res.ok = !err && res.expectedSamples !== null && frames >= res.expectedSamples;
  res.packetSamplesSum = ts;
  return res;
}
