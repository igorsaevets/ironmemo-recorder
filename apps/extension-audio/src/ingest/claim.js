/**
 * claim.js — the e-mail claim: the extension's identity becomes a verified IronMemo account.
 *
 * Product rule (Igor, 2026-09-13, option «б»): the free minutes of transcription are granted only
 * after the e-mail is verified — so the code step comes BEFORE the first upload (settings
 * `upload.authMode = 'email'`, the default). A guest that already exists (profiles from the I4a
 * build) is MERGED into / upgraded to the account by the same two calls.
 *
 * Contract (`from docs`: iron-note-backend origin/main `docs/auth-frontend.md` §1 and the frontend's
 * origin/main `src/api/schemas/auth.d.ts`, read 2026-09-13; `measured` on production the same day:
 * `GET /auth/api/v1/capabilities/` → otp {email_code_length 6, ttl_seconds 600,
 * resend_cooldown_seconds 30}, registration.email true, email_mock false):
 *   POST /auth/api/v1/email/request/ {email, device_id?} → 200 {message, target "u***@example.com"}
 *        429 error.429.rate_limit (1 request per 30 s per e-mail/device, params.retry_after_minutes)
 *        409 error.409.email_taken (only for an authenticated NON-anonymous caller)
 *   POST /auth/api/v1/email/verify/  {email, code}       → 200 AuthResponse {status, user, tokens}
 *        status REGISTERED (nobody or a guest + a new e-mail) | LOGGED_IN (nobody + an existing
 *        e-mail) | MERGED (a guest + an existing e-mail: the guest's rows are carried across) |
 *        MODIFIED; a 200 with status REJECTED is an invalid code as well
 *        400 error.400.invalid_code_attempts {attempts_remaining} · 400 error.400.code_expired ·
 *        422 error.422.blocked / 423 error.423.account_locked {retry_after_minutes} (5 wrong codes
 *        lock the identifier: 15 min, then 1 h, then 24 h)
 *   POST /auth/api/v1/logout/ {refresh_token}            → 200 {message}; both tokens blacklisted
 * Both claim calls carry the guest's Bearer when a guest exists — that is what makes the server
 * MERGE instead of signing into a different account (codex-second-opinion/CODEX.md Q1).
 *
 * The pending claim (the plain e-mail is needed for the verify call, the masked target for the UI,
 * timestamps for the cooldown/TTL countdowns) lives in chrome.storage.session under
 * `ironmemo.claim.v1` while a code is outstanding and is removed on success or cancel. The account
 * record keeps only the MASKED e-mail. Never logged: the e-mail, the code, any token.
 */

import { PATHS, ApiError, TransportError, AuthLostError } from './api.js';

export const CLAIM_KEY = 'ironmemo.claim.v1';
/** After MERGED the recordings move to the account asynchronously (`user.merged` over Kafka); a 404 inside this window is «moving», not «deleted». */
export const CLAIM_GRACE_MS = 30 * 60 * 1000;
const CAPS_TTL_MS = 10 * 60 * 1000;
const FALLBACK_OTP = Object.freeze({ codeLength: 6, ttlSeconds: 600, resendCooldownSeconds: 30 });

/** «u***@example.com» — the same shape the server uses in OtpSentResponse.target. */
export function maskEmail(email) {
  const s = String(email ?? '').trim();
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : null;
  return `${s[0]}***${s.slice(at)}`;
}

export function isPlausibleEmail(s) {
  const v = String(s ?? '').trim();
  return v.length >= 6 && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/**
 * Every failure of the claim becomes {kind, message, retryAfterMinutes, attemptsRemaining, status, code}
 * so the page renders ONE message per kind (Igor: «выдавать пользователю сообщения об ошибках»).
 * kinds: invalid_code | code_expired | locked | rate_limited | email_taken | captcha | invalid_email |
 *        auth_lost | transport | server | shape | client
 */
export function normalizeClaimError(e) {
  const out = { kind: 'client', message: String(e?.message ?? e).slice(0, 200), retryAfterMinutes: null, attemptsRemaining: null, status: e?.status ?? null, code: e?.code ?? null };
  const p = e?.params ?? {};
  if (e instanceof TransportError) out.kind = 'transport';
  else if (e instanceof AuthLostError) out.kind = 'auth_lost';
  else if (e instanceof ApiError) {
    out.kind = e.kind;
    if (e.status === 429) out.kind = 'rate_limited';
    if (e.status >= 500) out.kind = 'server';
    if (e.code && /^error\.400\.field\./.test(e.code)) out.kind = 'invalid_email';
    if (e.code === 'error.400.invalid_email' || (e.status === 400 && out.kind === 'client' && /email/i.test(e.message))) out.kind = 'invalid_email';
  } else if (e?.kind) out.kind = e.kind;
  const ram = Number(p.retry_after_minutes);
  if (Number.isFinite(ram)) out.retryAfterMinutes = ram;
  else if (Number.isFinite(Number(p.retry_after))) out.retryAfterMinutes = Math.max(1, Math.ceil(Number(p.retry_after) / 60));
  const ar = Number(p.attempts_remaining);
  if (Number.isFinite(ar)) out.attemptsRemaining = ar;
  return out;
}

export function createClaim({ api, auth, log = () => {} }) {
  let caps = null;

  async function load() {
    try { return (await chrome.storage.session.get(CLAIM_KEY))[CLAIM_KEY] ?? null; } catch { return null; }
  }
  async function save(p) { try { await chrome.storage.session.set({ [CLAIM_KEY]: p }); } catch { /* memory only */ } }
  async function clear() { try { await chrome.storage.session.remove(CLAIM_KEY); } catch { /* ignore */ } }

  /** Server-authoritative OTP parameters (AllowAny); cached 10 min; a fallback keeps the dialog usable offline. */
  async function capabilities() {
    if (caps && Date.now() - caps.at < CAPS_TTL_MS) return caps;
    try {
      const d = await api.get(PATHS.capabilities, { auth: false });
      const otp = d?.otp ?? {};
      const email = (d?.methods ?? []).find((m) => m?.id === 'email') ?? null;
      caps = {
        at: Date.now(), fromServer: true,
        codeLength: Number.isFinite(otp.email_code_length) ? otp.email_code_length : FALLBACK_OTP.codeLength,
        ttlSeconds: Number.isFinite(otp.ttl_seconds) ? otp.ttl_seconds : FALLBACK_OTP.ttlSeconds,
        resendCooldownSeconds: Number.isFinite(otp.resend_cooldown_seconds) ? otp.resend_cooldown_seconds : FALLBACK_OTP.resendCooldownSeconds,
        emailEnabled: email ? email.enabled !== false : (d?.registration?.email !== false),
        emailMock: !!(email?.mock ?? d?.registration?.email_mock),
      };
      log('claim.capabilities', { codeLength: caps.codeLength, ttlSeconds: caps.ttlSeconds, cooldown: caps.resendCooldownSeconds, emailEnabled: caps.emailEnabled, emailMock: caps.emailMock });
    } catch (e) {
      caps = { at: Date.now(), fromServer: false, ...FALLBACK_OTP, emailEnabled: true, emailMock: false, error: String(e?.message ?? e).slice(0, 120) };
      log('claim.capabilities_fallback', { kind: e?.kind ?? e?.name });
    }
    return caps;
  }

  /**
   * Ask the server for a code. With a live guest the call carries the guest's Bearer (→ MERGED /
   * REGISTERED on verify); when the guest key is dead the request is repeated without it — the
   * claim then signs into / creates the account but cannot carry the old guest's recordings.
   */
  async function requestCode(email, { resend = false } = {}) {
    const clean = String(email ?? '').trim().toLowerCase();
    if (!isPlausibleEmail(clean)) { const e = new Error('Enter a valid e-mail address.'); e.kind = 'invalid_email'; throw normalizeClaimError(e); }
    const c = await capabilities();
    const st = await auth.status();
    const hadGuest = st.hasAccount && st.kind !== 'user'; // a guest existed when the claim started (even if its key turns out dead)
    let withGuest = hadGuest;
    const authed = st.hasAccount; // a signed-in user re-verifying (reconnect) also carries its Bearer while it has one
    const device_id = await auth.deviceId();
    let res;
    try {
      res = await api.post(PATHS.emailRequest, { email: clean, device_id }, { auth: authed });
    } catch (e) {
      if (e instanceof AuthLostError && authed) {
        log('claim.guest_key_dead', { kind: e.kind });
        withGuest = false;
        try { res = await api.post(PATHS.emailRequest, { email: clean, device_id }, { auth: false }); }
        catch (e2) { throw rethrow(e2, 'request'); }
      } else throw rethrow(e, 'request');
    }
    const prev = await load();
    const pending = {
      email: clean, target: typeof res?.target === 'string' && res.target ? res.target : maskEmail(clean),
      requestedAt: Date.now(), requests: (prev?.email === clean ? (prev.requests ?? 0) : 0) + 1,
      cooldownSeconds: c.resendCooldownSeconds, ttlSeconds: c.ttlSeconds, codeLength: c.codeLength,
      attemptsRemaining: null, lockedUntil: null, withGuest, guestUserId: hadGuest ? st.userId : null, lastError: null,
    };
    await save(pending);
    log('claim.code_requested', { withGuest, resend, requests: pending.requests, cooldown: c.resendCooldownSeconds });
    return pending;
  }

  /** Verify the code; on success the token pair replaces the account (auth.adoptSession). */
  async function verify(code) {
    const p = await load();
    if (!p) { const e = new Error('Ask for a code first.'); e.kind = 'client'; throw normalizeClaimError(e); }
    const clean = String(code ?? '').replace(/\s+/g, '');
    if (!clean) { const e = new Error('Enter the code from the e-mail.'); e.kind = 'invalid_code'; throw normalizeClaimError(e); }
    const st = await auth.status();
    const authed = st.hasAccount && (p.withGuest || st.kind === 'user');
    let res;
    try {
      res = await api.post(PATHS.emailVerify, { email: p.email, code: clean }, { auth: authed });
    } catch (e) {
      const n = rethrow(e, 'verify');
      if (n.attemptsRemaining != null) p.attemptsRemaining = n.attemptsRemaining;
      if (n.kind === 'locked') p.lockedUntil = Date.now() + Math.max(1, n.retryAfterMinutes ?? 15) * 60 * 1000;
      p.lastError = { kind: n.kind, at: Date.now() };
      await save(p);
      throw n;
    }
    if (res?.status === 'REJECTED' || !res?.tokens) {
      const e = new Error('The code was not accepted.'); e.kind = 'invalid_code';
      log('claim.rejected', { status: res?.status ?? null });
      throw normalizeClaimError(e);
    }
    const acc = await auth.adoptSession(res, { via: 'email', emailMasked: p.target });
    await clear();
    log('claim.verified', { status: res.status, kind: acc.kind, withGuest: p.withGuest, merged: res.status === 'MERGED', previousUserId: acc.previousUserId });
    return { status: res.status, emailMasked: acc.user.emailMasked, userId: acc.user.id, previousUserId: acc.previousUserId, withGuest: p.withGuest };
  }

  /** Server logout (best effort: the refresh in the body, a fresh access in the header, no replay) → local wipe. */
  async function signOut() {
    const out = { serverOk: false, status: null, kind: null };
    try {
      await auth.getAccess(); // may rotate the pair — read the refresh AFTER
      const acc = await auth.loadAccount();
      if (acc?.refresh) {
        await api.post(PATHS.logout, { refresh_token: acc.refresh }, { replay: false });
        out.serverOk = true; out.status = 200;
      }
    } catch (e) {
      out.status = e?.status ?? null; out.kind = e?.kind ?? e?.name ?? 'error';
      log('claim.logout_failed', { kind: out.kind, status: out.status });
    }
    await auth.logout();
    await clear();
    log('claim.signed_out', { serverOk: out.serverOk });
    return out;
  }

  function rethrow(e, step) {
    const n = normalizeClaimError(e);
    log('claim.failed', { step, kind: n.kind, status: n.status, code: n.code, retryAfterMinutes: n.retryAfterMinutes, attemptsRemaining: n.attemptsRemaining });
    return n;
  }

  return { capabilities, requestCode, verify, signOut, pending: load, clear, maskEmail };
}
