/**
 * permission.js — request microphone permission on a VISIBLE extension page.
 *
 * Why this page exists
 * --------------------
 * Chrome MV3 offscreen documents cannot show a UA permission prompt for microphone.
 * The document is invisible, so Chrome auto-dismisses the request as
 * "Permission dismissed" — a NotAllowedError with no visible dialog.
 *
 * The standard workaround (used in Google's own extension samples) is to open a
 * VISIBLE extension page which calls getUserMedia. The UA prompt appears on that
 * page under the user's active click gesture. Once granted, the permission is
 * stored for the extension's origin, and the invisible offscreen document can
 * use getUserMedia freely in future sessions.
 *
 * This page is opened by the service worker whenever START is requested and
 * `ironmemo.micPermissionGranted` is false in chrome.storage.local.
 */

const $ = (id) => document.getElementById(id);
const STATE_KEY = 'ironmemo.micPermissionGranted';
let params = new URLSearchParams(location.search);
let returnPath = params.get('return') || null;

$('grant').addEventListener('click', requestPermission);
$('close').addEventListener('click', () => window.close());

async function requestPermission() {
  setStatus('Запрашиваю разрешение…', 'muted');
  $('grant').disabled = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());

    await chrome.storage.local.set({ [STATE_KEY]: { granted: true, at: Date.now() } });

    setStatus('Разрешение получено. Вкладку можно закрыть — запись теперь работает во всех сессиях.', 'ok');
    $('close').hidden = false;
    $('grant').hidden = true;

    // Tell whoever opened us that we succeeded. The service worker listens.
    try {
      await chrome.runtime.sendMessage({
        target: 'background', type: 'MIC_PERMISSION_RESULT', granted: true, returnPath,
      });
    } catch { /* nobody is listening — that is fine */ }

    // Auto-close after a short pause so the user sees confirmation.
    setTimeout(() => window.close(), 2500);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const name = e?.name ?? 'Error';

    await chrome.storage.local.set({
      [STATE_KEY]: { granted: false, at: Date.now(), error: `${name}: ${msg}` },
    });

    if (name === 'NotAllowedError' && /dismiss/i.test(msg)) {
      setStatus('Chrome «съел» запрос без диалога. Это MV3-баг. См. инструкцию ниже про '
              + 'chrome://extensions → Настройки сайта → Микрофон.', 'warn');
    } else if (name === 'NotAllowedError') {
      setStatus('Разрешение отклонено. Можно повторить попытку или разрешить вручную '
              + 'через chrome://extensions (инструкция ниже).', 'err');
    } else if (name === 'NotFoundError') {
      setStatus('В системе не найдено микрофонов. Подключите устройство и повторите.', 'err');
    } else {
      setStatus(`Ошибка: ${name}: ${msg}`, 'err');
    }

    try {
      await chrome.runtime.sendMessage({
        target: 'background', type: 'MIC_PERMISSION_RESULT',
        granted: false, error: `${name}: ${msg}`, returnPath,
      });
    } catch { /* SW may be gone — the user still sees the status */ }

    $('grant').disabled = false;
  }
}

function setStatus(text, kind = 'muted') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + kind;
}
