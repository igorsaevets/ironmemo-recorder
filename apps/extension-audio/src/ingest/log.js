/**
 * log.js — ingest log with redaction. What must never appear in any log line, journal or
 * storage dump: a JWT (access/refresh), a cookie, a presigned storage URL, an Authorization
 * header value. The I4a bench greps the console and this ring buffer for exactly those
 * (acceptance criterion 5 in 02-prompts/PROMPT-I4a-guest-ingest-core.md).
 *
 * Redaction is by KEY (anything that smells like a credential) and by VALUE (JWT prefix
 * `eyJ`, `X-Amz-` query strings, `Bearer `). URLs are reduced to origin + path with ids masked.
 */

const RING = [];
const MAX = 300;
const SESSION_KEY = 'ironmemo.ingestLog.v1';
const SECRET_KEY = /(token|access|refresh|authorization|cookie|presigned|signedurl|signed_url|etag|signature|password|code)$/i;

export function redact(v, depth = 0) {
  if (depth > 5) return '[deep]';
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = SECRET_KEY.test(k) || /url$/i.test(k)
        ? redactString(typeof x === 'string' ? x : '[object]')
        : redact(x, depth + 1);
    }
    return out;
  }
  return v;
}

function redactString(s) {
  if (/X-Amz-|eyJ[A-Za-z0-9_-]{10,}|Bearer\s|Signature=/i.test(s)) return '[redacted]';
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.origin}${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')}`;
    } catch { return '[url]'; }
  }
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try { await chrome.storage.session.set({ [SESSION_KEY]: RING.slice(-MAX) }); }
    catch { /* no session storage on this Chrome — memory ring only */ }
  }, 250);
}

/** Returns log(event, fields). Every field goes through redact() before it is kept anywhere. */
export function createLog(scope) {
  return function log(event, fields = {}) {
    const entry = { t: Date.now(), scope, event, ...redact(fields) };
    RING.push(entry);
    if (RING.length > MAX) RING.shift();
    console.info(`[ingest:${scope}] ${event}`, entry);
    persist();
    return entry;
  };
}

export function getLog() { return RING.slice(); }
