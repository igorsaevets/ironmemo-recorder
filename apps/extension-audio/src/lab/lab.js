import { runFullProbe, VIDEO_CANDIDATES, VIDEO_RESOLUTIONS } from '../shared/capability-probe.js';

const $ = (id) => document.getElementById(id);
let lastReport = null;

$('runFast').addEventListener('click', () => run(false));
$('runFull').addEventListener('click', () => run(true));
$('download').addEventListener('click', download);

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
