/**
 * record-entry.js — the ways a recording starts, and the recording notice every one of them needs (P300-28d).
 *
 * Entries: the popup's Start (the tab the toolbar was clicked on), the context-menu item «Record this tab with
 * IronMemo» (page menus and, from Chrome 150, the tab strip's own menu) and the keyboard command `record-this-tab`.
 * Each of these is a user gesture that gives the extension the right to capture exactly that tab (measured in
 * P300-28c on Chrome for Testing 152, 154 and 157: `03-research/2026-11-09-p300-28c-tab-routes/RESULT.md`).
 *
 * The recording notice (CWS «prominent disclosure» before the first data collection) is accepted in the popup. The
 * menu and the shortcut must not start a recording before it: without it they store the request here and open the
 * popup, which shows the notice and starts the stored request after Continue.
 */

// The popup's recording notice: bumping the version shows the notice again on the next popup open.
export const CONSENT_KEY = 'ironmemo.consent.v1';
export const CONSENT_VERSION = 4;

// The context-menu item id and the manifest's `commands` key (the same word on purpose).
export const ENTRY_MENU_ID = 'record-this-tab';
export const ENTRY_COMMAND = 'record-this-tab';

// chrome.storage.session: a request made before the notice was accepted; the popup runs it after Continue.
export const PENDING_ENTRY_KEY = 'ironmemo.pendingEntry.v1';
// A request older than this is dropped: the user has moved on, and the tab may have changed since.
export const PENDING_ENTRY_MAX_AGE_MS = 120_000;

// How long the popup keeps saying «already recording» after a menu click or a shortcut press during a recording.
export const ENTRY_NOTICE_MAX_AGE_MS = 60_000;

export async function hasRecordingConsent() {
  try {
    const r = await chrome.storage.local.get(CONSENT_KEY);
    return r[CONSENT_KEY]?.version === CONSENT_VERSION;
  } catch {
    return false;
  }
}
