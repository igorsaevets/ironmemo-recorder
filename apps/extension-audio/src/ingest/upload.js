/**
 * upload.js — which local file to send, and how: single PUT (< server part size) or multipart
 * with server-dictated parts; resumable through the ledger record (ledger.js).
 *
 * Facts this file is built on (03-research/I4-ingest/TECH-IDEAS.md §1, §3, §4; CODEX.md Q2/Q3):
 *   - One file per Recording. Prefer `compatibility_mix.*` — it exists for single-source
 *     sessions too (offscreen.js:251-259), so the choice reads capture-report.json, never a name.
 *   - Presigned PUTs carry NO Authorization header and NO cookies (XHR withCredentials=false).
 *   - Every accepted ETag is persisted on its own before the part counts as durable.
 *   - There is no route to re-sign parts: an expired/403'd session is restarted as a NEW
 *     multipart session on the SAME recording (the server supersedes the open session).
 *   - A lost `complete`/`finalize` answer → state `finalize_unknown` → query the recording first.
 *   - Blobs are sliced from the OPFS File: the bytes stream from disk (measured in the bench).
 */

import { PATHS, TransportError, isRetryable } from './api.js';

export const MIME_BY_EXT = Object.freeze({ opus: 'audio/ogg', ogg: 'audio/ogg', webm: 'audio/webm', wav: 'audio/wav' });
export const ROLE_PREFERENCE = ['compatibility_mix', 'local_mic', 'remote_tab'];
export const ROLE_SLUG = { local_mic: 'mic', remote_tab: 'tab', compatibility_mix: 'mix' };

export class AssetError extends Error {
  constructor(message, reason) { super(message); this.name = 'AssetError'; this.reason = reason; this.kind = 'asset'; }
}

/** The storage (MinIO behind nginx) answered with a non-2xx status. */
export class StorageError extends Error {
  constructor(message, { status, code = null } = {}) {
    super(message);
    this.name = 'StorageError'; this.status = status; this.code = code;
    this.kind = status === 403 ? 'storage_forbidden' : status === 413 ? 'too_large' : status >= 500 ? 'server' : status === 0 ? 'origin' : 'storage';
  }
}

/**
 * pickAsset({ files, report, recovery, status }) → asset descriptor or throws AssetError.
 *   files    [{name, size, lastModified}] of the OPFS session directory
 *   report   parsed capture-report.json (or null)
 *   recovery parsed recovery.json (or null)
 *   status   'ok' (report.final or journal session_stopped) | 'orphan'
 */
export function pickAsset({ files, report, recovery, status }) {
  const has = (n) => files.find((f) => f.name === n) ?? null;
  const readyFor = (role) => has(`${role}.opus`) ?? has(`${role}.webm`) ?? has(`${role}.wav`);
  const recoveredFor = (role) => has(`${role}.recovered.opus`) ?? has(`${role}.recovered.webm`);
  const partsFor = (role) => files.filter((f) => f.name.startsWith(`${role}.`) && f.name.endsWith('.part'));

  const present = ROLE_PREFERENCE.filter((r) => readyFor(r) || recoveredFor(r) || partsFor(r).length);
  const captured = Array.isArray(report?.appliedReport?.roles) && report.appliedReport.roles.length
    ? report.appliedReport.roles : present;

  let role;
  if (captured.includes('compatibility_mix') && present.includes('compatibility_mix')) role = 'compatibility_mix';
  else if (captured.includes('local_mic') && captured.includes('remote_tab')) {
    throw new AssetError('This recording has separate microphone and tab tracks but no mix. Enable "produce a compatibility mix" in Settings and record again — sending one side would drop the other participants.', 'no_mix');
  } else role = present.find((r) => r !== 'compatibility_mix') ?? present[0];
  if (!role) throw new AssetError('No audio file found in this recording.', 'no_file');

  const ready = readyFor(role), recovered = recoveredFor(role), parts = partsFor(role);
  if (ready && status === 'ok') return describe(ready, role, 'ready');
  if (recovered) {
    const r = recovery?.roles?.[role];
    if (r && r.decodesFully === false) throw new AssetError('The recovered file does not decode end to end and will not be sent.', 'recovered_invalid');
    return describe(recovered, role, 'recovered');
  }
  if (ready && status !== 'ok') {
    throw new AssetError('This recording was interrupted without Stop and has not been verified yet. Open the extension popup to run the check, then try again.', 'unverified');
  }
  if (parts.length) {
    const segments = new Set(parts.map((p) => p.name.match(/\.(\d{3})\.\d{6}\.part$/)?.[1] ?? '000'));
    if (segments.size > 1) {
      throw new AssetError(`This recording was made by the MediaRecorder fallback in ${segments.size} segments that cannot be joined into one file. Download the segments instead.`, 'multi_segment');
    }
    const sorted = [...parts].sort((a, b) => a.name.localeCompare(b.name));
    return {
      name: sorted[0].name.replace(/\.\d{3}\.\d{6}\.part$/, '.webm'), role, kind: 'parts',
      bytes: sorted.reduce((a, p) => a + p.size, 0), lastModified: Math.max(...sorted.map((p) => p.lastModified)),
      ext: 'webm', mime: 'audio/webm', parts: sorted.map((p) => p.name),
    };
  }
  throw new AssetError('No audio file found for this recording.', 'no_file');
}

function describe(f, role, kind) {
  const ext = f.name.split('.').pop().toLowerCase();
  return { name: f.name, role, kind, bytes: f.size, lastModified: f.lastModified, ext, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream', parts: null };
}

/** Open the asset as a Blob (an OPFS File; for `.part` a Blob of Files — slices still stream). */
export async function openAsset(dirHandle, asset) {
  if (asset.kind === 'parts') {
    const blobs = [];
    for (const n of asset.parts) blobs.push(await (await dirHandle.getFileHandle(n)).getFile());
    return new Blob(blobs, { type: asset.mime });
  }
  return (await dirHandle.getFileHandle(asset.name)).getFile();
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** Bounded exponential backoff with jitter — for retryable errors only. */
export async function withRetry(fn, { attempts = 6, baseMs = 2000, maxMs = 60_000, signal, log = () => {}, what = 'call' } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try { return await fn(i); }
    catch (e) {
      last = e;
      if (e?.name === 'AbortError' || !isRetryable(e)) throw e;
      if (i === attempts - 1) break;
      const wait = Math.min(maxMs, baseMs * 2 ** i) * (0.5 + Math.random());
      log('retry', { what, attempt: i + 1, of: attempts, kind: e.kind ?? e.name, status: e.status ?? null, waitMs: Math.round(wait) });
      await sleep(wait, signal);
    }
  }
  throw last;
}

/**
 * PUT a blob to a presigned URL via XHR (upload progress + readable ETag). No auth, no cookies.
 * An inactivity timer (no progress event for `inactivityMs`) aborts and reports a TransportError.
 */
export function putBlob({ url, blob, mime, signal, onProgress, inactivityMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false; let timer = null;
    const onAbort = () => { xhr.abort(); settle(() => reject(new DOMException('Aborted', 'AbortError'))); };
    const settle = (fn) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { xhr.abort(); settle(() => reject(new TransportError(`No upload progress for ${Math.round(inactivityMs / 1000)} s`))); }, inactivityMs);
    };
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.upload.addEventListener('progress', (e) => { kick(); if (e.lengthComputable) onProgress?.(e.loaded, e.total); });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) { settle(() => resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag') })); return; }
      const xml = xhr.responseText ?? '';
      const code = xml.match(/<Code>([^<]+)<\/Code>/i)?.[1] ?? null;
      settle(() => reject(new StorageError(`Storage answered ${xhr.status}${code ? ` (${code})` : ''}`, { status: xhr.status, code })));
    });
    xhr.addEventListener('error', () => settle(() => reject(new TransportError('Storage request failed without an answer'))));
    xhr.addEventListener('abort', () => settle(() => reject(new DOMException('Aborted', 'AbortError'))));
    try {
      xhr.open('PUT', url, true);
      xhr.withCredentials = false;
      if (mime) xhr.setRequestHeader('Content-Type', mime);
      kick();
      xhr.send(blob);
    } catch (e) { settle(() => reject(new TransportError(`Upload could not be sent: ${e?.message ?? e}`))); }
  });
}

function expired(iso, marginMs = 60_000) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t < Date.now() + marginMs;
}

async function assertOrigin(url, isOriginAllowed) {
  const origin = new URL(url).origin;
  if (!(await isOriginAllowed(origin))) {
    throw new StorageError(`Storage origin ${origin} is not covered by the granted host permission — nothing was sent.`, { status: 0, code: 'OriginNotAllowed' });
  }
  return origin;
}

/** Whitelist of RecordingResponse fields the UI needs (no free-form server text is kept). */
export function summarizeRecording(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    id: rec.id ?? null, status: rec.status ?? null, title: typeof rec.title === 'string' ? rec.title.slice(0, 200) : null,
    duration_seconds: rec.duration_seconds ?? null, file_size_bytes: rec.file_size_bytes ?? null,
    free_cap: rec.free_cap ?? null, failed_insufficient_credits: rec.failed_insufficient_credits ?? null,
    mic_skipped_insufficient_credits: rec.mic_skipped_insufficient_credits ?? null,
    error_message: typeof rec.error_message === 'string' ? rec.error_message.slice(0, 300) : null,
    created_at: rec.created_at ?? null, updated_at: rec.updated_at ?? null, seenAt: Date.now(),
  };
}

/**
 * performUpload(ctx) — drives job.state: uploading → finalizing → processing.
 * ctx: { api, job, blob, limits, save(job), signal, concurrency, log, onProgress(job), isOriginAllowed(origin) }
 * Returns the RecordingResponse from finalize/complete (or the status read after an unknown finalize).
 */
export async function performUpload(ctx) {
  const { api, job, blob, limits, save, signal, log } = ctx;
  const partSize = limits?.multipart_part_size ?? 10 * 1024 * 1024;
  job.timings ??= {};
  if (!job.transport) { job.transport = blob.size >= partSize ? 'multipart' : 'single'; await save(job); }

  if (job.state === 'uploading') {
    if (job.transport === 'multipart') await uploadMultipart(ctx);
    else await uploadSingle(ctx);
  }

  if (job.state === 'finalize_unknown') {
    const rec = await withRetry(() => api.get(PATHS.recording(job.recordingId), { signal }), { signal, log, what: 'status_after_unknown_finalize' });
    if (rec.status !== 'created' && rec.status !== 'uploading') {
      job.state = 'processing'; job.server = summarizeRecording(rec); await save(job);
      log('finalize_reconciled', { status: rec.status });
      return rec;
    }
    job.state = 'finalizing'; await save(job);
  }

  if (job.state === 'finalizing') {
    const t0 = performance.now();
    let rec;
    try {
      if (job.transport === 'multipart') {
        const parts = job.parts.map((p) => ({ part_number: p.n, etag: p.etag }));
        rec = await withRetry(() => api.post(PATHS.complete(job.recordingId, job.uploadId), { parts }, { signal }), { signal, log, what: 'complete', attempts: 3 });
      } else {
        rec = await withRetry(() => api.post(PATHS.finalize(job.recordingId, job.uploadId), { file_size_bytes: blob.size }, { signal }), { signal, log, what: 'finalize', attempts: 3 });
      }
    } catch (e) {
      if (e instanceof TransportError) { job.state = 'finalize_unknown'; await save(job); }
      throw e;
    }
    job.timings.finalizeMs = Math.round(performance.now() - t0);
    job.state = 'processing'; job.server = summarizeRecording(rec); await save(job);
    log('finalized', { transport: job.transport, ms: job.timings.finalizeMs, status: rec.status });
    return rec;
  }
  return null;
}

async function uploadSingle(ctx) {
  const { api, job, blob, save, signal, log, onProgress, isOriginAllowed } = ctx;
  for (let round = 0; round < 3; round++) {
    if (!job.singlePut?.url || expired(job.expiresAt)) {
      if (job.singlePut) log('single_put_restart', { reason: 'expired' });
      const t0 = performance.now();
      const s = await withRetry(() => api.post(PATHS.uploadSessions(job.recordingId), { filename: job.filename }, { signal }), { signal, log, what: 'upload_session' });
      if (typeof s?.presigned_url !== 'string' || !s.upload_id) throw new StorageError('upload-sessions: no presigned_url in the answer', { status: 0, code: 'BadSession' });
      job.uploadId = s.upload_id; job.singlePut = { url: s.presigned_url }; job.expiresAt = s.expires_at ?? null;
      job.storageOrigin = new URL(s.presigned_url).origin; job.timings.uploadSessionMs = Math.round(performance.now() - t0);
      job.bytesSent = 0;
      await save(job);
      log('upload_session', { ms: job.timings.uploadSessionMs, storageOrigin: job.storageOrigin, expiresAt: job.expiresAt });
    }
    await assertOrigin(job.singlePut.url, isOriginAllowed);
    const t1 = performance.now();
    try {
      const r = await withRetry(() => putBlob({
        url: job.singlePut.url, blob, mime: job.asset.mime, signal,
        onProgress: (loaded) => { job.bytesSent = loaded; onProgress?.(job); },
      }), { signal, log, what: 'single_put' });
      job.bytesSent = blob.size; job.timings.putMs = Math.round(performance.now() - t1);
      job.state = 'finalizing'; job.completeIntentAt = Date.now();
      await save(job);
      log('single_put_done', { bytes: blob.size, ms: job.timings.putMs, status: r.status });
      return;
    } catch (e) {
      if (e instanceof StorageError && e.status === 403) { job.singlePut = null; job.uploadId = null; await save(job); continue; }
      throw e;
    }
  }
  throw new StorageError('Storage refused the presigned URL three times (403)', { status: 403, code: 'Expired' });
}

async function uploadMultipart(ctx) {
  const { api, job, blob, save, signal, log, onProgress, isOriginAllowed } = ctx;
  const concurrency = Math.max(1, Math.min(8, ctx.concurrency ?? 3));
  for (let round = 0; round < 3; round++) {
    if (!job.uploadId || !Array.isArray(job.parts) || !job.parts.length || expired(job.expiresAt)) {
      if (job.uploadId) log('multipart_restart', { reason: expired(job.expiresAt) ? 'expired' : 'no_parts' });
      const t0 = performance.now();
      const s = await withRetry(() => api.post(PATHS.multipart(job.recordingId), { file_size_bytes: blob.size, content_type: job.asset.mime, filename: job.filename }, { signal }), { signal, log, what: 'multipart_start' });
      const partSize = Number(s?.part_size_bytes);
      const expected = Math.ceil(blob.size / partSize);
      const numbers = (s?.parts ?? []).map((p) => p.part_number);
      if (!(partSize > 0) || !s.upload_id || numbers.length !== expected || numbers.some((n, i) => n !== i + 1)) {
        throw new StorageError(`multipart: unexpected part plan (${numbers.length} parts, size ${partSize})`, { status: 0, code: 'BadPartPlan' });
      }
      job.uploadId = s.upload_id; job.partSizeBytes = partSize; job.expiresAt = s.expires_at ?? null;
      job.parts = s.parts.map((p) => ({
        n: p.part_number, url: p.presigned_url, etag: null, sentAt: null,
        bytes: Math.min(partSize, blob.size - (p.part_number - 1) * partSize),
      }));
      job.storageOrigin = new URL(s.parts[0].presigned_url).origin;
      job.timings.multipartStartMs = Math.round(performance.now() - t0);
      job.bytesSent = 0;
      await save(job);
      log('multipart_started', { parts: job.parts.length, partSize, ms: job.timings.multipartStartMs, storageOrigin: job.storageOrigin, expiresAt: job.expiresAt });
    }
    await assertOrigin(job.parts[0].url, isOriginAllowed);
    const pending = job.parts.filter((p) => !p.etag);
    log('multipart_upload', { parts: job.parts.length, pending: pending.length, concurrency });
    const t1 = performance.now();
    const inflight = new Map();
    const progress = () => {
      job.bytesSent = job.parts.reduce((a, p) => a + (p.etag ? p.bytes : (inflight.get(p.n) ?? 0)), 0);
      onProgress?.(job);
    };
    const queue = [...pending];
    let expiredSeen = false;
    const worker = async () => {
      while (queue.length && !expiredSeen) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const part = queue.shift();
        const start = (part.n - 1) * job.partSizeBytes;
        const slice = blob.slice(start, Math.min(start + job.partSizeBytes, blob.size));
        try {
          const r = await withRetry(() => putBlob({
            url: part.url, blob: slice, mime: job.asset.mime, signal,
            onProgress: (loaded) => { inflight.set(part.n, loaded); progress(); },
          }), { signal, log, what: `part_${part.n}` });
          if (!r.etag) throw new StorageError('Part accepted but the ETag header is not readable', { status: r.status, code: 'NoETag' });
          part.etag = r.etag; part.sentAt = Date.now(); inflight.delete(part.n);
          await save(job); // each ACK durable on its own
          progress();
          log('part_done', { n: part.n, bytes: part.bytes, of: job.parts.length });
        } catch (e) {
          if (e instanceof StorageError && e.status === 403) { expiredSeen = true; return; }
          throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker));
    if (expiredSeen) { job.uploadId = null; job.parts = []; await save(job); continue; }
    job.timings.putMs = (job.timings.putMs ?? 0) + Math.round(performance.now() - t1);
    job.state = 'finalizing'; job.completeIntentAt = Date.now();
    await save(job);
    log('multipart_parts_done', { parts: job.parts.length, ms: job.timings.putMs });
    return;
  }
  throw new StorageError('Storage refused the presigned part URLs three times (403)', { status: 403, code: 'Expired' });
}
