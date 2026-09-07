/**
 * audio-devices.js — enumerate, classify and warn about audio input devices.
 *
 * WHY THIS IS NOT A DROPDOWN
 * --------------------------
 * A plain <select> of `enumerateDevices()` is what Zoom and Meet show, and it is
 * not enough for us. Measured on the target machine 2026-09-07: 13 active capture
 * devices, including Voicemeeter (a virtual mixer exposing 11 outputs as inputs),
 * "Стерео микшер" (Stereo Mix), NVIDIA Broadcast, Shure MOTIV Mix, an AVerMedia
 * virtual microphone, and three Bluetooth headsets each appearing twice.
 *
 * Three of those choices silently destroy the recording, and none of them look
 * wrong in a dropdown:
 *
 *  1. LOOPBACK DEVICES ("Стерео микшер", "Voicemeeter Out …", "* Virtual Output")
 *     capture what the system is PLAYING. Selected as the microphone, `local_mic`
 *     would contain the remote participants as well — which destroys the entire
 *     point of keeping sources separate. The file looks fine; speaker attribution
 *     is ruined.
 *
 *  2. BLUETOOTH "HANDS-FREE" ENDPOINTS use HFP/HSP: mono, 8–16 kHz, narrowband.
 *     Every Bluetooth headset exposes two entries — an A2DP one (good audio, no
 *     mic) and a Hands-Free one (has a mic, poor audio). Picking the Hands-Free
 *     entry is the single most common way to get a bad meeting recording, and its
 *     name differs from the good one by two words.
 *
 *  3. DEVICES WITH THEIR OWN PROCESSING (NVIDIA Broadcast, Voicemeeter, MOTIV Mix)
 *     already apply noise suppression and gain. Stacking the browser's NS/AGC on
 *     top double-processes the signal — and AGC is already the prime suspect for
 *     voice-embedding mismatches between recordings.
 *
 * The other thing a dropdown hides: `deviceId` is origin-scoped and salted. It
 * rotates when the user clears site data. Storing only the id means the choice
 * silently reverts to default. We store id + label + groupId and fall back to
 * matching by label.
 */

/** Device roles we classify into. Order matters: first match wins. */
export const DEVICE_CLASS = {
  LOOPBACK: 'loopback',
  BT_HANDSFREE: 'bt_handsfree',
  VIRTUAL_PROCESSED: 'virtual_processed',
  VIRTUAL_OTHER: 'virtual_other',
  PHYSICAL: 'physical',
  UNKNOWN: 'unknown',
};

// Matched against the lowercased label. Localised names are included because
// Chrome reports device labels in the OS language, not in English.
const PATTERNS = [
  [DEVICE_CLASS.LOOPBACK, [
    'stereo mix', 'стерео микшер', 'stereomix', 'what u hear', 'what you hear',
    'wave out mix', 'loopback', 'voicemeeter out', 'virtual output',
    'monitor of', 'output mix',
  ]],
  [DEVICE_CLASS.BT_HANDSFREE, [
    'hands-free', 'handsfree', 'hands free', 'headset (', 'hfp', 'ag audio',
  ]],
  [DEVICE_CLASS.VIRTUAL_PROCESSED, [
    'nvidia broadcast', 'voicemeeter', 'motiv mix', 'shure virtual',
    'krisp', 'rtx voice', 'steelseries sonar',
  ]],
  [DEVICE_CLASS.VIRTUAL_OTHER, [
    'virtual', 'vb-audio', 'obs', 'avermedia', 'oculus', 'streaming center',
    'cable output', 'blackhole', 'soundflower',
  ]],
];

export function classifyDevice(label) {
  const l = (label || '').toLowerCase();
  if (!l) return DEVICE_CLASS.UNKNOWN;
  for (const [cls, needles] of PATTERNS) {
    if (needles.some((n) => l.includes(n))) return cls;
  }
  return DEVICE_CLASS.PHYSICAL;
}

/** Human-facing note per class. Empty string means "nothing to say". */
export function deviceWarning(cls) {
  switch (cls) {
    case DEVICE_CLASS.LOOPBACK:
      return 'Это устройство записывает то, что ВОСПРОИЗВОДИТ система. Выбранное как микрофон, '
           + 'оно запишет в local_mic и удалённых участников — разделение источников исчезнет, '
           + 'а файл при этом будет выглядеть нормальным.';
    case DEVICE_CLASS.BT_HANDSFREE:
      return 'Профиль Bluetooth Hands-Free: моно, 8–16 кГц. Это заметно хуже, чем тот же наушник '
           + 'в обычном режиме. У гарнитуры обычно есть вторая запись в списке — без слова '
           + '«Hands-Free»; но микрофон есть только у этой. Компромисс неизбежен, знать о нём — нет.';
    case DEVICE_CLASS.VIRTUAL_PROCESSED:
      return 'Устройство уже применяет собственное шумоподавление и автоусиление. Браузерные '
           + 'NS/AGC поверх дадут двойную обработку. Для замеров имеет смысл выключить обработку '
           + 'в настройках расширения — иначе непонятно, чей вклад вы измеряете.';
    case DEVICE_CLASS.VIRTUAL_OTHER:
      return 'Виртуальное устройство. Что именно попадёт в запись, зависит от его собственной '
           + 'маршрутизации, а не от нашей настройки.';
    default:
      return '';
  }
}

export const CLASS_LABEL = {
  [DEVICE_CLASS.LOOPBACK]: 'петля системного звука',
  [DEVICE_CLASS.BT_HANDSFREE]: 'Bluetooth Hands-Free',
  [DEVICE_CLASS.VIRTUAL_PROCESSED]: 'виртуальное с обработкой',
  [DEVICE_CLASS.VIRTUAL_OTHER]: 'виртуальное',
  [DEVICE_CLASS.PHYSICAL]: 'физическое',
  [DEVICE_CLASS.UNKNOWN]: 'неизвестно',
};

/**
 * Labels are empty until microphone permission has been granted for this origin.
 * Without labels classification is impossible, so the UI must be able to ask.
 */
export async function hasDeviceLabels() {
  try {
    const d = await navigator.mediaDevices.enumerateDevices();
    return d.some((x) => x.kind === 'audioinput' && x.label);
  } catch { return false; }
}

/**
 * Ask for microphone permission from a VISIBLE extension page (options).
 * Persists the result under `ironmemo.micPermissionGranted` so the service
 * worker knows it no longer needs to open the standalone permission page.
 */
export async function requestPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    try {
      await chrome.storage.local.set({
        'ironmemo.micPermissionGranted': { granted: true, at: Date.now() },
      });
    } catch { /* not in extension context — running from a plain page */ }
    return true;
  } catch (e) {
    try {
      await chrome.storage.local.set({
        'ironmemo.micPermissionGranted': {
          granted: false, at: Date.now(),
          error: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`,
        },
      });
    } catch { /* same as above */ }
    throw e;
  }
}

export async function listAudioDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === 'audioinput');
  const outputs = all.filter((d) => d.kind === 'audiooutput');

  const decorate = (d) => {
    const cls = classifyDevice(d.label);
    return {
      deviceId: d.deviceId, groupId: d.groupId, label: d.label,
      cls, clsLabel: CLASS_LABEL[cls], warning: deviceWarning(cls),
      isDefault: d.deviceId === 'default' || d.deviceId === 'communications',
      // A device sharing a groupId with an output is usually a headset:
      // the same physical unit exposes input and output.
      pairedOutput: outputs.find((o) => o.groupId && o.groupId === d.groupId)?.label ?? null,
    };
  };

  return {
    inputs: inputs.map(decorate),
    outputs: outputs.map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label })),
    hasLabels: inputs.some((d) => d.label),
  };
}

/**
 * Resolve a stored selection back to a live device.
 *
 * `deviceId` alone is not durable: it is salted per origin and rotates when site
 * data is cleared. So we try id, then exact label, then groupId, and report which
 * path matched — the recording manifest should say whether the requested device
 * was actually the one used.
 */
export function resolveDevice(stored, devices) {
  if (!stored || stored === 'default' || !devices.length) {
    return { device: null, match: 'default', requested: stored ?? 'default' };
  }
  const byId = devices.find((d) => d.deviceId === stored.deviceId || d.deviceId === stored);
  if (byId) return { device: byId, match: 'deviceId', requested: stored };

  if (stored.label) {
    const byLabel = devices.find((d) => d.label === stored.label);
    if (byLabel) return { device: byLabel, match: 'label', requested: stored };
  }
  if (stored.groupId) {
    const byGroup = devices.find((d) => d.groupId === stored.groupId);
    if (byGroup) return { device: byGroup, match: 'groupId', requested: stored };
  }
  return { device: null, match: 'not_found', requested: stored };
}

/**
 * Warnings that depend on the whole configuration, not on one device.
 * These are the ones a per-device dropdown cannot express.
 */
export function configWarnings({ micDevice, sourceMode, ecEnabled, nsEnabled, agcEnabled }) {
  const out = [];
  if (!micDevice) return out;

  if (micDevice.cls === DEVICE_CLASS.LOOPBACK && sourceMode !== 'mic') {
    out.push({
      level: 'error',
      text: 'Выбран петлевой вход вместе с захватом вкладки. Звук вкладки попадёт в запись ДВАЖДЫ: '
          + 'один раз как remote_tab, второй — через петлю в local_mic. Разделение источников '
          + 'бессмысленно, микс получит эхо.',
    });
  }
  if (micDevice.cls === DEVICE_CLASS.LOOPBACK && sourceMode === 'mic') {
    out.push({
      level: 'warn',
      text: 'Петлевой вход как единственный источник — это запись системного звука, а не голоса. '
          + 'Осмысленно только если вы этого и хотели.',
    });
  }
  if (micDevice.cls === DEVICE_CLASS.VIRTUAL_PROCESSED && (nsEnabled || agcEnabled)) {
    out.push({
      level: 'warn',
      text: `«${micDevice.label}» уже обрабатывает сигнал. Браузерные NS/AGC поверх — двойная `
          + 'обработка; для замера качества выключите их, иначе непонятно, чей вклад вы меряете.',
    });
  }
  if (micDevice.cls === DEVICE_CLASS.BT_HANDSFREE) {
    out.push({
      level: 'warn',
      text: 'Bluetooth Hands-Free даёт моно 8–16 кГц. Для замеров качества кодека это негодный '
          + 'источник: разницу между 32 и 96 кбит/с на таком сигнале вы не услышите.',
    });
  }
  if (micDevice.cls === DEVICE_CLASS.PHYSICAL && sourceMode !== 'mic' && !ecEnabled) {
    out.push({
      level: 'warn',
      text: 'Эхоподавление выключено при захвате вкладки. Если звук идёт из колонок, а не из '
          + 'наушников, микрофон запишет удалённых участников повторно.',
    });
  }
  return out;
}
