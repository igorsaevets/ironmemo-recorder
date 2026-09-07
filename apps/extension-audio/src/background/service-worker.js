/**
 * service-worker.js — ТОЛЬКО оркестрация. Здесь не живёт запись.
 *
 * Service worker в MV3 эфемерен: браузер вправе выгрузить его в любой момент.
 * Отсюда два запрета, нарушение которых ломает всё остальное:
 *
 *   1. Состояние записи НЕ хранится в глобальных переменных этого файла.
 *      Единственный источник правды — chrome.storage.local (быстрый статус)
 *      и журнал в offscreen-документе (что реально легло на диск).
 *
 *   2. chrome.alarms НЕ используется как способ «удержать worker живым».
 *      Это карго-культ: alarm будит worker, но не делает его владельцем
 *      MediaStream. Владелец потока — offscreen-документ, и живёт он по
 *      собственным правилам.
 *
 * Владение потоком: offscreen document. Роль worker'а — получить stream ID по
 * жесту пользователя, передать его вниз и отвечать на вопросы UI.
 */

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const STATE_KEY = 'ironmemo.captureState.v1';

// ─────────────────────────────────────────────────── состояние ──

async function getState() {
  const r = await chrome.storage.local.get(STATE_KEY);
  return r[STATE_KEY] ?? { status: 'idle', sessionId: null, startedAt: null, error: null };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  await updateBadge(next);
  return next;
}

async function updateBadge(state) {
  const map = {
    recording: { text: 'REC', color: '#ef5f6b' },
    paused:    { text: '||',  color: '#f0a238' },
    starting:  { text: '…',   color: '#4f7cff' },
    error:     { text: '!',   color: '#ef5f6b' },
  };
  const b = map[state.status];
  await chrome.action.setBadgeText({ text: b?.text ?? '' });
  if (b) await chrome.action.setBadgeBackgroundColor({ color: b.color });
}

// ──────────────────────────────────────── offscreen document ──

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification:
      'Запись микрофона и звука вкладки, воспроизведение возвращаемого звука вкладки '
      + 'и потоковая запись сегментов на диск. Service worker для этого не подходит: '
      + 'он эфемерен и не имеет доступа к MediaStream.',
  });
}

async function closeOffscreenIfIdle() {
  const s = await getState();
  if (s.status !== 'idle' && s.status !== 'error') return;
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) await chrome.offscreen.closeDocument().catch(() => {});
}

// ───────────────────────────────────────────────── команды ──

async function startCapture({ tabId } = {}) {
  await setState({ status: 'starting', error: null });
  try {
    const settings = (await chrome.storage.local.get('ironmemo.settings.v1'))['ironmemo.settings.v1'] ?? {};
    const mode = settings?.source?.mode ?? 'mic';

    let streamId = null;
    if (mode === 'tab' || mode === 'mic+tab') {
      // getMediaStreamId ТРЕБУЕТ жеста пользователя. Вызывается здесь, потому что
      // popup может закрыться в любой момент, а offscreen не имеет права его дать.
      const tab = tabId
        ? await chrome.tabs.get(tabId)
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab) throw new Error('Не найдена активная вкладка для захвата звука.');
      if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url ?? '')) {
        throw new Error('Звук служебных страниц браузера захватить нельзя. Откройте обычный сайт.');
      }
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    }

    await ensureOffscreen();
    const sessionId = crypto.randomUUID();

    const res = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'START', sessionId, streamId, settings,
    });
    if (!res?.ok) throw new Error(res?.error ?? 'Offscreen-документ не подтвердил старт.');

    return await setState({
      status: 'recording', sessionId, startedAt: Date.now(),
      appliedReport: res.appliedReport ?? null,
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    await setState({ status: 'error', error: msg });
    await closeOffscreenIfIdle();
    throw e;
  }
}

async function stopCapture() {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  const next = await setState({
    status: 'idle', sessionId: null, startedAt: null,
    lastResult: res?.result ?? null, error: res?.ok ? null : (res?.error ?? null),
  });
  await closeOffscreenIfIdle();
  return next;
}

async function pauseCapture() {
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PAUSE' });
  return setState({ status: 'paused' });
}

async function resumeCapture() {
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'RESUME' });
  return setState({ status: 'recording' });
}

// ─────────────────────────────────────────── маршрутизация ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target && msg.target !== 'background') return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATE':  return sendResponse({ ok: true, state: await getState() });
        case 'START':      return sendResponse({ ok: true, state: await startCapture(msg) });
        case 'STOP':       return sendResponse({ ok: true, state: await stopCapture() });
        case 'PAUSE':      return sendResponse({ ok: true, state: await pauseCapture() });
        case 'RESUME':     return sendResponse({ ok: true, state: await resumeCapture() });
        case 'OFFSCREEN_EVENT': {
          // Отчёты о прогрессе и об ошибках из offscreen-документа.
          if (msg.event === 'error') await setState({ status: 'error', error: msg.error });
          if (msg.event === 'progress') await setState({ progress: msg.progress });
          return sendResponse({ ok: true });
        }
        default: return sendResponse({ ok: false, error: `Неизвестная команда: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();

  return true; // асинхронный ответ
});

// ─────────────────────────────────────── восстановление после сбоя ──

/**
 * При каждом запуске worker'а проверяем, не осталась ли запись «в воздухе».
 * Такое состояние означает, что процесс умер, не пройдя через stop, — то есть
 * ровно тот случай, ради которого нужен журнал.
 */
chrome.runtime.onStartup.addListener(checkForOrphanedSession);
chrome.runtime.onInstalled.addListener(checkForOrphanedSession);

async function checkForOrphanedSession() {
  const s = await getState();
  if (s.status === 'recording' || s.status === 'paused' || s.status === 'starting') {
    // Никаких обещаний о восстановлении здесь не даём: сначала надо прочитать
    // журнал и убедиться, что сегменты действительно декодируются.
    await setState({
      status: 'idle',
      orphaned: { sessionId: s.sessionId, startedAt: s.startedAt, detectedAt: Date.now() },
      error: null,
    });
    await chrome.action.setBadgeText({ text: '?' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f0a238' });
  }
}
