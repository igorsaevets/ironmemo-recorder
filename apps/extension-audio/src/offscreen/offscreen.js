/**
 * offscreen.js — владелец живой сессии записи.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ (итерации 0 и 1):
 *   — открытие источников (микрофон, вкладка), возврат звука вкладки, микс;
 *   — два движка: MediaRecorder (итерация 0) и WebCodecs → Ogg/Opus → OPFS
 *     через Worker (итерация 1, см. capture-worker.js и ADR-002);
 *   — общая временная шкала сессии и журнал с двумя часами (wall + monotonic);
 *   — реакция на потерю/возврат устройства, отзыв разрешения, закрытие вкладки;
 *   — capture-report.json: requested против applied по КАЖДОМУ ключу схемы.
 *
 * ЧЕГО ЗДЕСЬ ЕЩЁ НЕТ (намеренно, каждое — отдельная итерация):
 *   — ремукс и восстановление после сбоя (И-2);
 *   — инкрементальный SHA-256 и экспорт библиотеки (И-3).
 *
 * Пути movement WebCodecs: этот документ только открывает потоки и отдаёт
 * `MediaStreamTrackProcessor.readable` в Worker. Кодирование, muxer и запись
 * на диск — там, потому что durable-запись в OPFS есть только у
 * createSyncAccessHandle, а он существует только в Worker (измерено, см.
 * 03-research/I1-capture-core/feasibility-*.json).
 */

import { runWebCodecsFeasibility } from '../shared/webcodecs-support.js';
import { SETTINGS, getByPath } from '../shared/settings-schema.js';

const state = {
  sessionId: null,
  settings: null,
  engine: null,            // 'mediarecorder' | 'webcodecs'
  recorders: [],           // MR: [{ role, recorder, chunks, mime }]
  streams: [],
  targets: new Map(),      // role -> { kind: 'mic'|'tab'|'mix', stream, track, processor? }
  audioContext: null,
  passthroughNode: null,
  mixDest: null,
  mixSources: new Map(),   // role -> MediaStreamAudioSourceNode feeding the mix
  startedAt: null,         // performance.now()
  timeline: null,          // { t0Wall, t0Mono, t0Iso, monoOrigin }
  opfsDir: null,           // MR path only
  journal: [],             // MR path only (WC path journals in the worker)
  appliedReport: null,
  worker: null,
  pending: new Map(),      // worker request/response waits
  roleApplied: {},         // role -> ROLE_OPENED.applied
  roleStats: {},           // role -> latest worker roleStats
  checkpoints: [],         // worker checkpoints (bounded)
  memSamples: [],
  events: [],
  lost: {},                // role -> { stored, label, atWall, atMono, policy }
  timers: [],
  lastProgressSent: 0,
  paused: false,
  micConstraints: null,
  micStored: null,
  deviceWatchInstalled: false,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'START':  return sendResponse(await start(msg));
        case 'STOP':   return sendResponse(await stop());
        case 'PAUSE':  return sendResponse(await pause());
        case 'RESUME': return sendResponse(await resume());
        case 'STATUS': return sendResponse(status());
        case 'PROBE_WEBCODECS': return sendResponse(await probeWebCodecs(msg));
        case 'DEBUG':  return sendResponse(await debugCommand(msg));
        case 'DEBUG_GUM': return sendResponse(await debugGum(msg));
        default:       return sendResponse({ ok: false, error: `Неизвестно: ${msg.type}` });
      }
    } catch (e) {
      report('error', { error: String(e?.message ?? e) });
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();
  return true;
});

function report(event, payload) {
  chrome.runtime.sendMessage({ target: 'background', type: 'OFFSCREEN_EVENT', event, ...payload })
    .catch(() => { /* worker мог быть выгружен — это нормально, не ошибка */ });
}

const g = (path, fallback) =>
  path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), state.settings) ?? fallback;

const nowPair = () => ({ wall: Date.now(), mono: Math.round(performance.now() * 10) / 10 });

/** Journal an event: in-memory (report) + worker journal (WC) or in-memory journal (MR). */
function logEvent(entry) {
  const e = { ...nowPair(), tMs: state.startedAt == null ? null : Math.round(performance.now() - state.startedAt), ...entry };
  if (state.events.length < 5000) state.events.push(e);
  if (state.worker) state.worker.postMessage({ type: 'EVENT', event: e });
  else state.journal.push({ event: 'event', ...e });
}

// ────────────────────────────────────── feasibility probe (I1) ──

/**
 * Measure, in THIS offscreen context, everything the WebCodecs path needs.
 * Opens the fake/real microphone (and the tab stream if a streamId is given),
 * pulls a second of AudioData through MediaStreamTrackProcessor, spawns the
 * capture worker in PROBE mode, then releases everything.
 */
async function probeWebCodecs({ streamId = null, withMic = true } = {}) {
  const streams = [];
  let micTrack = null, tabTrack = null, micSettings = null, tabSettings = null, errors = {};
  try {
    if (withMic) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
        streams.push(s); micTrack = s.getAudioTracks()[0]; micSettings = micTrack.getSettings();
      } catch (e) { errors.mic = `${e?.name}: ${e?.message}`; }
    }
    if (streamId) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
        streams.push(s); tabTrack = s.getAudioTracks()[0]; tabSettings = tabTrack.getSettings();
      } catch (e) { errors.tab = `${e?.name}: ${e?.message}`; }
    }
    const result = await runWebCodecsFeasibility({
      workerUrl: new URL('./capture-worker.js', import.meta.url).href,
      track: micTrack, tabTrack,
    });
    return { ok: true, result: { ...result, micSettings, tabSettings, micLabel: micTrack?.label ?? null,
                                 tabLabel: tabTrack?.label ?? null, errors } };
  } finally {
    for (const s of streams) s.getTracks().forEach((t) => t.stop());
  }
}

// ───────────────────────────────────────────────────── старт ──

async function start({ sessionId, streamId, settings, startTimings = null }) {
  if (state.sessionId) throw new Error('Запись уже идёт.');
  state.sessionId = sessionId;
  state.settings = settings;
  state.startedAt = performance.now();
  state.timeline = {
    t0Wall: Date.now(), t0Mono: Math.round(state.startedAt * 10) / 10, t0Iso: new Date().toISOString(),
    monoOrigin: performance.timeOrigin, startTimings,
  };
  state.journal = []; state.recorders = []; state.streams = []; state.targets = new Map();
  state.events = []; state.checkpoints = []; state.memSamples = []; state.roleApplied = {}; state.roleStats = {};
  state.lost = {}; state.paused = false; state.mixSources = new Map();

  const mode = g('source.mode', 'mic');
  const impl = g('audioEnc.impl', 'mediarecorder');
  state.engine = impl === 'webcodecs' ? 'webcodecs' : 'mediarecorder';
  const applied = { requestedAt: state.timeline.t0Iso, sources: {}, engine: state.engine };

  // ── микрофон ──
  let micStream = null;
  if (mode === 'mic' || mode === 'mic+tab') {
    const { stream, resolution, constraints, stored } = await openMic();
    micStream = stream;
    state.micConstraints = constraints; state.micStored = stored;
    const t = micStream.getAudioTracks()[0];
    applied.sources.local_mic = describeMicTrack(t, constraints, resolution, stored);
    state.targets.set('local_mic', { kind: 'mic', stream: micStream, track: t });
    attachTrackWatch(t, 'local_mic');
  }

  // ── звук вкладки ──
  let tabStream = null;
  if (mode === 'tab' || mode === 'mic+tab') {
    if (!streamId) throw new Error('Не получен stream ID вкладки.');
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    state.streams.push(tabStream);
    const t = tabStream.getAudioTracks()[0];
    applied.sources.remote_tab = { applied: t.getSettings(), label: t.label };
    state.targets.set('remote_tab', { kind: 'tab', stream: tabStream, track: t });
    attachTrackWatch(t, 'remote_tab');
  }

  // ── AudioContext: возврат звука вкладки и микс ──
  // Частота задаётся явно: без этого контекст берёт частоту устройства вывода
  // (на этой машине 96 000 Гц — измерено в И-0), и микс, а с ним и весь
  // compatibility-ассет, пошёл бы через лишний ресемплинг.
  const requestedRate = g('audioProc.sampleRate', 48000);
  let ac;
  try { ac = new AudioContext({ sampleRate: requestedRate }); }
  catch (e) { ac = new AudioContext(); applied.audioContextRateError = String(e?.message ?? e); }
  state.audioContext = ac;
  applied.audioContext = { sampleRate: ac.sampleRate, requestedSampleRate: requestedRate,
                           baseLatency: ac.baseLatency ?? null, state: ac.state, sinkId: ac.sinkId ?? null };

  const monitorOut = g('source.monitorOutputDeviceId', 'default');
  if (monitorOut && monitorOut !== 'default' && typeof ac.setSinkId === 'function') {
    const id = monitorOut.deviceId ?? monitorOut;
    try { await ac.setSinkId(id); applied.audioContext.sinkId = ac.sinkId; applied.audioContext.sinkRequested = id; }
    catch (e) { applied.audioContext.sinkError = String(e?.message ?? e); applied.audioContext.sinkRequested = id; }
  }

  if (tabStream && g('source.tabAudioPassthrough', true)) {
    const src = ac.createMediaStreamSource(tabStream);
    src.connect(ac.destination);
    state.passthroughNode = src;
  }
  applied.passthroughConnected = !!state.passthroughNode;

  // ── что именно пишем ──
  const keepSeparate = g('source.keepSeparate', true);
  const produceMix = g('source.produceMix', true);
  if (!keepSeparate) { state.targets.delete('local_mic'); state.targets.delete('remote_tab'); }
  if (produceMix && (micStream || tabStream)) {
    const { stream, dest } = buildMix(ac, micStream, tabStream);
    state.mixDest = dest;
    state.targets.set('compatibility_mix', { kind: 'mix', stream, track: stream.getAudioTracks()[0] });
    applied.mix = { layout: g('source.mixLayout', 'mono_sum'), channelCount: dest.channelCount,
                    trackSettings: stream.getAudioTracks()[0].getSettings() };
  }
  if (!state.targets.size) {
    const only = micStream ?? tabStream;
    if (!only) throw new Error('Нет ни одного источника звука.');
    const role = micStream ? 'local_mic' : 'remote_tab';
    state.targets.set(role, { kind: micStream ? 'mic' : 'tab', stream: only, track: only.getAudioTracks()[0] });
  }
  applied.roles = [...state.targets.keys()];

  // ── движок ──
  const bitrate = g('audioEnc.bitrateKbps', 48) * 1000;
  applied.encoder = { impl: state.engine, requestedBitrate: bitrate };
  if (state.engine === 'webcodecs') {
    await startWebCodecs(applied);
  } else {
    await startMediaRecorder(applied, bitrate);
  }

  // ── наблюдение за устройствами, память, часы ──
  installDeviceWatch();
  state.timers.push(setInterval(sampleMemory, 30_000));
  state.timers.push(setInterval(checkClocks, 10_000));
  sampleMemory();

  state.appliedReport = applied;
  await writeCaptureReport(false);
  logEvent({ t: 'session_started', engine: state.engine, roles: applied.roles });
  return { ok: true, appliedReport: applied };
}

async function openMic({ forceDefault = false } = {}) {
  const raw = g('audioProc.rawMode', false);
  const stored = forceDefault ? 'default' : g('source.micDeviceId', 'default');
  const followDefault = g('source.micFollowSystemDefault', true);
  let resolution = { requested: stored, match: 'default', device: null };
  if (stored && stored !== 'default') {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    resolution = resolveStoredDevice(stored, devices);
    if (resolution.match === 'not_found') {
      throw new Error(
        `Выбранный микрофон «${stored.label ?? stored}» сейчас недоступен. `
        + 'Выберите другой в настройках. Автоматически переключаться нельзя: '
        + 'запись пошла бы не с того входа, и вы узнали бы об этом из файла.',
      );
    }
  }
  const constraints = {
    audio: {
      deviceId: resolution.device ? { exact: resolution.device.deviceId } : undefined,
      echoCancellation: raw ? false : g('audioProc.echoCancellation', true),
      noiseSuppression: raw ? false : g('audioProc.noiseSuppression', true),
      autoGainControl:  raw ? false : g('audioProc.autoGainControl', true),
      sampleRate: g('audioProc.sampleRate', 48000),
      channelCount: g('audioProc.channelCount', 1),
    },
    video: false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.streams.push(stream);
  return { stream, resolution, constraints, stored, followDefault };
}

function describeMicTrack(t, constraints, resolution, stored) {
  return {
    requested: constraints.audio,
    applied: t.getSettings(),
    label: t.label,
    deviceResolution: { match: resolution.match, requestedLabel: stored?.label ?? null },
    followSystemDefault: g('source.micFollowSystemDefault', true),
    supportedConstraints: navigator.mediaDevices.getSupportedConstraints(),
    capabilities: typeof t.getCapabilities === 'function' ? safe(() => t.getCapabilities()) : null,
  };
}

const safe = (f) => { try { return f(); } catch { return null; } };

/**
 * Найти сохранённое устройство среди живых.
 * Дублирует `resolveDevice` из audio-devices.js намеренно: offscreen-документ
 * не должен тянуть модуль ради одной функции, а логика тут короткая. Если она
 * начнёт расходиться — вынести в общий модуль.
 */
function resolveStoredDevice(stored, devices) {
  const byId = devices.find((d) => d.deviceId === (stored.deviceId ?? stored));
  if (byId) return { requested: stored, match: 'deviceId', device: byId };
  if (stored.label) {
    const byLabel = devices.find((d) => d.label === stored.label);
    if (byLabel) return { requested: stored, match: 'label', device: byLabel };
  }
  if (stored.groupId) {
    const byGroup = devices.find((d) => d.groupId === stored.groupId);
    if (byGroup) return { requested: stored, match: 'groupId', device: byGroup };
  }
  return { requested: stored, match: 'not_found', device: null };
}

/** Сведение источников в один поток для compatibility-ассета. */
function buildMix(ac, micStream, tabStream) {
  const dest = ac.createMediaStreamDestination();
  const layout = g('source.mixLayout', 'mono_sum');
  if (layout === 'stereo_split' && micStream && tabStream) {
    // Экспериментальная раскладка: слева микрофон, справа вкладка.
    dest.channelCount = 2;
    const merger = ac.createChannelMerger(2);
    const m = ac.createMediaStreamSource(micStream); m.connect(merger, 0, 0); state.mixSources.set('local_mic', m);
    const t = ac.createMediaStreamSource(tabStream); t.connect(merger, 0, 1); state.mixSources.set('remote_tab', t);
    merger.connect(dest);
  } else {
    dest.channelCount = 1;
    if (micStream) { const m = ac.createMediaStreamSource(micStream); m.connect(dest); state.mixSources.set('local_mic', m); }
    if (tabStream) { const t = ac.createMediaStreamSource(tabStream); t.connect(dest); state.mixSources.set('remote_tab', t); }
  }
  return { stream: dest.stream, dest };
}

// ───────────────────────────────────────────── движок: MediaRecorder ──

async function startMediaRecorder(applied, bitrate) {
  const mime = resolveMime();
  applied.encoder.requestedMime = mime;
  if (g('storage.backend', 'opfs') === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory();
      const sessions = await root.getDirectoryHandle('sessions', { create: true });
      state.opfsDir = await sessions.getDirectoryHandle(state.sessionId, { create: true });
    } catch (e) {
      state.opfsDir = null;
      applied.opfsError = String(e?.message ?? e);
    }
  }
  for (const [role, t] of state.targets) startRecorderFor(role, t.stream, mime, bitrate);
  applied.tracks = state.recorders.map((r) => ({
    role: r.role, requestedMime: mime, actualMime: r.actualMime,
    requestedBitrate: bitrate, actualBitrate: r.actualBitrate, mimeHonoured: r.actualMime === mime,
  }));
}

function startRecorderFor(role, stream, mime, bitrate) {
  if (!MediaRecorder.isTypeSupported(mime)) {
    throw new Error(`Контейнер ${mime} не поддерживается этим Chrome. Смените его в настройках.`);
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: bitrate });
  const prev = state.recorders.filter((r) => r.role === role).at(-1);
  const entry = { role, recorder: rec, chunks: [], mime, bytes: prev?.bytes ?? 0, seq: prev?.seq ?? 0,
                  segment: (prev?.segment ?? -1) + 1, lastChunkMono: null, chunkIntervalsMs: [] };
  rec.ondataavailable = async (e) => {
    if (!e.data.size) return;
    const mono = performance.now();
    if (entry.lastChunkMono !== null && entry.chunkIntervalsMs.length < 100000) entry.chunkIntervalsMs.push(Math.round(mono - entry.lastChunkMono));
    entry.lastChunkMono = mono;
    entry.bytes += e.data.size;
    entry.seq++;
    if (state.opfsDir) {
      await writeChunk(entry, e.data).catch((err) => report('error', { error: `Запись на диск: ${err.message}` }));
    } else {
      entry.chunks.push(e.data);
    }
    throttledProgress({ role, seq: entry.seq, bytes: entry.bytes });
  };
  rec.onerror = (e) => report('error', { error: `MediaRecorder ${role}: ${e.error?.message}` });
  rec.start(g('storage.timesliceMs', 5000));
  entry.actualMime = rec.mimeType;
  entry.actualBitrate = rec.audioBitsPerSecond;
  state.recorders.push(entry);
  return entry;
}

function resolveMime() {
  const codec = g('audioEnc.codec', 'opus');
  const container = g('audioEnc.container', 'webm');
  if (codec === 'pcm16') return 'audio/webm;codecs=pcm';
  const codecPart = { opus: 'opus', aac: 'mp4a.40.2' }[codec] ?? 'opus';
  const containerPart = { webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4' }[container] ?? 'audio/webm';
  return `${containerPart};codecs=${codecPart}`;
}

/**
 * Журнал ведётся ПОСЛЕ успешной записи на диск, а не до неё.
 * Запись «собираюсь записать» бесполезна: восстановление должно опираться на
 * то, что действительно легло, иначе оно восстановит несуществующие байты.
 */
async function writeChunk(entry, blob) {
  const name = `${entry.role}.${String(entry.seq).padStart(6, '0')}.part`;
  const fh = await state.opfsDir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  state.journal.push({
    role: entry.role, seq: entry.seq, segment: entry.segment, file: name, bytes: blob.size,
    tMs: Math.round(performance.now() - state.startedAt), at: Date.now(),
  });
  if (g('storage.journalEnabled', true)) await flushJournal();
}

async function flushJournal() {
  if (!state.opfsDir) return;
  const fh = await state.opfsDir.getFileHandle('journal.jsonl', { create: true });
  const w = await fh.createWritable();
  await w.write(state.journal.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await w.close();
}

// ───────────────────────────────────────────── движок: WebCodecs ──

function workerRequest(msg, replyType, { role = null, timeoutMs = 10000, transfer = [] } = {}) {
  return new Promise((resolve, reject) => {
    const key = role ? `${replyType}:${role}` : replyType;
    const timer = setTimeout(() => { state.pending.delete(key); reject(new Error(`Worker не ответил на ${msg.type}${role ? ' (' + role + ')' : ''} за ${timeoutMs} мс`)); }, timeoutMs);
    state.pending.set(key, (data) => { clearTimeout(timer); state.pending.delete(key); resolve(data); });
    state.worker.postMessage(msg, transfer);
  });
}

function onWorkerMessage(e) {
  const m = e.data;
  const key = m.role ? `${m.type}:${m.role}` : m.type;
  const waiter = state.pending.get(key) ?? state.pending.get(m.type);
  if (waiter && ['SESSION_OPENED', 'SESSION_CLOSED', 'ROLE_OPENED', 'ROLE_REOPENED', 'ROLE_CLOSED', 'REPORT_WRITTEN', 'STOPPED', 'PAUSED', 'RESUMED', 'PROBE_RESULT'].includes(m.type)) {
    waiter(m);
    if (m.type !== 'ROLE_CLOSED') return;
  }
  switch (m.type) {
    case 'PROGRESS': {
      Object.assign(state.roleStats, m.roles);
      if (state.checkpoints.length < 5000) state.checkpoints.push(m.checkpoint);
      throttledProgress(progressSummary(), 5000);
      break;
    }
    case 'ERROR':
      logEvent({ t: 'worker_error', role: m.role ?? null, error: m.error, during: m.during ?? null });
      report('error', { error: `Worker${m.role ? ' (' + m.role + ')' : ''}: ${m.error}` });
      break;
    case 'ROLE_CLOSED':
      state.roleStats[m.role] = m.stats;
      break;
    default: break;
  }
}

function encoderRequestFromSettings() {
  return {
    bitrate: g('audioEnc.bitrateKbps', 48) * 1000,
    bitrateMode: g('audioEnc.bitrateMode', 'variable'),
    opus: {
      application: g('audioEnc.opusApplication', 'voip'),
      complexity: g('audioEnc.opusComplexity', 9),
      frameDuration: g('audioEnc.opusFrameDurationUs', 20000),
      usedtx: g('audioEnc.opusUseDTX', false),
      useinbandfec: g('audioEnc.opusUseInbandFEC', false),
    },
  };
}

async function startWebCodecs(applied) {
  if (g('audioEnc.codec', 'opus') !== 'opus') {
    throw new Error('Путь WebCodecs в этой итерации реализован только для Opus. Выберите Opus или MediaRecorder.');
  }
  if (g('audioEnc.container', 'webm') !== 'ogg') {
    throw new Error('Путь WebCodecs в этой итерации пишет только Ogg. Выберите контейнер Ogg или движок MediaRecorder. '
                  + 'Заглушка намеренная: молчаливая подмена контейнера исказила бы замер.');
  }
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof AudioEncoder === 'undefined') {
    throw new Error('В этом Chrome нет MediaStreamTrackProcessor или AudioEncoder — путь WebCodecs недоступен.');
  }
  if (g('storage.backend', 'opfs') !== 'opfs') {
    throw new Error('Путь WebCodecs пишет только в OPFS (createSyncAccessHandle в Worker). Выберите OPFS.');
  }
  state.worker = new Worker(new URL('./capture-worker.js', import.meta.url), { type: 'module' });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => report('error', { error: `Worker crashed: ${e.message}` });

  const opened = await workerRequest({
    type: 'OPEN_SESSION', sessionId: state.sessionId, t0: state.timeline,
    opts: {
      flushIntervalMs: g('storage.flushIntervalMs', 1000),
      journalEnabled: g('storage.journalEnabled', true),
      fillGapsWithSilence: g('source.onDeviceReturn', 'resume_fill_silence') === 'resume_fill_silence',
      muxerGapFillMs: g('storage.muxerGapFillMs', 40),
    },
    settingsSnapshot: g('experiment.forceProfileEveryRecording', true) ? state.settings : null,
  }, 'SESSION_OPENED');
  if (!opened.ok) throw new Error(opened.error ?? 'OPEN_SESSION failed');

  const encoder = encoderRequestFromSettings();
  applied.encoder.requested = encoder;
  applied.encoder.container = 'ogg';
  applied.encoder.codec = 'opus';
  applied.tracks = [];
  for (const [role, t] of state.targets) {
    const r = await openRoleInWorker(role, t, encoder);
    applied.tracks.push(r);
  }
}

async function openRoleInWorker(role, t, encoder, { reopen = false, gapMs = null } = {}) {
  const proc = new MediaStreamTrackProcessor({ track: t.track });
  t.processor = proc;
  const expected = t.track.getSettings();
  if (reopen) {
    const r = await workerRequest({ type: 'REOPEN_ROLE', role, readable: proc.readable, gapMs }, 'ROLE_REOPENED',
                                  { role, timeoutMs: 15000, transfer: [proc.readable] });
    return r;
  }
  const r = await workerRequest({
    type: 'OPEN_ROLE', role, readable: proc.readable, encoder, expected,
    downmix: t.kind === 'tab' && g('source.tabDownmixToMono', true),
    muxer: { comments: [`IRONMEMO_PROFILE=${g('experiment.profileId', 'default')}`, `IRONMEMO_T0=${state.timeline.t0Iso}`] },
  }, 'ROLE_OPENED', { role, timeoutMs: 8000, transfer: [proc.readable] });
  if (!r.ok) throw new Error(`${role}: ${r.error}`);
  state.roleApplied[role] = r.applied;
  return { role, container: 'ogg', codec: 'opus', file: `${role}.opus`, ...r.applied,
           bitrateHonouredByEncoderConfig: r.applied?.encoderApplied?.bitrate === encoder.bitrate };
}

// ───────────────────────────────────── устройства: потеря и возврат ──

function attachTrackWatch(track, role) {
  const t = state.targets.get(role);
  track.addEventListener('ended', () => onTrackEnded(role, track));
  track.addEventListener('mute', () => logEvent({ t: 'track_mute', role, label: track.label, readyState: track.readyState }));
  track.addEventListener('unmute', () => logEvent({ t: 'track_unmute', role, label: track.label, readyState: track.readyState }));
  if (t) t.watched = true;
}

function installDeviceWatch() {
  if (state.deviceWatchInstalled) return;
  state.deviceWatchInstalled = true;
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
}

async function onDeviceChange() {
  if (!state.sessionId) return;
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch {}
  logEvent({ t: 'devicechange', inputs: devices.map((d) => d.label || d.deviceId.slice(0, 8)) });
  for (const [role, lost] of Object.entries(state.lost)) {
    if (role !== 'local_mic') continue;
    const policy = lost.policy;
    if (policy !== 'pause_and_notify') continue;
    if (g('source.onDeviceReturn', 'resume_fill_silence') === 'stay_paused') continue;
    const found = resolveStoredDevice(lost.stored?.deviceId ? lost.stored : { label: lost.label, groupId: lost.groupId }, devices);
    if (found.match === 'not_found') continue;
    await reacquireMic(role, found.device, lost).catch((e) => {
      logEvent({ t: 'device_reacquire_failed', role, error: String(e?.message ?? e) });
      report('error', { error: `Устройство «${lost.label}» появилось снова, но открыть его не удалось: ${e?.message ?? e}` });
    });
  }
}

/**
 * Устройство пропало во время записи. Поведение задаёт `source.onDeviceLost`.
 * Молча продолжать с другого входа — худший вариант: человек узнает об этом
 * из файла, когда переслушивать уже поздно.
 */
async function onTrackEnded(role, track) {
  if (!state.sessionId) return;
  const t = state.targets.get(role);
  if (t && t.track !== track) return; // stale listener from a replaced track
  const label = track.label;
  logEvent({ t: 'track_ended', role, label, readyState: track.readyState });

  if (role === 'remote_tab') {
    // Вкладка закрыта или захват отозван. streamId одноразовый и выдаётся
    // только service worker'у по жесту — переоткрыть отсюда нельзя.
    if (state.worker) await workerRequest({ type: 'CLOSE_ROLE', role, reason: 'tab_track_ended' }, 'ROLE_CLOSED', { role }).catch(() => {});
    state.lost[role] = { label, ...nowPair(), policy: 'close_role' };
    report('warning', { error: `Захват вкладки завершился (вкладка закрыта или навигация запрещена). Микрофон продолжает записываться.` });
    return;
  }
  if (role !== 'local_mic') return;

  const policy = g('source.onDeviceLost', 'pause_and_notify');
  const stored = state.micStored;
  state.lost[role] = { stored, label, groupId: t?.track?.getSettings?.().groupId ?? null, ...nowPair(), policy };
  logEvent({ t: 'device_lost', role, label, policy });

  if (policy === 'stop') {
    report('error', { error: `Устройство «${label}» отключилось во время записи (${role}). Запись остановлена.` });
    stop().catch(() => {});
    return;
  }
  if (policy === 'switch_to_default') {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const def = devices.find((d) => d.deviceId === 'default') ?? devices[0];
      if (!def) throw new Error('нет ни одного входа');
      await reacquireMic(role, def, state.lost[role], { forceDefault: true });
      report('warning', { error: `Устройство «${label}» отключилось. Продолжаем с устройством по умолчанию — в файле будет стык.` });
    } catch (e) {
      report('error', { error: `Устройство «${label}» отключилось, переключиться на устройство по умолчанию не удалось: ${e?.message ?? e}` });
    }
    return;
  }
  // pause_and_notify: the file stays open; onDeviceChange resumes when the same device returns.
  report('error', { error: `Устройство «${label}» отключилось во время записи (${role}). Запись микрофона на паузе; `
                         + 'при возврате того же устройства продолжится автоматически.' });
}

async function reacquireMic(role, device, lost, { forceDefault = false } = {}) {
  const constraints = structuredClone(state.micConstraints);
  constraints.audio.deviceId = forceDefault ? undefined : { exact: device.deviceId };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.streams.push(stream);
  const track = stream.getAudioTracks()[0];
  const t = state.targets.get(role) ?? { kind: 'mic' };
  t.stream = stream; t.track = track; state.targets.set(role, t);
  attachTrackWatch(track, role);
  const gapMs = Date.now() - lost.wall;
  // Mix: replace the dead source node.
  if (state.mixDest && state.mixSources.has(role)) {
    const old = state.mixSources.get(role);
    try { old.disconnect(); } catch {}
    const src = state.audioContext.createMediaStreamSource(stream);
    src.connect(state.mixDest);
    state.mixSources.set(role, src);
  }
  if (state.engine === 'webcodecs') {
    const r = await openRoleInWorker(role, t, null, { reopen: true, gapMs });
    logEvent({ t: 'device_returned', role, label: track.label, gapMs, silenceFrames: r.silenceFrames ?? 0, match: forceDefault ? 'default' : 'same_device' });
  } else {
    const mime = resolveMime();
    startRecorderFor(role, stream, mime, g('audioEnc.bitrateKbps', 48) * 1000);
    logEvent({ t: 'device_returned', role, label: track.label, gapMs, match: forceDefault ? 'default' : 'same_device', note: 'MediaRecorder: new segment, gap NOT filled' });
  }
  delete state.lost[role];
  report('info', { error: null, info: `Устройство «${track.label}» снова записывается (пауза ${Math.round(gapMs / 100) / 10} с).` });
}

// ───────────────────────────────────────── часы, память, прогресс ──

function sampleMemory() {
  const m = performance.memory;
  const s = { ...nowPair(), usedJSHeapMB: m ? Math.round(m.usedJSHeapSize / 1048576 * 10) / 10 : null,
              totalJSHeapMB: m ? Math.round(m.totalJSHeapSize / 1048576 * 10) / 10 : null,
              events: state.events.length, checkpointsKept: state.checkpoints.length };
  if (state.memSamples.length < 2000) state.memSamples.push(s);
  logEvent({ t: 'memory', ...s });
}

let lastClock = null;
function checkClocks() {
  const now = nowPair();
  if (lastClock) {
    const dw = now.wall - lastClock.wall, dm = now.mono - lastClock.mono;
    if (Math.abs(dw - dm) > 1500) logEvent({ t: 'clock_jump_main', wallDeltaMs: dw, monoDeltaMs: Math.round(dm), disagreementMs: Math.round(dw - dm) });
  }
  lastClock = now;
}

function throttledProgress(progress, minIntervalMs = 1000) {
  const now = Date.now();
  if (now - state.lastProgressSent < minIntervalMs) return;
  state.lastProgressSent = now;
  report('progress', { progress });
}

function progressSummary() {
  const roles = {};
  for (const [role, s] of Object.entries(state.roleStats)) {
    roles[role] = { bytes: s.fileBytes, frames: s.frames, granule48k: s.granule48k, mediaSec: s.mediaSec,
                    driftVsWallMs: s.driftVsWallMs, discontinuities: s.discontinuities, pages: s.pages,
                    effectiveKbps: s.effectiveKbps, ended: s.ended, paused: s.paused };
  }
  const cp = state.checkpoints.at(-1);
  return { engine: 'webcodecs', roles, checkpoint: cp?.n ?? 0, drift: computeDrift(), memory: state.memSamples.at(-1) ?? null,
           bytes: Object.values(roles).reduce((a, r) => a + (r.bytes ?? 0), 0), events: state.events.length };
}

/**
 * Drift between roles from the worker's synchronous checkpoints.
 * For each pair: d(k) = mediaSec_a(k) − mediaSec_b(k); drift(k) = d(k) − d(0).
 * Slope in ppm = drift_last / elapsed. Pause frames are added back so that a
 * shared pause does not read as drift.
 */
function computeDrift() {
  const cps = state.checkpoints;
  if (cps.length < 2) return null;
  const roles = Object.keys(cps[0].roles ?? {});
  const media = (cp, r) => {
    const x = cp.roles[r];
    if (!x || !x.sampleRate) return null;
    // real frames + shared pause + silence inserted for a device gap: all of it is
    // time the asset's timeline accounts for, so none of it is drift.
    return (x.frames + x.pausedFrames + (x.silenceFrames ?? 0)) / x.sampleRate;
  };
  const out = { pairs: {}, vsWall: {}, checkpoints: cps.length, elapsedSec: Math.round((cps.at(-1).wall - cps[0].wall) / 100) / 10 };
  for (const r of roles) {
    const m0 = media(cps[0], r), m1 = media(cps.at(-1), r);
    if (m0 == null || m1 == null) continue;
    const wall = (cps.at(-1).wall - cps[0].wall) / 1000;
    const driftMs = ((m1 - m0) - wall) * 1000;
    // ms per second is parts per thousand; ×1000 gives ppm.
    out.vsWall[r] = { driftMs: Math.round(driftMs * 10) / 10, ppm: wall > 0 ? Math.round(driftMs / wall * 1000 * 10) / 10 : null, mediaSec: Math.round((m1 - m0) * 100) / 100, wallSec: Math.round(wall * 100) / 100 };
  }
  for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) {
    const a = roles[i], b = roles[j];
    const series = [];
    let d0 = null, maxAbs = 0;
    for (const cp of cps) {
      const ma = media(cp, a), mb = media(cp, b);
      if (ma == null || mb == null) continue;
      const d = ma - mb;
      if (d0 === null) d0 = d;
      const drift = (d - d0) * 1000;
      if (Math.abs(drift) > maxAbs) maxAbs = Math.abs(drift);
      series.push({ elapsedSec: Math.round((cp.wall - cps[0].wall) / 1000), driftMs: Math.round(drift * 10) / 10 });
    }
    if (!series.length) continue;
    const last = series.at(-1);
    out.pairs[`${a}_vs_${b}`] = {
      initialOffsetMs: d0 == null ? null : Math.round(d0 * 1000 * 10) / 10,
      driftMs: last.driftMs, maxAbsDriftMs: Math.round(maxAbs * 10) / 10,
      ppm: last.elapsedSec > 0 ? Math.round(last.driftMs / last.elapsedSec * 1000 * 10) / 10 : null,
      points: series.length,
      series: series.length > 60 ? series.filter((_, k) => k % Math.ceil(series.length / 60) === 0 || k === series.length - 1) : series,
    };
  }
  return out;
}

// ───────────────────────────────── capture-report: requested vs applied ──

/**
 * For every key of the settings schema: what was requested, what the browser
 * applied (read back from the place `readback` names), and whether they match.
 * `applied: null` with a note means "cannot be read back" — honest, not silent.
 */
function requestedVsApplied(final) {
  const a = state.appliedReport ?? {};
  const mic = a.sources?.local_mic;
  const micApplied = mic?.applied ?? null;
  const rs = state.roleStats;
  const anyRole = Object.values(rs)[0];
  const micRole = rs.local_mic ?? state.roleApplied.local_mic;
  const encApplied = (r) => (rs[r]?.encoderApplied ?? state.roleApplied[r]?.encoderApplied ?? null);
  const firstEnc = encApplied('local_mic') ?? encApplied('remote_tab') ?? encApplied('compatibility_mix');
  const raw = g('audioProc.rawMode', false);
  const mrTrack = (r) => a.tracks?.find((t) => t.role === r);
  const kbpsMeasured = Object.fromEntries(Object.entries(rs).map(([r, s]) => [r, s.effectiveKbps]));

  const rb = {
    'source.mode': { applied: a.roles ? `${Object.keys(a.sources ?? {}).length} источник(а): ${Object.keys(a.sources ?? {}).join(', ')}` : null },
    'source.keepSeparate': { applied: a.roles ? a.roles.includes('local_mic') || a.roles.includes('remote_tab') : null },
    'source.produceMix': { applied: a.roles ? a.roles.includes('compatibility_mix') : null },
    'source.mixLayout': { applied: a.mix ? (a.mix.channelCount === 2 ? 'stereo_split' : 'mono_sum') : null, note: a.mix ? `dest.channelCount=${a.mix.channelCount}` : 'микс не создавался' },
    'source.tabAudioPassthrough': { applied: a.sources?.remote_tab ? !!a.passthroughConnected : null, note: a.sources?.remote_tab ? null : 'вкладка не захватывалась' },
    'source.tabDownmixToMono': { applied: a.sources?.remote_tab ? (rs.remote_tab?.downmixedToMono ?? state.roleApplied.remote_tab?.input?.downmixedToMono ?? null) : null,
      note: a.sources?.remote_tab ? `вход вкладки: ${rs.remote_tab?.inputChannels ?? state.roleApplied.remote_tab?.input?.channels ?? '—'} кан., энкодер: ${rs.remote_tab?.channels ?? '—'} кан.` : 'вкладка не захватывалась' },
    'source.micDeviceId': { applied: micApplied ? { deviceId: micApplied.deviceId, label: mic.label, match: mic.deviceResolution?.match } : null },
    'source.micFollowSystemDefault': { applied: micApplied ? micApplied.deviceId === 'default' : null },
    'source.monitorOutputDeviceId': { applied: a.audioContext ? (a.audioContext.sinkId === '' || a.audioContext.sinkId == null ? 'default' : a.audioContext.sinkId) : null, note: a.audioContext?.sinkError ?? null },
    'source.onDeviceLost': { applied: null, note: `политика; событий device_lost: ${state.events.filter((e) => e.t === 'device_lost').length}` },
    'source.onDeviceReturn': { applied: null, note: `политика; событий device_returned: ${state.events.filter((e) => e.t === 'device_returned').length}` },
    'audioProc.echoCancellation': { applied: micApplied?.echoCancellation ?? null, requestedOverride: raw ? false : undefined },
    'audioProc.noiseSuppression': { applied: micApplied?.noiseSuppression ?? null, requestedOverride: raw ? false : undefined },
    'audioProc.autoGainControl': { applied: micApplied?.autoGainControl ?? null, requestedOverride: raw ? false : undefined },
    'audioProc.rawMode': { applied: micApplied ? (!micApplied.echoCancellation && !micApplied.noiseSuppression && !micApplied.autoGainControl) : null },
    'audioProc.sampleRate': { applied: micApplied?.sampleRate ?? a.sources?.remote_tab?.applied?.sampleRate ?? null,
      note: `track=${micApplied?.sampleRate ?? '—'}; AudioData=${micRole?.input?.sampleRate ?? rs.local_mic?.sampleRate ?? '—'}; AudioContext=${a.audioContext?.sampleRate ?? '—'}; tab=${a.sources?.remote_tab?.applied?.sampleRate ?? '—'}` },
    'audioProc.channelCount': { applied: micApplied?.channelCount ?? null, note: `AudioData channels=${rs.local_mic?.channels ?? '—'}` },
    'audioEnc.impl': { applied: state.engine === 'webcodecs' ? 'webcodecs' : 'mediarecorder' },
    'audioEnc.codec': { applied: state.engine === 'webcodecs' ? (firstEnc?.codec ?? 'opus') : (mrTrack('local_mic')?.actualMime ?? anyRole?.actualMime ?? a.tracks?.[0]?.actualMime ?? null) },
    'audioEnc.container': { applied: state.engine === 'webcodecs' ? 'ogg' : (a.tracks?.[0]?.actualMime?.split(';')[0]?.replace('audio/', '') ?? null) },
    'audioEnc.bitrateKbps': { applied: state.engine === 'webcodecs' ? (firstEnc ? firstEnc.bitrate / 1000 : null) : (a.tracks?.[0]?.actualBitrate != null ? a.tracks[0].actualBitrate / 1000 : null),
      note: final ? `измерено, кбит/с по ролям: ${JSON.stringify(kbpsMeasured)}` : 'измеренный битрейт — в финальном отчёте' },
    'audioEnc.bitrateMode': { applied: firstEnc?.bitrateMode ?? null },
    'audioEnc.opusApplication': { applied: firstEnc?.opus?.application ?? null },
    'audioEnc.opusComplexity': { applied: firstEnc?.opus?.complexity ?? null },
    'audioEnc.opusFrameDurationUs': { applied: firstEnc?.opus?.frameDuration ?? null, note: final ? `chunk durations seen: ${JSON.stringify(rs.local_mic?.chunkDurationsSeenUs ?? anyRole?.chunkDurationsSeenUs ?? null)}` : null },
    'audioEnc.opusUseDTX': { applied: firstEnc?.opus?.usedtx ?? null, note: final && anyRole ? `packets/s = ${anyRole.mediaSec ? Math.round(anyRole.packets / anyRole.mediaSec * 10) / 10 : '—'} (50/s без DTX при 20 мс)` : null },
    'audioEnc.opusUseInbandFEC': { applied: firstEnc?.opus?.useinbandfec ?? null, note: 'из isConfigSupported().config; в файле не проверяется' },
    'video.enabled': { applied: false, note: 'видео в этой итерации не пишется' },
    'storage.backend': { applied: state.engine === 'webcodecs' ? 'opfs' : (state.opfsDir ? 'opfs' : 'memory'), note: a.opfsError ?? null },
    'storage.segmentStrategy': { applied: state.engine === 'webcodecs' ? 'webcodecs_muxed' : 'continuous', note: 'rolling_finalized — И-2' },
    'storage.timesliceMs': { applied: state.engine === 'mediarecorder' && final ? meanInterval(state.recorders[0]?.chunkIntervalsMs) : null, note: state.engine === 'mediarecorder' ? 'измеренный средний интервал ondataavailable' : 'не применимо к WebCodecs' },
    // Median, not mean: a device-loss pause produces one page interval as long as the gap
    // (measured: one 10 000 ms interval in the `devices` run skewed the mean to 1094 ms).
    'storage.flushIntervalMs': { applied: state.engine === 'webcodecs' && final ? (anyRole?.pageIntervalMs?.p50 ?? null) : null, note: state.engine === 'webcodecs' ? `интервалы страниц Ogg (p50/p95/max/mean): ${JSON.stringify(anyRole?.pageIntervalMs ?? null)}` : 'не применимо к MediaRecorder' },
    'storage.journalEnabled': { applied: g('storage.journalEnabled', true), note: state.engine === 'webcodecs' ? 'журнал ведёт worker (journal.jsonl)' : `записей: ${state.journal.length}` },
    'storage.muxerGapFillMs': { applied: state.engine === 'webcodecs' ? g('storage.muxerGapFillMs', 40) : null,
      note: state.engine === 'webcodecs' ? `вставлено тишины по ролям, с: ${JSON.stringify(Object.fromEntries(Object.entries(rs).map(([k, v]) => [k, v.fillerSec ?? 0])))}` : 'не применимо к MediaRecorder' },
  };
  const out = [];
  for (const s of SETTINGS) {
    const requested = getByPath(state.settings, s.key);
    const r = rb[s.key];
    let applied = r?.applied, note = r?.note ?? null, honoured = null;
    const applicable = r !== undefined;
    if (!applicable) { applied = null; note = 'не участвует в записи (upload/consent/recovery/experiment/video)'; }
    else if (applied === null || applied === undefined) { applied = null; honoured = null; note ??= (s.readback ? `readback (${s.readback}) недоступен в этой сессии` : 'readback: null — не читается'); }
    else {
      const req = r.requestedOverride !== undefined ? r.requestedOverride : requested;
      honoured = compareApplied(s.key, req, applied);
    }
    out.push({ key: s.key, stage: s.stage, applicable, requested, applied, honoured, readback: s.readback ?? null, note });
  }
  return out;
}

function compareApplied(key, req, applied) {
  if (key === 'source.micDeviceId') {
    if (req === 'default' || !req) return applied.deviceId === 'default' || applied.match === 'default';
    return applied.match === 'deviceId' || applied.match === 'label' || applied.match === 'groupId';
  }
  if (key === 'source.mode') return true; // descriptive
  if (typeof req === 'number' && typeof applied === 'number') return Math.abs(req - applied) <= Math.max(1, req * 0.02);
  if (typeof req === 'object' && req) return JSON.stringify(req) === JSON.stringify(applied);
  return req === applied;
}

function meanInterval(arr) {
  if (!arr?.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function buildCaptureReport(final) {
  const rows = requestedVsApplied(final);
  return {
    kind: 'ironmemo-capture-report', version: 2, final,
    sessionId: state.sessionId, engine: state.engine,
    writtenAt: new Date().toISOString(),
    browser: { userAgent: navigator.userAgent, uaData: navigator.userAgentData
      ? { platform: navigator.userAgentData.platform, brands: navigator.userAgentData.brands } : null },
    timeline: state.timeline,
    appliedReport: state.appliedReport,
    requestedVsApplied: rows,
    mismatches: rows.filter((r) => r.honoured === false).map((r) => r.key),
    honoured: rows.filter((r) => r.honoured === true).map((r) => r.key),
    unreadable: rows.filter((r) => r.applicable && r.applied === null).map((r) => r.key),
    notApplicable: rows.filter((r) => !r.applicable).length,
    roles: state.roleStats,
    drift: computeDrift(),
    events: state.events,
    memory: state.memSamples,
    settings: state.settings,
  };
}

async function writeCaptureReport(final) {
  if (!g('diagnostics.keepCaptureReport', true)) return;
  const rep = buildCaptureReport(final);
  if (state.worker) {
    await workerRequest({ type: 'WRITE_REPORT', report: rep, final }, 'REPORT_WRITTEN').catch((e) => report('error', { error: `capture-report: ${e.message}` }));
  } else if (state.opfsDir) {
    const fh = await state.opfsDir.getFileHandle('capture-report.json', { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(rep, null, 2));
    await w.close();
  }
  return rep;
}

// ────────────────────────────────────────────── пауза / стоп ──

async function pause() {
  state.paused = true;
  logEvent({ t: 'pause_requested' });
  if (state.worker) await workerRequest({ type: 'PAUSE' }, 'PAUSED');
  for (const r of state.recorders) if (r.recorder.state === 'recording') r.recorder.pause();
  return { ok: true };
}

async function resume() {
  state.paused = false;
  logEvent({ t: 'resume_requested' });
  if (state.worker) await workerRequest({ type: 'RESUME' }, 'RESUMED');
  for (const r of state.recorders) if (r.recorder.state === 'paused') r.recorder.resume();
  return { ok: true };
}

function status() {
  return { ok: true, sessionId: state.sessionId, engine: state.engine, paused: state.paused,
           progress: state.worker ? progressSummary() : null, events: state.events.slice(-20), lost: state.lost };
}

async function stop() {
  if (!state.sessionId) return { ok: false, error: 'Запись не идёт.' };
  const results = [];
  let workerResult = null;
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
  state.deviceWatchInstalled = false;
  logEvent({ t: 'stop_requested' });

  if (state.worker) {
    const r = await workerRequest({ type: 'STOP' }, 'STOPPED', { timeoutMs: 30000 });
    workerResult = r.result;
    if (workerResult?.roles) Object.assign(state.roleStats, workerResult.roles);
    for (const [role, s] of Object.entries(workerResult?.roles ?? {})) {
      results.push({ role, mime: 'audio/ogg;codecs=opus', file: `${role}.opus`, bytes: s.fileBytes, segments: s.pages,
                     storedIn: 'opfs', stats: s });
    }
  } else {
    await Promise.all(state.recorders.map((entry) => new Promise((resolve) => {
      if (entry.recorder.state === 'inactive') return resolve();
      entry.recorder.onstop = resolve;
      entry.recorder.stop();
    })));
    const byRole = new Map();
    for (const entry of state.recorders) {
      const prev = byRole.get(entry.role);
      byRole.set(entry.role, { role: entry.role, mime: entry.actualMime, bytes: entry.bytes, segments: entry.seq,
                               storedIn: state.opfsDir ? 'opfs' : 'memory', recorderSegments: (prev?.recorderSegments ?? 0) + 1,
                               chunkIntervalMs: meanInterval(entry.chunkIntervalsMs) });
    }
    results.push(...byRole.values());
    if (state.opfsDir) await flushJournal().catch(() => {});
  }

  for (const s of state.streams) s.getTracks().forEach((t) => t.stop());
  state.passthroughNode?.disconnect();
  await state.audioContext?.close().catch(() => {});

  const durationMs = Math.round(performance.now() - state.startedAt);
  const drift = computeDrift();
  // Final report FIRST (the worker still holds the session), then close, then terminate.
  const finalReport = await writeCaptureReport(true).catch((e) => { report('error', { error: `final capture-report: ${e?.message ?? e}` }); return null; });
  if (state.worker) {
    await workerRequest({ type: 'CLOSE_SESSION' }, 'SESSION_CLOSED', { timeoutMs: 10000 }).catch(() => {});
    state.worker.terminate(); state.worker = null;
  }

  const result = {
    sessionId: state.sessionId, durationMs, engine: state.engine, assets: results,
    appliedReport: state.appliedReport, journalEntries: state.worker ? null : state.journal.length,
    drift, timeline: state.timeline, events: state.events.length, clockJumps: workerResult?.clockJumps ?? [],
    checkpoints: workerResult?.checkpoints ?? state.checkpoints.length,
    memory: { samples: state.memSamples.length, first: state.memSamples[0] ?? null, last: state.memSamples.at(-1) ?? null },
    mismatches: finalReport?.mismatches ?? null,
  };

  Object.assign(state, {
    sessionId: null, recorders: [], streams: [], audioContext: null, passthroughNode: null, mixDest: null,
    opfsDir: null, targets: new Map(), pending: new Map(), lost: {}, paused: false, engine: null,
  });
  return { ok: true, result };
}

// ───────────────────────────────────────── отладочные команды (тесты) ──

/** Try to consume a tabCapture stream id here; report settings or the exact error. */
async function debugGum({ id, video = false }) {
  try {
    const c = video
      ? { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } }, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } } }
      : { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } }, video: false };
    const s = await navigator.mediaDevices.getUserMedia(c);
    const t = s.getAudioTracks()[0];
    const r = { ok: true, label: t.label, settings: t.getSettings(), tracks: s.getTracks().map((x) => x.kind) };
    s.getTracks().forEach((x) => x.stop());
    return r;
  } catch (e) { return { ok: false, error: `${e?.name}: ${e?.message}` }; }
}

/**
 * DEBUG: simulate what the test bench cannot cause physically. Each command
 * exercises the SAME handlers a real event would, and says so in the journal.
 * Real-device behaviour (unplug, Bluetooth, sleep) is a separate measurement.
 */
async function debugCommand({ what, role = 'local_mic', sampleRate = 44100 }) {
  if (!state.sessionId) return { ok: false, error: 'нет сессии' };
  const t = state.targets.get(role);
  switch (what) {
    case 'open_synth_role': {
      // A synthetic source generated in the worker at wall-clock pace, at an
      // arbitrary sample rate (44.1 kHz): measures the encoder's internal
      // resampler over hours, since no 44.1 kHz capture device exists on this
      // machine (registry + real Chrome enumeration, 2026-09-07).
      if (!state.worker) return { ok: false, error: 'synth role needs the WebCodecs engine' };
      const r = await workerRequest({ type: 'OPEN_SYNTH_ROLE', role, sampleRate, encoder: encoderRequestFromSettings() }, 'ROLE_OPENED', { role, timeoutMs: 8000 });
      logEvent({ t: 'debug', what, role, sampleRate });
      return r;
    }
    case 'end_track': {
      // track.stop() dispatches no 'ended' event to the stopping context; fire the handler directly,
      // after actually stopping the track so the pipeline sees the stream close.
      logEvent({ t: 'debug', what, role, note: 'simulated: track.stop() + onTrackEnded' });
      t.track.stop();
      await onTrackEnded(role, t.track);
      return { ok: true };
    }
    case 'devicechange': {
      logEvent({ t: 'debug', what, note: 'simulated devicechange' });
      await onDeviceChange();
      return { ok: true };
    }
    case 'memory': sampleMemory(); return { ok: true, sample: state.memSamples.at(-1) };
    case 'status': return status();
    default: return { ok: false, error: `unknown debug command ${what}` };
  }
}
