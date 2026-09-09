/**
 * recovery-worker.js — runs shared/recovery.js where sync access handles and AudioDecoder
 * both exist. One message in, one result out; the caller terminates the worker.
 *
 *   SCAN                 → { ok, sessions: [...] }
 *   RECOVER {sessionId, opts} → { ok, result }
 *   RECOVER_ALL {opts}   → { ok, results: [...] }
 */
import { scanSessions, recoverSession, recoverAll } from '../shared/recovery.js';

self.onmessage = async (e) => {
  const msg = e.data ?? {};
  const logs = [];
  const log = (m) => { logs.push({ at: Date.now(), m }); };
  try {
    switch (msg.type) {
      case 'SCAN':        return self.postMessage({ ok: true, sessions: await scanSessions() });
      case 'RECOVER':     return self.postMessage({ ok: true, result: await recoverSession(msg.sessionId, msg.opts ?? {}, log), logs });
      case 'RECOVER_ALL': return self.postMessage({ ok: true, results: await recoverAll(msg.opts ?? {}, log), logs });
      default: return self.postMessage({ ok: false, error: `unknown message ${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message ?? err), stack: err?.stack ?? null, logs });
  }
};
