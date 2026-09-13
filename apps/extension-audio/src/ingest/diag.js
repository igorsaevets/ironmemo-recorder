/**
 * diag.js — error statistics that survive a browser restart, and a «Copy diagnostics» payload.
 *
 * Igor (2026-09-13): «Не забывать выдавать пользователю сообщения об различных ошибках. И нам тоже,
 * чтобы мы знали для статистики.» The user-facing half is the strings map; this is the «нам тоже»
 * half that needs no new server endpoint: every error-class event the redacting log emits is also
 * counted here (chrome.storage.local, key ironmemo.errorStats.v1 — counts per event/code plus the
 * last 30 entries, no ids, no e-mail, no text). The Recordings page copies the payload to the
 * clipboard so a person can paste it into a support message; a server-side channel (a client
 * header is already sent on every call — api.js X-IronMemo-Client) is the backend maintainer's item.
 */

export const STATS_KEY = 'ironmemo.errorStats.v1';
const MAX_LAST = 30;
let chain = Promise.resolve();

/** Called by log.js for error-class events; `fields` are already redacted. */
export function noteError(scope, event, fields = {}) {
  const entry = {
    t: Date.now(), scope, event,
    kind: fields.kind ?? null, code: fields.code ?? null, status: fields.status ?? null,
    reason: fields.reason ?? fields.stateReason ?? null, step: fields.step ?? null, what: fields.what ?? null,
  };
  chain = chain.then(async () => {
    const cur = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY] ?? { counts: {}, last: [], firstAt: Date.now() };
    const key = `${scope}.${event}` + (entry.code ? `:${entry.code}` : entry.kind ? `:${entry.kind}` : '');
    cur.counts[key] = (cur.counts[key] ?? 0) + 1;
    cur.last.push(entry);
    if (cur.last.length > MAX_LAST) cur.last.splice(0, cur.last.length - MAX_LAST);
    cur.updatedAt = Date.now();
    await chrome.storage.local.set({ [STATS_KEY]: cur });
  }).catch(() => {});
  return chain;
}

export async function readStats() {
  try { return (await chrome.storage.local.get(STATS_KEY))[STATS_KEY] ?? { counts: {}, last: [], firstAt: null }; }
  catch { return { counts: {}, last: [], firstAt: null }; }
}

/** What a support message needs and nothing a person would not want pasted: versions, states, counts. */
export async function buildDiagnostics({ jobs = [], account = null } = {}) {
  let version = null;
  try { version = chrome.runtime.getManifest().version; } catch { /* not an extension page */ }
  const byState = {};
  const transports = {};
  for (const j of jobs) {
    const k = j.state === 'error' || j.state === 'paused' ? `${j.state}:${j.stateReason ?? '?'}` : j.state;
    byState[k] = (byState[k] ?? 0) + 1;
    if (j.transport) transports[j.transport] = (transports[j.transport] ?? 0) + 1;
  }
  const stats = await readStats();
  return {
    extension: version, at: new Date().toISOString(), browser: navigator.userAgent,
    account: account ? { kind: account.kind ?? null, via: account.via ?? null, claimed: !!account.claimedAt, lost: !!account.lost } : null,
    jobs: { total: jobs.length, byState, transports, withTranscript: jobs.filter((j) => j.transcript?.state === 'stored').length },
    errors: { since: stats.firstAt ? new Date(stats.firstAt).toISOString() : null, counts: stats.counts, last: stats.last.slice(-15).map((e) => ({ ...e, t: new Date(e.t).toISOString() })) },
  };
}
