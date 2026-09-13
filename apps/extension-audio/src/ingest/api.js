/**
 * api.js — Bearer client for the live IronMemo API.
 *
 * Contract measured 2026-09-13 (03-research/I4-ingest/TECH-IDEAS.md §1, spike-01 fixtures):
 *   auth        /auth/api/v1/…               WITH trailing slash
 *   workspaces  /workspaces/api/v1/
 *   recordings  /recordings/api/recordings…  WITHOUT trailing slash (with slash → 404)
 * Error envelope: {localizable_error, error, params}.
 *
 * Rules adopted from the independent review (CODEX.md Q1/Q2, ADR-008 «Уточнения»):
 *   - credentials:'omit' — a website cookie session must never select a different identity;
 *   - 401 → ONE refresh (single-flight inside auth.js) → replay ONCE; a second 401 is auth loss;
 *   - 402/413/415 are answers, never retried; 5xx/network are retried by the caller with backoff;
 *   - a transport failure (no HTTP answer) is its own class: the outcome on the server is UNKNOWN.
 */

export const PATHS = Object.freeze({
  anonymous: '/auth/api/v1/anonymous/',
  refresh: '/auth/api/v1/token/refresh/',
  me: '/auth/api/v1/me/',
  emailRequest: '/auth/api/v1/email/request/',
  emailVerify: '/auth/api/v1/email/verify/',
  workspaces: '/workspaces/api/v1/',
  uploadLimits: '/recordings/api/recordings/upload-limits',
  recordings: '/recordings/api/recordings',
  recording: (id) => `/recordings/api/recordings/${id}`,
  uploadSessions: (id) => `/recordings/api/recordings/${id}/upload-sessions`,
  finalize: (id, up) => `/recordings/api/recordings/${id}/upload-sessions/${up}/finalize`,
  multipart: (id) => `/recordings/api/recordings/${id}/multipart`,
  complete: (id, up) => `/recordings/api/recordings/${id}/multipart/${up}/complete`,
  abort: (id, up) => `/recordings/api/recordings/${id}/multipart/${up}/abort`,
  transcriptV2: (id) => `/recordings/api/recordings/${id}/transcript-v2`,
  exports: (id) => `/recordings/api/recordings/${id}/exports`,
  exportDetail: (exportId) => `/recordings/api/exports/${exportId}`,
  entitlement: '/recordings/api/entitlement',
  meetingPage: (id) => `/app/meetings/${id}`,
});

/** The server answered with a non-2xx status. `kind` drives retry/UI decisions. */
export class ApiError extends Error {
  constructor({ status, code = null, message = null, params = null, path = null }) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status; this.code = code; this.params = params; this.path = path;
    this.kind = classify(status);
    // Error keys that mean more than their HTTP status (recordings_ext/errors.py, origin/main
    // 6720f51, 2026-09-13): the server says "too large" with a 400, not a 413.
    if (code === 'error.400.file_too_large') this.kind = 'too_large';
    else if (code === 'error.400.duration_too_long') this.kind = 'too_long';
    else if (code === 'error.402.insufficient_credits' || code === 'error.402.payment_required') this.kind = 'payment';
  }

  static async fromResponse(res, path) {
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return new ApiError({
      status: res.status,
      path,
      code: data?.localizable_error ?? null,
      message: data?.error ?? (typeof data?.detail === 'string' ? data.detail : null) ?? `HTTP ${res.status}`,
      params: data?.params ?? null,
    });
  }
}

/** No HTTP answer at all (DNS, TLS, connection reset, offline). The server MAY have acted. */
export class TransportError extends Error {
  constructor(message, { cause, path } = {}) {
    super(message, { cause });
    this.name = 'TransportError'; this.path = path ?? null; this.kind = 'transport';
  }
}

/** Refresh failed for good: the stored guest key no longer opens the account. */
export class AuthLostError extends Error {
  constructor(message = 'The saved IronMemo session is no longer valid.') {
    super(message);
    this.name = 'AuthLostError'; this.kind = 'auth_lost';
  }
}

export function classify(status) {
  if (status === 401) return 'auth';
  if (status === 402) return 'payment';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 415) return 'unsupported';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'ok';
}

/** Errors that a bounded retry may fix. Everything else is an answer. */
export function isRetryable(e) {
  return e instanceof TransportError || e?.kind === 'server' || e?.kind === 'rate_limited';
}

/** Path template for logs: ids → {id}. */
export function templ(path) {
  return String(path).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}');
}

/**
 * createApi({ baseUrl, auth, log }) → { origin, request, get, post, del }
 * `auth` is the broker from auth.js: getAccess() and refresh({staleAccess}).
 */
export function createApi({ baseUrl, auth, log = () => {} }) {
  const origin = new URL(baseUrl).origin;

  async function request(method, path, { json, auth: needAuth = true, replay = true, signal, raw = false } = {}) {
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    let usedAccess = null;
    if (needAuth) { usedAccess = await auth.getAccess(); headers.Authorization = `Bearer ${usedAccess}`; }
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(origin + path, { method, headers, body, credentials: 'omit', cache: 'no-store', redirect: 'error', signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      log('api.transport_error', { method, path: templ(path), error: String(e?.message ?? e) });
      throw new TransportError(`No answer from ${origin} (${e?.message ?? e})`, { cause: e, path });
    }
    const ms = Math.round(performance.now() - t0);
    if (res.status === 401 && needAuth && replay) {
      log('api.401_refresh_replay', { method, path: templ(path), ms });
      await auth.refresh({ staleAccess: usedAccess, reason: '401' });
      return request(method, path, { json, auth: needAuth, replay: false, signal, raw });
    }
    if (!res.ok) {
      const err = await ApiError.fromResponse(res, path);
      log('api.error', { method, path: templ(path), status: res.status, kind: err.kind, code: err.code, ms });
      if (res.status === 401) throw new AuthLostError();
      throw err;
    }
    log('api.ok', { method, path: templ(path), status: res.status, ms });
    if (res.status === 204) return null;
    // A 2xx whose body is cut off (headers arrived, connection died) is an UNKNOWN outcome,
    // exactly like a request without any answer: the server may have acted (measured in the
    // bench, run 8: a truncated 201 on create was classified as a plain error and a Retry
    // created a duplicate). TransportError sends the caller down the reconciliation path.
    let text;
    try { text = await res.text(); }
    catch (e) {
      log('api.body_cut_off', { method, path: templ(path), status: res.status });
      throw new TransportError(`Answer from ${origin} was cut off (${e?.message ?? e})`, { cause: e, path });
    }
    if (!text) return res.ok && method !== 'GET' ? (() => { throw new TransportError(`Empty ${res.status} answer from ${origin}`, { path }); })() : (raw ? { text: '', json: null } : null);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new TransportError(`Answer from ${origin} was not JSON (${res.status})`, { path }); }
    // raw: the caller wants the body exactly as received — the transcript is stored VERBATIM (I4b).
    return raw ? { text, json: parsed } : parsed;
  }

  return {
    origin,
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, json, opts) => request('POST', path, { ...opts, json: json ?? {} }),
    del: (path, opts) => request('DELETE', path, opts),
  };
}
