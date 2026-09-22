/**
 * auth.js — ONE auth broker for the extension ("guest first", ADR-008).
 *
 * Storage layout (why: CODEX.md Q1 — the refresh credential persists, the access one does not):
 *   chrome.storage.local   ironmemo.account.v1  {kind:'guest'|'user', apiOrigin, refresh, device_id,
 *                                                user:{id,is_anonymous,auth_type,emailMasked,is_email_verified},
 *                                                status, via:'guest'|'email', obtained_at, rotated_at, claimedAt,
 *                                                previousUserId, lost:{at,status}|null} — the e-mail is kept MASKED only
 *   chrome.storage.local   ironmemo.device.v1   {device_id} — survives logout, like the web app's
 *                                                device repo (auth-storage.ts: anti-abuse continuity)
 *   chrome.storage.session ironmemo.access.v1   {access, apiOrigin, userId, obtained_at}
 *
 * hardenStorage() sets TRUSTED_CONTEXTS on both areas before anything secret is written: a
 * content script (none today) could otherwise read chrome.storage.local — measured by the
 * review in CfT 152 (codex-second-opinion/artifacts/local-browser-results.json). Guarded call:
 * the reference page (accessed 2026-09-13) does not state the Chrome version for `local`.
 *
 * Refresh is single-flight per page AND guarded by a short lock in storage.session across
 * pages, because the server ROTATES the refresh credential: two pages refreshing with the same
 * old value would make the second one look like a replay. The rotated pair is saved together
 * before any waiter is released.
 *
 * Never logged: any credential value. Only lengths and ids.
 */

import { PATHS, ApiError, TransportError, AuthLostError, clientTag } from './api.js';
import { maskEmail } from './claim.js';

export const ACCOUNT_KEY = 'ironmemo.account.v1';
export const ACCESS_KEY = 'ironmemo.access.v1';
export const DEVICE_KEY = 'ironmemo.device.v1';
const LOCK_KEY = 'ironmemo.refreshLock.v1';
const LOCK_TTL_MS = 8000;

let hardened = null;
export function hardenStorage() {
  if (hardened) return hardened;
  hardened = (async () => {
    const out = { local: null, session: null };
    try {
      if (typeof chrome.storage.local.setAccessLevel === 'function') {
        await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        out.local = 'TRUSTED_CONTEXTS';
      } else out.local = 'setAccessLevel unavailable';
    } catch (e) { out.local = `error: ${e?.message ?? e}`; }
    try {
      if (chrome.storage.session && typeof chrome.storage.session.setAccessLevel === 'function') {
        await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        out.session = 'TRUSTED_CONTEXTS';
      } else out.session = 'setAccessLevel unavailable';
    } catch (e) { out.session = `error: ${e?.message ?? e}`; }
    return out;
  })();
  return hardened;
}

function validPair(p) {
  return !!p && typeof p.access === 'string' && p.access.length > 20 && typeof p.refresh === 'string' && p.refresh.length > 20;
}

const PLAIN_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-IronMemo-Client': clientTag() };

export function createAuth({ apiOrigin, log = () => {} }) {
  const pageId = crypto.randomUUID();
  let refreshing = null;
  let memAccess = null;

  async function loadAccount() { return (await chrome.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY] ?? null; }
  async function saveAccount(acc) { await chrome.storage.local.set({ [ACCOUNT_KEY]: acc }); }
  async function loadAccess() {
    try {
      const a = (await chrome.storage.session.get(ACCESS_KEY))[ACCESS_KEY];
      return a?.apiOrigin === apiOrigin ? a : null;
    } catch { return null; }
  }
  async function saveAccess(a) {
    memAccess = a;
    try { await chrome.storage.session.set({ [ACCESS_KEY]: a }); } catch { /* memory only */ }
  }
  async function clearAccess() {
    memAccess = null;
    try { await chrome.storage.session.remove(ACCESS_KEY); } catch { /* ignore */ }
  }

  async function deviceId() {
    const cur = (await chrome.storage.local.get(DEVICE_KEY))[DEVICE_KEY];
    if (cur?.device_id) return cur.device_id;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_KEY]: { device_id: id, createdAt: Date.now() } });
    return id;
  }

  async function status() {
    const acc = await loadAccount();
    return {
      hasAccount: !!acc && !acc.lost && acc.apiOrigin === apiOrigin,
      kind: acc?.kind ?? null,
      userId: acc?.user?.id ?? null,
      isAnonymous: acc?.user?.is_anonymous ?? null,
      lost: acc?.lost ?? null,
      obtainedAt: acc?.obtained_at ?? null,
      emailMasked: acc?.user?.emailMasked ?? null,
      via: acc?.via ?? null,
      claimedAt: acc?.claimedAt ?? null,
      previousUserId: acc?.previousUserId ?? null,
    };
  }

  /** Bare POST for the two credential endpoints (no Bearer, no cookies). */
  async function postPlain(path, json) {
    let res;
    try {
      res = await fetch(apiOrigin + path, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: PLAIN_HEADERS, body: JSON.stringify(json),
      });
    } catch (e) { throw new TransportError(`No answer from ${apiOrigin} (${e?.message ?? e})`, { cause: e, path }); }
    return res;
  }

  /** Returns the account, creating a guest when there is none. Only called after consent. */
  async function ensureSession() {
    await hardenStorage();
    const acc = await loadAccount();
    if (acc?.lost) throw new AuthLostError();
    if (acc?.refresh && acc.apiOrigin === apiOrigin) return acc;
    return createGuest();
  }

  async function createGuest() {
    const device_id = await deviceId();
    const res = await postPlain(PATHS.anonymous, { device_id });
    if (!res.ok) throw await ApiError.fromResponse(res, PATHS.anonymous);
    const data = await res.json();
    if (!validPair(data?.tokens)) throw new ApiError({ status: res.status, message: 'anonymous: missing token pair', path: PATHS.anonymous });
    const acc = {
      kind: data.user?.is_anonymous === false ? 'user' : 'guest',
      apiOrigin, refresh: data.tokens.refresh, device_id,
      user: { id: data.user?.id ?? null, is_anonymous: data.user?.is_anonymous ?? true, auth_type: data.user?.auth_type ?? null, emailMasked: null, is_email_verified: false },
      status: data.status ?? null, via: 'guest', obtained_at: Date.now(), rotated_at: null, claimedAt: null, previousUserId: null, lost: null,
    };
    await saveAccount(acc);
    await saveAccess({ access: data.tokens.access, apiOrigin, userId: acc.user.id, obtained_at: Date.now() });
    log('auth.guest_created', { userId: acc.user.id, status: acc.status, accessLength: data.tokens.access.length, refreshLength: data.tokens.refresh.length });
    return acc;
  }

  /**
   * The e-mail claim answered with a token pair (AuthResponse): it replaces the stored account —
   * REGISTERED upgrades the guest in place (same id), MERGED / LOGGED_IN switch to the existing
   * account (new id; `previousUserId` remembers the guest whose rows are being carried across).
   * The e-mail is stored MASKED only; the full address is never written or logged.
   */
  async function adoptSession(data, { via = 'email', emailMasked = null } = {}) {
    await hardenStorage();
    if (!validPair(data?.tokens)) throw new ApiError({ status: 200, message: 'verify: missing token pair', path: PATHS.emailVerify });
    const device_id = await deviceId();
    const prev = await loadAccount();
    const u = data.user ?? {};
    const acc = {
      kind: u.is_anonymous === true ? 'guest' : 'user', apiOrigin, refresh: data.tokens.refresh, device_id,
      user: { id: u.id ?? null, is_anonymous: u.is_anonymous ?? false, auth_type: u.auth_type ?? via, emailMasked: emailMasked ?? maskEmail(u.email) ?? null, is_email_verified: u.is_email_verified ?? null },
      status: data.status ?? null, via, obtained_at: Date.now(), rotated_at: null, claimedAt: Date.now(),
      previousUserId: prev?.user?.id && prev.user.id !== u.id ? prev.user.id : null, lost: null,
    };
    await saveAccount(acc);
    await saveAccess({ access: data.tokens.access, apiOrigin, userId: acc.user.id, obtained_at: Date.now() });
    log('auth.session_adopted', { via, status: acc.status, kind: acc.kind, userId: acc.user.id, previousUserId: acc.previousUserId, accessLength: data.tokens.access.length, refreshLength: data.tokens.refresh.length });
    return acc;
  }

  async function getAccess() {
    if (memAccess?.access) return memAccess.access;
    const a = await loadAccess();
    if (a?.access) { memAccess = a; return a.access; }
    return (await refresh({ reason: 'no_access' })).access;
  }

  async function withLock(fn) {
    // Best-effort cross-page lock in storage.session (not atomic, but shrinks the race to ms).
    const deadline = Date.now() + LOCK_TTL_MS * 2;
    for (;;) {
      let cur = null;
      try { cur = (await chrome.storage.session.get(LOCK_KEY))[LOCK_KEY] ?? null; } catch { break; }
      if (!cur || cur.owner === pageId || Date.now() - cur.at > LOCK_TTL_MS) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    try { await chrome.storage.session.set({ [LOCK_KEY]: { owner: pageId, at: Date.now() } }); } catch { /* ignore */ }
    try { return await fn(); }
    finally { try { await chrome.storage.session.remove(LOCK_KEY); } catch { /* ignore */ } }
  }

  /**
   * refresh({staleAccess, reason}) → {access,…}. Single-flight: N concurrent 401s share one call.
   * If the access value in memory is already newer than the one that got the 401, no call is made.
   */
  function refresh({ staleAccess = null, reason = 'unknown' } = {}) {
    if (staleAccess && memAccess?.access && memAccess.access !== staleAccess) return Promise.resolve(memAccess);
    if (refreshing) return refreshing;
    refreshing = withLock(async () => {
      // Another page may have rotated meanwhile: re-read both before spending the credential.
      const fresh = await loadAccess();
      if (fresh?.access && fresh.access !== staleAccess) { memAccess = fresh; return fresh; }
      const acc = await loadAccount();
      if (!acc?.refresh || acc.lost || acc.apiOrigin !== apiOrigin) throw new AuthLostError();
      const res = await postPlain(PATHS.refresh, { refresh: acc.refresh });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const again = await loadAccount();
        if (again?.refresh && again.refresh !== acc.refresh) { // rotated by a sibling page — not lost
          const a2 = await loadAccess();
          if (a2?.access) { memAccess = a2; return a2; }
        }
        await saveAccount({ ...acc, lost: { at: Date.now(), status: res.status } });
        await clearAccess();
        log('auth.lost', { status: res.status, reason });
        throw new AuthLostError();
      }
      if (!res.ok) throw await ApiError.fromResponse(res, PATHS.refresh);
      const pair = await res.json();
      if (!validPair(pair)) throw new ApiError({ status: res.status, message: 'refresh: bad token pair', path: PATHS.refresh });
      await saveAccount({ ...acc, refresh: pair.refresh, rotated_at: Date.now() });
      await saveAccess({ access: pair.access, apiOrigin, userId: acc.user?.id ?? null, obtained_at: Date.now() });
      log('auth.refreshed', { reason, userId: acc.user?.id ?? null });
      return memAccess;
    }).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function logout() {
    await chrome.storage.local.remove(ACCOUNT_KEY);
    await clearAccess();
    log('auth.logout', {});
  }

  /** Invalidate the in-memory access cache so the next getAccess() re-reads storage.
   *  Called by the controller when chrome.storage.onChanged fires for ACCOUNT_KEY. */
  function invalidateCache() { memAccess = null; }

  /** Test hook (bench only): alias kept for existing bench scripts. */
  function _resetMemory() { invalidateCache(); }

  return { pageId, status, ensureSession, getAccess, refresh, logout, loadAccount, hardenStorage, deviceId, adoptSession, invalidateCache, _resetMemory };
}
