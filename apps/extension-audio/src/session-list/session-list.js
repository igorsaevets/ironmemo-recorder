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
import { IngestController, waitingSince } from '../ingest/controller.js';
import { FILES, isTranscriptFile, formatStamp } from '../ingest/transcript.js';
import { S, reasonText } from '../shared/strings.js';
import { isPlausibleEmail } from '../ingest/claim.js';
import { buildDiagnostics } from '../ingest/diag.js';
import { demuxOggOpus, opusPacketSamples, OggOpusMuxer } from '../shared/ogg-opus.js';

const $ = (id) => document.getElementById(id);

const CAPTURE_STATE_KEY = 'ironmemo.captureState.v1';
let captureState = { status: 'idle', sessionId: null };

async function isCaptureActive(sid) {
  const fresh = (await chrome.storage.local.get(CAPTURE_STATE_KEY))[CAPTURE_STATE_KEY] ?? { status: 'idle', sessionId: null };
  return fresh.sessionId === sid && (fresh.status === 'recording' || fresh.status === 'paused');
}

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
let accountState = { hasAccount: false, kind: null, lost: null, emailMasked: null }; // mirrors ingest.accountStatus() for rendering
let activePlayer = null;           // UF3: { audio, blobUrl, sid, role, el, seeking, fileName }
let playSeq = 0;                   // monotonic counter — guards against rapid-click races in startPlayback
let trimState = null;              // UF4: { startSec, endSec, previewing }

boot().catch((e) => showStatus(`Failed to load the list: ${e?.message ?? e}`, 'error'));

async function boot() {
  $('refresh').addEventListener('click', () => refresh().catch((e) => showStatus(e.message, 'error')));
  const stored = await chrome.storage.local.get(CAPTURE_STATE_KEY);
  captureState = stored[CAPTURE_STATE_KEY] ?? { status: 'idle', sessionId: null };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[CAPTURE_STATE_KEY]) {
      const prev = captureState;
      captureState = changes[CAPTURE_STATE_KEY].newValue ?? { status: 'idle', sessionId: null };
      if (captureState.status !== prev.status || captureState.sessionId !== prev.sessionId) {
        refresh().catch((e) => showStatus(e.message, 'error'));
      }
    }
  });
  settings = await loadSettings();
  if (getByPath(settings, 'upload.enabled') !== false) {
    try {
      ingest = await new IngestController({ settings }).init();
      ingest.subscribe((sid) => {
        if (sid === '__account') { renderAccount().then(rerenderAll).catch((e) => console.warn('[session-list] account bar', e)); return; }
        const el = document.querySelector(`.session[data-sid="${cssEscape(sid)}"]`);
        const s = sessionsById.get(sid);
        if (el && s) renderIngest(el, s);
      });
      wireConsentDialog();
      wireClaimDialog();
      window.addEventListener('pagehide', () => ingest?.releaseAllLeases());
      window.__ironmemoIngest = ingest; // test-bench hook (.claude/scripts/test_ingest.py)
    } catch (e) {
      console.error('[session-list] ingest unavailable', e);
      showStatus(`Transcription is unavailable on this page: ${e?.message ?? e}`, 'error');
      ingest = null;
    }
  }
  window.addEventListener('pagehide', () => stopPlayback());
  $('copyDiag').addEventListener('click', () => copyDiagnostics());
  await renderAccount(); // before the list: the waiting-long hint reads accountState
  await refresh();
  focusHashSession(); // I4b task 4: the popup's line opens this page on #sid=<session>
  if (ingest) ingest.resumeAll().catch((e) => console.warn('[session-list] resume failed', e));
}

async function refresh() {
  stopPlayback();
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
    let meta = null;
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
      if (name === 'meta.json') {
        try { meta = JSON.parse(await f.text()); }
        catch (e) { console.warn('[session-list] meta.json parse failed', sid, e); }
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
      if (!matched && f.name !== 'capture-report.json' && f.name !== 'journal.jsonl' && f.name !== 'recovery.json' && f.name !== 'meta.json' && !isTranscriptFile(f.name)) otherFiles.push(f);
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

    // Active capture overrides file-based status — without this, a live recording shows "Interrupted"
    let status;
    if (captureState.sessionId === sid && (captureState.status === 'recording' || captureState.status === 'paused')) {
      status = captureState.status;
    } else {
      status = (report?.final === true || journalStoppedSeen) ? 'ok' : 'orphan';
    }

    const engine = report?.engine ?? null;

    out.push({ sid, bytes, files, groups, otherFiles, transcriptFiles: files.filter((f) => isTranscriptFile(f.name)), startedAt, durationSec, status, engine, report, recovery, displayName: meta?.displayName || null });
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
  const isCapturing = s.status === 'recording' || s.status === 'paused';
  const badge = s.status === 'ok'
    ? '<span class="pill ok">Completed</span>'
    : s.status === 'recording'
    ? `<span class="pill recording">${escapeHtml(S.badgeRecording)}</span>`
    : s.status === 'paused'
    ? `<span class="pill paused">${escapeHtml(S.badgePaused)}</span>`
    : '<span class="pill orphan">Interrupted without stop</span>';
  const engineTag = s.engine ? `<span class="tag">${escapeHtml(s.engine)}</span>` : '';
  const hasName = !!s.displayName;

  el.innerHTML = `
    <div class="session-head">
      <div>
        <div class="session-title-row">
          ${hasName ? `<span class="session-title">${escapeHtml(s.displayName)}</span>` : `<span class="session-date">${dateStr}</span>`}
          ${badge}${engineTag}
          <button class="btn ghost rename-btn" data-action="rename" title="${escapeHtml(S.btnRename)}">${escapeHtml(S.btnRename)}</button>
        </div>
        ${hasName ? `<div class="session-date secondary">${dateStr}</div>` : ''}
        <div class="session-meta">Duration: ${duration} · On disk: ${formatBytes(s.bytes)}</div>
      </div>
      <div class="session-id">${s.sid.slice(0, 8)}…</div>
    </div>
    <div class="roles"></div>
    <div class="player-bar" hidden></div>
    <div class="trim-bar" hidden></div>
    <div class="ingest" hidden></div>
    <div class="session-actions">
      ${isCapturing ? '' : '<button class="btn danger" data-action="delete">Delete session</button>'}
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
        ${f.size > 0 ? `<button class="btn" data-action="play" data-role="${role}" data-file="${escapeHtml(f.name)}" aria-label="${escapeHtml(S.btnPlay)} ${escapeHtml(label)}">${escapeHtml(S.btnPlay)}</button>` : ''}
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
        ${f.size > 0 ? `<button class="btn" data-action="play" data-role="${role}" data-file="${escapeHtml(f.name)}" aria-label="${escapeHtml(S.btnPlay)} ${escapeHtml(label)}">${escapeHtml(S.btnPlay)}</button>` : ''}
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

const PREVIEW_LINES = 20;
const NO_RETRY = ['too_large', 'too_long', 'unsupported', 'no_mix', 'multi_segment', 'no_file', 'recovered_invalid', 'payment', 'insufficient_credits'];
const expandedSids = new Set();               // transcript panels the user expanded ("Show all")
const transcriptTextCache = new Map();        // sid → {sha, body: string[]} (transcript.txt minus the header)

function renderIngest(el, s) {
  const box = el.querySelector('.ingest');
  if (!box || !ingest) return;
  const job = ingest.getJob(s.sid);
  const running = ingest.isRunning(s.sid);
  box.hidden = false;

  let status = '', cls = 'muted', hint = '', progress = null, panel = false;
  const buttons = [], banners = [];
  const st = job?.state ?? null;
  const id8 = job?.recordingId ? job.recordingId.slice(0, 8) : '';

  const sessionCapturing = s.status === 'recording' || s.status === 'paused';
  if (!job || (st === 'cancelled' && !job.recordingId)) {
    status = S.idleStatus; hint = escapeHtml(S.idleHint);
    if (!sessionCapturing) buttons.push(['transcribe', S.btnTranscribe, 'primary']);
  } else if (st === 'cancelled') {
    status = job.stateReason === 'local_deleted' ? S.cancelledLocalDeleted : S.cancelled;
    hint = escapeHtml(S.cancelledServerRemain(id8));
    if (!sessionCapturing) buttons.push(['transcribe', S.btnTranscribeAgain, '']);
  } else if (st === 'session' || st === 'creating' || st === 'finalizing') {
    status = S.stateText[st];
    if (job.stateReason === 'workspace_wait') hint = escapeHtml(S.workspaceWait);
    buttons.push(['ingest-cancel', S.btnCancel, 'danger']);
  } else if (st === 'create_unknown') {
    cls = 'error'; status = S.createUnknown; hint = escapeHtml(S.createUnknownHint);
    buttons.push(['ingest-retry', S.btnRetry, 'primary'], ['ingest-cancel', S.btnCancel, 'danger']);
  } else if (st === 'uploading') {
    const total = job.asset?.bytes ?? 0;
    const sent = Math.min(total, job.bytesSent ?? 0);
    const pct = total ? Math.floor((sent / total) * 100) : 0;
    const done = (job.parts ?? []).filter((p) => p.etag).length;
    status = job.transport === 'multipart'
      ? S.uploadingMultipart(pct, Math.min(done + 1, job.parts.length), job.parts.length)
      : S.uploadingSingle(pct, formatBytes(sent), formatBytes(total));
    progress = total ? sent / total : 0;
    hint = escapeHtml(running ? S.uploadingHintRunning : S.uploadingHintIdle);
    if (running) buttons.push(['ingest-pause', S.btnPause, '']);
    buttons.push(['ingest-cancel', S.btnCancel, 'danger']);
  } else if (st === 'finalize_unknown') {
    cls = 'error'; status = S.finalizeUnknown; hint = escapeHtml(S.finalizeUnknownHint);
    buttons.push(['ingest-retry', S.btnRetry, 'primary']);
  } else if (st === 'processing') {
    const server = job.server?.status ?? 'queued';
    const since = waitingSince(job);
    if (since) {
      // Measured 2026-09-13: `queued` for 3 hours with no error on any route (RESULT I4a §4.3/§4.4).
      cls = 'warn';
      status = S.waitingLong(formatClock(since));
      hint = `${escapeHtml(S.waitingLongHint(Math.round((Date.now() - since) / 60000), server))} ${escapeHtml(S.waitingLongKeep(accountState.kind === 'user'))}`;
      buttons.push(['check-now', S.btnCheckNow, '']);
    } else {
      status = S.processing(server);
      hint = escapeHtml(running ? S.processingHint(job.pollCount ?? 0) : S.processingHintIdle);
      if (!running) buttons.push(['ingest-resume', S.btnCheckStatus, '']);
    }
  } else if (st === 'completed') {
    cls = 'ok';
    const dur = job.server?.duration_seconds;
    status = S.completed(Number.isFinite(dur) ? formatDuration(dur) : null);
    const cap = job.server?.free_cap;
    if (cap?.applied) banners.push(['warn', capBannerHtml(cap, job)]);
    if (job.server?.mic_skipped_insufficient_credits) banners.push(['warn', escapeHtml(S.summarySkipped)]);
    if (job.serverDeleted) banners.push(['muted', escapeHtml(S.serverDeleted)]);
    else if (job.authLost) banners.push(['error', escapeHtml(job.authLost.reason === 'signed_out' ? S.completedSignedOut : S.completedAuthLost)]);
    const t = job.transcript;
    if (!t || t.state === 'pending') hint = escapeHtml(S.transcriptFetching);
    else if (t.state === 'error') {
      hint = escapeHtml(S.transcriptError(reasonText(t.lastError)));
      if (!job.serverDeleted && !job.authLost) buttons.push(['fetch-transcript', S.btnFetchTranscript, 'primary']);
    } else panel = true;
    if (job.meetingPage && !job.serverDeleted) {
      hint += ` <a href="${escapeHtml(job.meetingPage)}" target="_blank" rel="noopener">${escapeHtml(S.openOnIronMemo)}</a> ${escapeHtml(S.openCaveat)}`;
    }
    if (job.recordingId && !job.serverDeleted && !job.authLost && !running) buttons.push(['delete-server', S.btnDeleteServer, 'danger']);
    if (job.serverDeleted && !sessionCapturing) buttons.push(['transcribe', S.btnTranscribeAgain, '']);
  } else if (st === 'error') {
    cls = 'error';
    const r = job.stateReason;
    if (r === 'insufficient_credits' || r === 'payment') {
      status = S.needsCredits; hint = escapeHtml(S.needsCreditsHint);
      if (job.meetingPage) buttons.push(['open-link', S.btnOpenIronMemo, 'primary', job.meetingPage]);
    } else if (r === 'transport') {
      status = S.networkError; hint = escapeHtml(S.networkErrorHint);
      buttons.push(['ingest-retry', S.btnRetry, 'primary']);
    } else if (r === 'too_large' || r === 'too_long') {
      status = S.tooLarge; hint = escapeHtml(job.lastError?.message ?? '');
    } else if (r === 'auth_lost') {
      status = S.lostSession; hint = escapeHtml(S.lostSessionHint(ingest.authMode === 'email'));
      buttons.push(['ingest-retry', S.btnReconnect, 'primary']);
    } else {
      status = S.failed(reasonText(r));
      hint = job.lastError?.message ? escapeHtml(job.lastError.message) : '';
      if (!NO_RETRY.includes(r)) buttons.push(['ingest-retry', S.btnRetry, 'primary']);
    }
    buttons.push(['ingest-cancel', S.btnDismiss, 'danger']);
  } else if (st === 'paused') {
    cls = 'muted';
    status = S.paused[job.stateReason] ?? S.pausedOther(job.stateReason);
    hint = escapeHtml(S.pausedHint);
    if (job.stateReason === 'email_required' || job.stateReason === 'signed_out') buttons.push(['claim-open', job.stateReason === 'signed_out' ? S.account.btnReconnect : S.account.btnAddEmail, 'primary']);
    else buttons.push(['ingest-resume', S.btnResume, 'primary']);
    buttons.push(['ingest-cancel', S.btnCancel, 'danger']);
  } else {
    status = `State: ${st}`;
  }

  const btnHtml = buttons.map(([action, label, k, href]) => (href
    ? `<a class="btn ${k}" data-action="${action}" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
    : `<button class="btn ${k}" data-action="${action}">${escapeHtml(label)}</button>`)).join('');
  box.innerHTML = `
    <div class="ingest-row">
      <div class="ingest-status ${cls}">${escapeHtml(status)}</div>
      <div class="ingest-actions">${btnHtml}</div>
    </div>
    ${progress != null ? `<div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>` : ''}
    ${banners.map(([k, html]) => `<div class="banner ${k}">${html}</div>`).join('')}
    ${hint ? `<div class="ingest-hint">${hint}</div>` : ''}
    ${panel ? transcriptPanelHtml(job) : ''}
  `;
  if (panel) fillTranscriptPanel(box, s.sid, job).catch((e) => console.warn('[session-list] transcript panel', e));
}

/**
 * The cap banner says only what the DTO says (free_cap.cap_seconds of original_duration_seconds;
 * `original_duration_seconds` is null when the server could not probe the file — measured on
 * recording 75dd6ef0, 2026-09-13). The whole file was uploaded and is kept; nothing beyond the cap
 * was transcribed (trimming happens before STT). `reason: insufficient_credits` = the wallet bound,
 * not the plan (recordings_ext/free_cap.py _store).
 */
function capBannerHtml(cap, job) {
  const capStr = formatDuration(cap.cap_seconds ?? 0);
  const orig = Number.isFinite(cap.original_duration_seconds) ? formatDuration(cap.original_duration_seconds) : null;
  const credits = cap.reason === 'insufficient_credits';
  let text;
  if (credits && orig) text = S.capBannerCredits(capStr, orig);
  else if (orig) text = S.capBanner(capStr, orig);
  else text = S.capBannerUnknownLength(capStr);
  const link = job.meetingPage && !job.serverDeleted
    ? ` <a href="${escapeHtml(job.meetingPage)}" target="_blank" rel="noopener">${escapeHtml(credits ? S.capTopUp : S.capUnlock)}</a>`
    : '';
  return escapeHtml(text) + link;
}

function transcriptPanelHtml(job) {
  const t = job.transcript;
  const ex = t.exports ?? {};
  const srt = ex.srt;
  let srtBtn = '';
  if (srt?.state === 'stored') srtBtn = `<button class="btn" data-action="download-local" data-file="${escapeHtml(srt.file)}" data-ext="srt">${escapeHtml(S.btnDownloadSrt)}</button>`;
  else if (srt?.state === 'running') srtBtn = `<button class="btn" disabled>${escapeHtml(S.exportRunning)}</button>`;
  else if (!job.serverDeleted && !job.authLost) srtBtn = `<button class="btn" data-action="export" data-format="srt">${escapeHtml(S.btnExportSrt)}</button>`;
  const meta = S.transcriptMeta(t.segments, t.words, t.language?.detected ?? t.language?.routed ?? job.server?.language ?? null);
  const summary = typeof job.server?.summary === 'string' && job.server.summary.trim();
  return `
    <div class="transcript" data-expanded="${expandedSids.has(job.sessionId) ? '1' : '0'}">
      <div class="transcript-head">
        <span class="ingest-hint">${escapeHtml(meta)}</span>
        <span class="tbtns">
          <button class="btn" data-action="download-local" data-file="${FILES.txt}" data-ext="txt">${escapeHtml(S.btnDownloadTxt)}</button>
          <button class="btn" data-action="download-local" data-file="${FILES.json}" data-ext="json">${escapeHtml(S.btnDownloadJson)}</button>
          ${t.files?.summary ? `<button class="btn" data-action="download-local" data-file="${FILES.summary}" data-ext="md">${escapeHtml(S.btnDownloadSummary)}</button>` : ''}
          ${srtBtn}
        </span>
      </div>
      ${srt?.state === 'error' ? `<div class="banner error">${escapeHtml(S.exportFailed(reasonText(srt.lastError)))}</div>` : ''}
      <pre class="transcript-text" data-role="text">${escapeHtml(S.loading)}</pre>
      <div class="transcript-foot"><button class="btn ghost" data-action="toggle-transcript" data-role="toggle" hidden>${escapeHtml(S.btnShowAll(0))}</button></div>
      ${summary ? `<details><summary>${escapeHtml(S.summaryTitle)}${t.summaryStale ? ` — ${escapeHtml(S.summaryStale)}` : ''}</summary><pre class="transcript-text" data-role="summary"></pre></details>` : ''}
    </div>`;
}

/** Text goes in through textContent only — never transcript HTML (CODEX Q4). */
async function fillTranscriptPanel(box, sid, job) {
  const pre = box.querySelector('[data-role="text"]');
  const toggle = box.querySelector('[data-role="toggle"]');
  const sumEl = box.querySelector('[data-role="summary"]');
  if (sumEl && typeof job.server?.summary === 'string') sumEl.textContent = job.server.summary;
  if (!pre) return;
  const sha = job.transcript?.sha256 ?? '';
  let cached = transcriptTextCache.get(sid);
  if (!cached || cached.sha !== sha) {
    const text = await readSessionFileText(sid, FILES.txt);
    if (text == null) { pre.textContent = S.transcriptFileMissing; if (toggle) toggle.hidden = true; return; }
    const all = text.replace(/\n$/, '').split('\n');
    cached = { sha, body: all.slice(job.transcript?.headerLines ?? 6) };
    transcriptTextCache.set(sid, cached);
  }
  const expanded = expandedSids.has(sid);
  pre.textContent = (expanded ? cached.body : cached.body.slice(0, PREVIEW_LINES)).join('\n');
  if (toggle) {
    toggle.hidden = cached.body.length <= PREVIEW_LINES;
    toggle.textContent = expanded ? S.btnShowLess : S.btnShowAll(cached.body.length);
  }
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
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
      if (!granted) { showStatus(S.notGrantedRetry, 'error'); if (s) rerender(s.sid); return; }
      if (s && await isCaptureActive(s.sid)) { showStatus(S.transcribeBlockedActive, 'error'); if (s) rerender(s.sid); return; }
      if (s && await ingest.needsEmail()) { showClaim({ reason: 'transcribe', session: s, after: () => startIngest(s) }); return; } // product rule «б»: the e-mail before the first upload
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
  if (captureState.sessionId === session.sid && (captureState.status === 'recording' || captureState.status === 'paused')) {
    showStatus(S.transcribeBlockedActive, 'error');
    return;
  }
  if (!ingest.hasConsent()) { showConsent(session); return; }
  const granted = await ingest.requestPermission(); // first await → still inside the gesture
  if (!granted) { showStatus(S.notGranted, 'error'); return; }
  if (await ingest.needsEmail()) { showClaim({ reason: 'transcribe', session, after: () => startIngest(session) }); return; }
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
function rerenderAll() { for (const sid of sessionsById.keys()) rerender(sid); }

async function resumeJob(session) {
  try { await ingest.resume(session.sid); } catch (err) { showStatus(err?.message ?? String(err), 'error'); }
  rerender(session.sid);
}

async function handleAction(e, session, sessionEl) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'rename') { handleRename(session, sessionEl); return; }
  if (action === 'transcribe') { await onTranscribeClick(session); return; }
  if (action === 'ingest-resume' || action === 'ingest-retry') {
    if (!ingest) return;
    const granted = await ingest.requestPermission(); // sync call inside the click → user gesture
    if (!granted) { showStatus(S.notGranted, 'error'); return; }
    // e-mail mode: a lost session or a job paused for the e-mail goes through the claim dialog first
    if (await ingest.needsEmail()) { showClaim({ reason: accountState.lost ? 'reconnect' : 'transcribe', session, after: () => resumeJob(session) }); return; }
    await resumeJob(session);
    return;
  }
  if (action === 'claim-open') {
    if (!ingest) return;
    const job = ingest.getJob(session.sid);
    showClaim({ reason: job?.stateReason === 'signed_out' || accountState.lost ? 'reconnect' : 'transcribe', session, after: () => resumeJob(session) });
    return;
  }
  if (action === 'ingest-pause') { if (ingest) await ingest.pause(session.sid, 'user'); rerender(session.sid); return; }
  if (action === 'ingest-cancel') {
    if (!ingest) return;
    const job = ingest.getJob(session.sid);
    if (job && !['error', 'create_unknown', 'finalize_unknown'].includes(job.state) && !confirm(S.confirmCancel)) return;
    await ingest.cancel(session.sid);
    rerender(session.sid);
    return;
  }

  // ── I4b ──
  if (action === 'check-now') {
    if (ingest) { try { await ingest.checkNow(session.sid); } catch (err) { showStatus(err?.message ?? String(err), 'error'); } }
    rerender(session.sid); return;
  }
  if (action === 'fetch-transcript') {
    if (ingest) { try { await ingest.syncCompleted(session.sid); } catch (err) { showStatus(err?.message ?? String(err), 'error'); } }
    rerender(session.sid); return;
  }
  if (action === 'toggle-transcript') {
    if (expandedSids.has(session.sid)) expandedSids.delete(session.sid); else expandedSids.add(session.sid);
    const box = sessionEl.querySelector('.ingest'); const job = ingest?.getJob(session.sid);
    if (box && job) fillTranscriptPanel(box, session.sid, job).catch(() => {});
    return;
  }
  if (action === 'download-local') {
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Downloading…';
    try {
      await downloadLocal(session.sid, btn.dataset.file, btn.dataset.ext, session);
      btn.textContent = 'Done';
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1200);
    } catch (err) {
      showStatus(S.downloadFailed(err?.message ?? err), 'error');
      btn.disabled = false; btn.textContent = original;
    }
    return;
  }
  if (action === 'export') {
    if (!ingest) return;
    btn.disabled = true;
    try { await ingest.exportTranscript(session.sid, btn.dataset.format); }
    catch (err) { showStatus(S.exportFailed(err?.message ?? String(err)), 'error'); }
    rerender(session.sid); return;
  }
  if (action === 'delete-server') {
    if (!ingest || !confirm(S.confirmDeleteServer)) return;
    btn.disabled = true;
    try { await ingest.deleteOnServer(session.sid); showStatus(S.serverDeleteDone, 'ok'); setTimeout(() => $('status').hidden = true, 2500); }
    catch (err) { showStatus(S.serverDeleteFailed(err?.message ?? String(err)), 'error'); }
    rerender(session.sid); return;
  }

  if (action === 'play') {
    const roleKey = btn.dataset.role;
    const fileName = btn.dataset.file;
    if (activePlayer && activePlayer.sid === session.sid && activePlayer.role === roleKey) {
      if (activePlayer.audio.paused || activePlayer.audio.ended) activePlayer.audio.play().catch(() => {});
      else activePlayer.audio.pause();
      updatePlayerDisplay();
      return;
    }
    await startPlayback(session.sid, roleKey, fileName, sessionEl);
    return;
  }
  if (action === 'player-toggle') {
    if (!activePlayer) return;
    if (activePlayer.audio.paused || activePlayer.audio.ended) activePlayer.audio.play().catch(() => {});
    else activePlayer.audio.pause();
    updatePlayerDisplay();
    return;
  }
  if (action === 'player-stop') { stopPlayback(); return; }

  // ── UF4: trim ──
  if (action === 'trim-enter') { enterTrimMode(); return; }
  if (action === 'trim-mark-start') { if (activePlayer && trimState) { trimState.startSec = activePlayer.audio.currentTime; renderTrimBar(); } return; }
  if (action === 'trim-mark-end') { if (activePlayer && trimState) { trimState.endSec = activePlayer.audio.currentTime; renderTrimBar(); } return; }
  if (action === 'trim-preview') { previewTrim(); return; }
  if (action === 'trim-export') { await exportTrim(session, sessionEl); return; }
  if (action === 'trim-cancel') { exitTrimMode(); return; }

  if (action === 'download-file') {
    const file = btn.dataset.file;
    const roleKey = btn.dataset.role;
    const ext = btn.dataset.ext;
    btn.disabled = true; btn.textContent = 'Downloading…';
    try {
      await downloadFile(session.sid, file, roleKey, ext, session);
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
      await downloadParts(session.sid, roleKey, segment, parts, session);
      btn.textContent = 'Done';
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1200);
    } catch (err) {
      showStatus(`Assembly failed: ${err.message ?? err}`, 'error');
      btn.disabled = false; btn.textContent = original;
    }
    return;
  }

  if (action === 'delete') {
    if (await isCaptureActive(session.sid)) {
      showStatus(S.deleteBlockedActive, 'error');
      return;
    }
    const job = ingest?.getJob(session.sid);
    const active = job && (ingest.isRunning(session.sid) || ['session', 'creating', 'uploading', 'finalizing', 'finalize_unknown', 'processing', 'paused', 'create_unknown'].includes(job.state));
    const question = active
      ? S.confirmDeleteLocalActive
      : S.confirmDeleteLocal(sessionEl.querySelector('.session-date').textContent.replace(/Completed|Interrupted without stop|Recording now|Paused/, '').trim());
    if (!confirm(question)) return;
    if (await isCaptureActive(session.sid)) {
      showStatus(S.deleteBlockedActive, 'error');
      return;
    }
    if (activePlayer && activePlayer.sid === session.sid) stopPlayback();
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

async function downloadFile(sid, name, roleKey, ext, session) {
  const root = await navigator.storage.getDirectory();
  const sessionsDir = await root.getDirectoryHandle('sessions');
  const dh = await sessionsDir.getDirectoryHandle(sid);
  const fh = await dh.getFileHandle(name);
  const file = await fh.getFile();

  const base = filenameBase(session);
  const roleSlug = ROLE_SLUG[roleKey] ?? roleKey;
  const suffix = name.includes('.recovered.') ? '-recovered' : '';
  const filename = `${base}-${roleSlug}${suffix}.${ext}`;

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadParts(sid, roleKey, segment, parts, session) {
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

  const base = filenameBase(session);
  const roleSlug = ROLE_SLUG[roleKey] ?? roleKey;
  const segSuffix = segment && segment !== '000' ? `-seg${segment}` : '';
  const filename = `${base}-${roleSlug}${segSuffix}.webm`;

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

// ── UF3: inline audio player ──

async function startPlayback(sid, roleKey, fileName, sessionEl) {
  stopPlayback();
  const mySeq = ++playSeq;

  let file;
  try {
    const dh = await sessionDirHandle(sid);
    const fh = await dh.getFileHandle(fileName);
    file = await fh.getFile();
  } catch (e) {
    showStatus(S.playerError(e?.message || 'file not found'), 'error');
    return;
  }
  if (mySeq !== playSeq) return;
  if (file.size === 0) { showStatus(S.playerError('file is empty'), 'error'); return; }

  const blobUrl = URL.createObjectURL(file);
  if (mySeq !== playSeq) { URL.revokeObjectURL(blobUrl); return; }

  const audio = new Audio(blobUrl);
  const playerBar = sessionEl.querySelector('.player-bar');
  activePlayer = { audio, blobUrl, sid, role: roleKey, el: playerBar, seeking: false, fileName };

  const label = ROLE_LABEL[roleKey] ?? roleKey;
  const isOgg = fileName.endsWith('.opus');
  playerBar.innerHTML = `
    <button class="btn" data-action="player-toggle" aria-label="${escapeHtml(S.btnPause)}">${escapeHtml(S.btnPause)}</button>
    <span class="player-time"><span data-role="current">0:00</span> / <span data-role="total">${escapeHtml(S.playerDurationUnknown)}</span></span>
    <input type="range" class="player-seek" min="0" max="100" value="0" step="0.1" aria-label="Seek">
    <span class="player-label">${escapeHtml(label)}</span>
    ${isOgg ? `<button class="btn" data-action="trim-enter" aria-label="${escapeHtml(S.btnTrim)}">${escapeHtml(S.btnTrim)}</button>` : ''}
    <button class="btn ghost" data-action="player-stop" aria-label="${escapeHtml(S.playerStop)}">&times;</button>
  `;
  playerBar.hidden = false;

  const seek = playerBar.querySelector('.player-seek');
  seek.disabled = true;
  seek.addEventListener('mousedown', () => { if (activePlayer) activePlayer.seeking = true; });
  seek.addEventListener('touchstart', () => { if (activePlayer) activePlayer.seeking = true; }, { passive: true });
  seek.addEventListener('input', () => {
    if (activePlayer && !seek.disabled) { activePlayer.audio.currentTime = parseFloat(seek.value); updatePlayerTime(); }
  });
  const endSeek = () => { if (activePlayer) activePlayer.seeking = false; };
  window.addEventListener('mouseup', endSeek);
  window.addEventListener('touchend', endSeek);
  activePlayer._cleanupSeek = () => { window.removeEventListener('mouseup', endSeek); window.removeEventListener('touchend', endSeek); };

  audio.addEventListener('loadedmetadata', () => updatePlayerDisplay());
  audio.addEventListener('durationchange', () => updatePlayerDisplay());
  audio.addEventListener('timeupdate', () => updatePlayerTime());
  audio.addEventListener('play', () => updatePlayerButtons());
  audio.addEventListener('pause', () => updatePlayerButtons());
  audio.addEventListener('ended', () => { if (trimState) trimState.previewing = false; updatePlayerDisplay(); });
  audio.addEventListener('error', () => {
    if (mySeq !== playSeq) return;
    showStatus(S.playerError(audio.error?.message || 'unsupported format'), 'error');
    stopPlayback();
  });

  try { await audio.play(); updatePlayerDisplay(); }
  catch (e) {
    if (e?.name === 'AbortError') return;
    if (mySeq !== playSeq) return;
    showStatus(S.playerError(e?.message ?? String(e)), 'error');
    stopPlayback();
  }
}

function stopPlayback() {
  if (!activePlayer) return;
  exitTrimMode();
  const { audio, blobUrl, el, role, _cleanupSeek } = activePlayer;
  if (_cleanupSeek) _cleanupSeek();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  URL.revokeObjectURL(blobUrl);
  if (el) el.hidden = true;
  const sessionEl = el?.closest('.session');
  if (sessionEl) {
    const btn = sessionEl.querySelector(`button[data-action="play"][data-role="${role}"]`);
    if (btn) btn.textContent = S.btnPlay;
  }
  activePlayer = null;
}

function updatePlayerDisplay() {
  if (!activePlayer) return;
  const { audio, el } = activePlayer;
  const seek = el.querySelector('.player-seek');
  if (seek && isFinite(audio.duration) && audio.duration > 0) { seek.max = audio.duration; seek.disabled = false; }
  updatePlayerTime();
  updatePlayerButtons();
}

function updatePlayerTime() {
  if (!activePlayer) return;
  const { audio, el, seeking } = activePlayer;
  if (trimState?.previewing && audio.currentTime >= trimState.endSec) {
    audio.pause();
    trimState.previewing = false;
  }
  const cur = el.querySelector('[data-role="current"]');
  const tot = el.querySelector('[data-role="total"]');
  const seek = el.querySelector('.player-seek');
  if (cur) cur.textContent = formatPlayerTime(audio.currentTime);
  if (tot) tot.textContent = isFinite(audio.duration) ? formatPlayerTime(audio.duration) : S.playerDurationUnknown;
  if (seek && isFinite(audio.duration) && audio.duration > 0 && !seeking) seek.value = audio.currentTime;
}

function updatePlayerButtons() {
  if (!activePlayer) return;
  const { audio, el, role } = activePlayer;
  const paused = audio.paused || audio.ended;
  const toggleBtn = el.querySelector('[data-action="player-toggle"]');
  if (toggleBtn) toggleBtn.textContent = paused ? S.btnPlay : S.btnPause;
  const sessionEl = el.closest('.session');
  if (sessionEl) {
    const roleBtn = sessionEl.querySelector(`button[data-action="play"][data-role="${role}"]`);
    if (roleBtn) roleBtn.textContent = paused ? S.btnPlay : S.btnPause;
  }
}

function formatPlayerTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

// ── I4b: local transcript files ──

async function sessionDirHandle(sid) {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle('sessions')).getDirectoryHandle(sid);
}

async function readSessionFileText(sid, name) {
  try { return await (await (await sessionDirHandle(sid)).getFileHandle(name)).getFile().then((f) => f.text()); }
  catch (e) { if (e?.name === 'NotFoundError') return null; throw e; }
}

/** transcript.v2.json → IronMemo-<date>-transcript.json, transcript.txt → …-transcript.txt, summary.md → …-summary.md, export.srt → …-transcript.srt */
async function downloadLocal(sid, name, ext, session) {
  const file = await (await (await sessionDirHandle(sid)).getFileHandle(name)).getFile();
  const base = filenameBase(session);
  const kind = name === FILES.summary ? 'summary' : 'transcript';
  const filename = `${base}-${kind}.${ext}`;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── I4b part 2: account bar ──

async function renderAccount() {
  const bar = $('account');
  if (!bar) return;
  if (!ingest) { bar.hidden = true; return; }
  const st = await ingest.accountStatus();
  accountState = st;
  let cls, text, hint = '';
  const btns = [];
  if (st.lost) { cls = 'lost'; text = S.account.lost; btns.push(['claim-open', S.account.btnReconnect, 'primary']); }
  else if (!st.hasAccount) { cls = 'none'; text = S.account.none; btns.push(['claim-open', S.account.btnAddEmail, 'primary']); }
  else if (st.kind === 'user') { cls = 'user'; text = S.account.user(st.emailMasked ?? '…'); hint = S.account.userHint; btns.push(['sign-out', S.account.btnSignOut, 'ghost']); }
  else { cls = 'guest'; text = S.account.guest; btns.push(['claim-open', S.account.btnAddEmail, 'primary']); }
  bar.className = `account ${cls}`;
  bar.innerHTML = `<div class="account-text">${escapeHtml(text)}${hint ? `<div class="account-hint">${escapeHtml(hint)}</div>` : ''}</div>`
    + `<div class="account-actions">${btns.map(([a, label, k]) => `<button class="btn ${k}" data-account-action="${a}">${escapeHtml(label)}</button>`).join('')}</div>`;
  bar.hidden = false;
  bar.onclick = async (e) => {
    const btn = e.target.closest('button[data-account-action]');
    if (!btn) return;
    if (btn.dataset.accountAction === 'claim-open') { showClaim({ reason: st.lost ? 'reconnect' : 'keep' }); return; }
    if (btn.dataset.accountAction === 'sign-out') {
      if (!confirm(S.account.confirmSignOut)) return;
      btn.disabled = true;
      try { const r = await ingest.signOut(); showStatus(r.serverOk ? S.account.signedOut : S.account.signedOutServerFailed, r.serverOk ? 'ok' : ''); }
      catch (err) { showStatus(err?.message ?? String(err), 'error'); }
      await renderAccount(); rerenderAll();
    }
  };
}

/** The popup's line opens this page on #sid=<session>: scroll there and mark it for a few seconds (task 4). */
function focusHashSession() {
  const sid = new URLSearchParams(location.hash.replace(/^#/, '')).get('sid');
  if (!sid) return;
  const el = document.querySelector(`.session[data-sid="${cssEscape(sid)}"]`);
  if (!el) return;
  el.classList.add('highlight');
  el.scrollIntoView({ block: 'start' });
  setTimeout(() => el.classList.remove('highlight'), 6000);
}

async function copyDiagnostics() {
  try {
    const payload = await buildDiagnostics({ jobs: ingest ? [...ingest.jobs.values()] : [], account: ingest ? await ingest.accountStatus() : null });
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    showStatus(S.account.diagnosticsCopied, 'ok');
  } catch (e) { showStatus(S.account.diagnosticsFailed(e?.message ?? e), 'error'); }
}

// ── I4b part 2: e-mail claim dialog ──

const claim = { reason: null, session: null, after: null, pending: null, timer: null, busy: false, locked: false };

function wireClaimDialog() {
  const C = S.claim;
  $('claimEmailLabel').textContent = C.emailLabel; $('claimPrivacy').textContent = C.privacyNote; $('claimPrivacyLink').textContent = C.privacyLink;
  $('claimCancel').textContent = C.btnNotNow; $('claimSend').textContent = C.btnSendCode; $('claimVerify').textContent = C.btnVerify;
  $('claimResend').textContent = C.btnResend; $('claimOther').textContent = C.btnOtherEmail; $('claimContinue').textContent = C.btnContinue;
  $('claimCancel').addEventListener('click', () => hideClaim());
  $('claimSend').addEventListener('click', () => onClaimSend({ resend: false }));
  $('claimResend').addEventListener('click', () => onClaimSend({ resend: true }));
  $('claimVerify').addEventListener('click', () => onClaimVerify());
  $('claimOther').addEventListener('click', () => { ingest.claim.clear().catch(() => {}); claim.pending = null; claim.locked = false; claimStep('email'); });
  $('claimContinue').addEventListener('click', () => { const after = claim.after; hideClaim(); if (after) after(); });
  $('claimEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onClaimSend({ resend: false }); } });
  $('claimCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onClaimVerify(); } });
}

/** reason: 'transcribe' (before the first upload) | 'keep' (from the account bar) | 'reconnect' (lost session / signed out). */
async function showClaim({ reason, session = null, after = null }) {
  if (!ingest) return;
  const C = S.claim;
  claim.reason = reason; claim.session = session; claim.after = after; claim.locked = false;
  $('claimTitle').textContent = reason === 'reconnect' ? C.titleReconnect : C.title;
  $('claimIntro').textContent = reason === 'transcribe' ? C.introTranscribe : reason === 'reconnect' ? C.introReconnect : C.introKeep;
  $('claimCancel').textContent = C.btnNotNow;
  claimError('email', null); claimError('code', null);
  const pending = await ingest.claim.pending();
  if (pending?.email && Date.now() - pending.requestedAt < (pending.ttlSeconds ?? 600) * 1000 && !(pending.lockedUntil && pending.lockedUntil > Date.now())) {
    claim.pending = pending; claimStep('code'); startCooldown();
  } else { claim.pending = null; claimStep('email'); }
  $('claim').hidden = false;
  setTimeout(() => ($('claimStepCode').hidden ? $('claimEmail') : $('claimCode')).focus(), 50);
}

function hideClaim() {
  $('claim').hidden = true;
  clearInterval(claim.timer); claim.timer = null;
  const s = claim.session; claim.session = null; claim.after = null;
  if (s) rerender(s.sid);
}

function claimStep(step) {
  const C = S.claim;
  $('claimStepEmail').hidden = step !== 'email'; $('claimStepCode').hidden = step !== 'code'; $('claimStepDone').hidden = step !== 'done';
  if (step === 'code' && claim.pending) {
    $('claimSentText').textContent = C.codeSent(claim.pending.target, Math.round((claim.pending.ttlSeconds ?? 600) / 60));
    $('claimCodeLabel').textContent = C.codeLabel(claim.pending.codeLength ?? 6);
    claim.locked = !!(claim.pending.lockedUntil && claim.pending.lockedUntil > Date.now());
    $('claimCode').value = ''; $('claimCode').disabled = claim.locked; $('claimVerify').disabled = claim.locked;
    claimError('code', null); // a message from an earlier e-mail must not survive a fresh code
    if (claim.locked) claimError('code', C.errors.locked(Math.max(1, Math.ceil((claim.pending.lockedUntil - Date.now()) / 60000))));
    else if (claim.pending.attemptsRemaining != null && claim.pending.lastError?.kind === 'invalid_code') claimError('code', C.attemptsLeft(claim.pending.attemptsRemaining));
    setTimeout(() => $('claimCode').focus(), 50);
  }
  if (step === 'email') { $('claimSend').disabled = false; $('claimSend').textContent = C.btnSendCode; setTimeout(() => $('claimEmail').focus(), 50); }
}

function claimError(where, text) {
  const el = $(where === 'code' ? 'claimErrorCode' : 'claimErrorEmail');
  el.textContent = text ?? ''; el.hidden = !text;
}

function claimErrorText(err) {
  const E = S.claim.errors;
  switch (err?.kind) {
    case 'invalid_email': return E.invalid_email;
    case 'invalid_code': return err.attemptsRemaining != null ? S.claim.attemptsLeft(err.attemptsRemaining) : E.invalid_code;
    case 'code_expired': return E.code_expired;
    case 'locked': return E.locked(err.retryAfterMinutes ?? 15);
    case 'rate_limited': return E.rate_limited(err.retryAfterMinutes ? `${err.retryAfterMinutes} min` : `${claim.pending?.cooldownSeconds ?? 30} s`);
    case 'email_taken': return E.email_taken;
    case 'captcha': return E.captcha;
    case 'auth_lost': return E.auth_lost;
    case 'transport': return E.transport;
    case 'server': return E.server;
    default: return E.other(err?.message ?? String(err));
  }
}

function startCooldown(seconds = null) {
  const p = claim.pending;
  const total = seconds ?? (p?.cooldownSeconds ?? 30);
  const until = seconds != null ? Date.now() + seconds * 1000 : (p?.requestedAt ?? Date.now()) + total * 1000;
  clearInterval(claim.timer);
  const b = $('claimResend');
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) { b.disabled = true; b.textContent = S.claim.btnResendIn(left); }
    else { b.disabled = false; b.textContent = S.claim.btnResend; clearInterval(claim.timer); claim.timer = null; }
  };
  tick(); claim.timer = setInterval(tick, 500);
}

function claimBusy(on, label = null) {
  claim.busy = on;
  for (const id of ['claimSend', 'claimVerify', 'claimOther', 'claimCancel', 'claimResend']) $(id).disabled = on;
  if (claim.locked) { $('claimVerify').disabled = true; $('claimCode').disabled = true; } // a server-side lock outlives the busy state
  if (label) { const b = $('claimStepCode').hidden ? $('claimSend') : $('claimVerify'); b.textContent = label; }
  if (!on) { $('claimSend').textContent = S.claim.btnSendCode; $('claimVerify').textContent = S.claim.btnVerify; }
  if (!on && claim.timer) $('claimResend').disabled = true; // the cooldown owns this button while it runs
}

async function onClaimSend({ resend }) {
  if (claim.busy) return;
  const email = resend ? claim.pending?.email : $('claimEmail').value;
  const where = resend ? 'code' : 'email';
  claimError(where, null);
  if (!isPlausibleEmail(email)) { claimError(where, S.claim.errors.invalid_email); return; }
  const permission = ingest.requestPermission(); // first call inside the click → user gesture (Chrome may show its prompt)
  claimBusy(true, S.claim.sending);
  try {
    const granted = await permission;
    if (!granted) { claimError(where, S.notGranted); return; }
    const caps = await ingest.claim.capabilities();
    if (caps.emailEnabled === false) { claimError(where, S.claim.errors.disabled); return; }
    claim.pending = await ingest.claim.requestCode(email, { resend });
    claimStep('code'); startCooldown();
  } catch (err) {
    claimError(where, claimErrorText(err));
    if (err?.kind === 'rate_limited' && resend) startCooldown(err.retryAfterMinutes ? err.retryAfterMinutes * 60 : (claim.pending?.cooldownSeconds ?? 30));
  } finally { claimBusy(false); }
}

async function onClaimVerify() {
  if (claim.busy) return;
  const code = $('claimCode').value.trim();
  claimError('code', null);
  if (!code) { claimError('code', S.claim.errors.invalid_code); return; }
  claimBusy(true, S.claim.verifying);
  try {
    const r = await ingest.claim.verify(code);
    const done = S.claim.done[r.status] ?? ((t) => S.claim.done.other(t, r.status));
    $('claimDoneText').textContent = done(r.emailMasked ?? '');
    $('claimDoneHint').textContent = S.claim.doneHint + (claim.pending?.guestUserId && !r.withGuest ? ` ${S.claim.notMerged}` : '');
    clearInterval(claim.timer); claim.timer = null;
    claimStep('done');
    await renderAccount(); rerenderAll();
  } catch (err) {
    claimError('code', claimErrorText(err));
    if (err?.kind === 'locked') claim.locked = true;
  } finally { claimBusy(false); }
}

// ── UF4: trim ──

function enterTrimMode() {
  if (!activePlayer || !isFinite(activePlayer.audio.duration) || activePlayer.audio.duration <= 0) return;
  if (trimState) { exitTrimMode(); return; }
  trimState = { startSec: 0, endSec: activePlayer.audio.duration, previewing: false, exporting: false };
  renderTrimBar();
}

function exitTrimMode() {
  if (!trimState) return;
  if (trimState.previewing && activePlayer?.audio) activePlayer.audio.pause();
  trimState = null;
  const bar = activePlayer?.el?.closest('.session')?.querySelector('.trim-bar');
  if (bar) { bar.innerHTML = ''; bar.hidden = true; }
}

function renderTrimBar() {
  if (!activePlayer || !trimState) return;
  const bar = activePlayer.el.closest('.session')?.querySelector('.trim-bar');
  if (!bar) return;
  const dur = Math.max(0, trimState.endSec - trimState.startSec);
  bar.innerHTML = `
    <button class="btn" data-action="trim-mark-start">${escapeHtml(S.trimMarkStart(formatPlayerTime(trimState.startSec)))}</button>
    <button class="btn" data-action="trim-mark-end">${escapeHtml(S.trimMarkEnd(formatPlayerTime(trimState.endSec)))}</button>
    <span class="trim-range">${escapeHtml(S.trimSelection(formatPlayerTime(dur)))}</span>
    <button class="btn" data-action="trim-preview">${escapeHtml(S.trimPreview)}</button>
    <button class="btn primary" data-action="trim-export">${escapeHtml(S.trimExportSelection)}</button>
    <button class="btn ghost" data-action="trim-cancel">${escapeHtml(S.trimCancel)}</button>
  `;
  bar.hidden = false;
}

function previewTrim() {
  if (!activePlayer || !trimState) return;
  if (trimState.startSec >= trimState.endSec) { showStatus(S.trimInvalidRange, 'error'); return; }
  trimState.previewing = true;
  activePlayer.audio.currentTime = trimState.startSec;
  activePlayer.audio.play().catch((e) => { if (e?.name !== 'AbortError') showStatus(S.playerError(e?.message ?? String(e)), 'error'); });
}

async function exportTrim(session, sessionEl) {
  if (!activePlayer || !trimState || trimState.exporting) return;
  if (trimState.startSec >= trimState.endSec) { showStatus(S.trimInvalidRange, 'error'); return; }

  const { sid, fileName, role } = activePlayer;
  const { startSec, endSec } = trimState;
  trimState.exporting = true;

  const btn = sessionEl.querySelector('[data-action="trim-export"]');
  if (btn) { btn.disabled = true; btn.textContent = S.trimExporting; }

  try {
    const result = await trimOggOpus(sid, fileName, startSec, endSec);
    if (result.packets === 0) throw new Error('output verification failed: no valid packets');

    const base = filenameBase(session);
    const roleSlug = ROLE_SLUG[role] ?? role;
    const startTag = formatPlayerTime(startSec).replace(/:/g, '.');
    const endTag = formatPlayerTime(endSec).replace(/:/g, '.');
    const filename = `${base}-${roleSlug}-trim-${startTag}-${endTag}.opus`;

    const blob = new Blob([result.bytes], { type: 'audio/ogg; codecs=opus' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    if (btn) { btn.textContent = S.trimDone; setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = S.trimExportSelection; } }, 1500); }
  } catch (e) {
    showStatus(S.trimError(e?.message ?? String(e)), 'error');
    if (btn) { btn.disabled = false; btn.textContent = S.trimExportSelection; }
  } finally {
    if (trimState) trimState.exporting = false;
  }
}

async function trimOggOpus(sid, fileName, startSec, endSec) {
  const dh = await sessionDirHandle(sid);
  const fh = await dh.getFileHandle(fileName);
  const file = await fh.getFile();
  const buf = new Uint8Array(await file.arrayBuffer());

  const d = demuxOggOpus(buf);
  if (!d.opusHead || !d.packets.length) throw new Error('not a valid Ogg/Opus file');

  const startSample = Math.floor(startSec * 48000);
  const endSample = Math.ceil(endSec * 48000);

  let pos = 0;
  const selected = [];
  let startsAtBeginning = true;
  for (const pkt of d.packets) {
    const dur = opusPacketSamples(pkt.data);
    const pktEnd = pos + dur;
    if (pktEnd > startSample && pos < endSample) {
      if (selected.length === 0 && pos > 0) startsAtBeginning = false;
      selected.push({ data: new Uint8Array(pkt.data), samples: dur });
    }
    pos += dur;
    if (pos >= endSample) break;
  }

  if (!selected.length) throw new Error(S.trimEmpty);

  const mux = new OggOpusMuxer({
    channels: d.opusHead.channels,
    preSkip: startsAtBeginning ? d.opusHead.preSkip : 0,
    inputSampleRate: d.opusHead.inputSampleRate,
    comments: [`ENCODER=IronMemo Trim (lossless packet copy, ${selected.length} packets)`],
  });

  const chunks = [...mux.headerPages()];
  for (let i = 0; i < selected.length; i++) {
    mux.addPacket(selected[i].data, selected[i].samples);
    if ((i + 1) % 50 === 0) { const p = mux.flushPage(); if (p) chunks.push(p); }
  }
  const last = mux.flushPage({ eos: true });
  if (last) chunks.push(last);

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }

  return { bytes: out, packets: selected.length, durationSec: selected.reduce((a, p) => a + p.samples, 0) / 48000 };
}

// ── UF6a: display name ──────────────────────────────────────────────────────── //

function sanitizeFileName(name) {
  if (!name) return null;
  let clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  clean = Array.from(clean).slice(0, 60).join('');
  return clean.replace(/[.\s]+$/, '') || null;
}

function filenameBase(session) {
  const safe = sanitizeFileName(session?.displayName);
  if (safe) return `IronMemo-${safe}`;
  const dateStr = session?.startedAt
    ? new Date(session.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
    : 'unknown';
  return `IronMemo-${dateStr}`;
}

async function saveMeta(sid, patch) {
  const dh = await sessionDirHandle(sid);
  let existing = {};
  try {
    const fh = await dh.getFileHandle('meta.json');
    existing = JSON.parse(await (await fh.getFile()).text());
  } catch {}
  const merged = { ...existing, ...patch };
  if (merged.displayName === null || merged.displayName === '') delete merged.displayName;
  const fh = await dh.getFileHandle('meta.json', { create: true });
  const writable = await fh.createWritable();
  try { await writable.write(JSON.stringify(merged)); await writable.close(); }
  catch (e) { try { await writable.abort(); } catch {} throw e; }
}

function handleRename(session, sessionEl) {
  const row = sessionEl.querySelector('.session-title-row');
  if (!row || row.querySelector('.rename-input')) return;

  const children = [...row.children];
  children.forEach((c) => { c.dataset.preRenameHidden = c.hidden ?? false; c.hidden = true; });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = session.displayName || '';
  input.placeholder = S.renamePlaceholder;
  input.maxLength = 100;
  row.prepend(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    input.remove();
    children.forEach((c) => { c.hidden = c.dataset.preRenameHidden === 'true'; delete c.dataset.preRenameHidden; });

    if (save) {
      const name = input.value.trim() || null;
      if (name !== session.displayName) {
        session.displayName = name;
        try { await saveMeta(session.sid, { displayName: name }); }
        catch (e) { showStatus(`Could not save name: ${e?.message ?? e}`, 'error'); }
        rebuildSessionHead(session, sessionEl);
      }
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function rebuildSessionHead(s, sessionEl) {
  const leftDiv = sessionEl.querySelector('.session-head > div:first-child');
  if (!leftDiv) return;

  const date = s.startedAt ? new Date(s.startedAt) : null;
  const dateStr = date ? formatDate(date) : '—';
  const duration = s.durationSec != null ? formatDuration(s.durationSec) : '—';
  const badge = s.status === 'ok'
    ? '<span class="pill ok">Completed</span>'
    : s.status === 'recording'
    ? `<span class="pill recording">${escapeHtml(S.badgeRecording)}</span>`
    : s.status === 'paused'
    ? `<span class="pill paused">${escapeHtml(S.badgePaused)}</span>`
    : '<span class="pill orphan">Interrupted without stop</span>';
  const engineTag = s.engine ? `<span class="tag">${escapeHtml(s.engine)}</span>` : '';
  const hasName = !!s.displayName;

  leftDiv.innerHTML = `
    <div class="session-title-row">
      ${hasName ? `<span class="session-title">${escapeHtml(s.displayName)}</span>` : `<span class="session-date">${dateStr}</span>`}
      ${badge}${engineTag}
      <button class="btn ghost rename-btn" data-action="rename" title="${escapeHtml(S.btnRename)}">${escapeHtml(S.btnRename)}</button>
    </div>
    ${hasName ? `<div class="session-date secondary">${dateStr}</div>` : ''}
    <div class="session-meta">Duration: ${duration} · On disk: ${formatBytes(s.bytes)}</div>
  `;
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
