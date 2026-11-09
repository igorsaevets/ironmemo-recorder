import { clearSourceChoice, confirmMicOnly, loadSettings, micOnlyConfirmed, saveSettingsPatch } from '../shared/settings-store.js';
import { getByPath, estimateMBPerHour } from '../shared/settings-schema.js';
import { ENTRY, POPUP } from '../shared/strings.js';
import { listAudioDevices, resolveDevice, DEVICE_CLASS } from '../shared/audio-devices.js';
import { renderBuildLine, renderPromo } from '../shared/build-info.js';
import { CONSENT_KEY, CONSENT_VERSION, ENTRY_COMMAND, ENTRY_NOTICE_MAX_AGE_MS, PENDING_ENTRY_KEY,
         PENDING_ENTRY_MAX_AGE_MS } from '../shared/record-entry.js';

const $ = (id) => document.getElementById(id);
let timerHandle = null;
let uploadEnabled = true; // settings upload.enabled — the after-stop line is only offered when the feature is on
let entryShortcut = ''; // P300-28d: the key Chrome actually assigned to «Record this tab» ('' when none)

// CWS Purple Nickel: prominent disclosure BEFORE first data collection. C7 in checklist.
// Bumping the version key (CONSENT_VERSION in record-entry.js, shared with the service worker since P300-28d:
// the context menu and the shortcut check the same notice) forces the overlay to reappear on the next popup open,
// which is how Purple Nickel wants a change in data practices communicated.
// I4b (2026-09-13): the notice gained one neutral sentence about OPTIONAL transcription. The
// version is NOT bumped (nobody who records locally is asked again — ADR-008 «Уточнения» 5); the
// text id changes so the stored record says which text was shown. Cloud processing has its own
// consent (ironmemo.ingestConsent.v1) before the first upload.
const CONSENT_TEXT_ID = 'en-v4-cloud-note';
const NOTICE_KEY = 'ironmemo.updateNotice.v1';
const NOTICE_ID = 'cloud-option-2026-09';

let levelPoll = null;
let settingsValues = null;
let askingMode = false; // P300-23c: Start was pressed with an unconfirmed 'mic'; the choice buttons start the recording
let micPickerGen = 0;
let micDebounce = null;

boot().catch((e) => console.error('[popup] boot failed', e));

async function boot() {
  renderBuildLine($('buildLine')).catch(() => {});
  renderPromo($('promoLink'));
  const consent = await getConsent();
  if (!consent || consent.version !== CONSENT_VERSION) {
    showConsent();
    return;
  }
  $('app').hidden = false;
  await init();
  await maybeShowNotice(consent);
}

/** Existing users (recording notice accepted before the transcription option) see the update notice once. */
async function maybeShowNotice(consent) {
  try {
    const seen = (await chrome.storage.local.get(NOTICE_KEY))[NOTICE_KEY];
    if (seen?.id === NOTICE_ID) return;
    if (consent?.textShown === CONSENT_TEXT_ID) { // accepted the notice that already carries the sentence
      await chrome.storage.local.set({ [NOTICE_KEY]: { id: NOTICE_ID, seenAt: Date.now(), via: 'consent' } });
      return;
    }
    $('noticeText').textContent = POPUP.noticeText;
    $('noticeOk').textContent = POPUP.noticeOk;
    $('notice').hidden = false;
    $('noticeOk').addEventListener('click', async () => {
      await chrome.storage.local.set({ [NOTICE_KEY]: { id: NOTICE_ID, seenAt: Date.now(), via: 'notice' } });
      $('notice').hidden = true;
    }, { once: true });
  } catch (e) { console.warn('[popup] update notice', e); }
}

async function getConsent() {
  try {
    const r = await chrome.storage.local.get(CONSENT_KEY);
    return r[CONSENT_KEY] ?? null;
  } catch { return null; }
}

function showConsent() {
  $('consent').hidden = false;
  const check = $('consentAgree');
  const btn = $('consentContinue');
  check.addEventListener('change', () => { btn.disabled = !check.checked; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await chrome.storage.local.set({
        [CONSENT_KEY]: { version: CONSENT_VERSION, textShown: CONSENT_TEXT_ID, acceptedAt: Date.now() },
        [NOTICE_KEY]: { id: NOTICE_ID, seenAt: Date.now(), via: 'consent' },
      });
      $('consent').hidden = true;
      $('app').hidden = false;
      await init();
    } catch (e) {
      btn.disabled = false;
      console.error('[popup] consent save failed', e);
      return;
    }
    await runPendingEntry();
  });
}

/**
 * P300-28d: «Record this tab» used before the recording notice was accepted stored its tab and opened this popup.
 * The notice is accepted now, so record that tab (not the active one: a tab-strip click may name a background tab).
 */
async function runPendingEntry() {
  try {
    const p = (await chrome.storage.session.get(PENDING_ENTRY_KEY))[PENDING_ENTRY_KEY];
    await chrome.storage.session.remove(PENDING_ENTRY_KEY);
    if (!p?.tabId || !(Date.now() - p.at <= PENDING_ENTRY_MAX_AGE_MS)) return;
    await send('START', { tabId: p.tabId, via: p.via, clickedAt: Date.now() });
  } catch (e) {
    console.warn('[popup] pending entry', e);
  }
}

async function init() {
  // Boot probe (B3): the first GET_STATE is what wakes the service worker when the
  // popup opens. Its round-trip is the cold-start cost the user actually feels
  // before the Start button even works. Exposed for the test bench.
  const tBoot = performance.now();
  await renderConfig();
  try {
    entryShortcut = (await chrome.commands.getAll()).find((c) => c.name === ENTRY_COMMAND)?.shortcut ?? '';
  } catch { entryShortcut = ''; }
  const first = await state();
  window.__ironmemoBoot = { getStateMs: Math.round(performance.now() - tBoot), status: first.status, at: Date.now() };
  // clickedAt: точка отсчёта для замера холодного старта (B3) — от клика до 'recording'.
  // P300-10: Start is disabled in popup.html and refresh() enables it; its handler is attached BEFORE that, so an
  // enabled Start always has one (a click while the popup was still loading used to vanish without feedback).
  $('start').addEventListener('click', () => onStart(Date.now()));
  await refresh();

  $('pause').addEventListener('click', async () => {
    const s = await state();
    send(s.status === 'paused' ? 'RESUME' : 'PAUSE');
  });
  $('stop').addEventListener('click', () => send('STOP'));
  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault(); chrome.runtime.openOptionsPage();
  });
  $('openLab').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/lab/lab.html') });
  });
  $('openSessions').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('src/session-list/session-list.html') }));
  $('openPermission').addEventListener('click', () =>
    chrome.runtime.sendMessage({ target: 'background', type: 'OPEN_PERMISSION' }));
  // I4b task 4: the Recordings page opens scrolled to the session that just stopped (no upload from here)
  $('transcribeLink').addEventListener('click', (e) => {
    e.preventDefault();
    const sid = $('transcribeLink').dataset.sid;
    if (sid) chrome.tabs.create({ url: chrome.runtime.getURL(`src/session-list/session-list.html#sid=${encodeURIComponent(sid)}`) });
  });

  navigator.mediaDevices?.addEventListener('devicechange', () => {
    clearTimeout(micDebounce);
    micDebounce = setTimeout(() => { if (settingsValues) renderMicPicker(settingsValues); }, 200);
  });

  // Состояние живёт в storage, а не в popup: popup закрывается, запись — нет.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['ironmemo.captureState.v1']) refresh();
  });
}

async function renderConfig() {
  const v = await loadSettings();
  settingsValues = v;
  uploadEnabled = getByPath(v, 'upload.enabled') !== false;
  const modeLabel = { mic: 'microphone', tab: 'tab audio',
                      'mic+tab': 'microphone + tab' }[getByPath(v, 'source.mode')];
  const parts = [];
  if (getByPath(v, 'source.keepSeparate')) parts.push('separate');
  if (getByPath(v, 'source.produceMix')) parts.push('+ mix');

  $('config').innerHTML =
    `<div>Source: <b>${modeLabel}</b> ${parts.join(' ')}</div>` +
    `<div>Codec: <b>${getByPath(v, 'audioEnc.codec')}</b> / ${getByPath(v, 'audioEnc.container')}, `
    + `<b>${getByPath(v, 'audioEnc.bitrateKbps')} kbps</b></div>` +
    `<div>Est. size: <b>${estimateMBPerHour(v)} MB/h</b></div>`;

  await renderModeWarn(v);
  await renderMicPicker(v);
}

/**
 * P300-23: mic-only is what a fresh install of ≤2.2.0 records, and it survived the default change for anyone whose
 * settings were ever saved (the mic picker and Options saved them all). A call recorded that way has nobody else in
 * it, so say so before Start and offer the switch. P300-23c: the user answers once — meeting (microphone + tab) or
 * voice note (microphone only, kept in ironmemo.sourceChoice.v1) — and a confirmed voice-note user is not asked again.
 */
async function renderModeWarn(v) {
  const box = $('modeWarn');
  if (getByPath(v, 'source.mode') !== 'mic' || await micOnlyConfirmed()) {
    box.hidden = true;
    askingMode = false;
    return;
  }
  $('modeFix').textContent = POPUP.micOnlyFix;
  $('modeKeep').textContent = POPUP.micOnlyKeep;
  $('modeFix').onclick = () => chooseMode('mic+tab');
  $('modeKeep').onclick = () => chooseMode('mic');
  box.hidden = false;
  setModeWarnActive(await isRecordingActive());
}

/** P300-23c: Start with a stored 'mic' nobody confirmed asks first; the answer then starts the recording. */
async function onStart(clickedAt) {
  try {
    if (getByPath(await loadSettings(), 'source.mode') === 'mic' && !(await micOnlyConfirmed())) {
      askingMode = true;
      if ($('modeWarn').hidden) await renderConfig();
      setModeWarnActive(false);
      $('start').hidden = true;
      $('modeFix').focus();
      return;
    }
  } catch (e) {
    console.warn('[popup] mode check', e); // never block a recording on this check
  }
  await send('START', { clickedAt });
}

async function chooseMode(mode) {
  // P300-23b: the choice is for the next recording, and one may have started since the popup opened
  if (await isRecordingActive()) { setModeWarnActive(true); return; }
  const clickedAt = Date.now();
  const startAfter = askingMode;
  $('modeFix').disabled = $('modeKeep').disabled = true;
  try {
    if (mode === 'mic') await confirmMicOnly('popup');
    else {
      await saveSettingsPatch({ 'source.mode': 'mic+tab' });
      await clearSourceChoice();
    }
  } catch (e) {
    $('modeFix').disabled = $('modeKeep').disabled = false;
    showError(`Could not save the choice: ${e?.message ?? e}`);
    return;
  }
  askingMode = false;
  await renderConfig();
  if (startAfter) await send('START', { clickedAt });
  else await refresh();
}

/** While a recording runs, the warning is about that recording and the switch waits for the next one. */
function setModeWarnActive(active) {
  const asking = askingMode && !active;
  $('modeWarnText').textContent = active ? POPUP.micOnlyWarnActive : asking ? POPUP.micOnlyAsk : POPUP.micOnlyWarn;
  $('modeWarn').classList.toggle('asking', asking);
  $('modeFix').disabled = $('modeKeep').disabled = active;
}

async function renderMicPicker(v) {
  const gen = ++micPickerGen;
  const mode = getByPath(v, 'source.mode');
  const picker = $('micPicker');
  if (mode === 'tab') { picker.hidden = true; return; }
  picker.hidden = false;

  $('micLabel').textContent = POPUP.micLabel;
  const sel = $('micSelect');
  const warn = $('micWarn');
  const hint = $('micHint');

  let devices;
  try { devices = await listAudioDevices(); } catch { devices = { inputs: [], outputs: [], hasLabels: false }; }
  if (gen !== micPickerGen) return;

  sel.innerHTML = '';

  if (!devices.hasLabels) {
    const opt = document.createElement('option');
    opt.value = 'default';
    opt.textContent = POPUP.micDefault;
    sel.appendChild(opt);
    sel.disabled = true;
    warn.hidden = true;
    hint.hidden = false;
    hint.textContent = '';
    hint.append(
      document.createTextNode(POPUP.micNoLabels + ' '),
      Object.assign(document.createElement('a'), {
        href: '#', textContent: POPUP.micNoLabelsCta,
        onclick: (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); },
      }),
    );
    return;
  }

  hint.hidden = true;
  hint.textContent = '';

  const defOpt = document.createElement('option');
  defOpt.value = 'default';
  defOpt.textContent = POPUP.micDefault;
  sel.appendChild(defOpt);

  const stored = getByPath(v, 'source.micDeviceId');
  const resolved = resolveDevice(stored, devices.inputs);
  const matchId = resolved.device?.deviceId;

  for (const d of devices.inputs) {
    if (d.isDefault) continue;
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    let label = d.label;
    if (d.cls === DEVICE_CLASS.LOOPBACK || d.cls === DEVICE_CLASS.BT_HANDSFREE) label += ' ⚠';
    opt.textContent = label;
    if (d.deviceId === matchId) opt.selected = true;
    sel.appendChild(opt);
  }

  if (stored && stored !== 'default' && resolved.match === 'not_found') {
    const storedName = (typeof stored === 'object' ? stored.label || stored.deviceId : stored) || 'Saved microphone';
    warn.hidden = false;
    warn.className = 'mic-warn danger';
    warn.textContent = POPUP.micNotFound(storedName);
  } else {
    updateMicWarn(resolved.device);
  }

  const isActive = await isRecordingActive();
  sel.disabled = isActive;

  sel.onchange = async () => {
    const chosen = devices.inputs.find((d) => d.deviceId === sel.value);
    const newVal = (!chosen || sel.value === 'default') ? 'default'
      : { deviceId: chosen.deviceId, label: chosen.label, groupId: chosen.groupId };
    settingsValues = await saveSettingsPatch({ 'source.micDeviceId': newVal });
    const resolvedNew = resolveDevice(newVal, devices.inputs);
    updateMicWarn(resolvedNew.device);
  };
}

async function isRecordingActive() {
  try {
    const s = await state();
    return s.status === 'recording' || s.status === 'paused' || s.status === 'awaiting_perm';
  } catch { return false; }
}

function updateMicWarn(device) {
  const warn = $('micWarn');
  if (!device || device.cls === DEVICE_CLASS.PHYSICAL || device.cls === DEVICE_CLASS.UNKNOWN) {
    warn.hidden = true; return;
  }
  warn.hidden = false;
  warn.className = device.cls === DEVICE_CLASS.LOOPBACK ? 'mic-warn danger' : 'mic-warn';
  const msgs = {
    [DEVICE_CLASS.LOOPBACK]: POPUP.micWarnLoopback,
    [DEVICE_CLASS.BT_HANDSFREE]: POPUP.micWarnBtHandsfree,
    [DEVICE_CLASS.VIRTUAL_PROCESSED]: POPUP.micWarnVirtualProcessed,
  };
  warn.textContent = msgs[device.cls] || '';
  if (!warn.textContent) warn.hidden = true;
}

async function state() {
  const r = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
  return r?.state ?? { status: 'idle' };
}

async function send(type, extra = {}) {
  $('start').disabled = $('pause').disabled = $('stop').disabled = true;
  const r = await chrome.runtime.sendMessage({ target: 'background', type, ...extra })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (!r?.ok) showError(r?.error ?? 'Unknown error');
  await refresh();
}

async function refresh() {
  const s = await state();
  const rec = s.status === 'recording', paused = s.status === 'paused';
  const awaitingPerm = s.status === 'awaiting_perm';

  $('stateDot').className = `dot ${s.status}`;
  $('stateText').textContent = {
    idle: 'Ready to record', starting: 'Starting…', recording: 'Recording',
    paused: 'Paused', error: 'Error',
    awaiting_perm: 'Waiting for microphone permission (see the open tab)',
  }[s.status] ?? s.status;

  if (rec || paused || awaitingPerm) askingMode = false; // a recording started elsewhere answers nothing
  $('start').hidden = rec || paused || awaitingPerm || askingMode;
  $('pause').hidden = !(rec || paused);
  $('stop').hidden  = !(rec || paused);
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('start').disabled = $('pause').disabled = $('stop').disabled = false;

  const micSel = $('micSelect');
  if (micSel) {
    micSel.disabled = rec || paused || awaitingPerm;
  }
  if (!$('modeWarn').hidden) setModeWarnActive(rec || paused || awaitingPerm || s.status === 'starting');

  if (rec || paused) startLevelMeter(); else stopLevelMeter();

  // I4b task 4: one line for the recording that just stopped — until the next recording starts
  const stopped = s.status === 'idle' && s.lastStopped?.sessionId && uploadEnabled ? s.lastStopped : null;
  $('afterStop').hidden = !stopped;
  if (stopped) {
    $('transcribeLink').textContent = POPUP.transcribeLine;
    $('transcribeLink').dataset.sid = stopped.sessionId;
    $('afterStopHint').textContent = POPUP.transcribeHint;
  }

  // P300-28d: how to record a meeting that is in another tab (shown before a recording) and, after a menu click or a
  // shortcut press during a recording, why nothing new started.
  const idleLike = s.status === 'idle' || s.status === 'error';
  $('entryHint').hidden = !idleLike;
  if (idleLike) {
    $('entryHint').textContent = ENTRY.hint(chrome.i18n.getMessage('menuRecordThisTab') || 'Record this tab with IronMemo',
                                            entryShortcut);
  }
  const note = s.entryNotice && Date.now() - s.entryNotice.at <= ENTRY_NOTICE_MAX_AGE_MS && (rec || paused || awaitingPerm
    || s.status === 'starting') ? s.entryNotice : null;
  $('entryNote').hidden = !note;
  $('entryNote').textContent = note ? (note.kind === 'busy-same' ? ENTRY.busySame : ENTRY.busyOther) : '';

  if (s.error) showError(s.error); else { $('err').hidden = true; $('errActions').hidden = true; }
  // Warnings while recording (device lost/returned, tab capture ended) do not change the
  // status; they arrive as lastWarning/lastInfo from the offscreen document.
  const warn = (rec || paused) ? (s.lastWarning || s.lastInfo) : null;
  $('warn').hidden = !warn;
  $('warn').textContent = warn ?? '';

  if (s.orphaned) {
    $('orphan').hidden = false;
    $('orphan').textContent = orphanText(s.orphaned);
  } else {
    $('orphan').hidden = true;
  }

  // Recording status without data: the offscreen document reports progress every 1–5 s;
  // if nothing arrived for 20 s the status is stale (offscreen gone, browser stalled).
  const stale = rec && s.progressAt && Date.now() - s.progressAt > 20_000;
  if (stale && !warn) {
    $('warn').hidden = false;
    $('warn').textContent = `No data from the recording for ${Math.round((Date.now() - s.progressAt) / 1000)} s. If this continues — stop and start recording again.`;
  }

  clearInterval(timerHandle);
  if ((rec || paused) && s.startedAt) {
    const formatTimer = (ms) => {
      const sec = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
      return [sec / 3600, (sec % 3600) / 60, sec % 60]
        .map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
    };
    if (rec) {
      const base = s.mediaElapsedMs ?? 0;
      const resumedAt = s.lastResumedAt ?? s.startedAt;
      const tick = () => { $('timer').textContent = formatTimer(base + Date.now() - resumedAt); };
      tick();
      timerHandle = setInterval(tick, 1000);
    } else {
      $('timer').textContent = formatTimer(s.mediaElapsedMs ?? 0);
    }
  } else {
    $('timer').textContent = '00:00:00';
  }
}

/**
 * What to say about a recording that ended without STOP. Only what recovery.json measured:
 * seconds on disk per role and whether the file decodes end to end. No promise beyond that.
 */
function orphanText(o) {
  const when = o.startedAt ? new Date(o.startedAt).toLocaleString('en-US') : '—';
  const r = o.recovery;
  if (!r) return `Recording from ${when} was interrupted without stop. Files are in browser storage; verification not yet run.`;
  if (!r.ok && r.error) return `Recording from ${when} was interrupted. File verification failed: ${r.error}`;
  if (r.skipped) return `Recording from ${when}: ${r.skipped}.`;
  const fmt = (sec) => { const s = Math.round(sec); return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };
  const parts = Object.entries(r.roles ?? {}).map(([role, x]) => {
    const name = { local_mic: 'microphone', remote_tab: 'tab', compatibility_mix: 'mix' }[role] ?? role;
    const sec = x.secondsDecoded ?? x.secondsOnDisk;
    return `${name} — ${fmt(sec)}${x.decodesFully === true ? ', decodes fully' : x.decodesFully === false ? ', DOES NOT DECODE FULLY' : ''}`;
  });
  return `Recording from ${when} was interrupted without stop. On disk: ${parts.join('; ')}. `
       + `Verification took ${(r.ms / 1000).toFixed(1)} s. Open the Recordings page below to download the recovered file.`;
}

function startLevelMeter() {
  if (levelPoll) return;
  const canvas = $('wave');
  canvas.hidden = false;
  const c2d = canvas.getContext('2d');
  drawMeterText(c2d, canvas, POPUP.meterWaiting);
  levelPoll = setInterval(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_LEVELS' });
      if (r?.levels) drawLevels(c2d, canvas, r.levels);
      else drawMeterText(c2d, canvas, POPUP.meterWaiting);
    } catch { /* popup closing */ }
  }, 100);
}

function stopLevelMeter() {
  if (levelPoll) { clearInterval(levelPoll); levelPoll = null; }
  const canvas = $('wave');
  if (canvas) canvas.hidden = true;
}

const METER_LABELS = { local_mic: POPUP.meterMic, remote_tab: POPUP.meterTab, compatibility_mix: POPUP.meterMix };

function drawLevels(c2d, canvas, levels) {
  const W = canvas.width, H = canvas.height;
  c2d.fillStyle = '#1d212a';
  c2d.fillRect(0, 0, W, H);
  const roles = Object.entries(levels).filter(([r]) => r !== 'compatibility_mix');
  if (!roles.length) { drawMeterText(c2d, canvas, POPUP.meterWaiting); return; }
  const gap = 4, labelW = 32;
  const barH = Math.min(22, Math.floor((H - gap * (roles.length + 1)) / roles.length));
  const totalH = roles.length * barH + (roles.length - 1) * gap;
  const y0 = Math.floor((H - totalH) / 2);
  roles.forEach(([role, peak], i) => {
    const y = y0 + i * (barH + gap);
    c2d.fillStyle = '#8a8fa8';
    c2d.font = `${Math.min(11, barH - 4)}px sans-serif`;
    c2d.textBaseline = 'middle';
    c2d.fillText(METER_LABELS[role] ?? role, 6, y + barH / 2);
    const barX = labelW + 4, barW = W - barX - 6;
    c2d.fillStyle = '#2a2e3a';
    c2d.beginPath();
    c2d.roundRect(barX, y, barW, barH, 3);
    c2d.fill();
    const level = Math.min(1, Math.max(0, peak));
    if (level > 0.001) {
      const fillW = level * barW;
      c2d.fillStyle = level > 0.9 ? '#ef5f6b' : level > 0.5 ? '#f0a238' : '#4f7cff';
      c2d.beginPath();
      c2d.roundRect(barX, y, fillW, barH, 3);
      c2d.fill();
    }
  });
}

function drawMeterText(c2d, canvas, text) {
  c2d.fillStyle = '#1d212a';
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  c2d.fillStyle = '#8a8fa8';
  c2d.font = '11px sans-serif';
  c2d.textBaseline = 'middle';
  c2d.fillText(text, 8, canvas.height / 2);
}

function showError(msg) {
  $('err').hidden = false;
  $('err').textContent = msg;
  // Ошибка связана с микрофоном — предложить открыть страницу разрешения одним кликом.
  const isMicIssue = /microphone|Permission|permission|denied|dismissed/i.test(msg);
  $('errActions').hidden = !isMicIssue;
}
