/**
 * offscreen.js — владелец живой сессии записи.
 *
 * ЧТО ЗДЕСЬ УЖЕ ЕСТЬ (итерация 0): открытие источников, возврат звука вкладки,
 * запись через MediaRecorder, отчёт requested-vs-applied, запись сегментов
 * в OPFS с журналом.
 *
 * ЧЕГО ЗДЕСЬ ЕЩЁ НЕТ, и это отмечено намеренно, а не забыто:
 *   — путь WebCodecs + собственный muxer (settings.audioEnc.impl === 'webcodecs');
 *   — ремукс и проверка декодированием при восстановлении;
 *   — инкрементальный SHA-256 в Worker;
 *   — измерение дрейфа между источниками на длинной дистанции.
 * Каждый пункт — отдельная итерация с собственным критерием приёмки.
 * См. specs/SPEC-002-capture-core.md.
 */

const state = {
  sessionId: null,
  settings: null,
  recorders: [],     // [{ role, recorder, chunks, mime }]
  streams: [],
  audioContext: null,
  passthroughNode: null,
  startedAt: null,
  opfsDir: null,
  journal: [],
  appliedReport: null,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'START':  return sendResponse(await start(msg));
        case 'STOP':   return sendResponse(await stop());
        case 'PAUSE':  return sendResponse(pause());
        case 'RESUME': return sendResponse(resume());
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

// ───────────────────────────────────────────────────── старт ──

async function start({ sessionId, streamId, settings }) {
  state.sessionId = sessionId;
  state.settings = settings;
  state.startedAt = performance.now();
  state.journal = [];
  state.recorders = [];
  state.streams = [];

  const mode = g('source.mode', 'mic');
  const applied = { requestedAt: new Date().toISOString(), sources: {} };

  // ── микрофон ──
  let micStream = null;
  if (mode === 'mic' || mode === 'mic+tab') {
    const raw = g('audioProc.rawMode', false);
    const constraints = {
      audio: {
        deviceId: g('source.micDeviceId', 'default') === 'default'
          ? undefined : { exact: g('source.micDeviceId') },
        echoCancellation: raw ? false : g('audioProc.echoCancellation', true),
        noiseSuppression: raw ? false : g('audioProc.noiseSuppression', true),
        autoGainControl:  raw ? false : g('audioProc.autoGainControl', true),
        sampleRate: g('audioProc.sampleRate', 48000),
        channelCount: g('audioProc.channelCount', 1),
      },
      video: false,
    };
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
    state.streams.push(micStream);

    // ЭТО и есть ключевой замер: что мы просили против того, что дали.
    const t = micStream.getAudioTracks()[0];
    applied.sources.local_mic = {
      requested: constraints.audio,
      applied: t.getSettings(),
      label: t.label,
      supportedConstraints: navigator.mediaDevices.getSupportedConstraints(),
    };
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
  }

  // ── возврат звука вкладки пользователю ──
  // tabCapture ЗАБИРАЕТ звук. Без этой ветки человек перестаёт слышать встречу.
  const ac = new AudioContext();
  state.audioContext = ac;
  applied.audioContext = { sampleRate: ac.sampleRate, baseLatency: ac.baseLatency ?? null,
                           requestedSampleRate: g('audioProc.sampleRate', 48000) };

  if (tabStream && g('source.tabAudioPassthrough', true)) {
    const src = ac.createMediaStreamSource(tabStream);
    src.connect(ac.destination);
    state.passthroughNode = src;
  }

  // ── что именно пишем ──
  const targets = [];
  if (g('source.keepSeparate', true)) {
    if (micStream) targets.push({ role: 'local_mic', stream: micStream });
    if (tabStream) targets.push({ role: 'remote_tab', stream: tabStream });
  }
  if (g('source.produceMix', true) && (micStream || tabStream)) {
    targets.push({ role: 'compatibility_mix', stream: buildMix(ac, micStream, tabStream) });
  }
  if (!targets.length) {
    // Единственный источник и микс выключен — пишем сам источник, иначе запись пуста.
    const only = micStream ?? tabStream;
    if (!only) throw new Error('Нет ни одного источника звука.');
    targets.push({ role: micStream ? 'local_mic' : 'remote_tab', stream: only });
  }

  // ── OPFS ──
  if (g('storage.backend', 'opfs') === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory();
      const sessions = await root.getDirectoryHandle('sessions', { create: true });
      state.opfsDir = await sessions.getDirectoryHandle(sessionId, { create: true });
    } catch (e) {
      // Падать не нужно: пишем в память и ЧЕСТНО помечаем это в отчёте.
      state.opfsDir = null;
      applied.opfsError = String(e?.message ?? e);
    }
  }

  // ── запуск рекордеров ──
  const mime = resolveMime();
  const bitrate = g('audioEnc.bitrateKbps', 48) * 1000;
  applied.encoder = { requestedMime: mime, requestedBitrate: bitrate,
                      impl: g('audioEnc.impl', 'mediarecorder') };

  if (g('audioEnc.impl', 'mediarecorder') === 'webcodecs') {
    throw new Error(
      'Путь WebCodecs ещё не реализован (итерация 2). Выберите MediaRecorder в настройках. '
      + 'Заглушка стоит намеренно: молчаливый откат на другой движок исказил бы замер.',
    );
  }

  for (const t of targets) {
    if (!MediaRecorder.isTypeSupported(mime)) {
      throw new Error(`Контейнер ${mime} не поддерживается этим Chrome. Смените его в настройках.`);
    }
    const rec = new MediaRecorder(t.stream, { mimeType: mime, audioBitsPerSecond: bitrate });
    const entry = { role: t.role, recorder: rec, chunks: [], mime, bytes: 0, seq: 0 };

    rec.ondataavailable = async (e) => {
      if (!e.data.size) return;
      entry.bytes += e.data.size;
      entry.seq++;
      if (state.opfsDir) {
        await writeChunk(entry, e.data).catch((err) =>
          report('error', { error: `Запись на диск: ${err.message}` }));
      } else {
        entry.chunks.push(e.data);
      }
      report('progress', { progress: { role: t.role, seq: entry.seq, bytes: entry.bytes } });
    };
    rec.onerror = (e) => report('error', { error: `MediaRecorder ${t.role}: ${e.error?.message}` });

    rec.start(g('storage.timesliceMs', 5000));
    // Фактический mimeType может отличаться от запрошенного — фиксируем.
    entry.actualMime = rec.mimeType;
    entry.actualBitrate = rec.audioBitsPerSecond;
    state.recorders.push(entry);
  }

  applied.tracks = state.recorders.map((r) => ({
    role: r.role, requestedMime: mime, actualMime: r.actualMime,
    requestedBitrate: bitrate, actualBitrate: r.actualBitrate,
    mimeHonoured: r.actualMime === mime,
  }));
  state.appliedReport = applied;

  return { ok: true, appliedReport: applied };
}

/** Сведение источников в один поток для compatibility-ассета. */
function buildMix(ac, micStream, tabStream) {
  const dest = ac.createMediaStreamDestination();
  const layout = g('source.mixLayout', 'mono_sum');

  if (layout === 'stereo_split' && micStream && tabStream) {
    // Экспериментальная раскладка: слева микрофон, справа вкладка.
    // Даёт «бесплатное» разделение на два кластера, но семантика нестандартна:
    // ни плеер, ни backend о ней не знают.
    const merger = ac.createChannelMerger(2);
    ac.createMediaStreamSource(micStream).connect(merger, 0, 0);
    ac.createMediaStreamSource(tabStream).connect(merger, 0, 1);
    merger.connect(dest);
  } else {
    if (micStream) ac.createMediaStreamSource(micStream).connect(dest);
    if (tabStream) ac.createMediaStreamSource(tabStream).connect(dest);
  }
  return dest.stream;
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
    role: entry.role, seq: entry.seq, file: name, bytes: blob.size,
    tMs: Math.round(performance.now() - state.startedAt), at: Date.now(),
  });
  if (g('storage.journalEnabled', true)) await flushJournal();
}

async function flushJournal() {
  const fh = await state.opfsDir.getFileHandle('journal.jsonl', { create: true });
  const w = await fh.createWritable();
  await w.write(state.journal.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await w.close();
}

// ────────────────────────────────────────────── пауза / стоп ──

function pause() {
  for (const r of state.recorders) if (r.recorder.state === 'recording') r.recorder.pause();
  return { ok: true };
}

function resume() {
  for (const r of state.recorders) if (r.recorder.state === 'paused') r.recorder.resume();
  return { ok: true };
}

async function stop() {
  const results = [];
  await Promise.all(state.recorders.map((entry) => new Promise((resolve) => {
    if (entry.recorder.state === 'inactive') return resolve();
    entry.recorder.onstop = resolve;
    entry.recorder.stop();
  })));

  for (const entry of state.recorders) {
    results.push({
      role: entry.role, mime: entry.actualMime, bytes: entry.bytes,
      segments: entry.seq, storedIn: state.opfsDir ? 'opfs' : 'memory',
    });
  }

  if (state.opfsDir) await flushJournal().catch(() => {});

  for (const s of state.streams) s.getTracks().forEach((t) => t.stop());
  state.passthroughNode?.disconnect();
  await state.audioContext?.close().catch(() => {});

  const durationMs = Math.round(performance.now() - state.startedAt);
  const result = {
    sessionId: state.sessionId, durationMs, assets: results,
    appliedReport: state.appliedReport, journalEntries: state.journal.length,
  };

  Object.assign(state, {
    sessionId: null, recorders: [], streams: [], audioContext: null,
    passthroughNode: null, opfsDir: null,
  });

  return { ok: true, result };
}
