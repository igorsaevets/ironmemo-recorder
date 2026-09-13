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
//
// I4a (2026-09-13): "Transcribe with IronMemo" per session. The upload runs from THIS page
// (an extension tab) through src/ingest/controller.js — not from the service worker (5-min
// request cap) and not from the offscreen document (it is the recorder). Before the first
// upload ever a cloud disclosure is shown (ironmemo.ingestConsent.v1), then Chrome's own
// prompt for the optional host permission; both happen inside click handlers (user gesture).

import { loadSettings } from '../shared/settings-store.js';
import { getByPath } from '../shared/settings-schema.js';
import { IngestController } from '../ingest/controller.js';

const $ = (id) => document.getElementById(id);

const ROLES = ['compatibility_mix', 'local_mic', 'remote_tab']; // longest-first for prefix matching

const ROLE_LABEL = {
  local_mic: 'Microphone',
  remote_tab: 'Tab',
  compatibility_mix: 'Mix (mic+tab)',
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

let ingest = null;                 // IngestController, or null when upload.enabled is false
let settings = null;
let sessionsById = new Map();
let pendingConsentSession = null;  // the session whose Transcribe click opened the disclosure

boot().catch((e) => showStatus(`Failed to load the list: ${e?.message ?? e}`, 'error'));

async function boot() {
  $('refresh').addEventListener('click', () => refresh().catch((e) => showStatus(e.message, 'error')));
  settings = await loadSettings();
  if (getByPath(settings, 'upload.enabled') !== false) {
    try {
      ingest = await new IngestController({ settings }).init();
      ingest.subscribe((sid) => {
        const el = document.querySelector(`.session[data-sid="${cssEscape(sid)}"]`);
        const s = sessionsById.get(sid);
        if (el && s) renderIngest(el, s);
      });
      wireConsentDialog();
      window.addEventListener('pagehide', () => ingest?.releaseAllLeases());
      window.__ironmemoIngest = ingest; // test-bench hook (.claude/scripts/test_ingest.py)
    } catch (e) {
      console.error('[session-list] ingest unavailable', e);
      showStatus(`Transcription is unavailable on this page: ${e?.message ?? e}`, 'error');
      ingest = null;
    }
  }
  await refresh();
  if (ingest) ingest.resumeAll().catch((e) => console.warn('[session-list] resume failed', e));
}

async function refresh() {
  const sessions = await listSessions();
  sessionsById = new Map(sessions.map((s) => [s.sid, s]));
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
    let recovery = null;
    let journalFirstWall = null, journalLastWall = null, journalStoppedSeen = false;

    for await (const [name, fh] of dh.entries()) {
      if (fh.kind !== 'file') continue;
      const f = await fh.getFile();
      files.push({ name, size: f.size, lastModified: f.lastModified });

      if (name === 'capture-report.json') {
        try { report = JSON.parse(await f.text()); }
        catch (e) { console.warn('[session-list] capture-report parse failed', sid, e); }
      }
      if (name === 'recovery.json') {
        try { recovery = JSON.parse(await f.text()); }
        catch (e) { console.warn('[session-list] recovery.json parse failed', sid, e); }
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
        if (f.name === `${role}.opus` || f.name === `${role}.webm` || f.name === `${role}.wav`) { groups[role].ready.push(f); matched = true; break; }
        if (f.name === `${role}.recovered.opus` || f.name === `${role}.recovered.webm`) { groups[role].recovered.push(f); matched = true; break; }
        // MediaRecorder rolling_finalized: <role>.<seg>.<seq>.part
        // MediaRecorder continuous:       <role>.000.NNNNNN.part
        if (f.name.startsWith(`${role}.`) && f.name.endsWith('.part')) { groups[role].parts.push(f); matched = true; break; }
      }
      if (!matched && f.name !== 'capture-report.json' && f.name !== 'journal.jsonl' && f.name !== 'recovery.json') otherFiles.push(f);
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

    out.push({ sid, bytes, files, groups, otherFiles, startedAt, durationSec, status, engine, report, recovery });
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
  el.dataset.sid = s.sid;

  const date = s.startedAt ? new Date(s.startedAt) : null;
  const dateStr = date ? formatDate(date) : '—';
  const duration = s.durationSec != null ? formatDuration(s.durationSec) : '—';
  const badge = s.status === 'ok'
    ? '<span class="pill ok">Completed</span>'
    : '<span class="pill orphan">Interrupted without stop</span>';
  const engineTag = s.engine ? `<span class="tag">${escapeHtml(s.engine)}</span>` : '';

  el.innerHTML = `
    <div class="session-head">
      <div>
        <div class="session-date">${dateStr}${badge}${engineTag}</div>
        <div class="session-meta">Duration: ${duration} · On disk: ${formatBytes(s.bytes)}</div>
      </div>
      <div class="session-id">${s.sid.slice(0, 8)}…</div>
    </div>
    <div class="roles"></div>
    <div class="ingest" hidden></div>
    <div class="session-actions">
      <button class="btn danger" data-action="delete">Delete session</button>
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
    rolesEl.innerHTML = `<div class="session-meta" style="padding:8px 4px">No role files found. All files in the session: ${files || '(empty)'}.</div>`;
  }
  if (s.otherFiles.length) {
    const rest = s.otherFiles.map((f) => `${escapeHtml(f.name)} (${formatBytes(f.size)})`).join(', ');
    const note = document.createElement('div');
    note.className = 'session-meta';
    note.style.padding = '4px';
    note.textContent = `Other files: ${rest}`;
    rolesEl.appendChild(note);
  }

  if (ingest && anyRole) renderIngest(el, s);

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
    const ext = f.name.match(/\.(opus|webm|wav)$/)?.[1] ?? 'bin';
    row.innerHTML = `
      <div class="role-name">${escapeHtml(label)}</div>
      <div class="role-size">${formatBytes(f.size)}</div>
      <div class="role-actions">
        <button class="btn" data-action="download-file" data-role="${role}" data-file="${escapeHtml(f.name)}" data-ext="${ext}">Download</button>
      </div>
    `;
    return row;
  }

  if (g.recovered.length > 0) {
    const f = g.recovered[0];
    const ext = f.name.match(/\.(opus|webm)$/)?.[1] ?? 'opus';
    row.innerHTML = `
      <div class="role-name">${escapeHtml(label)} <span class="tag warn">recovered</span></div>
      <div class="role-size">${formatBytes(f.size)}</div>
      <div class="role-actions">
        <button class="btn" data-action="download-file" data-role="${role}" data-file="${escapeHtml(f.name)}" data-ext="${ext}">Download</button>
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
    ? ` <span class="tag warn">${segments.length} segments × download individually</span>`
    : '';
  const buttons = segments.map(([seg, parts]) => {
    const sz = parts.reduce((a, f) => a + f.size, 0);
    const suffix = segments.length > 1 ? ` #${seg}` : '';
    return `<button class="btn" data-action="download-parts" data-role="${role}" data-segment="${seg}">Download${suffix} (${formatBytes(sz)})</button>`;
  }).join(' ');
  row.innerHTML = `
    <div class="role-name">${escapeHtml(label)} <span class="tag warn">${g.parts.length} chunks</span>${segNote}</div>
    <div class="role-size">${formatBytes(totalBytes)}</div>
    <div class="role-actions">${buttons}</div>
  `;
  return row;
}

// ─────────────────────────────────────────────────── I4a: ingest block per session ──

const STATE_TEXT = {
  session: 'Connecting to IronMemo…',
  creating: 'Creating the recording on IronMemo…',
  finalizing: 'Finishing the upload…',
};

function renderIngest(el, s) {
  const box = el.querySelector('.ingest');
  if (!box || !ingest) return;
  const job = ingest.getJob(s.sid);
  const running = ingest.isRunning(s.sid);
  box.hidden = false;

  let status = '', cls = 'muted', hint = '', progress = null, buttons = [];
  const st = job?.state ?? null;

  if (!job || (st === 'cancelled' && !job.recordingId)) {
    status = 'Get a transcript from IronMemo.';
    hint = 'Sends this one recording to your IronMemo account. First 10 minutes free.';
    buttons.push(['transcribe', 'Transcribe with IronMemo', 'primary']);
  } else if (st === 'cancelled') {
    status = job.stateReason === 'local_deleted' ? 'Upload cancelled: the local files were deleted.' : 'Upload cancelled.';
    hint = job.recordingId ? `An empty recording may remain on IronMemo (id ${job.recordingId.slice(0, 8)}…).` : '';
    buttons.push(['transcribe', 'Transcribe again', '']);
  } else if (st === 'session' || st === 'creating' || st === 'finalizing') {
    status = STATE_TEXT[st];
    if (job.stateReason === 'workspace_wait') hint = 'IronMemo is preparing a workspace for your guest account — this can take a minute or two.';
    buttons.push(['ingest-cancel', 'Cancel', 'danger']);
  } else if (st === 'create_unknown') {
    cls = 'error';
    status = 'Could not confirm whether the recording was created on IronMemo.';
    hint = 'Retry checks the server for this recording before creating it again.';
    buttons.push(['ingest-retry', 'Retry', 'primary'], ['ingest-cancel', 'Cancel', 'danger']);
  } else if (st === 'uploading') {
    const total = job.asset?.bytes ?? 0;
    const sent = Math.min(total, job.bytesSent ?? 0);
    const pct = total ? Math.floor((sent / total) * 100) : 0;
    const done = (job.parts ?? []).filter((p) => p.etag).length;
    status = job.transport === 'multipart'
      ? `Uploading ${pct}% — part ${Math.min(done + 1, job.parts.length)} of ${job.parts.length}`
      : `Uploading ${pct}% (${formatBytes(sent)} of ${formatBytes(total)})`;
    progress = total ? sent / total : 0;
    hint = running ? 'Keep this tab open. If you close it, reopen Recordings to continue where it stopped.' : 'Not running in this tab.';
    if (running) buttons.push(['ingest-pause', 'Pause', '']);
    buttons.push(['ingest-cancel', 'Cancel', 'danger']);
  } else if (st === 'finalize_unknown') {
    cls = 'error';
    status = 'The upload finished but the confirmation was lost.';
    hint = 'Retry asks the server for the state before sending anything again.';
    buttons.push(['ingest-retry', 'Retry', 'primary']);
  } else if (st === 'processing') {
    const server = job.server?.status ?? 'queued';
    status = `Processing on IronMemo: ${server}…`;
    hint = running ? `Checked ${job.pollCount ?? 0} time(s). You can close this tab; the result is fetched when you come back.` : 'Not being checked in this tab.';
    if (!running) buttons.push(['ingest-resume', 'Check status', '']);
  } else if (st === 'completed') {
    cls = 'ok';
    const dur = job.server?.duration_seconds;
    status = `✓ Transcribed on IronMemo${Number.isFinite(dur) ? ` — ${formatDuration(dur)}` : ''}`;
    const cap = job.server?.free_cap;
    if (cap?.applied) {
      hint = `Free cap applied: the first ${formatDuration(cap.cap_seconds ?? 0)} of ${formatDuration(cap.original_duration_seconds ?? 0)} were transcribed. The whole file is kept on the server; unlocking the rest needs an IronMemo account with credits.`;
    } else {
      hint = 'The transcript view and download come in the next version (I4b).';
    }
    if (job.meetingPage) {
      hint += ` <a href="${escapeHtml(job.meetingPage)}" target="_blank" rel="noopener">Open on IronMemo</a> (the website asks you to sign in — attach your e-mail to this guest account first, coming in I4b).`;
    }
  } else if (st === 'error') {
    cls = 'error';
    status = `Failed: ${humanReason(job)}`;
    hint = job.stateReason === 'auth_lost'
      ? 'The saved guest session is no longer valid. Retry starts a NEW guest session; earlier uploads stay under the old one.'
      : (job.lastError?.message ? escapeHtml(job.lastError.message) : '');
    if (!['too_large', 'unsupported', 'no_mix', 'multi_segment', 'no_file', 'recovered_invalid', 'payment', 'insufficient_credits'].includes(job.stateReason)) {
      buttons.push(['ingest-retry', 'Retry', 'primary']);
    }
    buttons.push(['ingest-cancel', 'Dismiss', 'danger']);
  } else if (st === 'paused') {
    cls = 'muted';
    status = {
      permission_revoked: 'Paused: access to app.ironmemo.com was revoked. Nothing more is sent until you allow it again.',
      permission_missing: 'Paused: the extension has no access to app.ironmemo.com yet.',
      consent_missing: 'Paused: cloud processing has not been accepted.',
      user: 'Paused by you.',
    }[job.stateReason] ?? `Paused (${job.stateReason ?? 'unknown'}).`;
    hint = 'Local files are untouched. Resume continues from the last confirmed part.';
    buttons.push(['ingest-resume', 'Resume', 'primary'], ['ingest-cancel', 'Cancel', 'danger']);
  } else {
    status = `State: ${st}`;
  }

  const btnHtml = buttons.map(([action, label, k]) =>
    `<button class="btn ${k}" data-action="${action}">${escapeHtml(label)}</button>`).join('');
  box.innerHTML = `
    <div class="ingest-row">
      <div class="ingest-status ${cls}">${status}</div>
      <div class="ingest-actions">${btnHtml}</div>
    </div>
    ${progress != null ? `<div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>` : ''}
    ${hint ? `<div class="ingest-hint">${hint}</div>` : ''}
  `;
}

function humanReason(job) {
  const r = job.stateReason;
  const map = {
    auth_lost: 'the IronMemo session is no longer valid',
    payment: 'IronMemo needs credits for this recording',
    insufficient_credits: 'not enough credits on the IronMemo account',
    too_large: 'the file is too large for the server',
    unsupported: 'the server does not accept this file type',
    no_mix: 'no mix file to send',
    multi_segment: 'segmented recording cannot be sent as one file',
    no_file: 'no audio file in this recording',
    unverified: 'the interrupted recording has not been verified',
    recovered_invalid: 'the recovered file does not decode',
    asset_changed: 'the local file changed',
    transport: 'no answer from the server',
    server: 'server error',
    storage_forbidden: 'the storage refused the upload link',
    origin: 'storage origin not allowed',
    rate_limited: 'too many requests — try later',
    server_error: 'IronMemo could not process the recording',
    server_deleted: 'the recording was deleted on IronMemo',
  };
  return map[r] ?? (r ? String(r).replace(/_/g, ' ') : 'unknown error');
}

// ── consent dialog ──

function wireConsentDialog() {
  const agree = $('cloudConsentAgree');
  const cont = $('cloudConsentContinue');
  agree.addEventListener('change', () => { cont.disabled = !agree.checked; });
  $('cloudConsentCancel').addEventListener('click', () => { hideConsent(); pendingConsentSession = null; });
  cont.addEventListener('click', async () => {
    // The permission request MUST be the first thing in the handler: Chrome only honours it
    // inside a user gesture. Consent is recorded while the prompt is on screen.
    const permission = ingest.requestPermission();
    cont.disabled = true;
    try {
      await ingest.recordConsent();
      const granted = await permission;
      hideConsent();
      const s = pendingConsentSession; pendingConsentSession = null;
      if (!granted) { showStatus('Access to app.ironmemo.com was not granted — nothing was sent. Click Transcribe again to retry.', 'error'); if (s) rerender(s.sid); return; }
      if (s) await startIngest(s);
    } catch (e) {
      hideConsent();
      showStatus(`Could not start: ${e?.message ?? e}`, 'error');
    } finally { cont.disabled = false; agree.checked = false; }
  });
}

function showConsent(session) {
  pendingConsentSession = session;
  $('cloudConsentAgree').checked = false;
  $('cloudConsentContinue').disabled = true;
  $('cloudConsent').hidden = false;
}
function hideConsent() { $('cloudConsent').hidden = true; }

async function onTranscribeClick(session) {
  if (!ingest) return;
  if (!ingest.hasConsent()) { showConsent(session); return; }
  const granted = await ingest.requestPermission(); // first await → still inside the gesture
  if (!granted) { showStatus('Access to app.ironmemo.com was not granted — nothing was sent.', 'error'); return; }
  await startIngest(session);
}

async function startIngest(session) {
  try {
    $('status').hidden = true;
    await ingest.start(session);
  } catch (e) {
    showStatus(`Cannot send this recording: ${e?.message ?? e}`, 'error');
  }
  rerender(session.sid);
}

function rerender(sid) {
  const el = document.querySelector(`.session[data-sid="${cssEscape(sid)}"]`);
  const s = sessionsById.get(sid);
  if (el && s) renderIngest(el, s);
}

async function handleAction(e, session, sessionEl) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'transcribe') { await onTranscribeClick(session); return; }
  if (action === 'ingest-resume' || action === 'ingest-retry') {
    if (!ingest) return;
    const granted = await ingest.requestPermission(); // sync call inside the click → user gesture
    if (!granted) { showStatus('Access to app.ironmemo.com was not granted.', 'error'); return; }
    try { await ingest.resume(session.sid); } catch (err) { showStatus(err?.message ?? String(err), 'error'); }
    rerender(session.sid);
    return;
  }
  if (action === 'ingest-pause') { if (ingest) await ingest.pause(session.sid, 'user'); rerender(session.sid); return; }
  if (action === 'ingest-cancel') {
    if (!ingest) return;
    const job = ingest.getJob(session.sid);
    if (job && !['error', 'create_unknown', 'finalize_unknown'].includes(job.state) && !confirm('Cancel the upload to IronMemo? Local files stay.')) return;
    await ingest.cancel(session.sid);
    rerender(session.sid);
    return;
  }

  if (action === 'download-file') {
    const file = btn.dataset.file;
    const roleKey = btn.dataset.role;
    const ext = btn.dataset.ext;
    btn.disabled = true; btn.textContent = 'Downloading…';
    try {
      await downloadFile(session.sid, file, roleKey, ext, session.startedAt);
      btn.textContent = 'Done';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Download'; }, 1200);
    } catch (err) {
      showStatus(`Download failed: ${err.message ?? err}`, 'error');
      btn.disabled = false; btn.textContent = 'Download';
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
    btn.disabled = true; btn.textContent = 'Assembling…';
    try {
      await downloadParts(session.sid, roleKey, segment, parts, session.startedAt);
      btn.textContent = 'Done';
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1200);
    } catch (err) {
      showStatus(`Assembly failed: ${err.message ?? err}`, 'error');
      btn.disabled = false; btn.textContent = original;
    }
    return;
  }

  if (action === 'delete') {
    const job = ingest?.getJob(session.sid);
    const active = job && (ingest.isRunning(session.sid) || ['session', 'creating', 'uploading', 'finalizing', 'finalize_unknown', 'processing', 'paused', 'create_unknown'].includes(job.state));
    const question = active
      ? 'An upload to IronMemo is in progress for this recording. Deleting stops it and cannot be undone. Continue?'
      : `Delete session from ${sessionEl.querySelector('.session-date').textContent.replace(/Completed|Interrupted without stop/, '').trim()}? Files cannot be recovered.`;
    if (!confirm(question)) return;
    btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      if (ingest) await ingest.onSessionDeleted(session.sid); // stop + tombstone BEFORE the directory goes
      await deleteSession(session.sid);
      sessionEl.remove();
      sessionsById.delete(session.sid);
      const remaining = document.querySelectorAll('#list .session').length;
      $('totalCount').textContent = remaining;
      if (!remaining) $('empty').hidden = false;
      showStatus('Session deleted.', 'ok');
      setTimeout(() => $('status').hidden = true, 2500);
    } catch (err) {
      showStatus(`Delete failed: ${err.message ?? err}`, 'error');
      btn.disabled = false; btn.textContent = 'Delete session';
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
  if (!n) return '0 B';
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} m ${String(ss).padStart(2, '0')} s`;
  if (m) return `${m} m ${String(ss).padStart(2, '0')} s`;
  return `${ss} s`;
}

function formatDate(d) {
  return d.toLocaleString('en-US', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function showStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ` ${kind}` : '');
  el.hidden = false;
}
