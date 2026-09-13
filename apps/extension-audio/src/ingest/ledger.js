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
 * Leases (`ironmemo.ingestLease.v1:<sessionId>`) stop two Recordings pages from running the
 * same job; a lease older than LEASE_TTL_MS is dead (page closed) and may be taken over.
 */

export const JOB_PREFIX = 'ironmemo.ingest.v1:';
export const LEASE_PREFIX = 'ironmemo.ingestLease.v1:';
export const LEASE_TTL_MS = 15_000;
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

export async function acquireLease(sessionId, owner) {
  const key = LEASE_PREFIX + sessionId;
  const cur = (await chrome.storage.local.get(key))[key];
  if (cur && cur.owner !== owner && Date.now() - cur.at < LEASE_TTL_MS) return { ok: false, owner: cur.owner, at: cur.at };
  await chrome.storage.local.set({ [key]: { owner, at: Date.now() } });
  const check = (await chrome.storage.local.get(key))[key];
  return { ok: check?.owner === owner, owner: check?.owner ?? null, at: check?.at ?? null };
}

export async function renewLease(sessionId, owner) {
  const key = LEASE_PREFIX + sessionId;
  const cur = (await chrome.storage.local.get(key))[key];
  if (cur && cur.owner !== owner && Date.now() - cur.at < LEASE_TTL_MS) return false;
  await chrome.storage.local.set({ [key]: { owner, at: Date.now() } });
  return true;
}

export async function releaseLease(sessionId, owner) {
  const key = LEASE_PREFIX + sessionId;
  const cur = (await chrome.storage.local.get(key))[key];
  if (cur?.owner === owner) await chrome.storage.local.remove(key);
}

/** States in which the page is (or should be) actively working on the job. */
export function isActiveState(state) {
  return ['session', 'creating', 'uploading', 'finalizing', 'finalize_unknown', 'processing'].includes(state);
}
