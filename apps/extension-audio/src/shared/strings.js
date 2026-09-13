/**
 * strings.js — every user-facing string the ingest UI renders from JavaScript, in one map, so an
 * i18n layer can swap the map without touching the rendering code (CLAUDE.md: new UI strings are
 * English and go through one place; the static HTML copy of the dialogs stays in the .html files
 * until that layer exists). Parametrised strings are functions.
 *
 * Product rule (Igor, 2026-09-13): 10 free minutes of transcription per ACCOUNT, not per recording.
 * The server today trims EACH recording at its own cap (recordings_ext/entitlement.py, origin/main
 * 6720f51) — so the cap banner describes only what the DTO says (free_cap.cap_seconds of
 * original_duration_seconds) and the client never invents a per-account counter; remaining minutes
 * are shown only when the API returns them (it does not yet).
 */

export const S = Object.freeze({
  // ── idle / offer ──
  idleStatus: 'Get a transcript from IronMemo.',
  idleHint: 'Sends this one recording to your IronMemo account. 10 free minutes per account.',
  btnTranscribe: 'Transcribe with IronMemo',
  btnTranscribeAgain: 'Transcribe again',

  // ── in flight ──
  stateText: Object.freeze({
    session: 'Connecting to IronMemo…',
    creating: 'Creating the recording on IronMemo…',
    finalizing: 'Finishing the upload…',
  }),
  workspaceWait: 'IronMemo is preparing a workspace for your guest account — this can take a minute or two.',
  createUnknown: 'Could not confirm whether the recording was created on IronMemo.',
  createUnknownHint: 'Retry checks the server for this recording before creating it again.',
  uploadingMultipart: (pct, part, of) => `Uploading ${pct}% — part ${part} of ${of}`,
  uploadingSingle: (pct, sent, total) => `Uploading ${pct}% (${sent} of ${total})`,
  uploadingHintRunning: 'Keep this tab open. If you close it, reopen Recordings to continue where it stopped.',
  uploadingHintIdle: 'Not running in this tab.',
  finalizeUnknown: 'The upload finished but the confirmation was lost.',
  finalizeUnknownHint: 'Retry asks the server for the state before sending anything again.',
  processing: (server) => `Processing on IronMemo: ${server}…`,
  processingHint: (polls) => `Checked ${polls} time(s). You can close this tab; the result is fetched when you come back.`,
  processingHintIdle: 'Not being checked in this tab.',
  btnCheckStatus: 'Check status',

  // ── waiting long (measured 2026-09-13: a 3-hour `queued` with no error on any route) ──
  waitingLong: (clock) => `Waiting for the server… since ${clock}`,
  waitingLongHint: (minutes, server) => `IronMemo has not finished this recording for ${minutes} min (server status: ${server}). It usually takes under a minute; the upload is safe on the server and this page keeps checking.`,
  waitingLongKeep: 'Your guest session keeps the recording for 7 days of inactivity — adding your e-mail (coming in the next version) makes the access permanent.',
  btnCheckNow: 'Check now',

  // ── completed ──
  completed: (duration) => `✓ Transcribed on IronMemo${duration ? ` — ${duration}` : ''}`,
  transcriptFetching: 'Fetching the transcript…',
  transcriptError: (reason) => `The transcript could not be fetched: ${reason}.`,
  btnFetchTranscript: 'Fetch transcript',
  transcriptMeta: (segments, words, language) => `${segments} segment(s)${Number.isFinite(words) ? `, ${words} word(s)` : ''}${language ? `, language ${language}` : ''} — stored in this browser next to the audio.`,
  transcriptFileMissing: 'The local transcript file is missing — click "Fetch transcript" to store it again.',
  loading: 'Loading…',
  btnShowAll: (lines) => `Show all ${lines} lines`,
  btnShowLess: 'Show less',
  btnDownloadTxt: 'Download .txt',
  btnDownloadJson: 'Download .json',
  btnDownloadSummary: 'Download summary',
  btnExportSrt: 'Export .srt',
  btnDownloadSrt: 'Download .srt',
  exportRunning: 'Exporting…',
  exportFailed: (reason) => `The .srt export failed: ${reason}`,
  summaryTitle: 'Summary (AI)',
  summaryStale: 'The summary is older than the latest transcript edits on IronMemo.',
  summarySkipped: 'Summary skipped: the account had no credits for it. The transcript itself is complete.',
  openOnIronMemo: 'Open on IronMemo',
  openCaveat: '(the website asks you to sign in — guest recordings become visible there after you add your e-mail, coming in the next version).',
  completedAuthLost: 'The saved IronMemo session is no longer valid; the server copy stays under the old guest account. The local files below are yours.',

  // ── free cap (the DTO's free_cap block; never a per-account counter) ──
  capBanner: (cap, original) => `First ${cap} of ${original} transcribed — the free limit applied to this recording. The whole file was uploaded and is kept on the server; nothing beyond ${cap} was transcribed.`,
  capBannerUnknownLength: (cap) => `The first ${cap} were transcribed — the free limit applied and the full length of the file could not be read. The whole file is kept on the server.`,
  capBannerCredits: (cap, original) => `Your credits covered the first ${cap} of ${original}. The whole file is kept on the server; nothing beyond ${cap} was transcribed.`,
  capUnlock: 'Unlock the rest in IronMemo →',
  capTopUp: 'Top up credits in IronMemo →',

  // ── server copy ──
  btnDeleteServer: 'Delete on server',
  serverDeleted: 'Deleted on IronMemo. The local recording and transcript files are kept in this browser.',
  serverDeleteDone: 'Deleted on IronMemo — local files kept.',
  serverDeleteFailed: (msg) => `Could not delete on IronMemo: ${msg}`,
  confirmDeleteServer: 'Delete this recording on IronMemo? The server copy (audio, transcript, summary) is erased. The local recording and the transcript files in this browser are kept.',

  // ── errors ──
  failed: (reason) => `Failed: ${reason}`,
  needsCredits: 'Needs credits — the recording was not transcribed.',
  needsCreditsHint: 'IronMemo refused this recording because the account has no credits for it. The audio is kept on the server; add credits on IronMemo, then try again.',
  btnOpenIronMemo: 'Open IronMemo',
  networkError: 'No connection to IronMemo.',
  networkErrorHint: 'Check your internet connection, then Retry. Nothing was lost: the upload continues from the last confirmed part.',
  tooLarge: 'The file is larger than IronMemo accepts.',
  lostSession: 'Your IronMemo session is no longer valid.',
  lostSessionHint: 'Reconnect starts a NEW guest session and sends this recording again. Recordings uploaded under the old session stay on IronMemo but this extension can no longer open them — add your e-mail early next time (coming in the next version).',
  btnReconnect: 'Reconnect',
  btnRetry: 'Retry',
  btnDismiss: 'Dismiss',
  btnCancel: 'Cancel',
  btnPause: 'Pause',
  btnResume: 'Resume',
  reasons: Object.freeze({
    auth_lost: 'the IronMemo session is no longer valid',
    payment: 'IronMemo needs credits for this recording',
    insufficient_credits: 'not enough credits on the IronMemo account',
    too_large: 'the file is too large for the server',
    too_long: 'the recording is longer than the server accepts',
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
    not_found: 'the transcript is not on the server yet',
    shape: 'the server answered in an unexpected form',
    local_deleted: 'the local files were deleted',
    NotFoundError: 'the local recording folder is gone',
    export_failed: 'the server could not render the export',
    export_timeout: 'the export was not ready in time',
  }),

  // ── paused / cancelled ──
  paused: Object.freeze({
    permission_revoked: 'Paused: access to app.ironmemo.com was revoked. Nothing more is sent until you allow it again.',
    permission_missing: 'Paused: the extension has no access to app.ironmemo.com yet.',
    consent_missing: 'Paused: cloud processing has not been accepted.',
    user: 'Paused by you.',
    check_now: 'Checking…',
  }),
  pausedOther: (reason) => `Paused (${reason ?? 'unknown'}).`,
  pausedHint: 'Local files are untouched. Resume continues from the last confirmed part.',
  cancelled: 'Upload cancelled.',
  cancelledLocalDeleted: 'Upload cancelled: the local files were deleted.',
  cancelledServerRemain: (id8) => (id8 ? `An empty recording may remain on IronMemo (id ${id8}…).` : ''),
  confirmCancel: 'Cancel the upload to IronMemo? Local files stay.',

  // ── page-level messages ──
  notGranted: 'Access to app.ironmemo.com was not granted — nothing was sent.',
  notGrantedRetry: 'Access to app.ironmemo.com was not granted — nothing was sent. Click Transcribe again to retry.',
  cannotStart: (msg) => `Cannot send this recording: ${msg}`,
  couldNotStart: (msg) => `Could not start: ${msg}`,
  downloadFailed: (msg) => `Download failed: ${msg}`,
  confirmDeleteLocalActive: 'An upload to IronMemo is in progress for this recording. Deleting stops it and cannot be undone. Continue?',
  confirmDeleteLocal: (date) => `Delete session from ${date}? Audio and transcript files in this browser cannot be recovered (the server copy, if any, stays on IronMemo).`,
});

/** Popup: the one-time notice existing users see after the update (no consent bump — ADR-008 «Уточнения» 5). */
export const POPUP = Object.freeze({
  noticeText: 'New in this version: a recording can optionally be sent to IronMemo for transcription — from the Recordings page, one recording at a time, after a separate disclosure. Nothing is uploaded automatically and your existing recordings stay local. Keep recording locally as before, or click Transcribe on a recording when you want a transcript.',
  noticeOk: 'Got it — keep recording locally',
});

/** Reason → sentence, with a readable fallback for reasons the map does not know. */
export function reasonText(reasonOrError) {
  const r = typeof reasonOrError === 'string' ? reasonOrError : (reasonOrError?.reason ?? reasonOrError?.kind ?? null);
  if (r && S.reasons[r]) return S.reasons[r];
  const msg = typeof reasonOrError === 'object' && reasonOrError?.message ? String(reasonOrError.message) : null;
  return msg ? msg.slice(0, 200) : (r ? String(r).replace(/_/g, ' ') : 'unknown error');
}
