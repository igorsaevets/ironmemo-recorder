/**
 * source-type.js — IronMemo `source_type` enum (zoom|meet|teams|dictaphone|other) from the
 * captured tab URL. Tiny on purpose: the service worker imports it at START (the only place
 * the tab URL is known) without pulling the whole ingest stack into the worker.
 * Only the ENUM is ever persisted (ADR-008 «Уточнения» 7), never the host.
 */
export function sourceTypeFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'meet.google.com') return 'meet';
    if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
    if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
    return 'other';
  } catch { return 'other'; }
}
