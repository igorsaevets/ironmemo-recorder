// Список сессий в OPFS: чтение напрямую (не через service worker — он эфемерен), download
// через <a download> (не требует permission), delete через removeEntry({recursive:true}).
// Читается тот же путь, что пишет capture-worker: sessions/<sessionId>/{local_mic,remote_tab,
// compatibility_mix}.opus + capture-report.json + journal.jsonl.

const $ = (id) => document.getElementById(id);

const ROLE_LABEL = {
  local_mic: 'Микрофон',
  remote_tab: 'Вкладка',
  compatibility_mix: 'Микс (mic+tab)',
};

// Латинский slug для имени файла на диске — Cyrillic в имени скачанного файла
// на Windows и части Linux даёт непредсказуемое поведение (см. CLAUDE.md).
const ROLE_SLUG = {
  local_mic: 'mic',
  remote_tab: 'tab',
  compatibility_mix: 'mix',
};

boot().catch((e) => showStatus(`Не удалось загрузить список: ${e?.message ?? e}`, 'error'));

async function boot() {
  $('refresh').addEventListener('click', () => refresh().catch((e) => showStatus(e.message, 'error')));
  await refresh();
}

async function refresh() {
  const sessions = await listSessions();
  render(sessions);
}

async function listSessions() {
  const root = await navigator.storage.getDirectory();
  let sessionsDir;
  try { sessionsDir = await root.getDirectoryHandle('sessions'); }
  catch { return []; }

  const out = [];
  for await (const [sid, dh] of sessionsDir.entries()) {
    if (dh.kind !== 'directory') continue;
    const files = [];
    let report = null;
    for await (const [name, fh] of dh.entries()) {
      if (fh.kind !== 'file') continue;
      const f = await fh.getFile();
      files.push({ name, size: f.size, lastModified: f.lastModified });
      if (name === 'capture-report.json') {
        try { report = JSON.parse(await f.text()); } catch { /* corrupt report — treat as no report */ }
      }
    }
    const bytes = files.reduce((a, f) => a + f.size, 0);
    const roleFiles = files.filter((f) => /\.(opus|webm)$/.test(f.name));
    // Startedat: capture-report.openedWall берётся первым; иначе — самый ранний lastModified
    // из файлов роли (журнал пишется с самой первой записи).
    const startedAt = report?.openedWall
      ?? Math.min(...files.filter((f) => f.name === 'journal.jsonl').map((f) => f.lastModified), Infinity)
      ?? files[0]?.lastModified
      ?? null;
    // Duration: наибольшее mediaSec среди ролей — все роли пишутся одновременно, но при
    // разных audio-context'ах могут разойтись на десятки мс; берём максимум как «сколько шло».
    let durationSec = null;
    if (report?.roles) {
      for (const stats of Object.values(report.roles)) {
        const d = stats?.mediaSec;
        if (typeof d === 'number' && (durationSec == null || d > durationSec)) durationSec = d;
      }
    }
    if (durationSec == null && report?.openedWall && report?.stopWall) {
      durationSec = (report.stopWall - report.openedWall) / 1000;
    }
    const status = report?.final === true ? 'ok' : 'orphan';
    out.push({ sid, bytes, files, roleFiles, startedAt, durationSec, status, report });
  }

  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out;
}

function render(sessions) {
  const list = $('list');
  list.innerHTML = '';

  $('totalCount').textContent = sessions.length;
  $('totalSize').textContent = formatBytes(sessions.reduce((a, s) => a + s.bytes, 0));

  if (!sessions.length) { $('empty').hidden = false; return; }
  $('empty').hidden = true;

  for (const s of sessions) list.appendChild(renderSession(s));
}

function renderSession(s) {
  const el = document.createElement('div');
  el.className = 'session';

  const date = s.startedAt ? new Date(s.startedAt) : null;
  const dateStr = date ? formatDate(date) : '—';
  const duration = s.durationSec != null ? formatDuration(s.durationSec) : '—';
  const badge = s.status === 'ok'
    ? '<span class="pill ok">Завершена штатно</span>'
    : '<span class="pill orphan">Прервана без остановки</span>';

  el.innerHTML = `
    <div class="session-head">
      <div>
        <div class="session-date">${dateStr}${badge}</div>
        <div class="session-meta">Длительность: ${duration} · На диске: ${formatBytes(s.bytes)}</div>
      </div>
      <div class="session-id">${s.sid.slice(0, 8)}…</div>
    </div>
    <div class="roles"></div>
    <div class="session-actions">
      <button class="btn danger" data-action="delete">Удалить сессию</button>
    </div>
  `;

  const rolesEl = el.querySelector('.roles');
  if (!s.roleFiles.length) {
    rolesEl.innerHTML = '<div class="session-meta" style="padding:8px 4px">Файлов роли нет (только служебные).</div>';
  } else {
    for (const f of s.roleFiles) {
      const roleKey = f.name.replace(/\.(opus|webm)$/, '');
      const label = ROLE_LABEL[roleKey] ?? roleKey;
      const ext = f.name.match(/\.(opus|webm)$/)?.[1] ?? 'bin';
      const row = document.createElement('div');
      row.className = 'role-row';
      row.innerHTML = `
        <div class="role-name">${escapeHtml(label)}</div>
        <div class="role-size">${formatBytes(f.size)}</div>
        <div class="role-actions">
          <button class="btn" data-action="download" data-role="${escapeHtml(roleKey)}" data-file="${escapeHtml(f.name)}" data-ext="${ext}">Скачать</button>
        </div>
      `;
      rolesEl.appendChild(row);
    }
  }

  el.addEventListener('click', (e) => handleAction(e, s, el));
  return el;
}

async function handleAction(e, session, sessionEl) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'download') {
    const file = btn.dataset.file;
    const roleKey = btn.dataset.role;
    const ext = btn.dataset.ext;
    btn.disabled = true; btn.textContent = 'Скачивание…';
    try {
      await downloadFile(session.sid, file, roleKey, ext, session.startedAt);
      btn.textContent = 'Готово';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Скачать'; }, 1200);
    } catch (err) {
      showStatus(`Скачивание не удалось: ${err.message ?? err}`, 'error');
      btn.disabled = false; btn.textContent = 'Скачать';
    }
    return;
  }

  if (action === 'delete') {
    if (!confirm(`Удалить сессию от ${sessionEl.querySelector('.session-date').textContent.replace(/Завершена штатно|Прервана без остановки/, '').trim()}? Файлы нельзя будет восстановить.`)) return;
    btn.disabled = true; btn.textContent = 'Удаление…';
    try {
      await deleteSession(session.sid);
      sessionEl.remove();
      const remaining = document.querySelectorAll('#list .session').length;
      $('totalCount').textContent = remaining;
      if (!remaining) $('empty').hidden = false;
      showStatus('Сессия удалена.', 'ok');
      setTimeout(() => $('status').hidden = true, 2500);
    } catch (err) {
      showStatus(`Удаление не удалось: ${err.message ?? err}`, 'error');
      btn.disabled = false; btn.textContent = 'Удалить сессию';
    }
  }
}

async function downloadFile(sid, name, roleKey, ext, startedAt) {
  const root = await navigator.storage.getDirectory();
  const sessionsDir = await root.getDirectoryHandle('sessions');
  const dh = await sessionsDir.getDirectoryHandle(sid);
  const fh = await dh.getFileHandle(name);
  const file = await fh.getFile();

  const dateStr = startedAt ? new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-') : 'unknown';
  const roleSlug = ROLE_SLUG[roleKey] ?? roleKey;
  const filename = `IronMemo-${dateStr}-${roleSlug}.${ext}`;

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Оставляем URL живым 60с, чтобы browser dialog успел сохранить, потом освобождаем.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function deleteSession(sid) {
  const root = await navigator.storage.getDirectory();
  const sessionsDir = await root.getDirectoryHandle('sessions');
  await sessionsDir.removeEntry(sid, { recursive: true });
}

// ─────────────────────────────────────────────────────────── format helpers ──

function formatBytes(n) {
  if (!n) return '0 Б';
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} КБ`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} МБ`;
  return `${(mb / 1024).toFixed(2)} ГБ`;
}

function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h} ч ${String(m).padStart(2, '0')} мин ${String(ss).padStart(2, '0')} с`;
  if (m) return `${m} мин ${String(ss).padStart(2, '0')} с`;
  return `${ss} с`;
}

function formatDate(d) {
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ` ${kind}` : '');
  el.hidden = false;
}
