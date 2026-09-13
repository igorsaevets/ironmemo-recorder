/**
 * transcript.js — the transcript comes back (I4b).
 *
 * On `completed` the Recordings page fetches GET /recordings/api/recordings/{id}/transcript-v2 and
 * stores the body VERBATIM as sessions/<sid>/transcript.v2.json — the local copy is the user's, the
 * server copy stays under the (guest or claimed) account — then renders transcript.txt
 * (`[mm:ss] Speaker: text` per segment, speaker names from the registry), keeps summary.md when
 * the DTO carries a summary, and can ask the server for an export (srt / vtt / txt / json) that
 * is downloaded and stored as export.<fmt>.
 *
 * Shape facts (`measured` 2026-09-13, 03-research/I4-ingest/I4a/prod-dump-20260913-053733-*.json):
 *   {recording_id, schema_version "1.0", pipeline_version, duration_ms, language {routed, detected,
 *    path}, engine {asr_model_id, pipeline_version, fallback_used}, segments[{id, start_ms, end_ms,
 *    speaker_id, text, words[{w, start_ms, end_ms, conf}], lang}], speakers [], provenance {}, qa {}}.
 *   The frontend's hand-written type (iron-note-frontend origin/main src/api/transcript-v2.ts) adds
 *   speakers[{speaker_id, db_id, name, color}] — used here only for the display name.
 * Export facts (`read in code`, recordings_ext/exports.py + views.py, origin/main 6720f51):
 *   POST …/{id}/exports {format, include_timestamps, include_speakers} → 202 ExportResponse
 *   {id, status queued|ready|failed, download_url, download_url_expires_at, error, …}; poll
 *   GET /recordings/api/exports/{export_id}; the link is a presigned GET (15 min) issued fresh on
 *   every response; renderable formats are txt, srt, vtt, json — docx/pdf are refused with
 *   error.400.export_format_unavailable; a recording without segments → error.400.no_transcript.
 *
 * Write discipline (CODEX.md Q4): a new file is written completely under a temporary name, read
 * back and hashed, then moved over the old name — the only good copy is never overwritten in place.
 * Never logged: transcript or summary TEXT. Only counts, bytes and hashes.
 */

import { PATHS, TransportError } from './api.js';
import { withRetry, sleep } from './upload.js';

export const FILES = Object.freeze({ json: 'transcript.v2.json', txt: 'transcript.txt', summary: 'summary.md' });
/** What the server can render today (exports.py RENDERABLE_FORMATS). The UI offers srt. */
export const EXPORT_FORMATS = Object.freeze(['srt', 'vtt', 'txt', 'json']);
/** Lines before the first segment in transcript.txt (5 text lines + 1 blank). */
export const HEADER_LINES = 6;
const TMP_SUFFIX = '.part-tmp';

export function exportFileName(format) { return `export.${format}`; }

/** Files this module owns inside a session directory (the Recordings page keeps them out of "Other files"). */
export function isTranscriptFile(name) {
  return name === FILES.json || name === FILES.txt || name === FILES.summary
    || /^export\.(srt|vtt|txt|json)$/.test(name) || name.endsWith(TMP_SUFFIX);
}

/** ms → "mm:ss", or "h:mm:ss" past an hour (the summary's [mm:ss] anchors use the same form). */
export function formatStamp(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, '0'), sss = String(ss).padStart(2, '0');
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

/** Minimal runtime validation (CODEX Q4: never render from generated types alone). */
export function validateTranscript(t) {
  const problems = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { ok: false, problems: ['not an object'] };
  if (typeof t.schema_version !== 'string') problems.push('schema_version missing');
  if (!Array.isArray(t.segments)) problems.push('segments is not an array');
  else {
    for (let i = 0; i < t.segments.length && problems.length < 5; i++) {
      const s = t.segments[i];
      if (!s || typeof s !== 'object') { problems.push(`segment ${i} is not an object`); continue; }
      if (typeof s.text !== 'string') problems.push(`segment ${i}: text is not a string`);
      if (!Number.isFinite(s.start_ms) || !Number.isFinite(s.end_ms)) problems.push(`segment ${i}: start_ms/end_ms are not numbers`);
    }
  }
  if (t.speakers != null && !Array.isArray(t.speakers)) problems.push('speakers is not an array');
  return { ok: problems.length === 0, problems: problems.slice(0, 5) };
}

export function speakerNames(t) {
  const map = new Map();
  for (const sp of Array.isArray(t?.speakers) ? t.speakers : []) {
    if (sp && typeof sp === 'object' && sp.speaker_id != null) {
      const name = typeof sp.name === 'string' && sp.name.trim() ? sp.name.trim() : String(sp.speaker_id);
      map.set(String(sp.speaker_id), name);
    }
  }
  return map;
}

function oneLine(s) { return String(s ?? '').replace(/[\r\n]+/g, ' ').trim(); }

/**
 * transcript.txt: HEADER_LINES header lines, then exactly one line per segment
 * (`[mm:ss] Speaker: text`; no speaker part when the segment carries no speaker_id).
 */
export function renderTranscriptText(t, { title = '', recordingId = '', origin = '', fetchedAt = Date.now() } = {}) {
  const names = speakerNames(t);
  const segs = Array.isArray(t.segments) ? t.segments : [];
  const lang = t.language?.detected ?? t.language?.routed ?? (typeof t.language === 'string' ? t.language : null) ?? '—';
  const dur = Number.isFinite(t.duration_ms) ? formatStamp(t.duration_ms) : '—';
  const header = [
    `IronMemo transcript — ${oneLine(title) || recordingId}`,
    `Recording: ${recordingId}`,
    `Duration: ${dur} · Language: ${lang} · Segments: ${segs.length} · Speakers: ${names.size}`,
    `Fetched: ${new Date(fetchedAt).toISOString()} from ${origin}`,
    'Timestamps are [mm:ss] of the original audio; speaker names as on IronMemo.',
    '',
  ];
  const lines = segs.map((s) => {
    const who = s.speaker_id != null ? (names.get(String(s.speaker_id)) ?? String(s.speaker_id)) : null;
    return `[${formatStamp(s.start_ms)}] ${who ? `${who}: ` : ''}${oneLine(s.text)}`;
  });
  return `${header.join('\n')}\n${lines.join('\n')}\n`;
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const enc = new TextEncoder();
export function toBytes(data) {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** Write `name` atomically: <name>.part-tmp → read back + hash → move over `name`. Returns {bytes, sha256}. */
export async function writeFileAtomic(dir, name, data) {
  const bytes = toBytes(data);
  const tmpName = name + TMP_SUFFIX;
  const tmp = await dir.getFileHandle(tmpName, { create: true });
  const w = await tmp.createWritable({ keepExistingData: false });
  try { await w.write(bytes); await w.close(); }
  catch (e) { try { await w.abort(); } catch { /* already closed */ } throw e; }
  const back = await (await dir.getFileHandle(tmpName)).getFile();
  if (back.size !== bytes.byteLength) throw new Error(`write verification failed for ${name}: ${back.size} of ${bytes.byteLength} bytes`);
  const sha = await sha256Hex(new Uint8Array(await back.arrayBuffer()));
  if (sha !== await sha256Hex(bytes)) throw new Error(`write verification failed for ${name}: hash mismatch`);
  try { await dir.removeEntry(name); } catch (e) { if (e?.name !== 'NotFoundError') throw e; }
  const h = await dir.getFileHandle(tmpName);
  if (typeof h.move === 'function') await h.move(name);
  else {
    // No FileSystemFileHandle.move() (Chrome < 111): copy the verified bytes, then drop the temporary file.
    const fh = await dir.getFileHandle(name, { create: true });
    const w2 = await fh.createWritable(); await w2.write(bytes); await w2.close();
    await dir.removeEntry(tmpName);
  }
  return { bytes: bytes.byteLength, sha256: sha };
}

/** The File, or null when absent. */
export async function readFile(dir, name) {
  try { return await (await dir.getFileHandle(name)).getFile(); }
  catch (e) { if (e?.name === 'NotFoundError') return null; throw e; }
}

/**
 * fetchAndStoreTranscript({api, dir, job, log, signal, origin}) → the ledger's `transcript` record.
 * `job.server` (the whitelisted DTO, upload.js summarizeRecording) supplies the summary and
 * updated_at; the transcript-v2 body is stored exactly as received (api.get with raw:true).
 */
export async function fetchAndStoreTranscript({ api, dir, job, log = () => {}, signal, origin = '' }) {
  const t0 = performance.now();
  const { text, json } = await api.get(PATHS.transcriptV2(job.recordingId), { signal, raw: true });
  const v = validateTranscript(json);
  if (!v.ok) {
    const e = new Error(`transcript-v2: unexpected shape (${v.problems.join('; ')})`); e.kind = 'shape'; throw e;
  }
  if (json.recording_id && job.recordingId && String(json.recording_id) !== String(job.recordingId)) {
    log('transcript_id_mismatch', { got: String(json.recording_id).slice(0, 8), expected: String(job.recordingId).slice(0, 8) });
  }
  const fetchedAt = Date.now();
  const jsonFile = await writeFileAtomic(dir, FILES.json, text);
  const txt = renderTranscriptText(json, { title: job.title, recordingId: job.recordingId, origin, fetchedAt });
  const txtFile = await writeFileAtomic(dir, FILES.txt, txt);
  let summaryFile = null;
  const summary = job.server?.summary;
  if (typeof summary === 'string' && summary.trim()) {
    summaryFile = await writeFileAtomic(dir, FILES.summary, summary.endsWith('\n') ? summary : `${summary}\n`);
  } else {
    try { await dir.removeEntry(FILES.summary); } catch { /* none */ }
  }
  const segments = json.segments.length;
  const rec = {
    state: 'stored', fetchedAt, lastError: null,
    bytes: jsonFile.bytes, sha256: jsonFile.sha256, segments,
    speakers: Array.isArray(json.speakers) ? json.speakers.length : 0,
    words: json.segments.reduce((a, s) => a + (Array.isArray(s.words) ? s.words.length : 0), 0),
    schemaVersion: json.schema_version ?? null, pipelineVersion: json.pipeline_version ?? null,
    durationMs: Number.isFinite(json.duration_ms) ? json.duration_ms : null,
    language: { routed: json.language?.routed ?? null, detected: json.language?.detected ?? null },
    txtLines: HEADER_LINES + segments, headerLines: HEADER_LINES, txtBytes: txtFile.bytes,
    summaryBytes: summaryFile?.bytes ?? null, summaryStale: job.server?.summary_stale ?? null,
    recordingUpdatedAt: job.server?.updated_at ?? null, checkedAt: fetchedAt,
    files: { json: FILES.json, txt: FILES.txt, summary: summaryFile ? FILES.summary : null },
    exports: job.transcript?.exports ?? {},
    ms: Math.round(performance.now() - t0),
  };
  log('transcript_stored', {
    recordingId: job.recordingId, segments, bytes: rec.bytes, sha256: rec.sha256.slice(0, 16),
    txtLines: rec.txtLines, summaryBytes: rec.summaryBytes, speakers: rec.speakers, ms: rec.ms,
  });
  return rec;
}

/**
 * requestExport(ctx) — server-side render → poll → download the presigned link → store export.<fmt>.
 * ctx: { api, dir, job, format, log, signal, isOriginAllowed(origin), includeTimestamps, includeSpeakers }
 */
export async function requestExport({ api, dir, job, format, log = () => {}, signal, isOriginAllowed, includeTimestamps = true, includeSpeakers = true }) {
  if (!EXPORT_FORMATS.includes(format)) {
    const e = new Error(`Export format ${format} is not offered here (the server renders txt, srt, vtt, json).`); e.kind = 'unsupported'; throw e;
  }
  const t0 = performance.now();
  const created = await api.post(PATHS.exports(job.recordingId), { format, include_timestamps: includeTimestamps, include_speakers: includeSpeakers }, { signal });
  if (!created?.id) { const e = new Error('exports: no id in the answer'); e.kind = 'shape'; throw e; }
  log('export_requested', { format, exportId: created.id, status: created.status ?? null });
  let ex = created;
  let wait = 1500;
  for (let i = 0; i < 40 && ex.status !== 'ready' && ex.status !== 'failed'; i++) {
    await sleep(wait, signal);
    wait = Math.min(10_000, Math.round(wait * 1.5));
    ex = await withRetry(() => api.get(PATHS.exportDetail(created.id), { signal }), { signal, log, what: 'export_status', attempts: 4 });
  }
  if (ex.status === 'failed') {
    const e = new Error(`The server could not render the ${format} export${ex.error ? `: ${String(ex.error).slice(0, 200)}` : ''}.`); e.kind = 'export_failed'; throw e;
  }
  if (ex.status !== 'ready' || typeof ex.download_url !== 'string' || !ex.download_url) {
    const e = new Error(`The ${format} export was not ready after ${Math.round((performance.now() - t0) / 1000)} s.`); e.kind = 'export_timeout'; throw e;
  }
  const storageOrigin = new URL(ex.download_url).origin;
  if (isOriginAllowed && !(await isOriginAllowed(storageOrigin))) {
    const e = new Error(`The export link on ${storageOrigin} is not covered by the granted host permission — not downloaded.`); e.kind = 'origin'; throw e;
  }
  let res;
  try { res = await fetch(ex.download_url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal }); }
  catch (e) { if (e?.name === 'AbortError') throw e; throw new TransportError(`Export download failed (${e?.message ?? e})`, { cause: e }); }
  if (!res.ok) { const e = new Error(`The export download answered ${res.status}.`); e.kind = res.status >= 500 ? 'server' : 'storage'; e.status = res.status; throw e; }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const name = exportFileName(format);
  const file = await writeFileAtomic(dir, name, bytes);
  const rec = { state: 'stored', file: name, format, bytes: file.bytes, sha256: file.sha256, exportId: created.id, at: Date.now(), ms: Math.round(performance.now() - t0) };
  log('export_stored', { format, bytes: rec.bytes, exportId: created.id, ms: rec.ms, storageOrigin });
  return rec;
}
