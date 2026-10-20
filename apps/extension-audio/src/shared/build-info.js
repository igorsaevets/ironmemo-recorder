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

import { BUILD } from './strings.js';

const STORE_ID = 'epnajjfddhbhgabhmcaomfnjhnhjnchd'; // the Chrome Web Store item

export async function buildInfo() {
  const version = chrome.runtime.getManifest().version;
  let installType = null;
  try { installType = (await chrome.management.getSelf()).installType; } catch { /* API unavailable */ }
  const storeId = chrome.runtime.id === STORE_ID;
  return { version, installType, storeId, dev: installType === 'development', text: BUILD.line(version, installType, storeId) };
}

/** Fill an element with the build line; an unpacked build gets the `dev` class. */
export async function renderBuildLine(el) {
  if (!el) return null;
  const b = await buildInfo();
  el.textContent = b.text;
  el.classList.toggle('dev', b.dev);
  el.title = b.dev ? BUILD.devHint : '';
  return b;
}
