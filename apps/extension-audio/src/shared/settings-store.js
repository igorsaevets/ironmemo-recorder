/**
 * settings-store.js — чтение/запись настроек и профилей эксперимента.
 *
 * Почему chrome.storage.local, а не sync: профили эксперимента привязаны к
 * КОНКРЕТНОЙ машине (её кодекам, её диску, её микрофону). Синхронизировать их
 * между устройствами — значит получить замер, который нельзя объяснить.
 * Кроме того, sync имеет жёсткие квоты на элемент, а снимок настроек крупнее.
 */

import {
  SETTINGS, PRESETS, SETTINGS_SCHEMA_VERSION,
  defaultSettings, setByPath, getByPath, validate,
} from './settings-schema.js';

const KEY = 'ironmemo.settings.v1';
const PROFILES_KEY = 'ironmemo.profiles.v1';

export async function loadSettings() {
  const raw = await chrome.storage.local.get(KEY);
  const stored = raw[KEY];
  const base = defaultSettings();
  if (!stored) return base;

  // Миграция: неизвестные ключи отбрасываются, отсутствующие берут default.
  // Это ровно то место, где расширение переживает изменение схемы — молча
  // затирать чужие ключи нельзя, но и тащить мёртвые тоже.
  const merged = base;
  for (const s of SETTINGS) {
    const v = getByPath(stored, s.key);
    if (v !== undefined) setByPath(merged, s.key, v);
  }
  merged.__schemaVersion = SETTINGS_SCHEMA_VERSION;
  merged.__migratedFrom = stored.__schemaVersion ?? 'unknown';
  return merged;
}

export async function saveSettings(values) {
  values.__schemaVersion = SETTINGS_SCHEMA_VERSION;
  values.__savedAt = new Date().toISOString();
  await chrome.storage.local.set({ [KEY]: values });
  return values;
}

export async function resetSettings() {
  const d = defaultSettings();
  await chrome.storage.local.set({ [KEY]: d });
  return d;
}

/** Применить пресет поверх текущих значений (не сбрасывая остальное). */
export function applyPreset(values, presetId) {
  const p = PRESETS[presetId];
  if (!p) throw new Error(`Неизвестный пресет: ${presetId}`);
  const next = structuredClone(values);
  for (const [k, v] of Object.entries(p.values)) setByPath(next, k, v);
  next.experiment ??= {};
  next.experiment.profileId = presetId;
  return next;
}

// ─────────────────────────────────────────── именованные профили ──

export async function listProfiles() {
  const raw = await chrome.storage.local.get(PROFILES_KEY);
  return raw[PROFILES_KEY] ?? {};
}

export async function saveProfile(name, values) {
  const all = await listProfiles();
  all[name] = { savedAt: new Date().toISOString(), values: structuredClone(values) };
  await chrome.storage.local.set({ [PROFILES_KEY]: all });
  return all;
}

export async function deleteProfile(name) {
  const all = await listProfiles();
  delete all[name];
  await chrome.storage.local.set({ [PROFILES_KEY]: all });
  return all;
}

// ──────────────────────────────────────────── экспорт / импорт ──

/**
 * Экспорт профиля вместе с окружением. Окружение обязательно: результат замера
 * без версии Chrome и ОС невоспроизводим, а значит бесполезен для сравнения.
 */
export function exportProfile(values, extra = {}) {
  return JSON.stringify({
    kind: 'ironmemo-recorder-settings-profile',
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform ?? 'unknown',
      brands: navigator.userAgentData?.brands ?? null,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGB: navigator.deviceMemory ?? null,
      language: navigator.language,
    },
    validation: validate(values),
    settings: values,
    ...extra,
  }, null, 2);
}

export function importProfile(json) {
  const parsed = JSON.parse(json);
  if (parsed.kind !== 'ironmemo-recorder-settings-profile') {
    throw new Error('Это не файл профиля IronMemo Recorder.');
  }
  const base = defaultSettings();
  for (const s of SETTINGS) {
    const v = getByPath(parsed.settings ?? {}, s.key);
    if (v !== undefined) setByPath(base, s.key, v);
  }
  return { values: base, meta: parsed };
}
