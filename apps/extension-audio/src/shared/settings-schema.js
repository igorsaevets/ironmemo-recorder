/**
 * settings-schema.js — единственный источник правды по настройкам расширения.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ВЫГЛЯДИТ ТАК
 * ----------------------------
 * Оба входных плана (ChatGPT v2.0 и Claude v1.1) сходятся в одном: почти каждый
 * параметр записи нельзя выбрать из документации — его надо ИЗМЕРИТЬ на реальной
 * машине и на реальном корпусе речи. Поэтому настройки здесь — не «пользовательские
 * предпочтения», а **конфигурация эксперимента**.
 *
 * Из этого следуют три правила, которые нельзя нарушать:
 *
 *  1. Одна декларация — один источник. UI страницы настроек ГЕНЕРИРУЕТСЯ отсюда.
 *     Нельзя добавить поле в options.html руками: оно не попадёт в манифест записи
 *     и результат теста будет невоспроизводим.
 *
 *  2. `requested` ≠ `applied`. Браузер вправе проигнорировать любой constraint и
 *     любой битрейт. Мы всегда сохраняем обе величины (см. `capture-report`).
 *     Настройка, для которой мы не умеем прочитать applied-значение, помечается
 *     `readback: null` — это честнее, чем показать requested и сделать вид, что
 *     оно применилось.
 *
 *  3. `stage` определяет видимость, а НЕ существование. Экспериментальные опции
 *     не удаляются после решения — они переезжают в `stage: 'debug'`. Так решение
 *     остаётся обратимым, а старые манифесты — читаемыми.
 *
 * ПОЛЯ ОПИСАНИЯ ОПЦИИ
 *   key         точечный путь; он же путь в объекте настроек и в манифесте записи
 *   type        'enum' | 'bool' | 'int' | 'float' | 'string' | 'device'
 *   default     стартовое значение (см. «почему именно оно» в `why`)
 *   options     для enum: [{value, label, hint?, risk?}]
 *   min/max/step для чисел
 *   stage       'mvp'        — попадёт в публичный релиз
 *               'experiment' — включено сейчас ради замеров, судьба не решена
 *               'debug'      — только для диагностики, в релизе скрыто
 *   group       раздел UI
 *   why         почему опция вообще существует и что она меняет физически
 *   risk        чем плохо неверное значение (показывается в UI как предупреждение)
 *   readback    как прочитать фактически применённое значение, или null
 *   decides     какое проектное решение закрывается этим замером (ID из ADR)
 *   requires    условие показа: {key, equals|notEquals|includes}
 */

export const SETTINGS_SCHEMA_VERSION = '0.2.0';

export const GROUPS = [
  { id: 'source',     title: 'Источники звука',            order: 10 },
  { id: 'audioProc',  title: 'Обработка микрофона',        order: 20 },
  { id: 'audioEnc',   title: 'Кодирование аудио',          order: 30 },
  { id: 'video',      title: 'Видео (Meeting Video Mode)', order: 40 },
  { id: 'storage',    title: 'Хранение и сегментация',     order: 50 },
  { id: 'recovery',   title: 'Восстановление после сбоя',  order: 60 },
  { id: 'upload',     title: 'Отправка в IronMemo',        order: 70 },
  { id: 'consent',    title: 'Согласие и индикация',       order: 80 },
  { id: 'experiment', title: 'Эксперимент и диагностика',  order: 90 },
];

/** @type {Array<Object>} */
export const SETTINGS = [
  // ─────────────────────────────────────────────────────────── ИСТОЧНИКИ ──
  {
    key: 'source.mode', group: 'source', type: 'enum', stage: 'mvp',
    label: 'Что записываем',
    default: 'mic',
    options: [
      { value: 'mic',     label: 'Только микрофон' },
      { value: 'tab',     label: 'Только звук вкладки' },
      { value: 'mic+tab', label: 'Микрофон + вкладка', hint: 'основной режим для встреч' },
    ],
    why: 'Определяет, сколько MediaStream мы открываем и сколько ассетов получится на выходе.',
    decides: 'ADR-002',
    readback: 'stream.getAudioTracks().length',
  },
  {
    key: 'source.keepSeparate', group: 'source', type: 'bool', stage: 'mvp',
    label: 'Хранить источники раздельными файлами',
    default: true,
    why: 'local_mic и remote_tab — это РАЗНЫЕ РОЛИ, а не два спикера. Раздельное хранение позволяет '
       + 'диаризовать только удалённую дорожку, независимо перезаливать ассеты и пересобирать микс.',
    risk: 'Выключение делает speaker attribution принципиально хуже: смешанный сигнал нельзя разделить обратно.',
    decides: 'ADR-002',
    readback: null,
  },
  {
    key: 'source.produceMix', group: 'source', type: 'bool', stage: 'mvp',
    label: 'Дополнительно создавать совместимый микс',
    default: true,
    why: 'Обычный плеер и текущий backend умеют один файл. Микс — это compatibility-ассет, а не оригинал.',
    decides: 'ADR-002',
    readback: null,
  },
  {
    key: 'source.mixLayout', group: 'source', type: 'enum', stage: 'experiment',
    label: 'Раскладка микса',
    default: 'mono_sum',
    options: [
      { value: 'mono_sum',      label: 'Моно-сумма', hint: 'безопасно, играет везде' },
      { value: 'stereo_split',  label: 'Стерео L=микрофон / R=вкладка',
        hint: 'дешёвая псевдо-диаризация', risk: 'Нестандартная семантика: плеер и backend о ней не знают.' },
    ],
    why: 'v1.1 предлагал stereo_split как основную модель. v2.0 понизил его до compatibility-варианта. '
       + 'Оставлено включаемым, чтобы сравнить WER/диаризацию на своём корпусе, а не спорить о теории.',
    requires: { key: 'source.produceMix', equals: true },
    decides: 'ADR-002',
    readback: 'audioContext.destination.channelCount',
  },
  {
    key: 'source.tabAudioPassthrough', group: 'source', type: 'bool', stage: 'mvp',
    label: 'Возвращать звук вкладки в колонки',
    default: true,
    why: 'chrome.tabCapture ЗАБИРАЕТ звук у пользователя. Без явного возврата через AudioContext '
       + 'человек перестаёт слышать встречу. Это не украшение, а обязательная компенсация.',
    risk: 'Выключение = пользователь оглох на время записи. Оставлено выключаемым только для замера эха.',
    decides: 'ADR-001',
    readback: null,
  },
  {
    key: 'source.fillInputDropsWithSilence', group: 'source', type: 'bool', stage: 'experiment',
    label: 'Заполнять пропуски входа тишиной (скачок timestamp без кадров)',
    default: true,
    why: 'Измерено 07.09.2026 (accept-4h, 4 ч): дорожка вкладки 11 раз потеряла по 23 мс (timestamp '
       + 'AudioData прыгнул вперёд, кадров нет) — ассеты разошлись на 268 мс, хотя часы обоих источников '
       + 'шли ровно. Заполнение пропуска тишиной той же длины держит local_mic и remote_tab на одной '
       + 'шкале. Пропуски длиннее 5 с не заполняются (это уже потеря устройства/сон — см. onDeviceLost).',
    risk: 'Выключение возвращает расхождение ассетов на суммарную длину пропусков; факт пропуска '
        + 'остаётся только в журнале (discontinuity).',
    decides: 'ADR-003',
    readback: 'capture-report: roles.*.dropFillSamples48k, journal drop_filled',
  },
  {
    key: 'source.tabDownmixToMono', group: 'source', type: 'bool', stage: 'experiment',
    label: 'Звук вкладки сводить в моно перед кодированием',
    default: true,
    why: 'Измерено 07.09.2026: дорожка tabCapture приходит как СТЕРЕО на частоте устройства вывода '
       + '(на этой машине 96 000 Гц, 2 канала). Речь удалённых участников — моно по содержанию; стерео '
       + 'удваивает битрейт ассета при том же качестве. Моно-сведение делается в Worker до энкодера, '
       + 'ресемплинг 96k→48k — внутри AudioEncoder.',
    risk: 'Выключение даёт стерео-Opus и вдвое больший remote_tab; демо с музыкой/пространственным звуком '
        + 'могут выиграть.',
    requires: { key: 'source.mode', notEquals: 'mic' },
    decides: 'ADR-003',
    readback: 'encoderApplied.numberOfChannels для remote_tab (capture-report)',
  },
  {
    key: 'source.micDeviceId', group: 'source', type: 'device', stage: 'mvp',
    label: 'Устройство микрофона',
    default: 'default',
    why: 'Zoom и Meet дают выбирать микрофон, и здесь он нужен тем более: расширение должно писать '
       + 'ТОТ ЖЕ микрофон, который слышат участники встречи. Если встреча идёт через гарнитуру, '
       + 'а мы пишем микрофон ноутбука, запись не совпадёт с тем, что происходило.',
    risk: 'На этой машине 13 активных входов, и три их класса ломают запись незаметно: петлевые '
        + '(«Стерео микшер», «Voicemeeter Out …») затянут в local_mic удалённых участников; '
        + 'Bluetooth Hands-Free даст моно 8 кГц; устройства с собственной обработкой (NVIDIA '
        + 'Broadcast, Voicemeeter) дадут двойное шумоподавление. Список рядом помечает каждое.',
    decides: 'ADR-003',
    readback: 'track.getSettings().deviceId + label',
  },
  {
    key: 'source.micFollowSystemDefault', group: 'source', type: 'bool', stage: 'experiment',
    label: 'Следовать за системным устройством по умолчанию',
    default: true,
    why: 'Chrome отдаёт особое устройство `default`, которое следует за выбором в ОС. '
       + 'Явно выбранное устройство за ним НЕ следует: переключив гарнитуру в Windows посреди '
       + 'встречи, пользователь продолжит писать старую.',
    risk: 'Обратная сторона: при `default` невозможно гарантировать, ЧТО именно записано. '
        + 'Для воспроизводимого замера нужно явное устройство.',
    decides: 'ADR-003',
    readback: 'track.getSettings().deviceId',
  },
  {
    key: 'source.monitorOutputDeviceId', group: 'source', type: 'device-out', stage: 'experiment',
    label: 'Куда возвращать звук вкладки',
    default: 'default',
    why: 'Zoom и Meet дают выбирать не только микрофон, но и динамики. Захват вкладки забирает '
       + 'звук, и вернуть его надо туда, где человек слушает. Реализуется через '
       + 'AudioContext.setSinkId().',
    requires: { key: 'source.tabAudioPassthrough', equals: true },
    readback: 'audioContext.sinkId',
  },
  {
    key: 'source.onDeviceLost', group: 'source', type: 'enum', stage: 'experiment',
    label: 'Если устройство пропало во время записи',
    default: 'pause_and_notify',
    options: [
      { value: 'pause_and_notify', label: 'Поставить на паузу и сообщить' },
      { value: 'switch_to_default', label: 'Переключиться на устройство по умолчанию',
        risk: 'Продолжит запись с другого микрофона; в файле будет стык без предупреждения.' },
      { value: 'stop', label: 'Остановить запись' },
    ],
    why: 'Bluetooth-гарнитуры отваливаются и переподключаются сами по себе. Молча продолжать '
       + 'запись с другого устройства — худший вариант: пользователь узнает об этом из файла.',
    decides: 'ADR-003',
    readback: null,
  },
  {
    key: 'source.onDeviceReturn', group: 'source', type: 'enum', stage: 'experiment',
    label: 'Если устройство вернулось (после паузы по потере)',
    default: 'resume_fill_silence',
    options: [
      { value: 'resume_fill_silence', label: 'Продолжить, заполнив пропуск тишиной',
        hint: 'обе дорожки остаются на одной шкале' },
      { value: 'resume_no_fill', label: 'Продолжить без заполнения',
        risk: 'Файл станет короче стены на длину пропуска; дорожки разъедутся на эту величину.' },
      { value: 'stay_paused', label: 'Остаться на паузе до ручного продолжения' },
    ],
    why: 'Bluetooth-гарнитура возвращается через 5–30 с. Что делать с дырой во времени — вопрос '
       + 'о том, кто держит временную шкалу: файл или журнал. Тишина в файле — самый совместимый '
       + 'вариант: любой плеер и backend видят непрерывный ассет.',
    requires: { key: 'source.onDeviceLost', equals: 'pause_and_notify' },
    decides: 'ADR-003',
    readback: 'journal: device_returned.silenceFrames',
  },

  // ────────────────────────────────────────────── ОБРАБОТКА МИКРОФОНА ──
  {
    key: 'audioProc.echoCancellation', group: 'audioProc', type: 'bool', stage: 'mvp',
    label: 'Эхоподавление (EC)',
    default: true,
    why: 'Без EC микрофон запишет звук вкладки из колонок — удалённые голоса продублируются в local_mic '
       + 'и сломают разделение источников.',
    risk: 'Включённый EC может «съедать» тихую речь и портить voice embeddings.',
    decides: 'ADR-003',
    readback: 'track.getSettings().echoCancellation',
  },
  {
    key: 'audioProc.noiseSuppression', group: 'audioProc', type: 'bool', stage: 'mvp',
    label: 'Шумоподавление (NS)',
    default: true,
    why: 'Помогает STT в шумном помещении.',
    risk: 'Агрессивный NS вырезает согласные и тихие реплики. Для диаризации может быть вреден.',
    decides: 'ADR-003',
    readback: 'track.getSettings().noiseSuppression',
  },
  {
    key: 'audioProc.autoGainControl', group: 'audioProc', type: 'bool', stage: 'mvp',
    label: 'Автоусиление (AGC)',
    default: true,
    risk: 'AGC меняет уровень непредсказуемо во времени. Это ПРЯМО влияет на voice embeddings: '
        + 'один и тот же человек может не совпасть сам с собой между записями.',
    why: 'Главный подозреваемый в промахах Voice Enrollment. Замерить обязательно.',
    decides: 'ADR-003',
    readback: 'track.getSettings().autoGainControl',
  },
  {
    key: 'audioProc.rawMode', group: 'audioProc', type: 'bool', stage: 'experiment',
    label: 'Сырой режим (выключить EC/NS/AGC разом)',
    default: false,
    why: 'Референс для бенчмарка: как звучит тракт без вмешательства браузера.',
    risk: 'Перекрывает три опции выше.',
    decides: 'ADR-003',
    readback: null,
  },
  {
    key: 'audioProc.sampleRate', group: 'audioProc', type: 'enum', stage: 'experiment',
    label: 'Частота дискретизации (запрос)',
    default: 48000,
    options: [
      { value: 16000, label: '16 000 Гц', hint: 'формат, который всё равно нужен STT' },
      { value: 24000, label: '24 000 Гц' },
      { value: 44100, label: '44 100 Гц' },
      { value: 48000, label: '48 000 Гц', hint: 'нативно для Opus и WebAudio' },
    ],
    why: 'STT-конвейер всё равно сводит к 16 кГц. Вопрос — терять ли качество на клиенте (меньше файл) '
       + 'или на сервере (лучше архив и переобработка).',
    risk: 'Запрошенная частота часто игнорируется: AudioContext работает на частоте устройства.',
    decides: 'ADR-003',
    readback: 'audioContext.sampleRate',
  },
  {
    key: 'audioProc.channelCount', group: 'audioProc', type: 'enum', stage: 'experiment',
    label: 'Число каналов микрофона (запрос)',
    default: 1,
    options: [{ value: 1, label: 'Моно' }, { value: 2, label: 'Стерео' }],
    why: 'Моно на источник — база. Стерео нужно только для гарнитур/интерфейсов с двумя капсюлями.',
    readback: 'track.getSettings().channelCount',
  },

  // ────────────────────────────────────────────── КОДИРОВАНИЕ АУДИО ──
  {
    key: 'audioEnc.impl', group: 'audioEnc', type: 'enum', stage: 'experiment',
    label: 'Движок кодирования',
    default: 'mediarecorder',
    options: [
      { value: 'mediarecorder', label: 'MediaRecorder', hint: 'просто, но контейнер закрывает браузер' },
      { value: 'webcodecs',     label: 'WebCodecs + свой muxer', hint: 'полный контроль над границами пакетов' },
      { value: 'auto',          label: 'Авто по результату пробы' },
    ],
    why: 'Это и есть развилка crash-recovery. MediaRecorder не гарантирует, что оборванный файл '
       + 'воспроизведётся; WebCodecs даёт нам самим решать, где безопасная граница.',
    decides: 'ADR-004',
    readback: null,
  },
  {
    key: 'audioEnc.codec', group: 'audioEnc', type: 'enum', stage: 'mvp',
    label: 'Кодек',
    default: 'opus',
    options: [
      { value: 'opus',  label: 'Opus', hint: 'рекомендуемый baseline' },
      { value: 'aac',   label: 'AAC',  hint: 'только если проба прошла', risk: 'Доступность зависит от сборки Chrome и ОС.' },
      { value: 'pcm16', label: 'PCM 16-бит', hint: 'референс без потерь', risk: '345 МБ/час на дорожку.' },
      { value: 'auto',  label: 'Авто по результату пробы' },
    ],
    why: 'Opus — единственный кодек, у которого речь при 32–64 кбит/с и нативная поддержка в Chromium совпадают.',
    decides: 'ADR-005',
    readback: 'recorder.mimeType',
  },
  {
    key: 'audioEnc.container', group: 'audioEnc', type: 'enum', stage: 'experiment',
    label: 'Контейнер',
    default: 'webm',
    options: [
      { value: 'webm', label: 'WebM' },
      { value: 'ogg',  label: 'Ogg', hint: 'нативный для Opus; в MediaRecorder Chrome его НЕТ, на пути WebCodecs пишем сами' },
      { value: 'mp4',  label: 'MP4', risk: 'moov в конце: обрыв = файл нечитаем без ремукса.' },
      { value: 'wav',  label: 'WAV', requires: 'pcm16' },
    ],
    why: 'Кодек ≠ контейнер. Устойчивость к обрыву определяется КОНТЕЙНЕРОМ, а не кодеком.',
    decides: 'ADR-004',
    readback: 'recorder.mimeType',
  },
  {
    key: 'audioEnc.bitrateKbps', group: 'audioEnc', type: 'enum', stage: 'mvp',
    label: 'Битрейт на одну моно-дорожку',
    default: 48,
    options: [
      { value: 24,  label: '24 кбит/с — 10,8 МБ/ч', hint: 'нижняя граница для бенчмарка' },
      { value: 32,  label: '32 кбит/с — 14,4 МБ/ч', hint: 'Economy' },
      { value: 48,  label: '48 кбит/с — 21,6 МБ/ч', hint: 'Standard (старт)' },
      { value: 64,  label: '64 кбит/с — 28,8 МБ/ч', hint: 'High' },
      { value: 96,  label: '96 кбит/с — 43,2 МБ/ч', hint: 'Very High' },
      { value: 128, label: '128 кбит/с — 57,6 МБ/ч' },
    ],
    why: 'RFC 6716 даёт для fullband speech ориентир 28–40 кбит/с. 48 взято с запасом на шум и акценты. '
       + 'Финальное значение выбирается по WER/диаризации на корпусе IronMemo, а не по этой таблице.',
    decides: 'ADR-005',
    readback: 'recorder.audioBitsPerSecond',
  },
  {
    key: 'audioEnc.bitrateMode', group: 'audioEnc', type: 'enum', stage: 'experiment',
    label: 'Режим битрейта',
    default: 'variable',
    options: [
      { value: 'variable', label: 'VBR' },
      { value: 'constant', label: 'CBR', hint: 'предсказуемый размер' },
    ],
    why: 'VBR экономит на тишине; CBR даёт линейное соответствие «байты ↔ время», что упрощает ремукс.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    decides: 'ADR-004',
    readback: null,
  },
  {
    key: 'audioEnc.opusApplication', group: 'audioEnc', type: 'enum', stage: 'experiment',
    label: 'Opus: профиль применения',
    default: 'voip',
    options: [
      { value: 'voip',     label: 'voip', hint: 'оптимизация под разборчивость речи' },
      { value: 'audio',    label: 'audio', hint: 'общий звук, музыка в демо' },
      { value: 'lowdelay', label: 'lowdelay' },
    ],
    why: 'voip и audio дают заметно разный результат на одном битрейте. Для встреч со звуком демо это может '
       + 'решать больше, чем сам битрейт.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    decides: 'ADR-005',
    readback: null,
  },
  {
    key: 'audioEnc.opusComplexity', group: 'audioEnc', type: 'int', stage: 'debug',
    label: 'Opus: complexity (0–10)', default: 9, min: 0, max: 10, step: 1,
    why: 'Компромисс качество/CPU. На слабом ноутбуке при длинной встрече CPU важнее.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    readback: null,
  },
  {
    key: 'audioEnc.opusFrameDurationUs', group: 'audioEnc', type: 'enum', stage: 'debug',
    label: 'Opus: длительность фрейма',
    default: 20000,
    options: [
      { value: 10000, label: '10 мс' }, { value: 20000, label: '20 мс' },
      { value: 40000, label: '40 мс' }, { value: 60000, label: '60 мс', hint: 'меньше оверхед' },
    ],
    why: 'Длинный фрейм = меньше накладных расходов, но грубее гранулярность восстановления после обрыва.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    decides: 'ADR-004',
    readback: null,
  },
  {
    key: 'audioEnc.opusUseDTX', group: 'audioEnc', type: 'bool', stage: 'experiment',
    label: 'Opus: DTX (не кодировать тишину)',
    default: false,
    why: 'На встрече 1:1 удалённая дорожка молчит больше половины времени. DTX может сократить её в разы.',
    risk: 'ОПАСНО: пропуски в потоке. Наивная склейка сегментов после DTX ломает временную шкалу '
        + 'и рассинхронизирует дорожки. Включать только вместе с журналом временных меток.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    decides: 'ADR-004',
    readback: null,
  },
  {
    key: 'audioEnc.opusUseInbandFEC', group: 'audioEnc', type: 'bool', stage: 'debug',
    label: 'Opus: inband FEC', default: false,
    why: 'Смысл имеет при потерях в сети. При локальной записи в файл — почти наверняка бесполезен. '
       + 'Оставлено, чтобы проверить утверждение, а не поверить ему.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    readback: null,
  },

  // ──────────────────────────────────────────────────────────── ВИДЕО ──
  {
    key: 'video.enabled', group: 'video', type: 'bool', stage: 'experiment',
    label: 'Записывать видео', default: false,
    why: 'Meeting Video Mode. Полноценный screen recorder — отдельный продукт и отдельный gate.',
    decides: 'ADR-006',
    readback: null,
  },
  {
    key: 'video.codec', group: 'video', type: 'enum', stage: 'experiment',
    label: 'Видеокодек', default: 'auto',
    options: [
      { value: 'auto', label: 'Авто по результату пробы' },
      { value: 'h264', label: 'H.264', hint: 'максимальная совместимость' },
      { value: 'vp8',  label: 'VP8',  hint: 'простой fallback' },
      { value: 'vp9',  label: 'VP9' },
      { value: 'av1',  label: 'AV1',  risk: 'Без аппаратного блока software-AV1 не тянет реальное время.' },
      { value: 'hevc', label: 'HEVC/H.265', risk: 'Наличие декодера НЕ означает наличие энкодера.' },
    ],
    why: 'isTypeSupported()===true не значит «потянет в реальном времени». Порядок задаётся активной пробой.',
    requires: { key: 'video.enabled', equals: true },
    decides: 'ADR-006',
    readback: 'recorder.mimeType',
  },
  {
    key: 'video.resolution', group: 'video', type: 'enum', stage: 'experiment',
    label: 'Разрешение', default: '720p',
    options: [
      { value: '480p', label: '854×480' }, { value: '720p', label: '1280×720' },
      { value: '1080p', label: '1920×1080' }, { value: 'native', label: 'Как есть', risk: '4K: диск и CPU.' },
    ],
    requires: { key: 'video.enabled', equals: true },
    readback: 'track.getSettings().width/height',
  },
  {
    key: 'video.fps', group: 'video', type: 'enum', stage: 'experiment',
    label: 'Кадров в секунду', default: 15,
    options: [
      { value: 5, label: '5' }, { value: 10, label: '10' },
      { value: 15, label: '15', hint: 'достаточно для слайдов и UI' },
      { value: 24, label: '24' }, { value: 30, label: '30' }, { value: 60, label: '60', risk: 'Не нужно для встреч.' },
    ],
    requires: { key: 'video.enabled', equals: true },
    readback: 'track.getSettings().frameRate',
  },
  {
    key: 'video.bitrateKbps', group: 'video', type: 'int', stage: 'experiment',
    label: 'Видеобитрейт, кбит/с', default: 1500, min: 300, max: 12000, step: 100,
    requires: { key: 'video.enabled', equals: true },
    readback: 'recorder.videoBitsPerSecond',
  },
  {
    key: 'video.hardwareAcceleration', group: 'video', type: 'enum', stage: 'experiment',
    label: 'Предпочтение аппаратного кодирования', default: 'no-preference',
    options: [
      { value: 'no-preference',  label: 'Как решит браузер' },
      { value: 'prefer-hardware', label: 'Предпочесть аппаратное' },
      { value: 'prefer-software', label: 'Предпочесть программное' },
    ],
    why: 'Это ПОДСКАЗКА, а не переключатель. Спецификация WebCodecs прямо разрешает браузеру её проигнорировать, '
       + 'в том числе из-за защиты от fingerprinting.',
    risk: 'НИКОГДА не показывать в UI «используется NVENC/Quick Sync». Мы этого не знаем и знать не можем.',
    requires: { key: 'video.enabled', equals: true },
    decides: 'ADR-006',
    readback: 'mediaCapabilities.powerEfficient (косвенно)',
  },
  {
    key: 'video.latencyMode', group: 'video', type: 'enum', stage: 'debug',
    label: 'Режим задержки', default: 'quality',
    options: [{ value: 'quality', label: 'quality' }, { value: 'realtime', label: 'realtime' }],
    requires: { key: 'video.enabled', equals: true },
    readback: null,
  },
  {
    key: 'video.contentHint', group: 'video', type: 'enum', stage: 'experiment',
    label: 'Подсказка о содержимом', default: 'text',
    options: [
      { value: 'none', label: 'Нет' }, { value: 'detail', label: 'detail' },
      { value: 'text', label: 'text', hint: 'слайды, код, документы' }, { value: 'motion', label: 'motion' },
    ],
    requires: { key: 'video.enabled', equals: true },
    readback: 'track.contentHint',
  },
  {
    key: 'video.autoAdapt', group: 'video', type: 'bool', stage: 'experiment',
    label: 'Снижать качество при перегрузке', default: true,
    why: 'При росте очереди энкодера падать в 720p/15 вместо накопления кадров и краха.',
    risk: 'Молча менять качество без этой галки — нечестно: пользователь получит не то, что выбрал.',
    requires: { key: 'video.enabled', equals: true },
    readback: null,
  },

  // ────────────────────────────────────── ХРАНЕНИЕ И СЕГМЕНТАЦИЯ ──
  {
    key: 'storage.backend', group: 'storage', type: 'enum', stage: 'experiment',
    label: 'Куда пишем медиа', default: 'opfs',
    options: [
      { value: 'opfs',      label: 'OPFS', hint: 'потоковая запись на диск' },
      { value: 'indexeddb', label: 'IndexedDB', hint: 'fallback' },
      { value: 'memory',    label: 'Память', risk: 'Только для коротких тестов. 4 часа в RAM не поместятся.' },
    ],
    why: 'Многочасовую запись нельзя держать в памяти. Проверить доступность OPFS именно в offscreen-документе.',
    decides: 'ADR-004',
    readback: 'navigator.storage.estimate()',
  },
  {
    key: 'storage.segmentStrategy', group: 'storage', type: 'enum', stage: 'experiment',
    label: 'Стратегия сегментации', default: 'rolling_finalized',
    options: [
      { value: 'continuous', label: 'Непрерывный MediaRecorder',
        hint: 'baseline', risk: 'Чанк из timeslice НЕ обязан быть самостоятельно воспроизводимым.' },
      { value: 'rolling_finalized', label: 'Перекатывающиеся завершённые сегменты',
        hint: 'каждый сегмент — валидный файл' },
      { value: 'webcodecs_muxed', label: 'WebCodecs + свой muxer', hint: 'полный контроль' },
    ],
    why: 'ГЛАВНАЯ развилка проекта. Прошлый план считал, что Blob каждые 5 секунд = crash-safe. '
       + 'Спецификация MediaStream Recording этого не гарантирует: воспроизводимой объявлена совокупность '
       + 'блобов ЗАВЕРШЁННОЙ записи, а не отдельный чанк.',
    decides: 'ADR-004',
    readback: null,
  },
  {
    key: 'storage.segmentSeconds', group: 'storage', type: 'enum', stage: 'experiment',
    label: 'Длина сегмента', default: 30,
    options: [
      { value: 5, label: '5 с' }, { value: 10, label: '10 с' }, { value: 30, label: '30 с' },
      { value: 60, label: '60 с' }, { value: 300, label: '5 мин' },
    ],
    why: 'Прямо задаёт максимальную потерю при аварии и число файлов на диске.',
    requires: { key: 'storage.segmentStrategy', equals: 'rolling_finalized' },
    decides: 'ADR-004',
    readback: null,
  },
  {
    key: 'storage.timesliceMs', group: 'storage', type: 'int', stage: 'experiment',
    label: 'MediaRecorder timeslice, мс', default: 5000, min: 200, max: 60000, step: 100,
    why: 'Частота выдачи чанков. Мелкий timeslice = больше оверхеда контейнера, но чаще точка сохранения.',
    requires: { key: 'storage.segmentStrategy', notEquals: 'webcodecs_muxed' },
    readback: 'измеренный интервал ondataavailable (capture-report)',
  },
  {
    key: 'storage.flushIntervalMs', group: 'storage', type: 'int', stage: 'experiment',
    label: 'WebCodecs: интервал сброса страницы Ogg на диск, мс', default: 1000, min: 200, max: 10000, step: 100,
    why: 'На пути WebCodecs границу durable-записи выбираем мы: раз в N мс накопленные пакеты '
       + 'становятся страницей Ogg, пишутся через createSyncAccessHandle и flush(). Это и есть '
       + 'максимальная потеря при аварии на этом пути — не «длина буфера», а это число.',
    risk: 'Слишком мелко — много страниц (27+ байт заголовка на страницу) и flush() каждые 200 мс; '
        + 'слишком крупно — больше потеря при аварии.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    decides: 'ADR-004',
    readback: 'измеренный интервал страниц (capture-report, journal)',
  },
  {
    key: 'storage.muxerGapFillMs', group: 'storage', type: 'int', stage: 'experiment',
    label: 'WebCodecs: заполнять пропуски во времени тишиной от, мс (0 = выкл.)', default: 40, min: 0, max: 5000, step: 10,
    why: 'Измерено 07.09.2026: с Opus DTX энкодер молчит по ~400 мс, и muxer, складывающий длительности '
       + 'пакетов, схлопнул 205,8 с входа в файл на 47,7 с. Потеря входа (скачок timestamp на 260 мс) '
       + 'делает то же. Timestamp чанков энкодера при DTX идут подряд и шкалу не несут (измерено), поэтому '
       + 'позиция считается по числу ВХОДНЫХ кадров; в отставание ≥ N мс вставляются кадры нулевой длины '
       + '(1 байт на 20 мс) — файл остаётся на шкале входа; ffmpeg и AudioDecoder отдают полную длительность (измерено).',
    risk: 'Слишком мелкий порог начнёт «исправлять» медленные часы устройства вставками по 20 мс; '
        + '0 возвращает схлопывание времени при DTX.',
    requires: { key: 'audioEnc.impl', equals: 'webcodecs' },
    decides: 'ADR-004',
    readback: 'capture-report: roles.*.fillerPackets / fillerSec; journal gap_filled',
  },
  {
    key: 'storage.journalEnabled', group: 'storage', type: 'bool', stage: 'mvp',
    label: 'Журнал подтверждённых записей', default: true,
    why: 'Восстановление строится на журнале того, что ФАКТИЧЕСКИ легло на диск, а не на надежде, '
       + 'что байты дописались. Без журнала слово «recovery» произносить нельзя.',
    decides: 'ADR-004',
    readback: null,
  },
  {
    key: 'storage.hashAlgo', group: 'storage', type: 'enum', stage: 'experiment',
    label: 'Контрольная сумма', default: 'sha256_incremental',
    options: [
      { value: 'none', label: 'Не считать' },
      { value: 'sha256_incremental', label: 'SHA-256 инкрементально в Worker' },
      { value: 'sha256_whole', label: 'SHA-256 целиком через WebCrypto',
        risk: 'crypto.subtle.digest требует ВЕСЬ буфер в памяти. На многогигабайтном файле это не работает.' },
    ],
    why: 'Целостность нужна для дедупликации и идемпотентного upload. Способ подсчёта — не деталь: '
       + 'наивный вариант падает ровно на тех файлах, ради которых он нужен.',
    decides: 'ADR-007',
    readback: null,
  },
  {
    key: 'storage.quotaWarnPercent', group: 'storage', type: 'int', stage: 'mvp',
    label: 'Предупреждать при заполнении, %', default: 80, min: 50, max: 99, step: 1,
    readback: 'navigator.storage.estimate()',
  },
  {
    key: 'storage.retentionDays', group: 'storage', type: 'int', stage: 'mvp',
    label: 'Хранить локально, дней (0 = бессрочно)', default: 0, min: 0, max: 365, step: 1,
    why: 'Retention control — требование privacy-раздела и аргумент в описании для магазина.',
    readback: null,
  },

  // ─────────────────────────────────────────────── ВОССТАНОВЛЕНИЕ ──
  {
    key: 'recovery.autoRecoverOnStart', group: 'recovery', type: 'bool', stage: 'mvp',
    label: 'Искать оборванные записи при запуске', default: true,
    decides: 'ADR-004', readback: null,
  },
  {
    key: 'recovery.remuxOnRecover', group: 'recovery', type: 'bool', stage: 'experiment',
    label: 'Пересобирать контейнер при восстановлении', default: true,
    why: 'Побайтовая склейка WebM-чанков НЕ является корректным восстановлением. Нужен ремукс.',
    decides: 'ADR-004', readback: null,
  },
  {
    key: 'recovery.validateDecodeAfterRemux', group: 'recovery', type: 'bool', stage: 'mvp',
    label: 'Проверять декодированием весь файл', default: true,
    why: 'Единственное доказательство успешного восстановления — файл декодируется ЦЕЛИКОМ, '
       + 'а не открывается в плеере первые три секунды.',
    risk: 'Выключение превращает «восстановлено» в непроверенное утверждение.',
    decides: 'ADR-004', readback: null,
  },

  // ────────────────────────────────────────────────────── ОТПРАВКА ──
  {
    key: 'upload.enabled', group: 'upload', type: 'bool', stage: 'mvp',
    label: 'Разрешить отправку в IronMemo', default: false,
    why: 'Диктофон обязан приносить пользу БЕЗ регистрации. Отправка — добровольный шаг.',
    decides: 'ADR-008', readback: null,
  },
  {
    key: 'upload.apiBase', group: 'upload', type: 'string', stage: 'experiment',
    label: 'Базовый URL API', default: '',
    why: 'Пусто намеренно. Реальный путь берётся из аудита кода backend, а не из документа-предложения.',
    requires: { key: 'upload.enabled', equals: true },
    readback: null,
  },
  {
    key: 'upload.authMode', group: 'upload', type: 'enum', stage: 'experiment',
    label: 'Способ авторизации', default: 'oauth_pkce',
    options: [
      { value: 'oauth_pkce', label: 'OAuth Authorization Code + PKCE S256' },
      { value: 'personal_token', label: 'Личный токен',
        risk: 'Долгоживущий токен в chrome.storage. Расширение — публичный клиент без защищённого хранилища.' },
      { value: 'none', label: 'Без авторизации (только локальный стенд)' },
    ],
    why: 'Для публичных клиентов актуальный OAuth Security BCP требует PKCE.',
    requires: { key: 'upload.enabled', equals: true },
    decides: 'ADR-008', readback: null,
  },
  {
    key: 'upload.strategy', group: 'upload', type: 'enum', stage: 'experiment',
    label: 'Транспорт загрузки', default: 'multipart',
    options: [
      { value: 'django_post', label: 'Обычный POST на backend' },
      { value: 'single_put',  label: 'Presigned PUT в хранилище' },
      { value: 'multipart',   label: 'Multipart в хранилище', hint: 'докачка только неудавшихся частей' },
    ],
    requires: { key: 'upload.enabled', equals: true },
    decides: 'ADR-008', readback: null,
  },
  {
    key: 'upload.partSizeMB', group: 'upload', type: 'int', stage: 'experiment',
    label: 'Размер части, МБ', default: 8, min: 5, max: 100, step: 1,
    why: 'S3-совместимый multipart требует минимум 5 МБ на часть (кроме последней).',
    requires: { key: 'upload.strategy', equals: 'multipart' },
    readback: null,
  },
  {
    key: 'upload.concurrency', group: 'upload', type: 'int', stage: 'experiment',
    label: 'Параллельных частей', default: 3, min: 1, max: 8, step: 1,
    requires: { key: 'upload.strategy', equals: 'multipart' },
    readback: null,
  },
  {
    key: 'upload.deleteLocalAfterUpload', group: 'upload', type: 'bool', stage: 'mvp',
    label: 'Удалять локальную копию после отправки', default: false,
    risk: 'ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО НАМЕРЕННО. Успешный HTTP 200 не означает, что запись уцелела '
        + 'на другой стороне. Оригинал удаляется только по явному решению человека.',
    decides: 'ADR-008', readback: null,
  },

  // ─────────────────────────────────────── СОГЛАСИЕ И ИНДИКАЦИЯ ──
  {
    key: 'consent.recordingIndicator', group: 'consent', type: 'enum', stage: 'mvp',
    label: 'Индикатор записи', default: 'always',
    options: [
      { value: 'always', label: 'Всегда виден' },
      { value: 'badge_only', label: 'Только значок на иконке' },
    ],
    why: 'Постоянная видимая индикация — и требование магазина, и защита от разговоров о скрытой записи.',
    risk: 'Всё, что похоже на «скрытую запись», меняет юридический класс продукта. Маркетинговые слова '
        + '«secret», «undetectable», «без разрешения» запрещены во ВСЕХ текстах.',
    decides: 'ADR-009', readback: null,
  },
  {
    key: 'consent.audibleStartTone', group: 'consent', type: 'bool', stage: 'experiment',
    label: 'Звуковой сигнал в начале записи', default: false,
    why: 'В юрисдикциях с согласием всех сторон (напр. Калифорния) слышимый сигнал — дешёвое доказательство уведомления.',
    decides: 'ADR-009', readback: null,
  },
  {
    key: 'consent.requireAcknowledgement', group: 'consent', type: 'bool', stage: 'mvp',
    label: 'Подтверждение ответственности перед первой записью', default: true,
    decides: 'ADR-009', readback: null,
  },

  // ──────────────────────────────── ЭКСПЕРИМЕНТ И ДИАГНОСТИКА ──
  {
    key: 'experiment.profileId', group: 'experiment', type: 'string', stage: 'experiment',
    label: 'Метка профиля эксперимента', default: 'default',
    why: 'Под этой меткой результат попадёт в манифест и в отчёт бенчмарка. Без неё сравнение прогонов '
       + 'превращается в угадывание.',
    readback: null,
  },
  {
    key: 'experiment.probeOnStartup', group: 'experiment', type: 'bool', stage: 'experiment',
    label: 'Запускать пробу возможностей при старте', default: false,
    risk: 'Активная проба занимает несколько секунд и нагружает CPU.',
    readback: null,
  },
  {
    key: 'experiment.forceProfileEveryRecording', group: 'experiment', type: 'bool', stage: 'debug',
    label: 'Записывать полный снимок настроек в каждую запись', default: true,
    why: 'Дороже на несколько килобайт, но делает любую запись воспроизводимой задним числом.',
    readback: null,
  },
  {
    key: 'diagnostics.verboseLogging', group: 'experiment', type: 'bool', stage: 'debug',
    label: 'Подробный лог', default: true, readback: null,
  },
  {
    key: 'diagnostics.keepCaptureReport', group: 'experiment', type: 'bool', stage: 'debug',
    label: 'Сохранять отчёт requested/applied', default: true,
    why: 'Отчёт — единственное место, где видно, что браузер проигнорировал наш запрос.',
    readback: null,
  },
  {
    key: 'telemetry.enabled', group: 'experiment', type: 'bool', stage: 'mvp',
    label: 'Отправлять анонимную статистику', default: false,
    why: 'Выключено по умолчанию. Включается только явным действием и только после отдельного раскрытия '
       + 'в карточке магазина.',
    decides: 'ADR-009', readback: null,
  },
];

/** Готовые наборы для быстрого переключения между экспериментами. */
export const PRESETS = {
  'safe-baseline': {
    label: 'Безопасный базовый',
    description: 'Всё, что заведомо работает. Точка отсчёта для сравнений.',
    values: {
      'audioEnc.impl': 'mediarecorder', 'audioEnc.codec': 'opus', 'audioEnc.container': 'webm',
      'audioEnc.bitrateKbps': 48, 'storage.segmentStrategy': 'continuous',
      'storage.timesliceMs': 5000, 'storage.backend': 'opfs', 'video.enabled': false,
    },
  },
  'crash-safe-candidate': {
    label: 'Кандидат на crash-safe',
    description: 'Завершённые сегменты + журнал + проверка декодированием. Это конфигурация, '
               + 'которую мы пытаемся довести до права называться «восстановление после сбоя».',
    // ИСПРАВЛЕНО 07.09.2026. Первая редакция ставила здесь контейнер Ogg —
    // «он устойчивее к обрыву». Замер в Chrome 152 (и в CfT 152, и в реальном
    // браузере Игоря) показал: `MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')`
    // возвращает FALSE. Пресет предлагал конфигурацию, которая падает при старте.
    // Устойчивость Ogg к обрыву проверяется в И-1 через путь WebCodecs, где
    // контейнер пишем мы сами и поддержка MediaRecorder не нужна.
    values: {
      'audioEnc.impl': 'mediarecorder', 'audioEnc.container': 'webm',
      'storage.segmentStrategy': 'rolling_finalized', 'storage.segmentSeconds': 30,
      'storage.journalEnabled': true, 'recovery.remuxOnRecover': true,
      'recovery.validateDecodeAfterRemux': true, 'storage.hashAlgo': 'sha256_incremental',
    },
  },
  'stt-quality-probe': {
    label: 'Проба качества под STT',
    description: 'Максимум информации для распознавания и диаризации. Файл большой — это ожидаемо.',
    values: {
      'audioEnc.codec': 'opus', 'audioEnc.bitrateKbps': 96,
      'audioProc.autoGainControl': false, 'audioProc.noiseSuppression': false,
      'audioProc.sampleRate': 48000, 'source.keepSeparate': true, 'source.produceMix': true,
    },
  },
  'minimal-size': {
    label: 'Минимальный размер',
    description: 'Проверяем, где ломается STT при экономии места.',
    values: {
      'audioEnc.codec': 'opus', 'audioEnc.bitrateKbps': 24, 'audioProc.sampleRate': 16000,
      'audioEnc.opusUseDTX': true, 'audioEnc.impl': 'webcodecs', 'audioEnc.container': 'ogg',
      'storage.segmentStrategy': 'webcodecs_muxed', 'storage.backend': 'opfs',
    },
  },
  'webcodecs-ogg': {
    label: 'WebCodecs + Ogg/Opus (И-1)',
    description: 'Собственный muxer, durable-запись страницами через Worker, журнал с двумя часами. '
               + 'Конфигурация замеров дрейфа и кандидат для И-2.',
    values: {
      'audioEnc.impl': 'webcodecs', 'audioEnc.codec': 'opus', 'audioEnc.container': 'ogg',
      'audioEnc.bitrateKbps': 48, 'audioEnc.opusApplication': 'voip', 'audioEnc.opusFrameDurationUs': 20000,
      'storage.segmentStrategy': 'webcodecs_muxed', 'storage.backend': 'opfs', 'storage.flushIntervalMs': 1000,
      'storage.journalEnabled': true, 'source.keepSeparate': true, 'source.produceMix': true,
    },
  },
  'lossless-reference': {
    label: 'Эталон без потерь',
    description: 'Референс для бенчмарка: с чем сравниваем потери всех остальных профилей.',
    values: {
      'audioEnc.codec': 'pcm16', 'audioEnc.container': 'wav', 'audioProc.rawMode': true,
      'audioProc.sampleRate': 48000, 'source.produceMix': false,
    },
  },
};

// ───────────────────────────────────────────────────────── утилиты ──

export function defaultSettings() {
  const out = {};
  for (const s of SETTINGS) setByPath(out, s.key, s.default);
  out.__schemaVersion = SETTINGS_SCHEMA_VERSION;
  return out;
}

export function setByPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {});
  cur[parts[parts.length - 1]] = value;
  return obj;
}

export function getByPath(obj, path) {
  return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

export function schemaByKey(key) {
  return SETTINGS.find((s) => s.key === key) ?? null;
}

/** Показывать ли опцию при текущих значениях (учитывает `requires`). */
export function isVisible(setting, values) {
  const r = setting.requires;
  if (!r) return true;
  const v = getByPath(values, r.key);
  if ('equals' in r) return v === r.equals;
  if ('notEquals' in r) return v !== r.notEquals;
  if ('includes' in r) return Array.isArray(v) && v.includes(r.includes);
  return true;
}

/**
 * Проверка на внутренние противоречия. Возвращает список проблем.
 * Намеренно НЕ чинит настройки молча: пользователь должен видеть конфликт,
 * иначе результат замера будет объяснён неверной причиной.
 */
export function validate(values) {
  const issues = [];
  const g = (k) => getByPath(values, k);

  if (g('source.mode') === 'mic' && g('source.produceMix')) {
    issues.push({ level: 'info', key: 'source.produceMix',
      text: 'Один источник — микс совпадёт с оригиналом и просто удвоит размер.' });
  }
  if (g('source.mixLayout') === 'stereo_split' && g('source.mode') !== 'mic+tab') {
    issues.push({ level: 'warn', key: 'source.mixLayout',
      text: 'Стерео L/R имеет смысл только когда источников два.' });
  }
  if (g('source.mode') !== 'mic' && !g('source.tabAudioPassthrough')) {
    issues.push({ level: 'warn', key: 'source.tabAudioPassthrough',
      text: 'Захват вкладки без возврата звука: пользователь перестанет слышать встречу.' });
  }
  if (g('audioEnc.codec') === 'pcm16' && g('audioEnc.container') !== 'wav') {
    issues.push({ level: 'error', key: 'audioEnc.container',
      text: 'PCM16 требует контейнер WAV.' });
  }
  if (g('audioEnc.codec') === 'pcm16' && g('storage.backend') === 'memory') {
    issues.push({ level: 'error', key: 'storage.backend',
      text: 'PCM16 в память: 345 МБ на час на дорожку. Вкладка упадёт.' });
  }
  if (g('audioEnc.impl') === 'webcodecs') {
    if (g('audioEnc.codec') !== 'opus') {
      issues.push({ level: 'error', key: 'audioEnc.codec',
        text: 'Путь WebCodecs в этой итерации реализован только для Opus.' });
    }
    if (g('audioEnc.container') !== 'ogg') {
      issues.push({ level: 'error', key: 'audioEnc.container',
        text: 'Путь WebCodecs пишет только Ogg (свой muxer). Выберите Ogg или движок MediaRecorder.' });
    }
    if (g('storage.segmentStrategy') !== 'webcodecs_muxed') {
      issues.push({ level: 'warn', key: 'storage.segmentStrategy',
        text: 'Движок WebCodecs всегда пишет непрерывный muxed-файл; выбранная стратегия сегментации к нему не применяется.' });
    }
    if (g('storage.backend') !== 'opfs') {
      issues.push({ level: 'error', key: 'storage.backend',
        text: 'Путь WebCodecs пишет только в OPFS (durable-запись через createSyncAccessHandle в Worker).' });
    }
  } else if (g('storage.segmentStrategy') === 'webcodecs_muxed') {
    issues.push({ level: 'warn', key: 'storage.segmentStrategy',
      text: 'Стратегия «WebCodecs + muxer» требует движок WebCodecs (audioEnc.impl).' });
  }
  if (g('audioEnc.impl') !== 'webcodecs' && g('audioEnc.container') === 'ogg') {
    issues.push({ level: 'error', key: 'audioEnc.container',
      text: 'Ogg через MediaRecorder в Chrome не поддерживается (измерено 07.09.2026). Ogg доступен только на пути WebCodecs.' });
  }
  if (g('audioEnc.opusUseDTX') && g('storage.segmentStrategy') === 'continuous') {
    issues.push({ level: 'warn', key: 'audioEnc.opusUseDTX',
      text: 'DTX создаёт пропуски в потоке. Без журнала временных меток дорожки разъедутся.' });
  }
  if (g('storage.hashAlgo') === 'sha256_whole') {
    issues.push({ level: 'warn', key: 'storage.hashAlgo',
      text: 'WebCrypto требует весь файл в памяти — на записи в несколько ГБ упадёт.' });
  }
  if (g('storage.backend') === 'memory') {
    issues.push({ level: 'warn', key: 'storage.backend',
      text: 'Память — только для тестов до нескольких минут.' });
  }
  if (g('upload.deleteLocalAfterUpload')) {
    issues.push({ level: 'warn', key: 'upload.deleteLocalAfterUpload',
      text: 'Локальная копия удалится сразу после ответа сервера. Отката не будет.' });
  }
  if (g('upload.enabled') && g('upload.authMode') === 'none') {
    issues.push({ level: 'warn', key: 'upload.authMode',
      text: 'Отправка без авторизации допустима только на локальном стенде.' });
  }
  if (g('upload.enabled') && !g('upload.apiBase')) {
    issues.push({ level: 'error', key: 'upload.apiBase',
      text: 'Отправка включена, но адрес API не задан.' });
  }
  if (g('video.enabled') && g('video.codec') === 'av1' && g('video.fps') >= 30) {
    issues.push({ level: 'warn', key: 'video.codec',
      text: 'AV1 при 30+ fps без аппаратного энкодера почти наверняка не уложится в реальное время.' });
  }
  if (g('audioProc.rawMode') &&
      (g('audioProc.echoCancellation') || g('audioProc.noiseSuppression') || g('audioProc.autoGainControl'))) {
    issues.push({ level: 'info', key: 'audioProc.rawMode',
      text: 'Сырой режим перекрывает EC/NS/AGC — три галочки выше игнорируются.' });
  }
  if (g('audioProc.rawMode') && g('source.mode') !== 'mic') {
    issues.push({ level: 'warn', key: 'audioProc.rawMode',
      text: 'Без эхоподавления микрофон запишет звук вкладки из колонок: удалённые голоса попадут в local_mic.' });
  }
  return issues;
}

/**
 * Собрать MIME-строку так же, как это делает offscreen.js.
 * Держать в одном месте обязательно: если страница настроек и рекордер соберут
 * строку по-разному, настройки будут показывать «поддерживается», а запись падать.
 */
export function resolveMime(values) {
  const codec = getByPath(values, 'audioEnc.codec');
  const container = getByPath(values, 'audioEnc.container');
  if (codec === 'pcm16') return 'audio/webm;codecs=pcm';
  const codecPart = { opus: 'opus', aac: 'mp4a.40.2' }[codec] ?? 'opus';
  const containerPart = { webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4', wav: 'audio/wav' }[container]
    ?? 'audio/webm';
  return `${containerPart};codecs=${codecPart}`;
}

/**
 * Проверка ФАКТИЧЕСКОЙ поддержки в этом браузере, а не по таблице.
 *
 * Появилась после конкретной ошибки: пресет «Кандидат на crash-safe» предлагал
 * контейнер Ogg как более устойчивый к обрыву, и это звучало разумно — но
 * Chrome 152 на `audio/ogg;codecs=opus` отвечает false. Пресет предлагал
 * конфигурацию, которая падает при старте записи.
 *
 * Вывод общий: никакая комбинация в схеме не должна считаться рабочей, пока
 * её не подтвердил сам браузер.
 */
export function checkRuntimeSupport(values) {
  const issues = [];
  if (typeof MediaRecorder === 'undefined') return issues;

  const impl = getByPath(values, 'audioEnc.impl');
  const mime = resolveMime(values);

  if (impl !== 'webcodecs' && !MediaRecorder.isTypeSupported(mime)) {
    const codec = getByPath(values, 'audioEnc.codec');
    const alts = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm']
      .filter((m) => MediaRecorder.isTypeSupported(m));
    issues.push({
      level: 'error', key: 'audioEnc.container',
      text: `Этот браузер НЕ поддерживает ${mime} для MediaRecorder. Запись не запустится.`
          + (alts.length ? ` Работают: ${alts.join(', ')}.` : ''),
    });
  }

  if (getByPath(values, 'video.enabled')) {
    const vcodec = getByPath(values, 'video.codec');
    const vmime = {
      h264: 'video/mp4;codecs=avc1.42E01E', vp8: 'video/webm;codecs=vp8',
      vp9: 'video/webm;codecs=vp9', av1: 'video/webm;codecs=av01.0.04M.08',
      hevc: 'video/mp4;codecs=hvc1.1.6.L93.B0',
    }[vcodec];
    if (vmime && !MediaRecorder.isTypeSupported(vmime)) {
      issues.push({ level: 'error', key: 'video.codec',
        text: `Этот браузер не поддерживает ${vmime}.` });
    }
    // Замерено 07.09.2026 в Chrome 152: H.264 поддерживается MediaRecorder,
    // но VideoEncoder.isConfigSupported отвечает false при ЛЮБОЙ подсказке.
    // То есть выбор движка меняет доступность кодека — это надо видеть в UI,
    // а не выяснять при первом запуске записи.
    if (vcodec === 'h264' && getByPath(values, 'audioEnc.impl') === 'webcodecs') {
      issues.push({ level: 'warn', key: 'video.codec',
        text: 'H.264 доступен через MediaRecorder, но WebCodecs в Chrome 152 его конфигурацию '
            + 'не принимает. На пути WebCodecs выберите VP9 или AV1.' });
    }
  }
  return issues;
}

/**
 * Проверка поддержки пути WebCodecs — асинхронная, потому что
 * AudioEncoder.isConfigSupported возвращает промис. Вызывается страницей
 * настроек вместе с checkRuntimeSupport(); результат блокирует сохранение
 * так же, как и синхронные ошибки. Измерено 07.09.2026 в offscreen-документе
 * CfT 152: все 11 конфигураций Opus поддержаны (feasibility-*.json).
 */
export async function checkWebCodecsSupport(values) {
  const issues = [];
  if (getByPath(values, 'audioEnc.impl') !== 'webcodecs') return issues;
  if (typeof AudioEncoder === 'undefined') {
    issues.push({ level: 'error', key: 'audioEnc.impl', text: 'В этом браузере нет AudioEncoder (WebCodecs).' });
    return issues;
  }
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    issues.push({ level: 'error', key: 'audioEnc.impl', text: 'В этом браузере нет MediaStreamTrackProcessor — не из чего взять AudioData.' });
  }
  const config = {
    codec: 'opus', sampleRate: getByPath(values, 'audioProc.sampleRate') || 48000,
    numberOfChannels: getByPath(values, 'audioProc.channelCount') || 1,
    bitrate: (getByPath(values, 'audioEnc.bitrateKbps') || 48) * 1000,
    bitrateMode: getByPath(values, 'audioEnc.bitrateMode') || 'variable',
    opus: {
      application: getByPath(values, 'audioEnc.opusApplication') || 'voip',
      complexity: getByPath(values, 'audioEnc.opusComplexity') ?? 9,
      frameDuration: getByPath(values, 'audioEnc.opusFrameDurationUs') || 20000,
      usedtx: !!getByPath(values, 'audioEnc.opusUseDTX'),
      useinbandfec: !!getByPath(values, 'audioEnc.opusUseInbandFEC'),
    },
  };
  try {
    const r = await AudioEncoder.isConfigSupported(config);
    if (!r.supported) {
      issues.push({ level: 'error', key: 'audioEnc.impl', text: `AudioEncoder не принимает конфигурацию ${JSON.stringify(config)}.` });
    }
  } catch (e) {
    issues.push({ level: 'error', key: 'audioEnc.impl', text: `AudioEncoder.isConfigSupported: ${String(e?.message ?? e)}` });
  }
  return issues;
}

/** Оценка объёма на час по текущим настройкам, МБ. */
export function estimateMBPerHour(values) {
  const g = (k) => getByPath(values, k);
  const codec = g('audioEnc.codec');
  const sources = g('source.mode') === 'mic+tab' ? 2 : 1;
  const kept = g('source.keepSeparate') ? sources : 1;
  const mix = g('source.produceMix') ? 1 : 0;

  let perTrackMB;
  if (codec === 'pcm16') {
    perTrackMB = (g('audioProc.sampleRate') * 16 * 3600) / 8 / 1e6;
  } else {
    perTrackMB = (g('audioEnc.bitrateKbps') * 3600) / 8 / 1000;
  }
  let total = perTrackMB * (kept + mix);

  if (g('video.enabled')) total += (g('video.bitrateKbps') * 3600) / 8 / 1000;
  return Math.round(total * 10) / 10;
}
