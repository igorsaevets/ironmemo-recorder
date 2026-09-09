import { loadSettings } from '../shared/settings-store.js';
import { getByPath, estimateMBPerHour } from '../shared/settings-schema.js';

const $ = (id) => document.getElementById(id);
let timerHandle = null;

// Живая волна микрофона в popup, чтобы юзер видел «звук приходит» и не получил пустой
// файл, если mic заблокирован драйвером/системой (Kaspersky, audiosrv hang, mute).
// Второй getUserMedia в popup — Chrome шарит mic между контекстами одного origin.
const WAVE = { stream: null, ctx: null, an: null, raf: 0, starting: false, err: null };

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
  $('openSessions').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('src/session-list/session-list.html') }));
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

  if (rec) startWave(); else stopWave();

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
    $('warn').textContent = `Нет данных от записи ${Math.round((Date.now() - s.progressAt) / 1000)} с. Если это продолжается — остановите и запустите запись заново.`;
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

/**
 * What to say about a recording that ended without STOP. Only what recovery.json measured:
 * seconds on disk per role and whether the file decodes end to end. No promise beyond that.
 */
function orphanText(o) {
  const when = o.startedAt ? new Date(o.startedAt).toLocaleString('ru-RU') : '—';
  const r = o.recovery;
  if (!r) return `Запись от ${when} была прервана без остановки. Файлы лежат в хранилище браузера; проверка ещё не выполнялась.`;
  if (!r.ok && r.error) return `Запись от ${when} была прервана. Проверка файлов не удалась: ${r.error}`;
  if (r.skipped) return `Запись от ${when}: ${r.skipped}.`;
  const fmt = (sec) => { const s = Math.round(sec); return `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с`; };
  const parts = Object.entries(r.roles ?? {}).map(([role, x]) => {
    const name = { local_mic: 'микрофон', remote_tab: 'вкладка', compatibility_mix: 'микс' }[role] ?? role;
    const sec = x.secondsDecoded ?? x.secondsOnDisk;
    return `${name} — ${fmt(sec)}${x.decodesFully === true ? ', декодируется целиком' : x.decodesFully === false ? ', ДЕКОДИРУЕТСЯ НЕ ЦЕЛИКОМ' : ''}`;
  });
  return `Запись от ${when} была прервана без остановки. На диске: ${parts.join('; ')}. `
       + `Проверка заняла ${(r.ms / 1000).toFixed(1)} с. Файлы — в «Проба возможностей → Сессии».`;
}

async function startWave() {
  if (WAVE.stream || WAVE.starting || WAVE.err) return;
  WAVE.starting = true;
  try {
    const settings = await loadSettings();
    const mode = getByPath(settings, 'source.mode');
    if (mode === 'tab') { WAVE.starting = false; return; }
    const deviceId = getByPath(settings, 'audioProc.deviceId') || undefined;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
      video: false,
    });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    WAVE.stream = stream; WAVE.ctx = ctx; WAVE.an = an;
    const canvas = $('wave');
    canvas.hidden = false;
    const c2d = canvas.getContext('2d');
    const buf = new Uint8Array(an.fftSize);
    const draw = () => {
      if (!WAVE.stream) return;
      an.getByteTimeDomainData(buf);
      const W = canvas.width, H = canvas.height;
      c2d.fillStyle = '#1d212a';
      c2d.fillRect(0, 0, W, H);
      c2d.lineWidth = 2;
      c2d.strokeStyle = '#4f7cff';
      c2d.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / buf.length) * W;
        const y = (buf[i] / 255) * H;
        i === 0 ? c2d.moveTo(x, y) : c2d.lineTo(x, y);
      }
      c2d.stroke();
      WAVE.raf = requestAnimationFrame(draw);
    };
    WAVE.raf = requestAnimationFrame(draw);
  } catch (e) {
    WAVE.err = e?.name ?? String(e);
  } finally {
    WAVE.starting = false;
  }
}

function stopWave() {
  if (WAVE.raf) cancelAnimationFrame(WAVE.raf);
  WAVE.raf = 0;
  if (WAVE.stream) WAVE.stream.getTracks().forEach((t) => t.stop());
  if (WAVE.ctx && WAVE.ctx.state !== 'closed') WAVE.ctx.close().catch(() => {});
  WAVE.stream = WAVE.ctx = WAVE.an = null;
  const canvas = $('wave');
  if (canvas) canvas.hidden = true;
}

function showError(msg) {
  $('err').hidden = false;
  $('err').textContent = msg;
  // Ошибка связана с микрофоном — предложить открыть страницу разрешения одним кликом.
  const isMicIssue = /микрофон|Permission|разрешен/i.test(msg);
  $('errActions').hidden = !isMicIssue;
}
