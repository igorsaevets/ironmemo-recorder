/**
 * options.js — UI генерируется из settings-schema.js. Руками поля не добавлять:
 * то, чего нет в схеме, не попадёт в манифест записи, и замер станет
 * невоспроизводимым.
 */

import {
  SETTINGS, GROUPS, PRESETS, SETTINGS_SCHEMA_VERSION,
  getByPath, setByPath, isVisible, validate, estimateMBPerHour, checkRuntimeSupport, checkWebCodecsSupport,
} from '../shared/settings-schema.js';
import {
  loadSettings, saveSettings, resetSettings, applyPreset,
  listProfiles, saveProfile, deleteProfile, exportProfile, importProfile,
} from '../shared/settings-store.js';
import {
  listAudioDevices, requestPermission, resolveDevice, configWarnings, DEVICE_CLASS,
} from '../shared/audio-devices.js';

let values = null;
let stageFilter = 'all';
let audioDevices = { inputs: [], outputs: [], hasLabels: false };

const $ = (id) => document.getElementById(id);

init();

async function init() {
  values = await loadSettings();
  $('schemaVer').textContent = SETTINGS_SCHEMA_VERSION;

  await refreshDevices();
  // Устройства появляются и исчезают сами: Bluetooth-гарнитуры переподключаются,
  // Voicemeeter поднимает и убирает виртуальные входы. Не отслеживать это —
  // значит однажды писать не с того входа и не знать об этом.
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices();
    renderForm(); refreshDerived();
    flash('Список аудиоустройств изменился — обновлён.', 'warn');
  });

  renderPresets();
  renderNav();
  renderForm();
  renderProfiles();
  refreshDerived();

  $('stageFilter').addEventListener('change', (e) => {
    stageFilter = e.target.value;
    renderNav(); renderForm();
  });
  $('save').addEventListener('click', onSave);
  $('reset').addEventListener('click', onReset);
  $('openLab').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('src/lab/lab.html') }));
  $('saveProfile').addEventListener('click', onSaveProfile);
  $('exportProfile').addEventListener('click', onExportProfile);
  $('importProfile').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', onImportFile);
}

async function refreshDevices() {
  try { audioDevices = await listAudioDevices(); }
  catch { audioDevices = { inputs: [], outputs: [], hasLabels: false }; }
}

// ─────────────────────────────────────────────────────── рендер ──

function visibleSettings() {
  return SETTINGS.filter((s) => {
    if (stageFilter === 'mvp') return s.stage === 'mvp';
    if (stageFilter === 'experiment') return s.stage === 'mvp' || s.stage === 'experiment';
    return true;
  });
}

function renderNav() {
  const nav = $('sidenav');
  nav.innerHTML = '';
  const shown = visibleSettings();
  for (const g of [...GROUPS].sort((a, b) => a.order - b.order)) {
    const n = shown.filter((s) => s.group === g.id).length;
    if (!n) continue;
    const a = document.createElement('a');
    a.href = `#g-${g.id}`;
    a.textContent = g.title;
    nav.appendChild(a);
  }
}

function renderPresets() {
  const box = $('presetList');
  box.innerHTML = '';
  for (const [id, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.innerHTML = `<strong>${escapeHtml(p.label)}</strong><span>${escapeHtml(p.description)}</span>`;
    b.addEventListener('click', () => {
      values = applyPreset(values, id);
      renderForm(); refreshDerived();
      flash(`Применён пресет «${p.label}». Не забудьте сохранить.`);
    });
    box.appendChild(b);
  }
}

function renderForm() {
  const form = $('form');
  form.innerHTML = '';
  const shown = visibleSettings();

  for (const g of [...GROUPS].sort((a, b) => a.order - b.order)) {
    const items = shown.filter((s) => s.group === g.id);
    if (!items.length) continue;

    const section = document.createElement('section');
    section.className = 'group card';
    section.id = `g-${g.id}`;
    section.innerHTML = `<h2>${escapeHtml(g.title)}<span class="count">${items.length}</span></h2>`;

    for (const s of items) {
      if (!isVisible(s, values)) continue;
      section.appendChild(renderField(s));
    }
    form.appendChild(section);
  }
}

function renderField(s) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.key = s.key;

  const head = document.createElement('div');
  head.className = 'field-head';
  head.innerHTML =
    `<label for="f-${cssId(s.key)}">${escapeHtml(s.label)}</label>` +
    `<span class="badge ${s.stage}">${s.stage}</span>` +
    (s.decides ? `<span class="badge decides">${s.decides}</span>` : '') +
    `<code class="opt-hint">${escapeHtml(s.key)}</code>`;
  wrap.appendChild(head);

  const control = document.createElement('div');
  control.className = 'control';
  control.appendChild(buildInput(s));
  wrap.appendChild(control);

  if (s.why)      wrap.insertAdjacentHTML('beforeend', `<p class="why">${escapeHtml(s.why)}</p>`);
  if (s.risk)     wrap.insertAdjacentHTML('beforeend', `<p class="risk">⚠ ${escapeHtml(s.risk)}</p>`);
  if (s.readback) wrap.insertAdjacentHTML('beforeend',
    `<p class="readback">Фактическое значение читается как <code>${escapeHtml(s.readback)}</code> и пишется в манифест.</p>`);
  else if (s.readback === null) wrap.insertAdjacentHTML('beforeend',
    `<p class="readback">Прочитать фактически применённое значение нельзя — в манифест попадёт только запрошенное.</p>`);

  return wrap;
}

function buildInput(s) {
  const id = `f-${cssId(s.key)}`;
  const cur = getByPath(values, s.key);

  if (s.type === 'bool') {
    const el = document.createElement('input');
    el.type = 'checkbox'; el.id = id; el.checked = !!cur;
    el.addEventListener('change', () => onChange(s.key, el.checked));
    return el;
  }

  if (s.type === 'enum') {
    const el = document.createElement('select');
    el.id = id;
    for (const o of s.options) {
      const opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.label + (o.hint ? ` — ${o.hint}` : '') + (o.risk ? ' ⚠' : '');
      if (String(o.value) === String(cur)) opt.selected = true;
      el.appendChild(opt);
    }
    el.addEventListener('change', () => {
      const raw = el.value;
      const match = s.options.find((o) => String(o.value) === raw);
      onChange(s.key, match ? match.value : raw);
    });
    const box = document.createElement('div');
    box.style.display = 'flex'; box.style.flexDirection = 'column'; box.style.gap = '5px';
    box.appendChild(el);
    const chosen = s.options.find((o) => String(o.value) === String(cur));
    if (chosen?.risk) {
      const r = document.createElement('span');
      r.className = 'opt-hint'; r.style.color = '#ffd9a0';
      r.textContent = `⚠ ${chosen.risk}`;
      box.appendChild(r);
    }
    return box;
  }

  if (s.type === 'device' || s.type === 'device-out') {
    const isOut = s.type === 'device-out';
    const list = isOut ? audioDevices.outputs : audioDevices.inputs;
    const box = document.createElement('div');
    box.style.display = 'flex'; box.style.flexDirection = 'column'; box.style.gap = '6px';

    // Без выданного доступа Chrome возвращает пустые label. Классифицировать
    // нечего, и делать вид, что список полный, нельзя.
    if (!audioDevices.hasLabels) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn tiny';
      btn.textContent = 'Показать названия устройств (запросить доступ к микрофону)';
      btn.addEventListener('click', async () => {
        try { await requestPermission(); await refreshDevices(); renderForm(); refreshDerived(); }
        catch (e) { flash('Доступ не выдан: ' + e.message, 'error'); }
      });
      box.appendChild(btn);
      const note = document.createElement('span');
      note.className = 'opt-hint';
      note.textContent = 'Найдено устройств: ' + list.length
        + ', но названия Chrome скрывает до выдачи доступа.';
      box.appendChild(note);
      return box;
    }

    const el = document.createElement('select');
    el.id = id;
    const def = document.createElement('option');
    def.value = 'default';
    def.textContent = isOut ? 'По умолчанию (системные динамики)' : 'По умолчанию (следует за ОС)';
    el.appendChild(def);

    const curId = (cur && typeof cur === 'object') ? cur.deviceId : cur;

    // Группируем по классу: физические сверху, ловушки — внизу и подписаны,
    // чтобы «Стерео микшер» не стоял в списке наравне с гарнитурой.
    const order = [DEVICE_CLASS.PHYSICAL, DEVICE_CLASS.VIRTUAL_PROCESSED,
                   DEVICE_CLASS.VIRTUAL_OTHER, DEVICE_CLASS.BT_HANDSFREE, DEVICE_CLASS.LOOPBACK];

    if (isOut) {
      for (const d of list) {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label;
        if (d.deviceId === curId) o.selected = true;
        el.appendChild(o);
      }
    } else {
      for (const cls of order) {
        const arr = list.filter((d) => d.cls === cls && !d.isDefault);
        if (!arr.length) continue;
        const grp = document.createElement('optgroup');
        grp.label = labelForClass(cls);
        for (const d of arr) {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label + (d.pairedOutput ? '  ⇄ есть парный выход' : '');
          if (d.deviceId === curId) o.selected = true;
          grp.appendChild(o);
        }
        el.appendChild(grp);
      }
    }

    el.addEventListener('change', () => {
      const d = list.find((x) => x.deviceId === el.value);
      // Сохраняем не только id: он засолен по origin и меняется при очистке
      // данных сайта. Метка и groupId позволяют найти устройство снова.
      onChange(s.key, (el.value === 'default' || !d) ? 'default'
        : { deviceId: d.deviceId, label: d.label, groupId: d.groupId });
    });
    box.appendChild(el);

    if (!isOut) {
      const chosen = list.find((d) => d.deviceId === curId);
      if (chosen && chosen.warning) {
        const w = document.createElement('span');
        w.className = 'opt-hint';
        w.style.color = chosen.cls === DEVICE_CLASS.LOOPBACK ? '#ff9aa2' : '#ffd9a0';
        w.textContent = '⚠ ' + chosen.clsLabel + ': ' + chosen.warning;
        box.appendChild(w);
      }
      const stat = document.createElement('span');
      stat.className = 'opt-hint';
      stat.textContent = 'Всего входов: ' + list.length + '. '
        + order.map((c) => labelForClass(c) + ' — ' + list.filter((d) => d.cls === c).length)
               .join('; ') + '.';
      box.appendChild(stat);
    }
    return box;
  }

  if (s.type === 'int' || s.type === 'float') {
    const box = document.createElement('div');
    box.className = 'row';
    const range = document.createElement('input');
    range.type = 'range'; range.id = id;
    range.min = s.min ?? 0; range.max = s.max ?? 100; range.step = s.step ?? 1;
    range.value = cur;
    const num = document.createElement('input');
    num.type = 'number';
    num.min = range.min; num.max = range.max; num.step = range.step;
    num.value = cur; num.style.minWidth = '110px';
    const sync = (v) => {
      const n = s.type === 'int' ? parseInt(v, 10) : parseFloat(v);
      if (Number.isNaN(n)) return;
      range.value = n; num.value = n;
      onChange(s.key, n);
    };
    range.addEventListener('input', () => sync(range.value));
    num.addEventListener('change', () => sync(num.value));
    box.append(range, num);
    return box;
  }

  const el = document.createElement('input');
  el.type = 'text'; el.id = id; el.value = cur ?? '';
  el.placeholder = s.key === 'upload.apiBase' ? 'напр. http://localhost:8000/recordings/api' : '';
  el.addEventListener('change', () => onChange(s.key, el.value));
  return el;
}

function onChange(key, value) {
  setByPath(values, key, value);
  // Перерисовываем целиком: `requires` может открыть или закрыть другие поля,
  // и частичное обновление быстро разошлось бы со схемой.
  renderForm();
  refreshDerived();
  flash('Изменено — не забудьте «Сохранить настройки».', 'warn');
}

// ────────────────────────────────────────── производные величины ──

function refreshDerived() {
  // Сначала правила схемы, затем реальный опрос браузера. Второе важнее:
  // схема может считать комбинацию разумной, а MediaRecorder — не поддерживать её.
  const curMic = getByPath(values, 'source.micDeviceId');
  const resolved = resolveDevice(curMic, audioDevices.inputs);
  const issues = [
    ...validate(values),
    ...checkRuntimeSupport(values),
    ...configWarnings({
      micDevice: resolved.device,
      sourceMode: getByPath(values, 'source.mode'),
      ecEnabled: getByPath(values, 'audioProc.echoCancellation') && !getByPath(values, 'audioProc.rawMode'),
      nsEnabled: getByPath(values, 'audioProc.noiseSuppression') && !getByPath(values, 'audioProc.rawMode'),
      agcEnabled: getByPath(values, 'audioProc.autoGainControl') && !getByPath(values, 'audioProc.rawMode'),
    }).map((w) => ({ ...w, key: 'source.micDeviceId' })),
  ];
  // Сохранённое устройство могло исчезнуть — Bluetooth отключился, Voicemeeter
  // выгрузился. Молчать нельзя: запись пойдёт не с того входа.
  if (curMic && curMic !== 'default' && resolved.match === 'not_found') {
    issues.push({ level: 'error', key: 'source.micDeviceId',
      text: 'Выбранное устройство «' + (curMic.label || curMic) + '» сейчас недоступно.' });
  } else if (resolved.match === 'label' || resolved.match === 'groupId') {
    issues.push({ level: 'info', key: 'source.micDeviceId',
      text: 'Устройство найдено по '
        + (resolved.match === 'label' ? 'названию' : 'группе')
        + ', а не по идентификатору — Chrome его пересоздал. Сохраните настройки, чтобы закрепить.' });
  }
  const box = $('issues');
  box.innerHTML = '';
  box.hidden = issues.length === 0;
  for (const i of issues) {
    const d = document.createElement('div');
    d.className = `issue ${i.level}`;
    d.innerHTML = `<b>${i.level === 'error' ? '✕' : i.level === 'warn' ? '⚠' : 'ℹ'}</b>` +
                  `<code>${escapeHtml(i.key)}</code> — ${escapeHtml(i.text)}`;
    box.appendChild(d);
  }

  const mode = getByPath(values, 'source.mode');
  const sources = mode === 'mic+tab' ? 2 : 1;
  const assets = (getByPath(values, 'source.keepSeparate') ? sources : 1)
               + (getByPath(values, 'source.produceMix') ? 1 : 0)
               + (getByPath(values, 'video.enabled') ? 1 : 0);
  const mb = estimateMBPerHour(values);

  $('sumSources').textContent = String(sources);
  $('sumAssets').textContent = `${assets} + манифест`;
  $('sumSize').textContent = `${mb} МБ/ч`;
  $('sumSize4h').textContent = `${Math.round(mb * 4 * 10) / 10} МБ`;

  const strat = getByPath(values, 'storage.segmentStrategy');
  const stratLabel = { continuous: 'непрерывная', rolling_finalized: 'завершённые сегменты',
                       webcodecs_muxed: 'WebCodecs + muxer' }[strat] ?? strat;
  $('sumSeg').textContent = stratLabel;

  // Честная оценка максимальной потери: при continuous гарантий нет вообще.
  const loss = strat === 'rolling_finalized'
    ? `≤ ${getByPath(values, 'storage.segmentSeconds')} с`
    : strat === 'webcodecs_muxed'
      ? '≤ длина буфера'
      : 'не гарантирована';
  $('sumLoss').textContent = loss;
  $('sumLoss').style.color = strat === 'continuous' ? 'var(--warn)' : '';
}

// ─────────────────────────────────────────────────── действия ──

async function onSave() {
  // Обе проверки, а не только схемная: иначе можно сохранить конфигурацию,
  // которую этот браузер не поддерживает, и узнать об этом при старте записи.
  const curMic = getByPath(values, 'source.micDeviceId');
  const resolved = resolveDevice(curMic, audioDevices.inputs);
  const issues = [
    ...validate(values),
    ...checkRuntimeSupport(values),
    // Путь WebCodecs проверяется асинхронно (AudioEncoder.isConfigSupported — промис).
    ...(await checkWebCodecsSupport(values)),
    ...configWarnings({
      micDevice: resolved.device,
      sourceMode: getByPath(values, 'source.mode'),
      ecEnabled: getByPath(values, 'audioProc.echoCancellation') && !getByPath(values, 'audioProc.rawMode'),
      nsEnabled: getByPath(values, 'audioProc.noiseSuppression') && !getByPath(values, 'audioProc.rawMode'),
      agcEnabled: getByPath(values, 'audioProc.autoGainControl') && !getByPath(values, 'audioProc.rawMode'),
    }).map((w) => ({ ...w, key: 'source.micDeviceId' })),
  ];
  // Сохранённое устройство могло исчезнуть — Bluetooth отключился, Voicemeeter
  // выгрузился. Молчать нельзя: запись пойдёт не с того входа.
  if (curMic && curMic !== 'default' && resolved.match === 'not_found') {
    issues.push({ level: 'error', key: 'source.micDeviceId',
      text: 'Выбранное устройство «' + (curMic.label || curMic) + '» сейчас недоступно.' });
  } else if (resolved.match === 'label' || resolved.match === 'groupId') {
    issues.push({ level: 'info', key: 'source.micDeviceId',
      text: 'Устройство найдено по '
        + (resolved.match === 'label' ? 'названию' : 'группе')
        + ', а не по идентификатору — Chrome его пересоздал. Сохраните настройки, чтобы закрепить.' });
  }
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) {
    flash(`Не сохранено: ${errors.length} конфликт(ов) нужно устранить.`, 'error');
    return;
  }
  await saveSettings(values);
  flash('Сохранено. Настройки применятся к следующей записи.', 'ok');
}

async function onReset() {
  if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
  values = await resetSettings();
  renderForm(); refreshDerived();
  flash('Сброшено к значениям по умолчанию.', 'ok');
}

async function onSaveProfile() {
  const name = $('profileName').value.trim();
  if (!name) { flash('Укажите имя профиля.', 'warn'); return; }
  await saveProfile(name, values);
  $('profileName').value = '';
  renderProfiles();
  flash(`Профиль «${name}» сохранён.`, 'ok');
}

async function renderProfiles() {
  const all = await listProfiles();
  const box = $('profileList');
  box.innerHTML = '';
  const names = Object.keys(all);
  if (!names.length) {
    box.innerHTML = '<p class="muted" style="font-size:12.5px">Сохранённых профилей пока нет.</p>';
    return;
  }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'profile-item';
    row.innerHTML = `<span><b>${escapeHtml(name)}</b> <span class="muted">${
      new Date(all[name].savedAt).toLocaleString('ru-RU')}</span></span>`;
    const actions = document.createElement('span');
    actions.className = 'row';
    const load = document.createElement('button');
    load.className = 'btn tiny'; load.textContent = 'Загрузить';
    load.addEventListener('click', () => {
      values = structuredClone(all[name].values);
      renderForm(); refreshDerived();
      flash(`Загружен профиль «${name}». Не забудьте сохранить.`, 'warn');
    });
    const del = document.createElement('button');
    del.className = 'btn tiny ghost'; del.textContent = 'Удалить';
    del.addEventListener('click', async () => {
      await deleteProfile(name); renderProfiles();
    });
    actions.append(load, del);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

function onExportProfile() {
  const json = exportProfile(values);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const id = getByPath(values, 'experiment.profileId') || 'profile';
  a.href = url;
  a.download = `ironmemo-settings-${id}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const { values: v } = importProfile(await file.text());
    values = v;
    renderForm(); refreshDerived();
    flash('Профиль импортирован. Не забудьте сохранить.', 'ok');
  } catch (err) {
    flash(`Не удалось импортировать: ${err.message}`, 'error');
  }
  e.target.value = '';
}

// ────────────────────────────────────────────────── утилиты ──

let flashTimer = null;
function flash(text, kind = 'info') {
  const el = $('saveState');
  el.textContent = text;
  el.style.color = { ok: 'var(--ok)', warn: 'var(--warn)', error: 'var(--error)' }[kind] ?? 'var(--muted)';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssId(key) { return key.replace(/\./g, '-'); }

function labelForClass(c) {
  return {
    [DEVICE_CLASS.PHYSICAL]: 'Физические',
    [DEVICE_CLASS.VIRTUAL_PROCESSED]: 'Виртуальные с обработкой',
    [DEVICE_CLASS.VIRTUAL_OTHER]: 'Виртуальные',
    [DEVICE_CLASS.BT_HANDSFREE]: 'Bluetooth Hands-Free (моно 8-16 кГц)',
    [DEVICE_CLASS.LOOPBACK]: 'Петля системного звука — запишет и удалённых',
  }[c] || c;
}
