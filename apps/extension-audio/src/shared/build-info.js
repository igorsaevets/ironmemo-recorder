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

export async function buildInfo() {
  const version = chrome.runtime.getManifest().version;
  let installType = null;
  try { installType = (await chrome.management.getSelf()).installType; } catch { /* API unavailable */ }
  const storeId = chrome.runtime.id === STORE_ID;
  return { version, installType, storeId, dev: installType === 'development', text: BUILD.line(version, installType, storeId) };
}

/** Fill an element with the build line; an unpacked build gets the `dev` class. A clean store install
 * (installType 'normal' AND the store item id) is the obvious case — the line is hidden so the popup
 * footer stays quiet. The data still goes into capture-report.json for post-hoc diagnostics. */
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
