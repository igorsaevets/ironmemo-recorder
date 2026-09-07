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
 *
 * Порядок вызовов для tabCapture (важно): сначала ensureOffscreen, потом
 * chrome.tabCapture.getMediaStreamId. Stream ID живёт «несколько секунд»
 * (доклад Chrome, обращение 07.09.2026, developer.chrome.com/docs/extensions/
 * reference/api/tabCapture), поэтому offscreen должен быть готов принять
 * ID немедленно. Обратный порядок даёт гонку с медленным `chrome.offscreen.
 * createDocument`.
 *
 * Разрешение микрофона (важно): в MV3 offscreen document невидим и не может
 * показать UA-prompt для микрофона — Chrome отклоняет запрос как
 * «Permission dismissed». Поэтому первый старт открывает видимую страницу
 * src/permission/permission.html, где UA-prompt показывается по нажатию
 * пользователя. Разрешение персистится для origin расширения и живёт до
 * очистки данных сайта.
 */

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const PERMISSION_PATH = 'src/permission/permission.html';
const STATE_KEY = 'ironmemo.captureState.v1';
const MIC_PERMISSION_KEY = 'ironmemo.micPermissionGranted';

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
    recording:      { text: 'REC', color: '#ef5f6b' },
    paused:         { text: '||',  color: '#f0a238' },
    starting:       { text: '…',   color: '#4f7cff' },
    awaiting_perm:  { text: '?',   color: '#f0a238' },
    error:          { text: '!',   color: '#ef5f6b' },
  };
  const b = map[state.status];
  await chrome.action.setBadgeText({ text: b?.text ?? '' });
  if (b) await chrome.action.setBadgeBackgroundColor({ color: b.color });
}

// ────────────────────────────────────────────── разрешение микрофона ──

async function getMicPermission() {
  const r = await chrome.storage.local.get(MIC_PERMISSION_KEY);
  return r[MIC_PERMISSION_KEY] ?? { granted: false };
}

/**
 * Открыть видимую страницу запроса разрешения. Возвращает промис, который
 * резолвится, когда permission.js пришлёт результат в MIC_PERMISSION_RESULT,
 * или отклоняется по таймауту.
 */
function requestMicPermissionInteractively() {
  return new Promise(async (resolve, reject) => {
    const url = chrome.runtime.getURL(PERMISSION_PATH);
    const tab = await chrome.tabs.create({ url, active: true });

    const timeoutMs = 5 * 60 * 1000; // 5 минут — пользователю может потребоваться время
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Пользователь не ответил в разумное время — старт отменён.'));
    }, timeoutMs);

    const listener = (msg, sender) => {
      if (msg?.target === 'background' && msg?.type === 'MIC_PERMISSION_RESULT') {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        if (msg.granted) resolve({ granted: true, tabId: tab.id });
        else reject(new Error(msg.error || 'Разрешение не выдано.'));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
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
    const needsMic = mode === 'mic' || mode === 'mic+tab';
    const needsTab = mode === 'tab' || mode === 'mic+tab';

    // ── 1. Разрешение микрофона, если нужно ──
    //
    // Не пытаемся дать offscreen шанс попросить самому: он невидим, и Chrome
    // молча отклонит с "Permission dismissed". Видимая страница — единственный
    // способ увидеть UA-prompt.
    if (needsMic) {
      const perm = await getMicPermission();
      if (!perm.granted) {
        await setState({ status: 'awaiting_perm', error: null });
        await requestMicPermissionInteractively();
        // Дошли сюда — значит granted; повторный старт не нужен, продолжаем.
      }
    }

    // ── 2. Offscreen СНАЧАЛА, tabCapture ID ПОТОМ ──
    //
    // Stream ID из tabCapture живёт несколько секунд. Если offscreen ещё не
    // создан, ID устареет пока chrome.offscreen.createDocument доедет до конца.
    await ensureOffscreen();

    // ── 3. Захват звука вкладки (если нужен) — под user gesture ──
    let streamId = null;
    if (needsTab) {
      const tab = tabId
        ? await chrome.tabs.get(tabId)
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab) throw new Error('Не найдена активная вкладка для захвата звука.');
      if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url ?? '')) {
        throw new Error('Звук служебных страниц браузера захватить нельзя. Откройте обычный сайт.');
      }
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    }

    // ── 4. START в offscreen — сразу, пока streamId ещё жив ──
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
    const raw = String(e?.message ?? e);
    // Раскрываем известные ошибки в понятный человеку текст. Оригинал — в поле errorRaw.
    const msg = translateError(raw);
    await setState({ status: 'error', error: msg, errorRaw: raw });
    await closeOffscreenIfIdle();
    throw e;
  }
}

function translateError(raw) {
  if (/Permission dismissed/i.test(raw)) {
    return 'Chrome не показал диалог разрешения микрофона (известное поведение MV3). '
         + 'Откройте настройки расширения — там есть кнопка «Показать названия устройств», '
         + 'она откроет страницу разрешения. Либо: chrome://extensions → Подробнее → '
         + 'Настройки сайта → Микрофон → Разрешить.';
  }
  if (/NotAllowedError/i.test(raw)) {
    return 'Микрофон не разрешён. Откройте страницу разрешения или chrome://extensions → '
         + 'Настройки сайта → Микрофон.';
  }
  if (/NotFoundError/i.test(raw)) {
    return 'Не найден выбранный микрофон. Проверьте, что устройство подключено, '
         + 'и обновите список в настройках.';
  }
  if (/streamId/i.test(raw) || /stream.*expired/i.test(raw)) {
    return 'Идентификатор захвата вкладки истёк. Попробуйте ещё раз.';
  }
  return raw;
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

async function checkMicPermission() {
  return getMicPermission();
}

async function openPermissionPage() {
  const url = chrome.runtime.getURL(PERMISSION_PATH);
  await chrome.tabs.create({ url, active: true });
  return { ok: true };
}

// ─────────────────────────────────────────── маршрутизация ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target && msg.target !== 'background') return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATE':          return sendResponse({ ok: true, state: await getState() });
        case 'START':              return sendResponse({ ok: true, state: await startCapture(msg) });
        case 'STOP':               return sendResponse({ ok: true, state: await stopCapture() });
        case 'PAUSE':              return sendResponse({ ok: true, state: await pauseCapture() });
        case 'RESUME':             return sendResponse({ ok: true, state: await resumeCapture() });
        case 'GET_MIC_PERMISSION': return sendResponse({ ok: true, permission: await checkMicPermission() });
        case 'OPEN_PERMISSION':    return sendResponse(await openPermissionPage());
        case 'MIC_PERMISSION_RESULT': {
          // Роутится в requestMicPermissionInteractively через собственный listener.
          // Здесь ничего не делаем, только подтверждаем.
          return sendResponse({ ok: true });
        }
        case 'OFFSCREEN_EVENT': {
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

  return true;
});

// ─────────────────────────────────────── восстановление после сбоя ──

chrome.runtime.onStartup.addListener(checkForOrphanedSession);
chrome.runtime.onInstalled.addListener(checkForOrphanedSession);

async function checkForOrphanedSession() {
  const s = await getState();
  if (s.status === 'recording' || s.status === 'paused' || s.status === 'starting'
      || s.status === 'awaiting_perm') {
    await setState({
      status: 'idle',
      orphaned: s.sessionId ? { sessionId: s.sessionId, startedAt: s.startedAt, detectedAt: Date.now() } : null,
      error: null,
    });
    if (s.sessionId) {
      await chrome.action.setBadgeText({ text: '?' });
      await chrome.action.setBadgeBackgroundColor({ color: '#f0a238' });
    }
  }
}
