import { loadSettings } from '../shared/settings-store.js';
import { getByPath, estimateMBPerHour } from '../shared/settings-schema.js';

const $ = (id) => document.getElementById(id);
let timerHandle = null;

init();

async function init() {
  // Boot probe (B3): the first GET_STATE is what wakes the service worker when the
  // popup opens. Its round-trip is the cold-start cost the user actually feels
  // before the Start button even works. Exposed for the test bench.
  const tBoot = performance.now();
  await renderConfig();
  const first = await state();
  window.__ironmemoBoot = { getStateMs: Math.round(performance.now() - tBoot), status: first.status, at: Date.now() };
  await refresh();

  // clickedAt: точка отсчёта для замера холодного старта (B3) — от клика до 'recording'.
  $('start').addEventListener('click', () => send('START', { clickedAt: Date.now() }));
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
  $('openPermission').addEventListener('click', () =>
    chrome.runtime.sendMessage({ target: 'background', type: 'OPEN_PERMISSION' }));

  // Состояние живёт в storage, а не в popup: popup закрывается, запись — нет.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['ironmemo.captureState.v1']) refresh();
  });
}

async function renderConfig() {
  const v = await loadSettings();
  const modeLabel = { mic: 'микрофон', tab: 'звук вкладки',
                      'mic+tab': 'микрофон + вкладка' }[getByPath(v, 'source.mode')];
  const parts = [];
  if (getByPath(v, 'source.keepSeparate')) parts.push('раздельно');
  if (getByPath(v, 'source.produceMix')) parts.push('+ микс');

  $('config').innerHTML =
    `<div>Источник: <b>${modeLabel}</b> ${parts.join(' ')}</div>` +
    `<div>Кодек: <b>${getByPath(v, 'audioEnc.codec')}</b> / ${getByPath(v, 'audioEnc.container')}, `
    + `<b>${getByPath(v, 'audioEnc.bitrateKbps')} кбит/с</b></div>` +
    `<div>Сегменты: <b>${getByPath(v, 'storage.segmentStrategy')}</b></div>` +
    `<div>Оценка объёма: <b>${estimateMBPerHour(v)} МБ/ч</b></div>` +
    `<div>Профиль: <b>${getByPath(v, 'experiment.profileId')}</b></div>`;
}

async function state() {
  const r = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
  return r?.state ?? { status: 'idle' };
}

async function send(type, extra = {}) {
  $('start').disabled = $('pause').disabled = $('stop').disabled = true;
  const r = await chrome.runtime.sendMessage({ target: 'background', type, ...extra })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (!r?.ok) showError(r?.error ?? 'Неизвестная ошибка');
  await refresh();
}

async function refresh() {
  const s = await state();
  const rec = s.status === 'recording', paused = s.status === 'paused';
  const awaitingPerm = s.status === 'awaiting_perm';

  $('stateDot').className = `dot ${s.status}`;
  $('stateText').textContent = {
    idle: 'Готов к записи', starting: 'Запуск…', recording: 'Идёт запись',
    paused: 'Пауза', error: 'Ошибка',
    awaiting_perm: 'Ждём разрешение микрофона (см. открытую вкладку)',
  }[s.status] ?? s.status;

  $('start').hidden = rec || paused || awaitingPerm;
  $('pause').hidden = !(rec || paused);
  $('stop').hidden  = !(rec || paused);
  $('pause').textContent = paused ? 'Продолжить' : 'Пауза';
  $('start').disabled = $('pause').disabled = $('stop').disabled = false;

  if (s.error) showError(s.error); else { $('err').hidden = true; $('errActions').hidden = true; }

  if (s.orphaned) {
    $('orphan').hidden = false;
    $('orphan').textContent =
      `Найдена незавершённая запись от ${new Date(s.orphaned.startedAt).toLocaleString('ru-RU')}. `
      + 'Сегменты лежат в OPFS. Автоматическое восстановление пока не реализовано — '
      + 'обещать его до проверки декодированием было бы нечестно.';
  } else {
    $('orphan').hidden = true;
  }

  clearInterval(timerHandle);
  if (rec && s.startedAt) {
    const tick = () => {
      const sec = Math.floor((Date.now() - s.startedAt) / 1000);
      $('timer').textContent = [sec / 3600, (sec % 3600) / 60, sec % 60]
        .map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  } else if (!paused) {
    $('timer').textContent = '00:00:00';
  }
}

function showError(msg) {
  $('err').hidden = false;
  $('err').textContent = msg;
  // Ошибка связана с микрофоном — предложить открыть страницу разрешения одним кликом.
  const isMicIssue = /микрофон|Permission|разрешен/i.test(msg);
  $('errActions').hidden = !isMicIssue;
}
