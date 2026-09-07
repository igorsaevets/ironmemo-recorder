/**
 * capability-probe.js — что ЭТА машина умеет кодировать на самом деле.
 *
 * ГЛАВНОЕ, ЧТО НАДО ПОНЯТЬ ПРО ЭТОТ ФАЙЛ
 * --------------------------------------
 * В браузере НЕЛЬЗЯ узнать, что кодированием занимается NVENC, Quick Sync, AMF
 * или VideoToolbox. Web API намеренно не раскрывают железо: это защита от
 * fingerprinting. `hardwareAcceleration: 'prefer-hardware'` — по спецификации
 * WebCodecs ПОДСКАЗКА, которую user agent вправе проигнорировать.
 *
 * Поэтому мы не спрашиваем «какая видеокарта». Мы задаём другой вопрос, на
 * который ответ получить МОЖНО: «успевает ли эта конфигурация кодировать
 * быстрее реального времени, не копя очередь и не роняя кадры».
 *
 * Четыре уровня уверенности, от слабого к сильному:
 *
 *   1. DECLARED    — isTypeSupported()/isConfigSupported() сказали «да».
 *                    Стоит мало: это про парсинг строки, а не про работу.
 *   2. MEASURED    — реально закодировали тестовый сигнал, вывод не пустой.
 *   3. VALIDATED   — вывод УСПЕШНО ДЕКОДИРОВАЛСЯ обратно.
 *   4. REALTIME_OK — плюс уложились в бюджет реального времени с запасом.
 *
 * Отдельным флагом идёт `powerEfficientHint` из MediaCapabilities. Это
 * единственный намёк на аппаратный путь, который вообще существует, и он
 * остаётся именно НАМЁКОМ. Ни при каких условиях не выводим в UI название
 * производителя железа.
 */

export const CONFIDENCE = {
  UNSUPPORTED: 'UNSUPPORTED',
  DECLARED: 'DECLARED',
  MEASURED: 'MEASURED',
  VALIDATED: 'VALIDATED',
  REALTIME_OK: 'REALTIME_OK',
};

export const PROBE_VERSION = '0.1.0';

// ─────────────────────────────────────────── кандидаты для проверки ──

export const AUDIO_CANDIDATES = [
  { id: 'opus-webm',     mime: 'audio/webm;codecs=opus',  codec: 'opus',      container: 'webm' },
  { id: 'opus-ogg',      mime: 'audio/ogg;codecs=opus',   codec: 'opus',      container: 'ogg'  },
  { id: 'aac-mp4',       mime: 'audio/mp4;codecs=mp4a.40.2', codec: 'aac',    container: 'mp4'  },
  { id: 'vorbis-webm',   mime: 'audio/webm;codecs=vorbis', codec: 'vorbis',   container: 'webm' },
  { id: 'webm-default',  mime: 'audio/webm',              codec: 'default',   container: 'webm' },
];

export const AUDIO_WEBCODECS_CANDIDATES = [
  { id: 'wc-opus-48k-mono', codec: 'opus',       sampleRate: 48000, numberOfChannels: 1, bitrate: 48000 },
  { id: 'wc-opus-16k-mono', codec: 'opus',       sampleRate: 16000, numberOfChannels: 1, bitrate: 24000 },
  { id: 'wc-aac-48k-mono',  codec: 'mp4a.40.2',  sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 },
  { id: 'wc-flac-48k-mono', codec: 'flac',       sampleRate: 48000, numberOfChannels: 1, bitrate: 0     },
  { id: 'wc-pcm-48k-mono',  codec: 'pcm-s16',    sampleRate: 48000, numberOfChannels: 1, bitrate: 0     },
];

export const VIDEO_CANDIDATES = [
  { id: 'h264-mp4',  mime: 'video/mp4;codecs=avc1.42E01E',  wc: 'avc1.42E01E', container: 'mp4'  },
  { id: 'h264-webm', mime: 'video/webm;codecs=h264',        wc: 'avc1.42E01E', container: 'webm' },
  { id: 'vp8-webm',  mime: 'video/webm;codecs=vp8',         wc: 'vp8',         container: 'webm' },
  { id: 'vp9-webm',  mime: 'video/webm;codecs=vp9',         wc: 'vp09.00.10.08', container: 'webm' },
  { id: 'av1-webm',  mime: 'video/webm;codecs=av01.0.04M.08', wc: 'av01.0.04M.08', container: 'webm' },
  { id: 'av1-mp4',   mime: 'video/mp4;codecs=av01.0.04M.08', wc: 'av01.0.04M.08', container: 'mp4'  },
  { id: 'hevc-mp4',  mime: 'video/mp4;codecs=hvc1.1.6.L93.B0', wc: 'hvc1.1.6.L93.B0', container: 'mp4' },
];

export const VIDEO_RESOLUTIONS = [
  { id: '480p',  width: 854,  height: 480 },
  { id: '720p',  width: 1280, height: 720 },
  { id: '1080p', width: 1920, height: 1080 },
];

// ──────────────────────────────────────────────── уровень 1: DECLARED ──

export function probeDeclaredAudio() {
  return AUDIO_CANDIDATES.map((c) => ({
    ...c,
    mediaRecorderSupported:
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime),
  }));
}

export function probeDeclaredVideo() {
  return VIDEO_CANDIDATES.map((c) => ({
    ...c,
    mediaRecorderSupported:
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime),
  }));
}

// ────────────────────────────────── уровень 1b: WebCodecs isConfigSupported ──

export async function probeWebCodecsAudio() {
  if (typeof AudioEncoder === 'undefined') {
    return [{ id: 'n/a', error: 'AudioEncoder отсутствует в этом контексте' }];
  }
  const out = [];
  for (const c of AUDIO_WEBCODECS_CANDIDATES) {
    const config = {
      codec: c.codec, sampleRate: c.sampleRate, numberOfChannels: c.numberOfChannels,
      ...(c.bitrate ? { bitrate: c.bitrate } : {}),
    };
    try {
      const r = await AudioEncoder.isConfigSupported(config);
      out.push({ ...c, supported: r.supported, resolvedConfig: r.config ?? null });
    } catch (e) {
      out.push({ ...c, supported: false, error: String(e?.message ?? e) });
    }
  }
  return out;
}

export async function probeWebCodecsVideo({ fps = 30, bitrate = 2_000_000 } = {}) {
  if (typeof VideoEncoder === 'undefined') {
    return [{ id: 'n/a', error: 'VideoEncoder отсутствует в этом контексте' }];
  }
  const out = [];
  for (const c of VIDEO_CANDIDATES) {
    for (const res of VIDEO_RESOLUTIONS) {
      // Спрашиваем ОБА варианта подсказки: разница между ними — единственный
      // косвенный признак того, что аппаратный путь вообще существует.
      for (const hw of ['no-preference', 'prefer-hardware', 'prefer-software']) {
        const config = {
          codec: c.wc, width: res.width, height: res.height,
          bitrate, framerate: fps, hardwareAcceleration: hw,
        };
        try {
          const r = await VideoEncoder.isConfigSupported(config);
          out.push({
            candidate: c.id, resolution: res.id, hardwarePreference: hw,
            supported: r.supported, resolvedConfig: r.config ?? null,
          });
        } catch (e) {
          out.push({
            candidate: c.id, resolution: res.id, hardwarePreference: hw,
            supported: false, error: String(e?.message ?? e),
          });
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────── уровень 1c: MediaCapabilities hint ──

export async function probePowerEfficiency({ fps = 30, bitrate = 2_000_000 } = {}) {
  if (!navigator.mediaCapabilities?.encodingInfo) {
    return [{ error: 'MediaCapabilities.encodingInfo недоступен' }];
  }
  const out = [];
  for (const c of VIDEO_CANDIDATES) {
    for (const res of VIDEO_RESOLUTIONS) {
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'record',
          video: {
            contentType: c.mime, width: res.width, height: res.height,
            bitrate, framerate: fps,
          },
        });
        out.push({
          candidate: c.id, resolution: res.id,
          supported: info.supported, smooth: info.smooth,
          powerEfficient: info.powerEfficient,
        });
      } catch (e) {
        out.push({ candidate: c.id, resolution: res.id, error: String(e?.message ?? e) });
      }
    }
  }
  return out;
}

// ───────────────────────── уровень 2–4: активная проба (реальный энкод) ──

/**
 * Синтетический видеосигнал, специально подобранный под наш сценарий:
 * резкие границы текста и умеренное движение. Градиент или шум дали бы
 * совсем другую нагрузку на энкодер и увели бы вывод не туда.
 */
function drawSyntheticFrame(ctx, w, h, i) {
  ctx.fillStyle = i % 2 ? '#101014' : '#0d0d10';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#e8e8ef';
  ctx.font = `${Math.round(h / 22)}px monospace`;
  const offset = (i * 7) % Math.round(h / 12);
  for (let line = 0; line < 14; line++) {
    ctx.fillText(
      `const segment_${line} = journal.append(${(i * 31 + line * 7) % 9973});`,
      24, Math.round(h / 12) * (line + 1) - offset,
    );
  }
  // Движущийся блок — чтобы не мерить только статическую сцену.
  ctx.fillStyle = '#4f7cff';
  ctx.fillRect((i * 11) % Math.max(1, w - 120), h - 90, 120, 60);

  // Штамп времени: позволяет глазами проверить порядок кадров в выводе.
  ctx.fillStyle = '#ffcc4d';
  ctx.font = `${Math.round(h / 26)}px monospace`;
  ctx.fillText(`frame ${String(i).padStart(5, '0')}`, 24, h - 24);
}

/**
 * Активная проба видео через WebCodecs.
 * Возвращает измеренные величины, а НЕ вердикт «есть GPU».
 */
/**
 * ВАЖНО ПРО `paced` — методологическая правка после первого прогона (07.09.2026).
 *
 * Первая версия пихала все кадры в энкодер так быстро, как получится. Это даёт
 * верный ответ про ПРОПУСКНУЮ СПОСОБНОСТЬ (realtimeRatio вышел 0.07–0.13, то есть
 * в 8–14 раз быстрее реального времени), но делает метрику очереди бессмысленной:
 * очередь выросла до 141 просто потому, что мы завалили энкодер входом. На первом
 * прогоне из-за этого НИ ОДИН кодек не получил REALTIME_OK, хотя все кодировали
 * многократно быстрее необходимого.
 *
 * Реальная запись подаёт кадры со скоростью съёмки. Поэтому:
 *   paced = false → меряем пропускную способность, очередь ИГНОРИРУЕТСЯ;
 *   paced = true  → подаём кадры в темпе fps, и вот тогда рост очереди
 *                   действительно означает, что энкодер не справляется.
 */
export async function activeVideoProbe({
  codec = 'avc1.42E01E', width = 1280, height = 720, fps = 30,
  bitrate = 2_000_000, durationSec = 5, hardwareAcceleration = 'no-preference',
  latencyMode = 'quality', paced = false,
} = {}) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return { confidence: CONFIDENCE.UNSUPPORTED, error: 'WebCodecs недоступен' };
  }

  const config = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, latencyMode };
  let support;
  try {
    support = await VideoEncoder.isConfigSupported(config);
  } catch (e) {
    return { confidence: CONFIDENCE.UNSUPPORTED, error: String(e?.message ?? e), config };
  }
  if (!support?.supported) {
    return { confidence: CONFIDENCE.UNSUPPORTED, reason: 'isConfigSupported=false', config };
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const totalFrames = Math.round(fps * durationSec);
  const queueSamples = [];
  let encodedChunks = 0, encodedBytes = 0, keyFrames = 0;
  let encoderError = null;
  const firstChunks = [];

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      encodedChunks++;
      encodedBytes += chunk.byteLength;
      if (chunk.type === 'key') keyFrames++;
      // Первые чанки сохраняем для последующей проверки декодированием.
      if (firstChunks.length < 60) {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        firstChunks.push({
          type: chunk.type, timestamp: chunk.timestamp,
          duration: chunk.duration, data: buf,
          decoderConfig: meta?.decoderConfig ?? null,
        });
      }
    },
    error: (e) => { encoderError = String(e?.message ?? e); },
  });

  encoder.configure(config);

  const t0 = performance.now();
  const frameDurationUs = Math.round(1_000_000 / fps);

  for (let i = 0; i < totalFrames; i++) {
    if (encoderError) break;
    drawSyntheticFrame(ctx, width, height, i);
    const frame = new VideoFrame(canvas, {
      timestamp: i * frameDurationUs, duration: frameDurationUs,
    });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    queueSamples.push(encoder.encodeQueueSize);

    if (paced) {
      // Держим темп съёмки: только так рост очереди означает «не справляется».
      const target = t0 + ((i + 1) / fps) * 1000;
      const wait = target - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else await new Promise((r) => setTimeout(r, 0));
    } else if (i % 10 === 0) {
      // Отдаём поток раз в 10 кадров: иначе замер превратится в измерение
      // одного длинного синхронного блока и потеряет смысл.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  try {
    await encoder.flush();
  } catch (e) {
    encoderError ??= String(e?.message ?? e);
  }
  const wallMs = performance.now() - t0;
  encoder.close();

  const mediaMs = (totalFrames / fps) * 1000;
  const realtimeRatio = wallMs / mediaMs; // <1 значит быстрее реального времени
  queueSamples.sort((a, b) => a - b);
  const q = (p) => queueSamples.length
    ? queueSamples[Math.min(queueSamples.length - 1, Math.floor(queueSamples.length * p))] : 0;

  // Проверка декодированием — граница между MEASURED и VALIDATED.
  let decodeOk = false, decodeError = null, decodedFrames = 0;
  if (!encoderError && firstChunks.length && typeof VideoDecoder !== 'undefined') {
    try {
      const decCfg = firstChunks.find((c) => c.decoderConfig)?.decoderConfig ?? { codec, codedWidth: width, codedHeight: height };
      const sup = await VideoDecoder.isConfigSupported(decCfg);
      if (sup.supported) {
        await new Promise((resolve, reject) => {
          const dec = new VideoDecoder({
            output: (f) => { decodedFrames++; f.close(); },
            error: (e) => reject(e),
          });
          dec.configure(decCfg);
          for (const c of firstChunks) {
            dec.decode(new EncodedVideoChunk({
              type: c.type, timestamp: c.timestamp, duration: c.duration, data: c.data,
            }));
          }
          dec.flush().then(() => { dec.close(); resolve(); }).catch(reject);
        });
        decodeOk = decodedFrames > 0;
      } else {
        decodeError = 'декодер не поддерживает эту конфигурацию';
      }
    } catch (e) {
      decodeError = String(e?.message ?? e);
    }
  }

  // Косвенный намёк на энергоэффективность — единственный, что нам доступен.
  let powerEfficientHint = null;
  try {
    const cand = VIDEO_CANDIDATES.find((c) => c.wc === codec);
    if (cand && navigator.mediaCapabilities?.encodingInfo) {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'record',
        video: { contentType: cand.mime, width, height, bitrate, framerate: fps },
      });
      powerEfficientHint = info.powerEfficient;
    }
  } catch { /* намёк необязателен */ }

  // Два режима — два РАЗНЫХ критерия, и путать их нельзя.
  //
  // Непацованный: кормим энкодер на максимальной скорости. Показатель —
  //   realtimeRatio. Очередь бессмысленна: она отражает наш темп подачи.
  //
  // Пацованный: подаём ровно в темпе съёмки, поэтому realtimeRatio по
  //   построению равен ≈1.000 и КРИТЕРИЕМ БЫТЬ НЕ МОЖЕТ. (Первая версия
  //   именно на этом и ошиблась: условие `ratio <= 0.8` не выполнялось
  //   никогда, и все кодеки застревали на VALIDATED, хотя очередь
  //   держалась на 1–2, то есть энкодер справлялся с огромным запасом.)
  //   Здесь показатель — не растёт ли очередь и все ли кадры закодированы.
  const queueMeaningful = paced;
  const framesComplete = encodedChunks >= totalFrames * 0.98;
  const keepsUp = paced ? (q(0.95) <= 4 && framesComplete) : realtimeRatio <= 0.8;

  let confidence;
  if (encoderError || encodedChunks === 0) confidence = CONFIDENCE.UNSUPPORTED;
  else if (!decodeOk) confidence = CONFIDENCE.MEASURED;
  else if (keepsUp) confidence = CONFIDENCE.REALTIME_OK;
  else confidence = CONFIDENCE.VALIDATED;

  return {
    probeVersion: PROBE_VERSION,
    config,
    paced,
    confidence,
    encoderError,
    frames: { requested: totalFrames, encodedChunks, keyFrames, decodedForValidation: decodedFrames },
    bytes: encodedBytes,
    effectiveBitrateKbps: Math.round((encodedBytes * 8) / (mediaMs / 1000) / 1000),
    timing: {
      wallMs: Math.round(wallMs), mediaMs, realtimeRatio: Math.round(realtimeRatio * 1000) / 1000,
      fasterThanRealtime: realtimeRatio < 1,
    },
    encodeQueue: {
      p50: q(0.5), p95: q(0.95), max: queueSamples.at(-1) ?? 0,
      meaningful: queueMeaningful,
      note: queueMeaningful ? 'кадры подавались в темпе съёмки — рост очереди значим'
                            : 'кадры подавались максимально быстро — очередь НЕ показатель',
    },
    decode: { ok: decodeOk, error: decodeError },
    powerEfficientHint,
    // Формулировки для UI. Названия вендоров железа здесь не появятся никогда.
    humanVerdict: verdictText(confidence, realtimeRatio, powerEfficientHint),
  };
}

function verdictText(confidence, ratio, powerHint) {
  switch (confidence) {
    case CONFIDENCE.UNSUPPORTED: return 'Не поддерживается или упало при кодировании';
    case CONFIDENCE.MEASURED:    return 'Кодирует, но результат не удалось проверить декодированием';
    case CONFIDENCE.VALIDATED:
      return ratio < 1
        ? 'Работает, вывод корректен, но запас по скорости небольшой'
        : 'Работает, вывод корректен, НО не успевает за реальным временем — для записи не годится';
    case CONFIDENCE.REALTIME_OK:
      return powerHint === true
        ? 'Успевает в реальном времени без роста очереди; браузер считает путь энергоэффективным'
        : 'Успевает в реальном времени без роста очереди';
    default: return 'Нет данных';
  }
}

/** Активная проба аудио: короткая запись синтетического сигнала. */
export async function activeAudioProbe({
  mime = 'audio/webm;codecs=opus', bitrate = 48000, durationSec = 3, sampleRate = 48000,
} = {}) {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mime)) {
    return { confidence: CONFIDENCE.UNSUPPORTED, mime, reason: 'isTypeSupported=false' };
  }

  const ac = new AudioContext({ sampleRate });
  try {
    // Речеподобный сигнал: несущая + модуляция + пауза. Чистая синусоида
    // сжимается неправдоподобно хорошо и дала бы слишком оптимистичный размер.
    const osc = ac.createOscillator();
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    const gain = ac.createGain();
    const dest = ac.createMediaStreamDestination();

    osc.type = 'sawtooth'; osc.frequency.value = 165;
    lfo.type = 'sine'; lfo.frequency.value = 4.5; lfoGain.gain.value = 0.35;
    gain.gain.value = 0.25;

    lfo.connect(lfoGain).connect(gain.gain);
    osc.connect(gain).connect(dest);
    osc.start(); lfo.start();

    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: bitrate });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const t0 = performance.now();
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(1000);
    await new Promise((r) => setTimeout(r, durationSec * 1000));
    rec.stop();
    await done;
    const wallMs = performance.now() - t0;

    osc.stop(); lfo.stop();

    const blob = new Blob(chunks, { type: mime });
    const bytes = blob.size;

    // Проверка декодированием: WebAudio разберёт файл целиком или упадёт.
    let decodeOk = false, decodedSeconds = null, decodeError = null;
    try {
      const buf = await blob.arrayBuffer();
      const decoded = await new AudioContext().decodeAudioData(buf);
      decodeOk = true;
      decodedSeconds = Math.round(decoded.duration * 100) / 100;
    } catch (e) {
      decodeError = String(e?.message ?? e);
    }

    const effKbps = Math.round((bytes * 8) / durationSec / 1000);
    const confidence = !bytes ? CONFIDENCE.UNSUPPORTED
      : !decodeOk ? CONFIDENCE.MEASURED
      : CONFIDENCE.REALTIME_OK;

    return {
      probeVersion: PROBE_VERSION, mime, confidence,
      requestedBitrateKbps: Math.round(bitrate / 1000),
      effectiveBitrateKbps: effKbps,
      // Расхождение здесь = браузер проигнорировал наш битрейт. Ровно ради
      // этого числа проба и нужна.
      bitrateHonoured: Math.abs(effKbps - bitrate / 1000) / (bitrate / 1000) < 0.35,
      bytes, chunks: chunks.length,
      requestedSampleRate: sampleRate, actualSampleRate: ac.sampleRate,
      sampleRateHonoured: ac.sampleRate === sampleRate,
      decode: { ok: decodeOk, seconds: decodedSeconds, error: decodeError },
      estimatedMBPerHour: Math.round((effKbps * 3600 / 8 / 1000) * 10) / 10,
      wallMs: Math.round(wallMs),
    };
  } finally {
    ac.close().catch(() => {});
  }
}

// ──────────────────────────────────────────────── окружение и OPFS ──

export async function probeEnvironment() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  let opfs = { available: false, writable: false, error: null };
  try {
    const root = await navigator.storage.getDirectory();
    opfs.available = true;
    const dir = await root.getDirectoryHandle('__probe__', { create: true });
    const fh = await dir.getFileHandle('t.bin', { create: true });
    // createWritable может отсутствовать; createSyncAccessHandle работает
    // только в Worker. Проверяем оба пути и честно пишем, какой доступен.
    if (fh.createWritable) {
      const w = await fh.createWritable();
      await w.write(new Uint8Array(1024));
      await w.close();
      opfs.writable = true;
      opfs.method = 'createWritable';
    }
    await dir.removeEntry('t.bin').catch(() => {});
    await root.removeEntry('__probe__', { recursive: true }).catch(() => {});
  } catch (e) {
    opfs.error = String(e?.message ?? e);
  }

  return {
    probeVersion: PROBE_VERSION,
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    uaData: navigator.userAgentData
      ? { platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile,
          brands: navigator.userAgentData.brands }
      : null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    storage: est ? {
      quotaGB: Math.round((est.quota ?? 0) / 1e9 * 100) / 100,
      usageGB: Math.round((est.usage ?? 0) / 1e9 * 100) / 100,
    } : null,
    opfs,
    apis: {
      MediaRecorder: typeof MediaRecorder !== 'undefined',
      VideoEncoder: typeof VideoEncoder !== 'undefined',
      AudioEncoder: typeof AudioEncoder !== 'undefined',
      VideoDecoder: typeof VideoDecoder !== 'undefined',
      MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor !== 'undefined',
      AudioData: typeof AudioData !== 'undefined',
      mediaCapabilities: !!navigator.mediaCapabilities?.encodingInfo,
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      storageEstimate: !!navigator.storage?.estimate,
    },
  };
}

/** Полный отчёт. Тяжёлые активные пробы включаются флагом. */
export async function runFullProbe({ active = false, onProgress = () => {} } = {}) {
  const report = { probeVersion: PROBE_VERSION, startedAt: new Date().toISOString() };

  onProgress('Окружение и OPFS…');
  report.environment = await probeEnvironment();

  onProgress('Заявленная поддержка контейнеров…');
  report.declaredAudio = probeDeclaredAudio();
  report.declaredVideo = probeDeclaredVideo();

  onProgress('WebCodecs: конфигурации аудио…');
  report.webCodecsAudio = await probeWebCodecsAudio();

  onProgress('WebCodecs: конфигурации видео…');
  report.webCodecsVideo = await probeWebCodecsVideo();

  onProgress('Подсказки об энергоэффективности…');
  report.powerEfficiency = await probePowerEfficiency();

  if (active) {
    report.activeAudio = [];
    for (const c of AUDIO_CANDIDATES) {
      if (!MediaRecorder.isTypeSupported(c.mime)) continue;
      onProgress(`Активная проба аудио: ${c.id}…`);
      report.activeAudio.push({ candidate: c.id, ...(await activeAudioProbe({ mime: c.mime })) });
    }

    report.activeVideo = [];
    // Только те, что прошли уровень DECLARED — иначе проба гарантированно впустую.
    const viable = report.webCodecsVideo.filter(
      (r) => r.supported && r.hardwarePreference === 'no-preference' && r.resolution === '720p',
    );
    for (const v of viable) {
      const cand = VIDEO_CANDIDATES.find((c) => c.id === v.candidate);
      if (!cand) continue;

      // Два прогона на кандидата, и они отвечают на РАЗНЫЕ вопросы.
      // Быстрый: «какой у энкодера потолок пропускной способности».
      // Пацованный: «справится ли он, когда кадры идут ровно в темпе съёмки».
      onProgress(`Проба видео (пропускная способность): ${cand.id} 720p30…`);
      const burst = await activeVideoProbe({
        codec: cand.wc, width: 1280, height: 720, fps: 30, durationSec: 5, paced: false });

      let sustained = null;
      if (burst.confidence !== CONFIDENCE.UNSUPPORTED) {
        onProgress(`Проба видео (в темпе съёмки): ${cand.id} 720p30…`);
        sustained = await activeVideoProbe({
          codec: cand.wc, width: 1280, height: 720, fps: 30, durationSec: 5, paced: true });
      }

      report.activeVideo.push({
        candidate: cand.id,
        // Итоговый вердикт берём из пацованного прогона: именно он моделирует запись.
        ...(sustained ?? burst),
        burstThroughput: {
          realtimeRatio: burst.timing?.realtimeRatio ?? null,
          confidence: burst.confidence,
        },
      });
    }
  }

  report.finishedAt = new Date().toISOString();
  report.summary = summarize(report);
  return report;
}

function summarize(r) {
  const declaredAudioOk = r.declaredAudio.filter((a) => a.mediaRecorderSupported).map((a) => a.id);
  const declaredVideoOk = r.declaredVideo.filter((v) => v.mediaRecorderSupported).map((v) => v.id);

  // Ключевой вывод про «аппаратность»: если prefer-hardware и prefer-software
  // дают РАЗНЫЙ ответ, значит два пути действительно существуют. Если ответ
  // одинаковый — подсказка ничего не меняет и делать по ней выводы нельзя.
  const hwDiscriminates = [];
  for (const cand of VIDEO_CANDIDATES) {
    for (const res of VIDEO_RESOLUTIONS) {
      const get = (hw) => r.webCodecsVideo.find(
        (x) => x.candidate === cand.id && x.resolution === res.id && x.hardwarePreference === hw);
      const hard = get('prefer-hardware'), soft = get('prefer-software');
      if (hard && soft && hard.supported !== soft.supported) {
        hwDiscriminates.push({
          candidate: cand.id, resolution: res.id,
          hardwareOnly: hard.supported && !soft.supported,
          softwareOnly: soft.supported && !hard.supported,
        });
      }
    }
  }

  const realtimeOk = (r.activeVideo ?? [])
    .filter((v) => v.confidence === CONFIDENCE.REALTIME_OK).map((v) => v.candidate);

  return {
    declaredAudioOk, declaredVideoOk,
    hardwarePreferenceDiscriminates: hwDiscriminates,
    realtimeCapableVideo: realtimeOk,
    caveat:
      'Ни одно поле этого отчёта не доказывает участие конкретного аппаратного энкодера. '
      + 'Браузер не раскрывает эту информацию. Максимум, что здесь есть, — измеренная '
      + 'скорость, подсказка powerEfficient и различие в ответах на prefer-hardware/'
      + 'prefer-software. Точное определение NVENC/Quick Sync/AMF/VideoToolbox возможно '
      + 'только в нативном desktop-приложении.',
  };
}
