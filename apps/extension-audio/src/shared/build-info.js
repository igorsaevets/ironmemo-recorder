/**
 * build-info.js — which build is running, shown in the popup and on the Recordings page (P300-23).
 *
 * 2026-10-19: the owner recorded a 1 h Google Meet call with an unpacked 0.5.0 test build
 * loaded in September, believing it was the store version; nothing on screen told the two
 * apart. installType 'development' is an unpacked build; 'normal' is any .crx install, and it is
 * the store's when the id is the store item's (its key lives with the store, P300-23b).
 * chrome.management.getSelf() works without the "management" permission, so this adds no
 * install warning.
 */

import { BUILD, PROMO } from './strings.js';

const STORE_ID = 'epnajjfddhbhgabhmcaomfnjhnhjnchd'; // the Chrome Web Store item
const INSTALL_TYPE_TIMEOUT_MS = 1000;

/** installType from chrome.management.getSelf(), or null with the reason. Never waits longer than `timeoutMs`:
 * Start must not hang on a diagnostic (P300-23c). */
async function readInstallType(timeoutMs = INSTALL_TYPE_TIMEOUT_MS) {
  let timer;
  try {
    const self = await Promise.race([
      chrome.management.getSelf(),
      new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    const installType = typeof self?.installType === 'string' && self.installType ? self.installType : null;
    return { installType, note: installType ? null : 'chrome.management.getSelf() returned no installType' };
  } catch (e) {
    return { installType: null, note: `chrome.management.getSelf(): ${String(e?.message ?? e).slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildInfo() {
  const version = chrome.runtime.getManifest().version;
  const { installType } = await readInstallType();
  const storeId = chrome.runtime.id === STORE_ID;
  return { version, installType, storeId, dev: installType === 'development', text: BUILD.line(version, installType, storeId) };
}

/**
 * The build that is about to CREATE a recording (P300-23c), taken by the service worker when Start arrives and
 * written into that session's capture-report.json and journal. The offscreen document cannot take it: runtime is
 * the only extension API it has (developer.chrome.com/docs/extensions/reference/api/offscreen, read 2026-11-08), so
 * chrome.management is out of its reach. installType null + installTypeNote = unknown, never a guess; 'other' is
 * a real value Chrome reports. Never throws.
 */
export async function buildSnapshot() {
  let version = null;
  try { version = chrome.runtime.getManifest().version ?? null; } catch { /* keep null */ }
  const { installType, note } = await readInstallType();
  return {
    version, installType, ...(note ? { installTypeNote: note } : {}),
    storeItem: chrome.runtime.id === STORE_ID, capturedAt: new Date().toISOString(), capturedBy: 'service-worker',
  };
}

/** Fill an element with the build line; an unpacked build gets the `dev` class. A clean store install
 * (installType 'normal' AND the store item id) is the obvious case — the line is hidden so the popup
 * footer stays quiet. Which build CREATED a recording is in that session's capture-report.json (`build`). */
export async function renderBuildLine(el) {
  if (!el) return null;
  const b = await buildInfo();
  if (b.installType === 'normal' && b.storeId) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('dev');
    el.removeAttribute('title');
    return b;
  }
  el.hidden = false;
  el.textContent = b.text;
  el.classList.toggle('dev', b.dev);
  el.title = b.dev ? BUILD.devHint : '';
  return b;
}

/** Fill an <a> with the promo text and href. Native link to the service's own transcription landing. */
export function renderPromo(el) {
  if (!el) return;
  el.textContent = `${PROMO.text} — ${PROMO.host}`;
  el.href = PROMO.url;
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
}
