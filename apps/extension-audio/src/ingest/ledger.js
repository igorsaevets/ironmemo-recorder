/**
 * ledger.js — durable job records ("resume ledger") in chrome.storage.local.
 *
 * One key per session (`ironmemo.ingest.v1:<sessionId>`), never one shared map: the review
 * measured that two concurrent read-modify-write updates of ONE storage map keep only the
 * second ACK (local-browser-results.json, parallel_parts_lost_update). Per-key records plus a
 * per-page write chain make every part ACK durable on its own.
 *
 * The record holds the remaining presigned URLs (there is no read/re-sign route on the server,
 * only start/complete/abort) — it is therefore a credential store and stays under
 * TRUSTED_CONTEXTS (auth.js hardenStorage). It is never exported with settings/profiles.
 *
 * Leases use the Web Locks API (navigator.locks) for true atomic mutual exclusion across
 * extension pages. A lock is held for the full duration of the upload operation and released
 * automatically when the page closes. No TTL or renewal polling needed.
 * A2 fix — the previous storage-based get→set→get was not atomic (audit 20.09.2026).
 */

export const JOB_PREFIX = 'ironmemo.ingest.v1:';
export const LEASE_PREFIX = 'ironmemo.ingestLease.v1:';
export const LEDGER_SCHEMA = 1;

let chain = Promise.resolve();
function serialized(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

export async function listJobs() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith(JOB_PREFIX)).map(([, v]) => v);
}

export async function getJob(sessionId) {
  return (await chrome.storage.local.get(JOB_PREFIX + sessionId))[JOB_PREFIX + sessionId] ?? null;
}

export function putJob(job) {
  return serialized(async () => {
    job.schemaVersion = LEDGER_SCHEMA;
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ [JOB_PREFIX + job.sessionId]: job });
    return job;
  });
}

/** Read-modify-write of ONE record, serialized within this page. patch(job) mutates and returns it. */
export function updateJob(sessionId, patch) {
  return serialized(async () => {
    const key = JOB_PREFIX + sessionId;
    const cur = (await chrome.storage.local.get(key))[key];
    if (!cur) throw new Error(`ledger: no job for session ${sessionId}`);
    const next = patch(cur) ?? cur;
    next.schemaVersion = LEDGER_SCHEMA;
    next.updatedAt = Date.now();
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
}

export function removeJob(sessionId) {
  return serialized(() => chrome.storage.local.remove([JOB_PREFIX + sessionId, LEASE_PREFIX + sessionId]));
}

/**
 * Acquire an exclusive lock for the given session using the Web Locks API.
 * Returns { ok: true, release: Function } or { ok: false }.
 * The lock is held until release() is called or the page is destroyed.
 */
export function acquireLease(sessionId) {
  return new Promise((resolve) => {
    try {
      navigator.locks.request(LEASE_PREFIX + sessionId, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve({ ok: false }); return; }
        return new Promise((releaseFn) => {
          resolve({ ok: true, release: () => releaseFn() });
        });
      }).catch(() => resolve({ ok: false }));
    } catch { resolve({ ok: false }); }
  });
}

/** States in which the page is (or should be) actively working on the job. */
export function isActiveState(state) {
  return ['session', 'creating', 'uploading', 'finalizing', 'finalize_unknown', 'processing'].includes(state);
}
