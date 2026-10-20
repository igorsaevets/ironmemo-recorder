// Synthetic WebM inputs for src/shared/webm-seekable.js (P300-23b): every input shape the P300-23
// reviewers named, the outcome it must have, and a structural check of every rewritten file
// (Segment size, SeekHead and Cue targets, known cluster sizes, blocks kept, Duration).
//   node tests/webm_seekable_cases.mjs [real-chrome-recording.webm ...]   → RESULTS <json> + VERDICT: OK | FAIL
// A real MediaRecorder file passed as an argument must be rewritten; its rewrite fed back must be left alone.
import { openAsBlob } from 'node:fs';
import { makeWebmSeekable } from '../apps/extension-audio/src/shared/webm-seekable.js';

// ── building inputs ──
const idB = (id) => { const o = []; let v = id; while (v > 0) { o.unshift(v & 255); v = Math.floor(v / 256); } return o; };
const vint = (n) => {
  for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) {
    const o = []; let v = n; for (let i = 0; i < len; i++) { o.unshift(v % 256); v = Math.floor(v / 256); }
    o[0] |= 0x80 >> (len - 1); return o;
  }
  throw new Error('too big');
};
const uN = (n, len) => { const o = []; let v = n; for (let i = 0; i < len; i++) { o.unshift(v % 256); v = Math.floor(v / 256); } return o; };
const u = (n) => { const o = []; let v = n; do { o.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0); return o; };
const str = (s) => [...s].map((c) => c.charCodeAt(0));
const UNKNOWN8 = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
const E = (id, body, size) => [...idB(id), ...(size ?? vint(body.length)), ...body];

const EBML = E(0x1A45DFA3, [...E(0x4282, str('webm')), ...E(0x4287, u(4)), ...E(0x4285, u(2))]);
const info = () => E(0x1549A966, [...E(0x2AD7B1, u(1_000_000)), ...E(0x4D80, str('test'))]);
const tracks = (tn = 1, codec = 'A_OPUS', entries = 1) => E(0x1654AE6B, Array.from({ length: entries }, (_, i) =>
  E(0xAE, [...E(0xD7, u(tn + i)), ...E(0x73C5, u(1 + i)), ...E(0x83, u(2)), ...E(0x86, str(codec))])).flat());
// a 20 ms Opus packet: TOC 0xF8 = CELT fullband 20 ms, mono, one frame
const block = (tn, rel, flags = 0x80, pkt = [0xF8, 1, 2, 3]) => E(0xA3, [...vint(tn), ...uN(rel & 0xFFFF, 2), flags, ...pkt]);
const run20 = (tn, n, start = 0) => Array.from({ length: n }, (_, i) => block(tn, start + i * 20));
const cluster = (tc, blocks, { known = false, size, noTimecode = false } = {}) => {
  const body = [...(noTimecode ? [] : E(0xE7, u(tc))), ...blocks.flat()];
  return E(0x1F43B675, body, size ?? (known ? vint(body.length) : UNKNOWN8));
};
const file = (kids, segSize) => [...EBML, ...E(0x18538067, kids.flat(), segSize ?? UNKNOWN8)];
const head = () => [info(), tracks()];

// ── checking outputs ──
const rd = (b, o) => {
  const f = b[o]; const il = f & 0x80 ? 1 : f & 0x40 ? 2 : f & 0x20 ? 3 : f & 0x10 ? 4 : 0;
  if (!il || o + il >= b.length) return null;
  let id = 0; for (let i = 0; i < il; i++) id = id * 256 + b[o + i];
  const s0 = b[o + il]; let sl = 0; for (let i = 0; i < 8; i++) if (s0 & (0x80 >> i)) { sl = i + 1; break; }
  if (!sl) return null;
  let v = s0 & (0xFF >> sl), ones = v === (0xFF >> sl);
  for (let i = 1; i < sl; i++) { v = v * 256 + b[o + il + i]; if (b[o + il + i] !== 0xFF) ones = false; }
  return { id, data: o + il + sl, size: ones ? null : v };
};
const num = (b, o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; };
const kids = (b, s, e) => {
  const out = [];
  for (let p = s; p < e;) { const h = rd(b, p); if (!h || h.size == null || h.data + h.size > e) return null; out.push({ ...h, off: p, end: h.data + h.size }); p = h.data + h.size; }
  return out;
};

function verify(buf) {
  const issues = [];
  const eb = rd(buf, 0), sg = rd(buf, eb.data + eb.size);
  if (sg.size == null) return { issues: ['Segment size unknown'] };
  if (sg.data + sg.size !== buf.length) issues.push(`Segment ends at ${sg.data + sg.size}, the file at ${buf.length}`);
  const top = kids(buf, sg.data, buf.length);
  if (!top) return { issues: ['a top-level element of unknown size or past the end'] };
  const clusterAt = new Set(); const cues = [], seeks = [];
  let blocks = 0, duration = null, scale = 1e6, clusters = 0;
  for (const t of top) {
    if (t.id === 0x1F43B675) {
      const ks = kids(buf, t.data, t.end);
      if (!ks) { issues.push(`cluster at ${t.off} has a child of unknown size or past its end`); continue; }
      clusterAt.add(t.off - sg.data); clusters++; blocks += ks.filter((k) => k.id === 0xA3).length;
    } else if (t.id === 0x1549A966) {
      for (const k of kids(buf, t.data, t.end)) {
        if (k.id === 0x4489) duration = new DataView(buf.buffer, buf.byteOffset + k.data, 8).getFloat64(0);
        if (k.id === 0x2AD7B1) scale = num(buf, k.data, k.size);
      }
    } else if (t.id === 0x1C53BB6B) {
      for (const cp of kids(buf, t.data, t.end)) {
        const c = {};
        for (const k of kids(buf, cp.data, cp.end)) {
          if (k.id === 0xB3) c.time = num(buf, k.data, k.size);
          if (k.id === 0xB7) for (const kk of kids(buf, k.data, k.end)) {
            if (kk.id === 0xF7) c.track = num(buf, kk.data, kk.size);
            if (kk.id === 0xF1) c.pos = num(buf, kk.data, kk.size);
          }
        }
        cues.push(c);
      }
    } else if (t.id === 0x114D9B74) {
      for (const s of kids(buf, t.data, t.end)) { const [a, b] = kids(buf, s.data, s.end); seeks.push({ id: num(buf, a.data, a.size), pos: num(buf, b.data, b.size) }); }
    }
  }
  for (const s of seeks) { const h = rd(buf, sg.data + s.pos); if (!h || h.id !== s.id) issues.push(`SeekHead entry 0x${s.id.toString(16)} misses its element`); }
  for (const c of cues) if (!clusterAt.has(c.pos)) issues.push(`cue at ${c.pos} misses a cluster`);
  if (!(duration > 0)) issues.push(`Duration ${duration}`);
  return { issues, clusters, blocks, cues: cues.length, cueTimes: cues.map((c) => c.time), cueTracks: [...new Set(cues.map((c) => c.track))],
           durationMs: duration == null ? null : duration * scale / 1e6 };
}

// ── cases ──
const results = [];
async function run(name, input, expect = {}) {
  const blob = input instanceof Blob ? input : new Blob([new Uint8Array(input)], { type: 'audio/webm' });
  let ok = false, detail = '', res = null;
  try {
    res = await makeWebmSeekable(blob, { windowBytes: expect.windowBytes ?? 8 << 20 });
    if (expect.keep) {
      ok = !res.changed && res.blob === blob && expect.keep.test(res.reason ?? '');
      detail = `changed=${res.changed} reason=${res.reason}`;
    } else {
      const v = verify(new Uint8Array(await res.blob.arrayBuffer()));
      const probs = [...v.issues];
      if (!res.changed) probs.push(`not rewritten: ${res.reason}`);
      for (const [k, want] of Object.entries(expect.want ?? {})) {
        const got = k in v ? v[k] : res[k];
        const good = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
        if (!good) probs.push(`${k}=${JSON.stringify(got)}, want ${typeof want === 'function' ? want : JSON.stringify(want)}`);
      }
      ok = !probs.length;
      detail = ok ? `${v.clusters} clusters, ${v.cues} cues, ${v.blocks} blocks, ${res.durationMs} ms, dropped ${res.droppedTailBytes} B`
                  : probs.join('; ');
    }
  } catch (e) { detail = `threw: ${e?.message ?? e}`; }
  results.push({ case: name, ok, detail });
  return res;
}

const baseline = file([...head(), cluster(0, run20(1, 5)), cluster(100, run20(1, 5)), cluster(200, run20(1, 5))]);
const base = await run('baseline: 3 unknown-size clusters', baseline,
  { want: { clusters: 3, cues: 3, blocks: 15, durationMs: 300, cueTimes: [0, 100, 200], patchedClusters: 3, droppedTailBytes: 0 } });
const tiny = await makeWebmSeekable(new Blob([new Uint8Array(baseline)]), { windowBytes: 16 });
const same = base && Buffer.from(await tiny.blob.arrayBuffer()).equals(Buffer.from(await base.blob.arrayBuffer()));
results.push({ case: 'a 16-byte read window writes the same bytes', ok: !!same, detail: String(same) });
if (base) await run('its own output is left alone', base.blob, { keep: /already seekable/ });

await run('two streams concatenated → kept', [...baseline, ...baseline], { keep: /second EBML/ });
await run('data after a known-size Segment → kept', [...file(head().concat([cluster(0, run20(1, 5))]), vint(head().flat().length + cluster(0, run20(1, 5)).length)), ...baseline], { keep: /after the Segment/ });
await run('Void between known-size clusters keeps both', file([...head(), cluster(0, run20(1, 5), { known: true }), E(0xEC, [0, 0, 0]),
  cluster(100, run20(1, 5), { known: true })]), { want: { clusters: 2, blocks: 10, durationMs: 200, patchedClusters: 0 } });
await run('Tags after the clusters → kept', file([...head(), cluster(0, run20(1, 5)), E(0x1254C367, E(0x7373, []))]), { keep: /after the clusters/ });
await run('Tags before the clusters → kept', file([...head(), E(0x1254C367, E(0x7373, [])), cluster(0, run20(1, 5))]), { keep: /would drop/ });
await run('a cluster without a timecode → kept', file([...head(), cluster(0, run20(1, 5)), cluster(100, run20(1, 5), { noTimecode: true }),
  cluster(200, run20(1, 5))]), { keep: /timecode/ });
await run('garbage between clusters → kept', file([...head(), cluster(0, run20(1, 5)), Array(20).fill(0), cluster(100, run20(1, 5))]), { keep: /unreadable/ });
await run('cut mid-block: only the partial block goes', baseline.slice(0, -3),
  { want: { blocks: 14, durationMs: 280, droppedTailBytes: (n) => n > 0 && n < 10 } });
const known = file([...head(), cluster(0, run20(1, 5), { known: true }), cluster(100, run20(1, 5), { known: true })]);
await run('cut inside a known-size cluster: its size is rewritten', known.slice(0, -3),
  { want: { clusters: 2, blocks: 9, durationMs: 180, patchedClusters: 1 } });
await run('cut right after a cluster header', [...baseline, ...idB(0x1F43B675), 0x01, 0xFF],
  { want: { clusters: 3, blocks: 15, durationMs: 300 } });
await run('TrackNumber 256 → CueTrack 256', file([info(), tracks(256), cluster(0, run20(256, 5)), cluster(100, run20(256, 5))]),
  { want: { cueTracks: [256], cues: 2, blocks: 10 } });
await run('laced blocks → kept', file([...head(), cluster(0, [block(1, 0, 0x82), block(1, 40, 0x82)])]), { keep: /laced/ });
await run('BlockGroup → kept', file([...head(), cluster(0, [E(0xA0, E(0xA1, [0x81, 0, 0, 0, 0xF8, 1]))])]), { keep: /BlockGroup/ });
await run('a block of another track → kept', file([...head(), cluster(0, [block(1, 0), block(2, 20)])]), { keep: /another track/ });
await run('two tracks → kept', file([info(), tracks(1, 'A_OPUS', 2), cluster(0, run20(1, 5))]), { keep: /2 tracks/ });
await run('first block before its cluster time → CueTime of that block', file([...head(), cluster(0, run20(1, 5)), cluster(100, [block(1, -10), block(1, 10)])]),
  { want: { cueTimes: [0, 90], durationMs: 130 } });
await run('an empty last cluster gets no cue', file([...head(), cluster(0, run20(1, 5)), cluster(5000, [])]),
  { want: { cues: 1, clusters: 2, durationMs: 100 } });
await run('1-byte unknown cluster size that fits is filled', file([...head(), cluster(0, run20(1, 5), { size: [0xFF] })]),
  { want: { patchedClusters: 1, blocks: 5 } });
await run('1-byte unknown cluster size that cannot fit → kept', file([...head(), cluster(0, run20(1, 15), { size: [0xFF] })]), { keep: /does not fit/ });
await run('PCM: the last block lasts as long as the one before', file([info(), tracks(1, 'A_PCM/FLOAT/IEEE'), cluster(0, Array.from({ length: 6 }, (_, i) => block(1, i * 10, 0x80, [0, 0, 0, 0])))]),
  { want: { durationMs: 60 } });
const n24 = 17_280; // 24 h of 5 s clusters, the default timeslice
const t0 = performance.now();
const big = await run('24 h at the default 5 s timeslice', file([...head(), ...Array.from({ length: n24 }, (_, i) => cluster(i * 5000, [block(1, 0)]))]),
  { want: { clusters: n24, cues: n24, durationMs: (n24 - 1) * 5000 + 20 } });
if (big) results.at(-1).detail += `, ${Math.round(performance.now() - t0)} ms incl. the check`;

for (const path of process.argv.slice(2)) {
  const real = await openAsBlob(path);
  const r = await run(`real recording ${path.split(/[\\/]/).pop()}`, real, { want: { droppedTailBytes: 0, durationMs: (d) => d > 0 } });
  if (r?.changed) await run('  … its rewrite is left alone', r.blob, { keep: /already seekable/ });
}

for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.case} — ${r.detail}`);
console.log('RESULTS ' + JSON.stringify(results));
const ok = results.every((r) => r.ok);
console.log(`VERDICT: ${ok ? 'OK' : 'FAIL'} ${results.filter((r) => r.ok).length}/${results.length}`);
process.exitCode = ok ? 0 : 1;
