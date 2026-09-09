// Session list: reads OPFS directly (SW is ephemeral, no round-trip needed).
// Downloads via <a download> — DOM standard, no chrome.downloads permission needed.
// Delete via removeEntry({recursive:true}).
//
// v0.3.1 (2026-09-09): defensive filename detection.
// v0.3.0 shipped with regex /\.(opus|webm)$/ that missed two engines:
//   - MediaRecorder fallback → <role>.NNN.NNNNNN.part (rolling_finalized chunks)
//   - Recovery finalize     → <role>.recovered.opus
// Both are legitimate outputs; the user cannot tell which one their Chrome ran.
// Now: prefer ready file → recovered file → concatenated parts.

const $ = (id) => document.getElementById(id);

const ROLES = ['compatibility_mix', 'local_mic', 'remote_tab']; // longest-first for prefix matching

const ROLE_LABEL = {
  local_mic: 'Микрофон',
  remote_tab: 'Вкладка',
  compatibility_mix: 'Микс (mic+tab)',
};

// Latin slug in downloaded filenames. Cyrillic in Windows Downloads
// filenames gives unpredictable behavior (CLAUDE.md rule).
const ROLE_SLUG = {
  local_mic: 'mic',
  remote_tab: 'tab',
  compatibility_mix: 'mix',
};

// Opus @ 48 kbps ≈ 6 kB/s per role → used only as a last-resort duration fallback.
const BYTES_PER_SEC_PER_ROLE = 6000;

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
    let journalFirstWall = null, journalLastWall = null, journalStoppedSeen = false;

    for await (const [name, fh] of dh.entries()) {
      if (fh.kind !== 'file') continue;
      const f = await fh.getFile();
      files.push({ name, size: f.size, lastModified: f.lastModified });

      if (name === 'capture-report.json') {
        try { report = JSON.parse(await f.text()); }
        catch (e) { console.warn('[session-list] capture-report parse failed', sid, e); }
      }
      if (name === 'journal.jsonl') {
        // Journal schema dualism: WebCodecs worker writes {t, wall, ...};
        // MediaRecorder path writes {event, at, startWall, ...}. Both must be read.
        try {
          const text = await f.text();
          const lines = text.split('\n').filter(Boolean);
          const wallOf = (j) => j.wall ?? j.at ?? j.startWall ?? null;
          const isStop = (j) => j.t === 'session_stopped' || j.event === 'session_stopped';
          if (lines.length > 0) {
            try { journalFirstWall = wallOf(JSON.parse(lines[0])); } catch {}
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const j = JSON.parse(lines[i]);
                if (journalLastWall == null) journalLastWall = wallOf(j);
                if (isStop(j)) journalStoppedSeen = true;
                if (journalLastWall != null && journalStoppedSeen) break;
              } catch {}
            }
          }
        } catch (e) { console.warn('[session-list] journal read failed', sid, e); }
      }
    }

    // Group files by role, by kind
    const groups = Object.fromEntries(ROLES.map((r) => [r, { ready: [], recovered: [], parts: [] }]));
    const otherFiles = [];
    for (const f of files) {
      let matched = false;
      for (const role of ROLES) {
        if (f.name === `${role}.opus` || f.name === `${role}.webm`) { groups[role].ready.push(f); matched = true; break; }
        if (f.name === `${role}.recovered.opus` || f.name === `${role}.recovered.webm`) { groups[role].recovered.push(f); matched = true; break; }
        // MediaRecorder rolling_finalized: <role>.<seg>.<seq>.part
        // MediaRecorder continuous:       <role>.000.NNNNNN.part
        if (f.name.startsWith(`${role}.`) && f.name.endsWith('.part')) { groups[role].parts.push(f); matched = true; break; }
      }
      if (!matched && f.name !== 'capture-report.json' && f.name !== 'journal.jsonl') otherFiles.push(f);
    }

    // Sort .part chunks by segment/seq
    for (const role of ROLES) {
      groups[role].parts.sort((a, b) => a.name.localeCompare(b.name));
    }

    const bytes = files.reduce((a, f) => a + f.size, 0);

    // startedAt: report.timeline.t0Wall (v2 report) → journal first line wall → earliest file mtime
    const startedAt = report?.timeline?.t0Wall
      ?? report?.openedWall    // legacy field, in case some old report has it
      ?? journalFirstWall
      ?? Math.min(...files.map((f) => f.lastModified).filter(Number.isFinite))
      ?? null;

    // durationSec (in priority order):
    // 1) report.roles[*].mediaSec (max across roles) — best, comes from encoder frames
    // 2) journal last-line wall − first-line wall
    // 3) (max file mtime − startedAt) / 1000
    // 4) bytes / (BYTES_PER_SEC_PER_ROLE × numRolesWithData) — very rough
    let durationSec = null;
    if (report?.roles) {
      for (const stats of Object.values(report.roles)) {
        const d = stats?.mediaSec;
        if (typeof d === 'number' && (durationSec == null || d > durationSec)) durationSec = d;
      }
    }
    if (durationSec == null && journalFirstWall != null && journalLastWall != null && journalLastWall > journalFirstWall) {
      durationSec = (journalLastWall - journalFirstWall) / 1000;
    }
    if (durationSec == null && startedAt != null) {
      const lastMtime = Math.max(...files.map((f) => f.lastModified).filter(Number.isFinite));
      if (Number.isFinite(lastMtime) && lastMtime > startedAt) durationSec = (lastMtime - startedAt) / 1000;
    }
    if (durationSec == null) {
      const rolesWithData = ROLES.filter((r) =>
        groups[r].ready.length + groups[r].recovered.length + groups[r].parts.length > 0
      ).length;
      if (rolesWithData > 0) durationSec = bytes / (BYTES_PER_SEC_PER_ROLE * rolesWithData);
    }

    // Status: capture-report.final:true → штатно, else журнал session_stopped → штатно, else orphan
    const status = (report?.final === true || journalStoppedSeen) ? 'ok' : 'orphan';

    const engine = report?.engine ?? null;

    out.push({ sid, bytes, files, groups, otherFiles, startedAt, durationSec, status, engine, report });
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
  const engineTag = s.engine ? `<span class="tag">${escapeHtml(s.engine)}</span>` : '';

  el.innerHTML = `
    <div class="session-head">
      <div>
        <div class="session-date">${dateStr}${badge}${engineTag}</div>
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
  let anyRole = false;
  for (const role of ROLES) {
    const g = s.groups[role];
    const row = renderRoleRow(role, g);
    if (row) { rolesEl.appendChild(row); anyRole = true; }
  }
  if (!anyRole) {
    const files = s.files.map((f) => `${escapeHtml(f.name)} (${formatBytes(f.size)})`).join(', ');
    rolesEl.innerHTML = `<div class="session-meta" style="padding:8px 4px">Роль-файлы не найдены. Все файлы в сессии: ${files || '(пусто)'}.</div>`;
  }
  if (s.otherFiles.length) {
    const rest = s.otherFiles.map((f) => `${escapeHtml(f.name)} (${formatBytes(f.size)})`).join(', ');
    const note = document.createElement('div');
    note.className = 'session-meta';
    note.style.padding = '4px';
    note.textContent = `Прочие файлы: ${rest}`;
    rolesEl.appendChild(note);
  }

  el.addEventListener('click', (e) => handleAction(e, s, el));
  return el;
}

/**
 * One row per role. Priority for the download:
 *   1. `<role>.opus` / `<role>.webm` — normal
 *   2. `<role>.recovered.opus` — after recovery
 *   3. concatenated `.part` chunks — MediaRecorder fallback, best-effort
 */
function renderRoleRow(role, g) {
  const label = ROLE_LABEL[role] ?? role;
  if (g.ready.length === 0 && g.recovered.length === 0 && g.parts.length === 0) return null;

  const row = document.createElement('div');
  row.className = 'role-row';

  if (g.ready.length > 0) {
    const f = g.ready[0];
    const ext = f.name.match(/\.(opus|webm)$/)?.[1] ?? 'bin';
    row.innerHTML = `
      <div class="role-name">${escapeHtml(label)}</div>
      <div class="role-size">${formatBytes(f.size)}</div>
      <div class="role-actions">
        <button class="btn" data-action="download-file" data-role="${role}" data-file="${escapeHtml(f.name)}" data-ext="${ext}">Скачать</button>
      </div>
    `;
    return row;
  }

  if (g.recovered.length > 0) {
    const f = g.recovered[0];
    const ext = f.name.match(/\.(opus|webm)$/)?.[1] ?? 'opus';
    row.innerHTML = `
      <div class="role-name">${escapeHtml(label)} <span class="tag warn">восстановлено</span></div>
      <div class="role-size">${formatBytes(f.size)}</div>
      <div class="role-actions">
        <button class="btn" data-action="download-file" data-role="${role}" data-file="${escapeHtml(f.name)}" data-ext="${ext}">Скачать</button>
      </div>
    `;
    return row;
  }

  // .part chunks — MediaRecorder path. Each `rolling_finalized` segment starts a NEW
  // MediaRecorder → NEW EBML header, so cross-segment byte-concat = doubled headers
  // (players do NOT reliably tolerate this). Group by segment (`<role>.<seg>.<seq>.part`),
  // one download per segment. `continuous` writes a single segment → one download.
  const bySegment = new Map();
  for (const p of g.parts) {
    const m = p.name.match(/\.(\d{3})\.\d{6}\.part$/);
    const seg = m ? m[1] : '000';
    if (!bySegment.has(seg)) bySegment.set(seg, []);
    bySegment.get(seg).push(p);
  }
  const segments = [...bySegment.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalBytes = g.parts.reduce((a, f) => a + f.size, 0);
  const segNote = segments.length > 1
    ? ` <span class="tag warn">${segments.length} сегм. × скачать по одному</span>`
    : '';
  const buttons = segments.map(([seg, parts]) => {
    const sz = parts.reduce((a, f) => a + f.size, 0);
    const suffix = segments.length > 1 ? ` #${seg}` : '';
    return `<button class="btn" data-action="download-parts" data-role="${role}" data-segment="${seg}">Скачать${suffix} (${formatBytes(sz)})</button>`;
  }).join(' ');
  row.innerHTML = `
    <div class="role-name">${escapeHtml(label)} <span class="tag warn">${g.parts.length} фраг.</span>${segNote}</div>
    <div class="role-size">${formatBytes(totalBytes)}</div>
    <div class="role-actions">${buttons}</div>
  `;
  return row;
}

async function handleAction(e, session, sessionEl) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'download-file') {
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

  if (action === 'download-parts') {
    const roleKey = btn.dataset.role;
    const segment = btn.dataset.segment;
    const parts = session.groups[roleKey].parts.filter((p) => {
      const m = p.name.match(/\.(\d{3})\.\d{6}\.part$/);
      return (m ? m[1] : '000') === segment;
    });
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Сборка…';
    try {
      await downloadParts(session.sid, roleKey, segment, parts, session.startedAt);
      btn.textContent = 'Готово';
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1200);
    } catch (err) {
      showStatus(`Сборка не удалась: ${err.message ?? err}`, 'error');
      btn.disabled = false; btn.textContent = original;
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
  const suffix = name.includes('.recovered.') ? '-recovered' : '';
  const filename = `IronMemo-${dateStr}-${roleSlug}${suffix}.${ext}`;

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadParts(sid, roleKey, segment, parts, startedAt) {
  const root = await navigator.storage.getDirectory();
  const sessionsDir = await root.getDirectoryHandle('sessions');
  const dh = await sessionsDir.getDirectoryHandle(sid);

  // Parts within one segment concatenate to a valid WebM (single EBML header
  // in the first timeslice; subsequent chunks are continuation clusters).
  const ordered = [...parts].sort((a, b) => a.name.localeCompare(b.name));
  const blobs = [];
  for (const p of ordered) {
    const fh = await dh.getFileHandle(p.name);
    const f = await fh.getFile();
    blobs.push(f);
  }
  const combined = new Blob(blobs, { type: 'audio/webm' });

  const dateStr = startedAt ? new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-') : 'unknown';
  const roleSlug = ROLE_SLUG[roleKey] ?? roleKey;
  const segSuffix = segment && segment !== '000' ? `-seg${segment}` : '';
  const filename = `IronMemo-${dateStr}-${roleSlug}${segSuffix}.webm`;

  const url = URL.createObjectURL(combined);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
