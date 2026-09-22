/**
 * controller.js — per-session ingest state machine, run from the Recordings page (an
 * extension tab), never from the service worker (5-minute request cap) and never from the
 * offscreen document (there is one, and it is the recorder). ADR-008.
 *
 * States: idle → session → creating → uploading → finalizing → processing → completed
 *         plus create_unknown | finalize_unknown | paused(reason) | error(reason) | cancelled
 *
 * Preconditions checked here, in this order, with ZERO network before both hold:
 *   1. cloud consent (ironmemo.ingestConsent.v1, version CONSENT_VERSION) — the page shows the
 *      disclosure dialog and calls recordConsent();
 *   2. optional host permission for the API origin — the page calls requestPermission()
 *      synchronously inside the click handler (user gesture).
 *
 * "Creation outcome unknown": a create POST without an HTTP answer (or with a 5xx) may still
 * have inserted the row (no idempotency key on the server, CODEX.md Q2). The job stops in
 * `create_unknown`; Retry lists the workspace's recordings and adopts the one carrying this
 * job's unique title before it would ever create again.
 */

import { createLog } from './log.js';
import { createApi, PATHS, ApiError, TransportError, AuthLostError } from './api.js';
import { createAuth, hardenStorage, ACCOUNT_KEY } from './auth.js';
import { createClaim, CLAIM_GRACE_MS } from './claim.js';
import * as ledger from './ledger.js';
import { pickAsset, openAsset, performUpload, withRetry, sleep, summarizeRecording, AssetError, ROLE_SLUG } from './upload.js';
import { fetchAndStoreTranscript, requestExport } from './transcript.js';

export const CONSENT_KEY = 'ironmemo.ingestConsent.v1';
// v2 (I4b part 2): the disclosure now says that the e-mail is verified before the first transcription. Nobody
// outside the benches ever accepted v1 (the feature has not shipped), so the bump costs no one a re-prompt.
export const CONSENT_VERSION = 2;
export const CONSENT_TEXT_ID = 'cloud-en-v2-email';
export const DEFAULT_API_BASE = 'https://app.ironmemo.com';
const TERMINAL = new Set(['completed', 'error', 'deleted']);
const RESUMABLE = new Set(['session', 'creating', 'create_unknown', 'uploading', 'finalizing', 'finalize_unknown', 'processing']);
/** A `queued` older than this is its own UI state: measured 2026-09-13, a 3-hour silent stall with no error on any route. */
export const WAIT_LONG_MS = 10 * 60 * 1000;
/** How often a stored transcript is checked against the server's updated_at (a paid unlock reprocesses the recording). */
export const REVISION_CHECK_MS = 60 * 60 * 1000;

/** When a processing job has been waiting longer than WAIT_LONG_MS: the timestamp it has been waiting since, else null. */
export function waitingSince(job) {
  if (job?.state !== 'processing') return null;
  const since = job.timings?.processingSince ?? job.completeIntentAt ?? job.timings?.firstStatusAt ?? null;
  return since && Date.now() - since > WAIT_LONG_MS ? since : null;
}

export { sourceTypeFromUrl } from './source-type.js';

function errInfo(e) {
  return { kind: e?.kind ?? e?.name ?? 'error', status: e?.status ?? null, code: e?.code ?? null, reason: e?.reason ?? null, message: String(e?.message ?? e).slice(0, 300), at: Date.now() };
}

function clamp(n, lo, hi) { const x = Number(n); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; }

function stampUtc(ms) {
  const d = ms ? new Date(ms) : new Date();
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export class IngestController {
  constructor({ settings } = {}) {
    const u = settings?.upload ?? {};
    this.apiBase = (typeof u.apiBase === 'string' && u.apiBase.trim()) ? u.apiBase.trim() : DEFAULT_API_BASE;
    this.origin = new URL(this.apiBase).origin;
    this.originPattern = `${this.origin}/*`;
    this.enabled = u.enabled !== false;
    this.concurrency = clamp(u.concurrency ?? 3, 1, 8);
    // 'email' (default, product rule «б» 2026-09-13): a verified e-mail before the first upload; 'guest': the I4a path.
    this.authMode = u.authMode === 'guest' ? 'guest' : 'email';
    this.log = createLog('controller');
    this.auth = createAuth({ apiOrigin: this.origin, log: createLog('auth') });
    this.api = createApi({ baseUrl: this.origin, auth: this.auth, log: createLog('api') });
    this.claim = createClaim({ api: this.api, auth: this.auth, log: createLog('claim') });
    this.owner = this.auth.pageId;
    this.jobs = new Map();
    this.running = new Map();
    this.listeners = new Set();
    this.consent = null;
    this.limits = null;
  }

  async init() {
    this.hardening = await hardenStorage();
    this.consent = (await chrome.storage.local.get(CONSENT_KEY))[CONSENT_KEY] ?? null;
    for (const j of await ledger.listJobs()) this.jobs.set(j.sessionId, j);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [k, ch] of Object.entries(changes)) {
        if (k.startsWith(ledger.JOB_PREFIX)) {
          const sid = k.slice(ledger.JOB_PREFIX.length);
          if (ch.newValue) this.jobs.set(sid, ch.newValue); else this.jobs.delete(sid);
          this.emit(sid);
        } else if (k === CONSENT_KEY) this.consent = ch.newValue ?? null;
        else if (k === ACCOUNT_KEY) {
          this.auth.invalidateCache();
          const oldUser = ch.oldValue?.user?.id ?? null;
          const newUser = ch.newValue?.user?.id ?? null;
          if (oldUser !== newUser) this.pauseAll('account_changed').catch(() => {});
          this.emit('__account');
        }
      }
    });
    try {
      chrome.permissions.onRemoved.addListener((p) => {
        const host = new URL(this.origin).host;
        if ((p?.origins ?? []).some((o) => o === this.originPattern || o.includes(host))) this.pauseAll('permission_revoked');
      });
    } catch { /* no permissions API in this context */ }
    this.log('init', { origin: this.origin, jobs: this.jobs.size, consent: this.hasConsent(), hardening: this.hardening, authMode: this.authMode });
    return this;
  }

  // ── consent + permission (network-free) ─────────────────────────────────────────────
  hasConsent() { return this.consent?.version === CONSENT_VERSION; }
  async recordConsent() {
    this.consent = { version: CONSENT_VERSION, textId: CONSENT_TEXT_ID, acceptedAt: Date.now() };
    await chrome.storage.local.set({ [CONSENT_KEY]: this.consent });
    this.log('consent_recorded', { version: CONSENT_VERSION, textId: CONSENT_TEXT_ID });
  }
  async hasPermission() {
    try { return await chrome.permissions.contains({ origins: [this.originPattern] }); } catch { return false; }
  }
  /** Call this SYNCHRONOUSLY at the top of a click handler: Chrome requires a user gesture. */
  requestPermission() {
    return chrome.permissions.request({ origins: [this.originPattern] });
  }
  async isOriginAllowed(origin) {
    try { return await chrome.permissions.contains({ origins: [`${origin}/*`] }); } catch { return false; }
  }

  // ── account / e-mail claim (I4b part 2) ─────────────────────────────────────────────
  accountStatus() { return this.auth.status(); }
  /** Product rule «б»: with authMode 'email' nothing is uploaded until the e-mail is verified (a guest or no account → the claim dialog first). */
  async needsEmail() {
    if (this.authMode !== 'email') return false;
    const st = await this.auth.status();
    return !(st.hasAccount && st.kind === 'user');
  }
  /** Sign out = pause running uploads, server logout (best effort) + local wipe; completed jobs remember why the server copy is out of reach. */
  async signOut() {
    this.auth.invalidateCache();
    for (const sid of [...this.running.keys()]) await this.pause(sid, 'signed_out');
    const r = await this.claim.signOut();
    for (const job of [...this.jobs.values()]) {
      if (job.state !== 'completed' || job.localDeleted) continue;
      job.authLost = { at: Date.now(), reason: 'signed_out' };
      await ledger.putJob(job); this.jobs.set(job.sessionId, job); this.emit(job.sessionId);
    }
    this.log('signed_out', { serverOk: r.serverOk, status: r.status });
    this.emit('__account');
    return r;
  }

  // ── observers ────────────────────────────────────────────────────────────────────────
  subscribe(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit(sid) {
    const job = this.jobs.get(sid) ?? null;
    for (const cb of this.listeners) { try { cb(sid, job); } catch (e) { console.error('[ingest] listener failed', e); } }
  }
  getJob(sid) { return this.jobs.get(sid) ?? null; }
  isRunning(sid) { return this.running.has(sid); }

  // ── entry points used by the page ────────────────────────────────────────────────────
  /**
   * start(session): consent + permission must already hold. `session` comes from the
   * Recordings page: {sid, files, report, recovery, status, startedAt}.
   */
  async start(session) {
    const sid = session.sid;
    if (!this.hasConsent()) throw new Error('Cloud processing has not been accepted yet.');
    if (!(await this.hasPermission())) throw new Error(`Access to ${this.origin} was not granted.`);
    if (await this.needsEmail()) { const e = new Error('Verify your e-mail first — the free minutes are granted per account.'); e.kind = 'email_required'; throw e; }
    const existing = this.jobs.get(sid);
    if (existing && this.running.has(sid)) return existing;
    if (existing?.state === 'completed') return existing;

    const lease = await ledger.acquireLease(sid, this.owner);
    if (!lease.ok) throw new Error('Another Recordings tab is already handling this recording.');

    let job;
    if (existing?.recordingId && existing.state !== 'cancelled') {
      job = { ...existing, state: existing.pausedFrom ?? existing.state, pausedFrom: null };
      if (job.state === 'paused' || job.state === 'error') job.state = job.uploadId ? 'uploading' : 'session';
    } else {
      const asset = pickAsset(session); // throws AssetError with a user-facing message
      job = this.newJob(session, asset);
    }
    await ledger.putJob(job); this.jobs.set(sid, job); this.emit(sid);
    return this.run(sid);
  }

  newJob(session, asset) {
    const sid = session.sid;
    const roles = session.report?.appliedReport?.roles ?? [];
    const sourceType = session.report?.appliedReport?.sourceType
      ?? (roles.includes('remote_tab') ? 'other' : 'dictaphone');
    const title = `IronMemo recording ${stampUtc(session.startedAt)} · ${sid.slice(0, 8)}`;
    return {
      schemaVersion: ledger.LEDGER_SCHEMA, sessionId: sid, apiOrigin: this.origin, userId: null, accountKind: null,
      workspaceId: null, title, sourceType,
      filename: `ironmemo-${sid.slice(0, 8)}-${ROLE_SLUG[asset.role] ?? asset.role}.${asset.ext}`,
      createBody: {
        workspace_id: null, title, source_type: sourceType, language_mode: 'auto', language: null,
        diarization_enabled: sourceType !== 'dictaphone', provider_override: null,
        filename: `ironmemo-${sid.slice(0, 8)}-${ROLE_SLUG[asset.role] ?? asset.role}.${asset.ext}`, full_length: false,
      },
      asset, state: 'session', stateReason: null, pausedFrom: null,
      recordingId: null, transport: null, uploadId: null, partSizeBytes: null, parts: [], singlePut: null,
      storageOrigin: null, expiresAt: null, bytesSent: 0, attempts: 0, lastError: null,
      completeIntentAt: null, server: null, pollCount: 0, meetingPage: null,
      timings: { startedAt: Date.now() }, consentVersion: this.consent?.version ?? null, consentTextId: this.consent?.textId ?? null,
      createdAt: Date.now(), updatedAt: Date.now(), localDeleted: false,
      transcript: null, serverDeleted: null, authLost: null, // I4b
    };
  }

  /**
   * Resume every unfinished job (page open / extension reload). Needs consent + permission.
   * A job whose lease is still held by a page that just closed (lease younger than
   * LEASE_TTL_MS) is retried after the TTL — measured in the bench: without this retry a
   * reopened Recordings page sat on an `uploading` job forever.
   */
  async resumeAll() {
    if (!this.hasConsent() || !(await this.hasPermission())) return [];
    const out = [];
    let blocked = false;
    const acct = await this.auth.status(); // without an identity there is nothing to sync for completed jobs
    for (const job of [...this.jobs.values()]) {
      if (job.localDeleted || !RESUMABLE.has(job.state) || this.running.has(job.sessionId)) continue;
      if (job.state === 'creating') { job.state = 'create_unknown'; job.stateReason = 'page_closed_during_create'; await ledger.putJob(job); }
      const lease = await ledger.acquireLease(job.sessionId, this.owner);
      if (!lease.ok) { blocked = true; this.log('resume_lease_busy', { sid: job.sessionId, ageMs: Date.now() - (lease.at ?? 0) }); continue; }
      out.push(this.run(job.sessionId));
    }
    // I4b: completed jobs — fetch a transcript that is not stored yet (jobs finished by an
    // earlier version, or a failed fetch), and re-check the server revision once an hour.
    for (const job of [...this.jobs.values()]) {
      if (!acct.hasAccount || job.state !== 'completed' || job.localDeleted || job.serverDeleted || this.running.has(job.sessionId)) continue;
      const t = job.transcript;
      const needFetch = !t || t.state !== 'stored';
      const needCheck = t?.state === 'stored' && Date.now() - (t.checkedAt ?? 0) > REVISION_CHECK_MS;
      if (needFetch || needCheck) out.push(this.syncCompleted(job.sessionId));
    }
    if (blocked && !this.resumeTimer) {
      this.resumeTimer = setTimeout(() => { this.resumeTimer = null; this.resumeAll().catch(() => {}); }, ledger.LEASE_TTL_MS + 1000);
    }
    return Promise.all(out);
  }

  /** Best-effort on pagehide: let the next page take over without waiting for the lease TTL. */
  releaseAllLeases() {
    for (const sid of this.running.keys()) ledger.releaseLease(sid, this.owner).catch(() => {});
  }

  async pause(sid, reason = 'user') {
    const job = this.jobs.get(sid);
    if (!job) return null;
    const r = this.running.get(sid);
    if (!RESUMABLE.has(job.state) && !r) return job;
    job.pausedFrom = job.state === 'creating' ? 'create_unknown' : job.state;
    job.state = 'paused'; job.stateReason = reason;
    await ledger.putJob(job); this.jobs.set(sid, job);
    r?.abort.abort();
    this.log('paused', { sid, reason, from: job.pausedFrom });
    this.emit(sid);
    return job;
  }

  async pauseAll(reason) {
    for (const sid of [...this.running.keys()]) await this.pause(sid, reason);
  }

  /** Continue a paused job (permission and consent are re-checked inside run()). */
  async resume(sid) {
    const job = this.jobs.get(sid);
    if (!job || this.running.has(sid)) return job ?? null;
    if (job.state === 'paused' || job.state === 'error' || job.state === 'create_unknown' || job.state === 'finalize_unknown') {
      const lease = await ledger.acquireLease(sid, this.owner);
      if (!lease.ok) throw new Error('Another Recordings tab is already handling this recording.');
      if (job.state === 'paused') { job.state = job.pausedFrom ?? (job.uploadId ? 'uploading' : 'session'); job.pausedFrom = null; }
      else if (job.state === 'error') {
        if (job.stateReason === 'auth_lost' && this.authMode === 'guest') { await this.auth.logout(); job.state = 'session'; job.userId = null; job.workspaceId = null; job.recordingId = null; job.uploadId = null; job.parts = []; job.singlePut = null; job.transport = null; }
        // e-mail mode after auth_lost: the reconnect signed into the SAME account (LOGGED_IN) — continue where it stopped
        else if (job.uploadId) job.state = job.completeIntentAt ? 'finalizing' : 'uploading';
        else if (job.recordingId) job.state = 'uploading';
        else job.state = 'session';
      }
      job.stateReason = null;
      await ledger.putJob(job); this.jobs.set(sid, job); this.emit(sid);
    }
    return this.run(sid);
  }

  /** Explicit cancel: abort the transfer, release the multipart parts, keep a tombstone record. */
  async cancel(sid) {
    const job = this.jobs.get(sid);
    if (!job) return null;
    this.running.get(sid)?.abort.abort();
    if (job.transport === 'multipart' && job.uploadId && job.recordingId && !job.completeIntentAt) {
      try { await this.api.del(PATHS.abort(job.recordingId, job.uploadId)); job.abortedOnServer = true; }
      catch (e) { job.abortedOnServer = false; this.log('abort_failed', { kind: e.kind ?? e.name }); }
    }
    job.state = 'cancelled'; job.stateReason = 'user'; job.pausedFrom = null;
    await ledger.putJob(job); this.jobs.set(sid, job); this.emit(sid);
    return job;
  }

  /** The Recordings page is deleting the OPFS directory: stop and tombstone, never recreate. */
  async onSessionDeleted(sid) {
    const job = this.jobs.get(sid);
    if (!job) return;
    this.running.get(sid)?.abort.abort();
    job.localDeleted = true;
    if (RESUMABLE.has(job.state) || job.state === 'paused') { job.state = 'cancelled'; job.stateReason = 'local_deleted'; }
    await ledger.putJob(job); this.jobs.set(sid, job); this.emit(sid);
  }

  // ── the state machine ────────────────────────────────────────────────────────────────
  async run(sid) {
    if (this.running.has(sid)) return this.jobs.get(sid);
    const abort = new AbortController();
    const signal = abort.signal;
    this.running.set(sid, { abort });
    const leaseTimer = setInterval(() => ledger.renewLease(sid, this.owner).catch(() => {}), 5000);
    const log = this.log;
    const save = async (job) => { this.jobs.set(sid, job); await ledger.putJob(job); this.emit(sid); };
    let job = this.jobs.get(sid);
    try {
      if (!job) throw new Error('no job record');
      if (!this.hasConsent()) { job.state = 'paused'; job.stateReason = 'consent_missing'; await save(job); return job; }
      if (!(await this.hasPermission())) { job.pausedFrom = job.state; job.state = 'paused'; job.stateReason = 'permission_missing'; await save(job); return job; }

      if (['session', 'creating', 'create_unknown', 'uploading', 'finalizing', 'finalize_unknown'].includes(job.state)) {
        if (await this.needsEmail()) { job.pausedFrom = job.state; job.state = 'paused'; job.stateReason = 'email_required'; await save(job); log('paused', { sid, reason: 'email_required' }); return job; }
        const acc = await this.auth.ensureSession();
        const currentUserId = acc.user?.id ?? null;
        if (job.userId && currentUserId && job.userId !== currentUserId) {
          const st = await this.auth.status();
          if (st.previousUserId === job.userId) {
            job.userId = currentUserId; job.accountKind = acc.kind;
          } else {
            job.state = 'error'; job.stateReason = 'wrong_account';
            job.lastError = { kind: 'wrong_account', message: `Job belongs to ${job.userId}, current account is ${currentUserId}`, at: Date.now() };
            await save(job);
            log('wrong_account', { sid, jobUserId: job.userId, currentUserId });
            return job;
          }
        } else {
          job.userId = currentUserId; job.accountKind = acc.kind;
        }
        if (!job.workspaceId) {
          job.workspaceId = await this.resolveWorkspace(signal, job, save);
          job.createBody.workspace_id = job.workspaceId; job.stateReason = null;
          await save(job);
        }
        if (!this.limits) {
          this.limits = await withRetry(() => this.api.get(PATHS.uploadLimits, { signal }), { signal, log, what: 'upload_limits' });
          log('upload_limits', { max: this.limits?.max_upload_bytes, partSize: this.limits?.multipart_part_size, ext: (this.limits?.allowed_extensions ?? []).length });
        }
        if (Number.isFinite(this.limits?.max_upload_bytes) && job.asset.bytes > this.limits.max_upload_bytes) {
          throw new AssetError(`The file (${job.asset.bytes} bytes) exceeds the server limit of ${this.limits.max_upload_bytes} bytes.`, 'too_large');
        }
        const allowed = this.limits?.allowed_extensions;
        if (Array.isArray(allowed) && allowed.length && !allowed.includes(job.asset.ext)) {
          throw new AssetError(`The server does not accept .${job.asset.ext} files.`, 'unsupported');
        }
      }

      if (job.state === 'session') { job.state = 'creating'; await save(job); }
      if (job.state === 'create_unknown') await this.resolveUnknownCreate(job, signal, save);
      if (job.state === 'creating') {
        const t0 = performance.now();
        let rec;
        try { rec = await this.api.post(PATHS.recordings, job.createBody, { signal }); } // sent ONCE, never retried blindly
        catch (e) {
          if (e?.name === 'AbortError') throw e;
          if (e instanceof TransportError || e?.kind === 'server' || e?.kind === 'rate_limited') {
            job.state = 'create_unknown'; job.stateReason = e.kind; job.lastError = errInfo(e); await save(job);
            log('create_unknown', { kind: e.kind, status: e.status ?? null });
            return job;
          }
          throw e;
        }
        job.recordingId = rec.id; job.timings.createMs = Math.round(performance.now() - t0); job.server = summarizeRecording(rec);
        job.state = 'uploading'; await save(job);
        log('created', { recordingId: rec.id, ms: job.timings.createMs, status: rec.status });
      }

      if (['uploading', 'finalizing', 'finalize_unknown'].includes(job.state)) {
        const dir = await this.sessionDir(sid);
        const blob = await openAsset(dir, job.asset);
        if (blob.size !== job.asset.bytes) throw new AssetError('The local file changed since the upload started; start over from the Recordings page.', 'asset_changed');
        await performUpload({
          api: this.api, job, blob, limits: this.limits, save, signal, concurrency: this.concurrency, log,
          onProgress: () => this.emit(sid), isOriginAllowed: (o) => this.isOriginAllowed(o),
        });
      }

      if (job.state === 'processing') await this.poll(job, signal, save);
      return job;
    } catch (e) {
      if (e?.name === 'AbortError') { log('aborted', { sid, state: this.jobs.get(sid)?.state }); return this.jobs.get(sid); }
      job.lastError = errInfo(e); job.attempts = (job.attempts ?? 0) + 1;
      if (e instanceof AuthLostError) { job.state = 'error'; job.stateReason = 'auth_lost'; }
      else if (e instanceof AssetError) { job.state = 'error'; job.stateReason = e.reason; }
      else if (job.state !== 'create_unknown' && job.state !== 'finalize_unknown') { job.state = 'error'; job.stateReason = e.kind ?? e.name; }
      await save(job);
      log('job_failed', { sid, state: job.state, reason: job.stateReason, kind: e.kind ?? e.name, status: e.status ?? null, message: e.message });
      return job;
    } finally {
      clearInterval(leaseTimer);
      this.running.delete(sid);
      await ledger.releaseLease(sid, this.owner).catch(() => {});
      this.emit(sid);
    }
  }

  /**
   * The guest's personal workspace is created asynchronously after enrolment (stapel-auth
   * `auth.user.enrolled` milestone → workspaces service). Measured 2026-09-13: spike-01 had it
   * on the first read; spike-02, under a slow production, did not get it within 20 s. So: up to
   * ~2 minutes, with the job visibly in `workspace_wait`.
   */
  async resolveWorkspace(signal, job = null, save = null) {
    const started = Date.now();
    for (let attempt = 0; attempt < 30; attempt++) {
      const data = await withRetry(() => this.api.get(PATHS.workspaces, { signal }), { signal, log: this.log, what: 'workspaces' });
      const items = Array.isArray(data?.workspaces) ? data.workspaces : [];
      const ids = new Set(items.map((w) => String(w?.id)).filter((x) => x && x !== 'undefined'));
      // Measured on prod for a fresh guest (spike-01): default/preferred ids are EMPTY STRINGS and
      // the list holds exactly one personal workspace — so the single-item fallback is the norm.
      const chosen = [data?.default_workspace_id, data?.preferred_workspace_id].find((x) => typeof x === 'string' && x.length > 0) ?? null;
      if (chosen && ids.has(chosen)) return chosen;
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) throw new ApiError({ status: 200, message: 'Several workspaces and no default — cannot choose one.', path: PATHS.workspaces });
      if (Date.now() - started > 120_000) break;
      this.log('workspace_wait', { attempt: attempt + 1, waitedMs: Date.now() - started });
      if (job && save && job.stateReason !== 'workspace_wait') { job.stateReason = 'workspace_wait'; await save(job); }
      await sleep(Math.min(6000, 2000 + attempt * 500), signal);
    }
    throw new ApiError({ status: 200, message: 'IronMemo did not prepare a workspace for the guest within 2 minutes — try again later.', path: PATHS.workspaces });
  }

  /** create_unknown → find the recording by this job's unique title; adopt it, else create anew. */
  async resolveUnknownCreate(job, signal, save) {
    const data = await withRetry(() => this.api.get(`${PATHS.recordings}?workspace_id=${encodeURIComponent(job.workspaceId)}`, { signal }), { signal, log: this.log, what: 'list_after_unknown_create' });
    const items = Array.isArray(data?.recordings) ? data.recordings : (Array.isArray(data) ? data : []);
    const matches = items.filter((r) => r?.title === job.title);
    this.log('create_unknown_resolved', { matches: matches.length, listed: items.length });
    if (matches.length === 1) {
      job.recordingId = matches[0].id; job.server = summarizeRecording(matches[0]); job.state = 'uploading'; job.stateReason = null;
      await save(job);
    } else if (matches.length === 0) {
      job.state = 'creating'; job.stateReason = null; await save(job);
    } else {
      throw new ApiError({ status: 200, message: `${matches.length} recordings carry this title on the server — cannot pick one safely.`, path: PATHS.recordings });
    }
  }

  async poll(job, signal, save) {
    let wait = 5000;
    job.pollCount ??= 0;
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const rec = await withRetry(() => this.api.get(PATHS.recording(job.recordingId), { signal }), { signal, log: this.log, what: 'status', attempts: 8, baseMs: 5000 });
      job.pollCount += 1;
      const prev = job.server?.status ?? null;
      job.server = summarizeRecording(rec);
      job.timings.firstStatusAt ??= Date.now();
      if (prev !== rec.status) this.log('status', { status: rec.status, poll: job.pollCount });
      if (TERMINAL.has(rec.status)) {
        job.timings.completedAt = Date.now();
        job.meetingPage = `${this.origin}${PATHS.meetingPage(job.recordingId)}`;
        if (rec.status === 'completed') {
          job.state = 'completed'; job.stateReason = null;
          await save(job);
          await this.fetchTranscript(job, signal, save); // I4b: the transcript comes back right here
          return;
        }
        job.state = 'error'; job.stateReason = rec.failed_insufficient_credits ? 'insufficient_credits' : `server_${rec.status}`;
        await save(job);
        return;
      }
      await save(job);
      await sleep(wait, signal);
      wait = Math.min(30_000, Math.round(wait * 1.5));
    }
  }

  // ── I4b: the transcript comes back ───────────────────────────────────────────────────
  /** Fetch + store the transcript of a completed job; failures land in job.transcript, never in job.state. */
  async fetchTranscript(job, signal, save) {
    const sid = job.sessionId;
    job.transcript = { ...(job.transcript ?? {}), state: 'pending', lastError: null };
    await save(job);
    try {
      if (job.localDeleted) { const e = new Error('the local files were deleted'); e.kind = 'local_deleted'; throw e; }
      const dir = await this.sessionDir(sid);
      job.transcript = await fetchAndStoreTranscript({ api: this.api, dir, job, log: this.log, signal, origin: this.origin });
      job.authLost = null;
      await save(job);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const info = errInfo(e);
      job.transcript = { ...(job.transcript ?? {}), state: 'error', lastError: info, checkedAt: Date.now() };
      if (e instanceof AuthLostError) job.authLost = { at: Date.now() };
      await save(job);
      this.log('transcript_failed', { sid, kind: info.kind, status: info.status, code: info.code, message: info.message });
    }
  }

  /**
   * A completed job on page open: read the recording, fetch the transcript when it is not stored,
   * replace the local snapshot when the server's updated_at moved (a paid unlock reprocesses the
   * recording; transcript-v2 may serve the OLD object while that runs, so the status is read first
   * and a non-terminal status goes back to polling), remember a server-side delete.
   */
  async syncCompleted(sid) {
    const job = this.jobs.get(sid);
    if (!job || job.state !== 'completed' || this.running.has(sid)) return job ?? null;
    const lease = await ledger.acquireLease(sid, this.owner);
    if (!lease.ok) return job;
    const abort = new AbortController();
    const signal = abort.signal;
    this.running.set(sid, { abort });
    const save = async (j) => { this.jobs.set(sid, j); await ledger.putJob(j); this.emit(sid); };
    try {
      let rec;
      try {
        rec = await withRetry(() => this.api.get(PATHS.recording(job.recordingId), { signal }), { signal, log: this.log, what: 'status_completed', attempts: 3 });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (e instanceof ApiError && e.status === 404) {
          const st = await this.auth.status();
          if (job.userId && st.userId && job.userId !== st.userId && st.previousUserId !== job.userId) {
            job.authLost = { at: Date.now(), reason: 'wrong_account' };
            job.transcript = { ...(job.transcript ?? {}), checkedAt: Date.now() };
            await save(job); this.log('wrong_account_404', { sid, jobUserId: job.userId, currentUserId: st.userId }); return job;
          }
          if (st.claimedAt && Date.now() - st.claimedAt < CLAIM_GRACE_MS && !job.serverDeleted) {
            job.transcript = { ...(job.transcript ?? {}), checkedAt: Date.now() - REVISION_CHECK_MS + 60_000 };
            await save(job); this.log('server_copy_moving', { sid, sinceClaimMs: Date.now() - st.claimedAt });
            if (!this.movingTimer) this.movingTimer = setTimeout(() => { this.movingTimer = null; this.resumeAll().catch(() => {}); }, 60_000);
            return job;
          }
          job.serverDeleted = job.serverDeleted ?? { at: Date.now(), reason: 'not_found' };
          job.transcript = { ...(job.transcript ?? {}), checkedAt: Date.now() };
          await save(job); this.log('server_copy_gone', { sid }); return job;
        }
        if (e instanceof AuthLostError) {
          job.authLost = { at: Date.now() };
          job.transcript = { ...(job.transcript ?? {}), state: job.transcript?.state === 'stored' ? 'stored' : 'error', lastError: errInfo(e), checkedAt: Date.now() };
          await save(job); return job;
        }
        throw e;
      }
      job.server = summarizeRecording(rec);
      job.authLost = null; // the session answered — an earlier auth loss no longer holds
      if (rec.status !== 'completed') {
        if (rec.status === 'deleted') job.serverDeleted = job.serverDeleted ?? { at: Date.now(), reason: 'server_deleted' };
        else if (!TERMINAL.has(rec.status)) {
          // Reprocessing: keep the local snapshot, poll again; the new run replaces it on completed.
          this.log('reprocess_detected', { sid, status: rec.status });
          job.state = 'processing'; job.stateReason = null; job.timings.processingSince = Date.now();
          await save(job);
          this.running.delete(sid); await ledger.releaseLease(sid, this.owner).catch(() => {});
          return this.run(sid);
        }
        job.transcript = { ...(job.transcript ?? {}), checkedAt: Date.now() };
        await save(job); return job;
      }
      const t = job.transcript;
      const changed = t?.state === 'stored' && !!t.recordingUpdatedAt && !!rec.updated_at && t.recordingUpdatedAt !== rec.updated_at;
      if (!t || t.state !== 'stored' || changed) {
        if (changed) {
          this.log('transcript_revision_changed', { sid, from: t.recordingUpdatedAt, to: rec.updated_at });
          // an export made before the revision describes the OLD transcript: forget it and remove the file (part-1 carry-over)
          const stale = Object.values(t.exports ?? {}).map((x) => x?.file).filter(Boolean);
          job.transcript = { ...t, exports: {} };
          if (stale.length) { try { const dir = await this.sessionDir(sid); for (const f of stale) { try { await dir.removeEntry(f); } catch { /* already gone */ } } } catch { /* no directory */ } }
        }
        await this.fetchTranscript(job, signal, save);
      } else {
        job.transcript = { ...t, checkedAt: Date.now() };
        await save(job);
      }
      return job;
    } catch (e) {
      if (e?.name !== 'AbortError') {
        this.log('sync_completed_failed', { sid, kind: e.kind ?? e.name, status: e.status ?? null, message: String(e.message ?? e).slice(0, 200) });
        job.transcript = { ...(job.transcript ?? {}), state: job.transcript?.state === 'stored' ? 'stored' : 'error', lastError: errInfo(e), checkedAt: Date.now() };
        await save(job);
      }
      return job;
    } finally {
      this.running.delete(sid);
      await ledger.releaseLease(sid, this.owner).catch(() => {});
      this.emit(sid);
    }
  }

  /** «Waiting for the server» → an immediate status read (pause + resume restarts the poll at 5 s). */
  async checkNow(sid) {
    const job = this.jobs.get(sid);
    if (!job || job.state !== 'processing') return job ?? null;
    if (this.running.has(sid)) await this.pause(sid, 'check_now');
    return this.resume(sid);
  }

  /** DELETE the server copy (soft-delete + erasure on the server); the local files stay. */
  async deleteOnServer(sid) {
    const job = this.jobs.get(sid);
    if (!job?.recordingId) throw new Error('This recording has no copy on IronMemo.');
    if (this.running.has(sid) || RESUMABLE.has(job.state)) throw new Error('Finish or cancel the upload first.');
    try { await this.api.del(PATHS.recording(job.recordingId)); }
    catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    job.serverDeleted = { at: Date.now(), reason: 'user' }; job.meetingPage = null;
    await ledger.putJob(job); this.jobs.set(sid, job); this.emit(sid);
    this.log('server_deleted', { sid, recordingId: job.recordingId });
    return job;
  }

  /** Ask the server for an export (srt/vtt/txt/json), download it, store export.<fmt> next to the audio. */
  async exportTranscript(sid, format) {
    const job = this.jobs.get(sid);
    if (!job?.recordingId || job.state !== 'completed') throw new Error('The transcript is not ready yet.');
    if (job.serverDeleted) throw new Error('The server copy was deleted; exports are rendered on the server.');
    if (this.running.has(sid)) throw new Error('Busy with this recording — try again in a moment.');
    const abort = new AbortController();
    this.running.set(sid, { abort });
    const save = async (j) => { this.jobs.set(sid, j); await ledger.putJob(j); this.emit(sid); };
    job.transcript = { ...(job.transcript ?? {}), exports: { ...(job.transcript?.exports ?? {}), [format]: { state: 'running', at: Date.now() } } };
    await save(job);
    try {
      const dir = await this.sessionDir(sid);
      // Speaker prefixes only when the transcript names speakers: with `speakers []` the server renders
      // «Unknown: …» on every cue (measured on production 2026-09-13, export fd5fd06c).
      const includeSpeakers = (job.transcript?.speakers ?? 0) > 0;
      const rec = await requestExport({ api: this.api, dir, job, format, log: this.log, signal: abort.signal, isOriginAllowed: (o) => this.isOriginAllowed(o), includeSpeakers });
      job.transcript.exports[format] = rec;
      await save(job);
      return rec;
    } catch (e) {
      job.transcript.exports[format] = { state: 'error', lastError: errInfo(e), at: Date.now() };
      await save(job);
      this.log('export_failed', { sid, format, kind: e.kind ?? e.name, status: e.status ?? null, code: e.code ?? null });
      throw e;
    } finally {
      this.running.delete(sid);
      this.emit(sid);
    }
  }

  async sessionDir(sid) {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle('sessions');
    return sessions.getDirectoryHandle(sid);
  }
}
