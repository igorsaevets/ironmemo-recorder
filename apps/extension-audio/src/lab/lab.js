import { runFullProbe, VIDEO_CANDIDATES, VIDEO_RESOLUTIONS } from '../shared/capability-probe.js';
import { decodeOggOpusFully, demuxOggOpus } from '../shared/ogg-opus.js';

const $ = (id) => document.getElementById(id);
let lastReport = null;

$('runFast').addEventListener('click', () => run(false));
$('runFull').addEventListener('click', () => run(true));
$('download').addEventListener('click', download);
$('refreshSessions').addEventListener('click', renderSessions);
renderSessions().catch(() => {});

async function run(active) {
  $('runFast').disabled = $('runFull').disabled = true;
  $('progress').textContent = 'Запуск…';
  try {
    lastReport = await runFullProbe({
      active,
      onProgress: (m) => { $('progress').textContent = m; },
    });
    render(lastReport);
    $('download').disabled = false;
    $('progress').textContent = active
      ? 'Полная проба завершена. Активные замеры выполнены на реальном кодировании.'
      : 'Быстрая проба завершена. Это только заявленная поддержка — она НЕ доказывает работоспособность.';
  } catch (e) {
    $('progress').textContent = `Ошибка: ${e?.message ?? e}`;
    console.error(e);
  } finally {
    $('runFast').disabled = $('runFull').disabled = false;
  }
}

function render(r) {
  $('raw').textContent = JSON.stringify(r, null, 2);

  const e = r.environment;
  $('env').innerHTML = table(
    ['Параметр', 'Значение'],
    [
      ['Браузер', e.userAgent],
      ['Платформа', e.uaData?.platform ?? '—'],
      ['Логических ядер', e.hardwareConcurrency ?? 'скрыто'],
      ['Память, ГБ (округлено браузером)', e.deviceMemoryGB ?? 'скрыто'],
      ['Квота хранилища', e.storage ? `${e.storage.usageGB} / ${e.storage.quotaGB} ГБ` : '—'],
      ['OPFS доступен', bool(e.opfs.available)],
      ['OPFS пишется', bool(e.opfs.writable) + (e.opfs.method ? ` (${e.opfs.method})` : '')],
      ['OPFS ошибка', e.opfs.error ?? '—'],
      ...Object.entries(e.apis).map(([k, v]) => [`API: ${k}`, bool(v)]),
    ],
  );

  $('declAudio').innerHTML = table(
    ['Кандидат', 'MIME', 'isTypeSupported'],
    r.declaredAudio.map((a) => [a.id, `<code>${a.mime}</code>`, bool(a.mediaRecorderSupported)]),
  );

  $('wcAudio').innerHTML = table(
    ['Конфигурация', 'Кодек', 'Частота', 'Битрейт', 'Поддержана'],
    r.webCodecsAudio.map((a) => [
      a.id, a.codec ?? '—', a.sampleRate ?? '—',
      a.bitrate ? `${a.bitrate / 1000} кбит/с` : '—',
      a.error ? `<span class="no">${esc(a.error)}</span>` : bool(a.supported),
    ]),
  );

  if (r.activeAudio?.length) {
    $('actAudio').innerHTML = table(
      ['Кандидат', 'Уверенность', 'Запрошено', 'Фактически', 'Битрейт учтён', 'Частота учтена', 'Декодируется', 'МБ/час'],
      r.activeAudio.map((a) => [
        a.candidate,
        `<span class="pill ${a.confidence}">${a.confidence}</span>`,
        num(a.requestedBitrateKbps, ' кбит/с'), num(a.effectiveBitrateKbps, ' кбит/с'),
        bool(a.bitrateHonoured), bool(a.sampleRateHonoured) + ` (${a.actualSampleRate ?? '—'} Гц)`,
        a.decode?.ok ? `${bool(true)} ${a.decode.seconds}s` : `<span class="no">${esc(a.decode?.error ?? '—')}</span>`,
        num(a.estimatedMBPerHour),
      ]),
    ) + `<p class="why">Столбец «Битрейт учтён» — самый полезный. Если там «нет», значит браузер
         проигнорировал наш запрос, и рассчитанные по таблице объёмы неверны.</p>`;
  } else {
    $('actAudio').innerHTML = '<p class="muted">Запустите полную пробу.</p>';
  }

  // Сводная матрица: строка — кодек+разрешение, столбцы — три варианта подсказки.
  const rows = [];
  for (const c of VIDEO_CANDIDATES) {
    for (const res of VIDEO_RESOLUTIONS) {
      const get = (hw) => r.webCodecsVideo.find(
        (x) => x.candidate === c.id && x.resolution === res.id && x.hardwarePreference === hw);
      const none = get('no-preference'), hard = get('prefer-hardware'), soft = get('prefer-software');
      const pe = r.powerEfficiency.find((p) => p.candidate === c.id && p.resolution === res.id);
      const discriminates = hard && soft && hard.supported !== soft.supported;
      rows.push([
        c.id, res.id,
        bool(none?.supported), bool(hard?.supported), bool(soft?.supported),
        pe ? bool(pe.powerEfficient) : '—',
        discriminates
          ? '<span class="yes">да — два пути различимы</span>'
          : '<span class="no">нет — подсказка ничего не меняет</span>',
      ]);
    }
  }
  $('wcVideo').innerHTML = table(
    ['Кодек', 'Разрешение', 'no-preference', 'prefer-hardware', 'prefer-software', 'powerEfficient', 'Подсказка различает?'],
    rows,
  ) + `<p class="why">Последний столбец и есть максимум того, что браузер сообщает об
       аппаратном кодировании. «Да» означает лишь, что prefer-hardware и prefer-software дают
       разный ответ — то есть два пути существуют. Какое именно железо за этим стоит, узнать
       нельзя.</p>`;

  if (r.activeVideo?.length) {
    $('actVideo').innerHTML = table(
      ['Кандидат', 'Уверенность', 'Коэф. реального времени', 'Очередь p95', 'Кадров', 'Декодируется', 'Факт. битрейт', 'Вывод'],
      r.activeVideo.map((v) => [
        v.candidate,
        `<span class="pill ${v.confidence}">${v.confidence}</span>`,
        v.timing ? num(v.timing.realtimeRatio) : '—',
        v.encodeQueue?.p95 ?? '—',
        v.frames ? `${v.frames.encodedChunks}/${v.frames.requested}` : '—',
        v.decode?.ok ? bool(true) : `<span class="no">${esc(v.decode?.error ?? v.reason ?? '—')}</span>`,
        v.effectiveBitrateKbps ? `${v.effectiveBitrateKbps} кбит/с` : '—',
        esc(v.humanVerdict ?? ''),
      ]),
    ) + `<p class="why">Коэффициент реального времени = затраченное время / длительность материала.
         Меньше 1 — успевает. Больше 1 — на записи будет накапливаться отставание, и такой профиль
         использовать нельзя, даже если isTypeSupported вернул «да».</p>`;
  } else {
    $('actVideo').innerHTML = '<p class="muted">Запустите полную пробу.</p>';
  }
}

function download() {
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ironmemo-capability-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const bool = (v) => v === true ? '<span class="yes">да</span>'
  : v === false ? '<span class="no">нет</span>' : '—';
const num = (v, suffix = '') => v == null ? '—' : `<span class="num">${v}${suffix}</span>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}


// ───────────────────────────────────────── сессии в OPFS: экспорт и проверка ──

async function listSessions() {
  const root = await navigator.storage.getDirectory();
  const out = [];
  let sessions;
  try { sessions = await root.getDirectoryHandle('sessions'); } catch { return out; }
  for await (const [sid, dir] of sessions.entries()) {
    const files = [];
    for await (const [name, fh] of dir.entries()) {
      if (fh.kind !== 'file') continue;
      const f = await fh.getFile();
      files.push({ name, size: f.size, lastModified: f.lastModified });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ session: sid, files, bytes: files.reduce((a, f) => a + f.size, 0) });
  }
  out.sort((a, b) => (b.files[0]?.lastModified ?? 0) - (a.files[0]?.lastModified ?? 0));
  return out;
}

async function getFile(session, name) {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle(session);
  return (await dir.getFileHandle(name)).getFile();
}

/** Download one OPFS file through a normal <a download> — Playwright intercepts it as a Download. */
async function downloadFile(session, name) {
  const f = await getFile(session, name);
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url; a.download = `${session.slice(0, 8)}-${name}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { name, size: f.size };
}

/** Decode every .opus in a session end to end with WebCodecs; count samples. */
async function decodeSession(session) {
  const results = {};
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle(session);
  for await (const [name, fh] of dir.entries()) {
    if (!name.endsWith('.opus')) continue;
    const f = await fh.getFile();
    const t0 = performance.now();
    const buf = await f.arrayBuffer();
    const r = await decodeOggOpusFully(buf, { onProgress: (i, n) => { const el = document.getElementById('sessions'); if (el) el.dataset.progress = `${name}: ${i}/${n}`; } });
    results[name] = { ...r, bytes: f.size, wallMs: Math.round(performance.now() - t0) };
  }
  return results;
}

async function deleteSession(session) {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle('sessions');
  await sessions.removeEntry(session, { recursive: true });
  return true;
}

async function renderSessions() {
  const box = $('sessions');
  const list = await listSessions();
  if (!list.length) { box.innerHTML = '<p class="muted">Сессий нет.</p>'; return; }
  box.innerHTML = '';
  for (const s of list) {
    const div = document.createElement('div');
    div.className = 'session';
    div.innerHTML = `<h3 style="margin:14px 0 4px"><code>${esc(s.session)}</code> — ${(s.bytes / 1048576).toFixed(1)} МБ</h3>`
      + table(['Файл', 'Байт', 'Изменён', ''], s.files.map((f) => [
          esc(f.name), f.size.toLocaleString('ru-RU'), new Date(f.lastModified).toLocaleTimeString('ru-RU'),
          `<a href="#" data-dl="${esc(s.session)}|${esc(f.name)}">скачать</a>`]))
      + `<p><button class="btn" data-decode="${esc(s.session)}">Проверить декодированием (все .opus)</button>
            <button class="btn ghost" data-del="${esc(s.session)}">Удалить сессию</button></p>
         <pre class="decode-result" hidden></pre>`;
    box.appendChild(div);
  }
  box.querySelectorAll('a[data-dl]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); const [sid, name] = a.dataset.dl.split('|'); downloadFile(sid, name);
  }));
  box.querySelectorAll('button[data-decode]').forEach((b) => b.addEventListener('click', async () => {
    const pre = b.parentElement.nextElementSibling; pre.hidden = false; pre.textContent = 'Декодирую…';
    const r = await decodeSession(b.dataset.decode);
    pre.textContent = JSON.stringify(r, null, 2);
  }));
  box.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить сессию ' + b.dataset.del + '?')) return;
    await deleteSession(b.dataset.del); renderSessions();
  }));
}

// Test-bench API (Playwright): window.ironmemoLab.*
window.ironmemoLab = { listSessions, downloadFile, decodeSession, deleteSession, demuxOggOpus, getFile };
