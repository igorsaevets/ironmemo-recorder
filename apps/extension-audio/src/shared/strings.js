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
  waitingLongKeep: (isUser) => (isUser
    ? 'The upload is safe on the server under your IronMemo account.'
    : 'Your guest session keeps the recording for 7 days of inactivity — add your e-mail (the bar above the list) to make the access permanent.'),
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
  openCaveat: '(the website asks you to sign in — use the same e-mail as in this extension).',
  completedAuthLost: 'The saved IronMemo session is no longer valid; the server copy stays under the account it was uploaded with. Reconnect with the same e-mail (the bar above the list) to reach it again. The local files below are yours.',
  completedSignedOut: 'You signed out of IronMemo in this extension; the server copy stays under your account (sign in on the website, or reconnect here with the same e-mail). The local files below are yours.',

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
  lostSessionHint: (emailMode) => (emailMode
    ? 'Reconnect verifies your e-mail again (a one-time code) and continues this upload under the same IronMemo account.'
    : 'Reconnect starts a NEW guest session and sends this recording again. Recordings uploaded under the old session stay on IronMemo but this extension can no longer open them.'),
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
    email_required: 'the e-mail is not verified yet',
    signed_out: 'you signed out of IronMemo',
    invalid_code: 'the code was not accepted',
    code_expired: 'the code expired',
    locked: 'too many wrong codes — locked for a while',
    email_taken: 'this e-mail belongs to another IronMemo account',
    captcha: 'IronMemo asks for a captcha on this network',
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
    email_required: 'Paused: verify your e-mail to continue — the free minutes are granted per account.',
    signed_out: 'Paused: you signed out of IronMemo. Reconnect with your e-mail to continue.',
  }),
  pausedOther: (reason) => `Paused (${reason ?? 'unknown'}).`,
  pausedHint: 'Local files are untouched. Resume continues from the last confirmed part.',
  cancelled: 'Upload cancelled.',
  cancelledLocalDeleted: 'Upload cancelled: the local files were deleted.',
  cancelledServerRemain: (id8) => (id8 ? `An empty recording may remain on IronMemo (id ${id8}…).` : ''),
  confirmCancel: 'Cancel the upload to IronMemo? Local files stay.',

  // ── account bar (I4b part 2) ──
  account: Object.freeze({
    none: 'Not connected to IronMemo yet. Your e-mail is verified with a one-time code before the first transcription — 10 free minutes per account, no password.',
    guest: 'Guest session on IronMemo (from an earlier version). It keeps your recordings for 7 days of inactivity — add your e-mail to keep them and to get your free minutes.',
    user: (masked) => `IronMemo account: ${masked}`,
    userHint: 'Sign in on app.ironmemo.com with this e-mail to see the same recordings on the website.',
    lost: 'Your IronMemo session is no longer valid. Reconnect with your e-mail to keep working with the server copies.',
    btnAddEmail: 'Add your e-mail',
    btnReconnect: 'Reconnect',
    btnSignOut: 'Sign out',
    btnDiagnostics: 'Copy diagnostics',
    diagnosticsCopied: 'Diagnostics copied to the clipboard: versions, states and error counts — no recordings, no e-mail.',
    diagnosticsFailed: (msg) => `Could not copy the diagnostics: ${msg}`,
    confirmSignOut: 'Sign out of IronMemo in this extension? The server copies stay under your account (sign in on the website, or reconnect here with the same e-mail). Local files are untouched; an upload in progress is paused.',
    signedOut: 'Signed out of IronMemo. Local files are untouched.',
    signedOutServerFailed: 'Signed out in this extension; the server did not confirm the logout (the session expires on its own).',
  }),

  // ── e-mail claim dialog (I4b part 2): a one-time code, no password ──
  claim: Object.freeze({
    title: 'Add your e-mail',
    titleReconnect: 'Reconnect to IronMemo',
    introTranscribe: 'IronMemo verifies your e-mail before the first transcription: the 10 free minutes are granted per account, and the e-mail is what lets you sign in on the website later. A one-time code is sent to your e-mail — no password.',
    introKeep: 'Your recordings on IronMemo are kept under an account. Verify your e-mail once with a one-time code — no password. An existing IronMemo account with this e-mail is used; otherwise one is created.',
    introReconnect: 'Verify your e-mail again to continue with the same IronMemo account. A one-time code, no password.',
    privacyNote: 'The e-mail is sent to IronMemo (app.ironmemo.com) to deliver the code and becomes the login of the account. ',
    privacyLink: 'Privacy Policy',
    emailLabel: 'E-mail',
    btnSendCode: 'Send code',
    btnNotNow: 'Not now',
    sending: 'Sending…',
    codeSent: (target, minutes) => `We sent a code to ${target}. It is valid for ${minutes} minutes.`,
    codeLabel: (n) => `Code from the e-mail (${n} digits)`,
    btnVerify: 'Verify',
    verifying: 'Verifying…',
    btnResend: 'Resend code',
    btnResendIn: (s) => `Resend in ${s} s`,
    btnOtherEmail: 'Use another e-mail',
    attemptsLeft: (n) => `Wrong code — ${n} attempt(s) left. Check the newest e-mail from IronMemo.`,
    errors: Object.freeze({
      invalid_email: 'That does not look like an e-mail address.',
      invalid_code: 'Wrong code. Check the newest e-mail from IronMemo.',
      code_expired: 'The code expired. Ask for a new one.',
      locked: (min) => `Too many wrong codes — this e-mail is locked for ${min} minute(s). Try again later.`,
      rate_limited: (wait) => `A code was sent recently. You can ask for a new one in ${wait}.`,
      email_taken: 'This e-mail already belongs to another IronMemo account. Sign out first, then use it.',
      captcha: 'IronMemo asks for a captcha on this network — sign in on the website instead.',
      auth_lost: 'The guest session had expired, so the earlier recordings could not be merged; the e-mail itself was accepted.',
      transport: 'No connection to IronMemo. Check your internet connection and try again.',
      server: 'IronMemo answered with a server error. Try again in a minute.',
      disabled: 'E-mail sign-in is switched off on this server — sign in on the website.',
      other: (msg) => `Could not complete: ${msg}`,
    }),
    done: Object.freeze({
      MERGED: (target) => `Done — ${target} is your IronMemo account. The guest recordings from this browser were merged into it.`,
      REGISTERED: (target) => `Done — an IronMemo account was created for ${target}. The recordings from this browser stay with it.`,
      LOGGED_IN: (target) => `Done — signed in to the IronMemo account ${target}.`,
      MODIFIED: (target) => `Done — ${target} is now the e-mail of your IronMemo account.`,
      other: (target, status) => `Done — connected as ${target} (${status}).`,
    }),
    doneHint: 'Sign in on app.ironmemo.com with the same e-mail to see the recordings on the website.',
    notMerged: 'The earlier guest session had expired, so its recordings could not be merged into this account.',
    btnContinue: 'Continue',
    btnClose: 'Close',
  }),

  // ── page-level messages ──
  notGranted: 'Access to app.ironmemo.com was not granted — nothing was sent.',
  notGrantedRetry: 'Access to app.ironmemo.com was not granted — nothing was sent. Click Transcribe again to retry.',
  cannotStart: (msg) => `Cannot send this recording: ${msg}`,
  couldNotStart: (msg) => `Could not start: ${msg}`,
  downloadFailed: (msg) => `Download failed: ${msg}`,
  confirmDeleteLocalActive: 'An upload to IronMemo is in progress for this recording. Deleting stops it and cannot be undone. Continue?',
  confirmDeleteLocal: (date) => `Delete session from ${date}? Audio and transcript files in this browser cannot be recovered (the server copy, if any, stays on IronMemo).`,
  badgeRecording: 'Recording now',
  badgePaused: 'Paused',
  deleteBlockedActive: 'Cannot delete — this recording is still in progress. Stop the recording first.',
  transcribeBlockedActive: 'Cannot transcribe — recording is still in progress. Stop the recording first.',

  // ── player (UF3) ──
  btnPlay: 'Play',
  playerStop: 'Close player',
  playerDurationUnknown: '—',
  playerError: (msg) => `Cannot play: ${msg}`,

  // ── trim (UF4) ──
  btnTrim: 'Trim',
  trimMarkStart: (t) => `Start: ${t}`,
  trimMarkEnd: (t) => `End: ${t}`,
  trimPreview: 'Preview',
  trimExportSelection: 'Export Selection',
  trimCancel: 'Cancel',
  trimExporting: 'Exporting…',
  trimDone: 'Exported',
  trimNotSupported: 'Trim is only available for Opus recordings',
  trimInvalidRange: 'Start must be before end',
  trimEmpty: 'Selection contains no audio packets',
  trimError: (msg) => `Trim failed: ${msg}`,
  trimSelection: (dur) => `Selection: ${dur}`,

  // ── rename (UF6a) ──
  btnRename: 'Rename',
  renamePlaceholder: 'Enter a name for this recording',

  // ── search (UF6b) ──
  searchPlaceholder: 'Search by name or date…',
  searchNoResults: 'No recordings match your search.',

  // ── markers (UF9) ──
  btnMark: 'Mark',
  markerRemoveTitle: 'Remove marker',

  // ── download / export states (UF8) ──
  btnDownload: 'Download',
  dlPreparing: 'Preparing…',
  dlAssembling: 'Assembling…',
  dlSaved: 'Saved',
  dlSentToDownloads: 'Sent to Downloads',
});

/** Popup: the one-time notice existing users see after the update (no consent bump — ADR-008 «Уточнения» 5). */
export const POPUP = Object.freeze({
  noticeText: 'New in this version: a recording can optionally be sent to IronMemo for transcription — from the Recordings page, one recording at a time, after a separate disclosure. Nothing is uploaded automatically and your existing recordings stay local. Keep recording locally as before, or click Transcribe on a recording when you want a transcript.',
  noticeOk: 'Got it — keep recording locally',
  // I4b task 4: the line after a recording stops (opens the Recordings page on that session; nothing is uploaded from the popup)
  transcribeLine: 'Transcribe with IronMemo →',
  transcribeHint: 'Opens the Recordings page on this recording. Nothing is uploaded until you click Transcribe there.',
  micLabel: 'Microphone',
  micDefault: 'Default (follows OS)',
  micNotFound: (name) => `"${name}" is not available — choose another or use Default.`,
  micNoLabels: 'Grant microphone access to see device names.',
  micNoLabelsCta: 'Open Settings',
  micWarnLoopback: 'This device captures system playback, not your voice.',
  micWarnBtHandsfree: 'Bluetooth Hands-Free: mono, 8–16 kHz — lower quality.',
  micWarnVirtualProcessed: 'Already applies its own noise suppression.',
  micDisabledRecording: 'Cannot change while recording.',
  meterMic: 'Mic',
  meterTab: 'Tab',
  meterMix: 'Mix',
  meterWaiting: 'Waiting for audio…',
  meterPaused: 'Paused',
});

/** Reason → sentence, with a readable fallback for reasons the map does not know. */
export function reasonText(reasonOrError) {
  const r = typeof reasonOrError === 'string' ? reasonOrError : (reasonOrError?.reason ?? reasonOrError?.kind ?? null);
  if (r && S.reasons[r]) return S.reasons[r];
  const msg = typeof reasonOrError === 'object' && reasonOrError?.message ? String(reasonOrError.message) : null;
  return msg ? msg.slice(0, 200) : (r ? String(r).replace(/_/g, ' ') : 'unknown error');
}
