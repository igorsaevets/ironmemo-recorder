# Chrome Web Store record — IronMemo

> Last Updated: 2026-11-13 · item `epnajjfddhbhgabhmcaomfnjhnhjnchd` · publisher «Ironmemo»

This is the file Google's `chrome-extensions` agent skill (GoogleChrome/modern-web-guidance) keeps
for an extension: what the Developer Dashboard asks for, and where each value comes from. One home
per fact: the long EN and RU descriptions live in `docs/cws-listing-draft.md` and are edited there,
never copied here. This file sits outside `apps/extension-audio/`, so it never enters the store zip.

## Store listing

| Field | Value | Source |
|---|---|---|
| Name | `IronMemo: Free Audio Recorder & Transcribe Meetings & AI Notetaker` (66 of 75 chars; RU name 66) | `_locales/<lang>/messages.json` → `extensionName`. The store takes it from the package: it changes only with a new version |
| Summary | EN 121, RU 115 of 132 chars | `_locales/<lang>/messages.json` → `extensionDescription`, same rule |
| Detailed description | EN + RU saved with the 2.2.5 draft on 2026-11-13 (P300-29b), the «New in» paragraph now opening with 2.2.5 (the draft file at `3ecc439`; SHA-256 of each locale checked after a reload: EN `81b2642a…`, RU `928e7cda…`; before the change the console held exactly the 2.2.4 texts, EN `8b4fee75…`, RU `74c1c10c…`). The draft file holds the 2.2.6 text (opening with «New in 2.2.6»); 2.2.6 was never uploaded, and the 2.2.7 release commit turns it into «New in 2.2.7» | `docs/cws-listing-draft.md` |
| Category | Workflow & Planning | public listing, 2026-10-17 |
| Languages | English, Russian | public listing, 2026-10-17 |
| Single purpose | «Records the microphone and browser tab audio locally, so users can capture meetings, calls, and interviews without a meeting bot joining. Recordings stay on the user's disk (OPFS) until the user chooses to send a specific recording for transcription on the IronMemo service. Optional; only one recording at a time; separate consent shown before any upload.» | Dashboard → Privacy tab, read 2026-11-09 (P300-28f) |

## Graphics

- Store icon: `apps/extension-audio/icons/icon128.png` (the package icon).
- Screenshots: 5 at 1280×800, uploaded 2026-09-28 for 2.1.0. Not compared with the 2.2.0 UI, which
  added the account line (credits and free minutes) and the price before an upload, or with 2.2.1, whose popup
  shows a version line and, for «Microphone only», a warning.
- Promo tiles: none uploaded as far as recorded.

## Permissions

The reason column is the public privacy policy, §«Permissions used, and why». The dashboard's own
justification texts, read from the Privacy tab on 2026-11-09, are below the table.

| Permission | Type | Reason | Install warning (measured 2026-10-17) |
|---|---|---|---|
| `tabCapture` | permissions | Record audio from the tab the user selects | «Read and change all your data on all websites». It is the only install warning of 2.2.0 and 2.2.1 (same permissions) |
| `offscreen` | permissions | Manifest V3 needs it to keep the recording running while the popup is closed | none |
| `storage` | permissions | Recording settings, consent state and IronMemo tokens in `chrome.storage.local` | none |
| `unlimitedStorage` | permissions | Long recordings must not be cut by Chrome's default quota (up to ~65 MB per hour with all tracks) | none |
| `https://app.ironmemo.com/*` | optional_host_permissions | Requested only when the user clicks Transcribe and accepts the cloud consent | none once granted (covered by the line above) |
| `contextMenus` (from 2.2.4, P300-28d) | permissions | One item, «Record this tab with IronMemo», on page menus and on the tab strip's menu of a tab | none: the warning list equals 2.2.3's on CfT 152 and 157 (2026-11-09, `.claude/scripts/permission_warnings_p300_28d.py`) |
| `commands` → `record-this-tab` (same version; a manifest key, not a permission) | commands | Ctrl+Shift+Y (⌘⇧Y on Mac) records the open tab | none (same measurement) |

**Dashboard justification for `contextMenus`** (saved in the Privacy tab with the 2.2.4 draft on 2026-11-09; the
dashboard showed the new field empty and kept «Submit for review» disabled until it was filled; SHA-256 after a
reload `e131fefd…`):
«Adds one item, “Record this tab with IronMemo”, to the right-click menu of web pages and of tabs in the tab strip.
Choosing it starts recording the audio of that tab — the same action as pressing Start in the extension's popup on
that tab — so a user can record a meeting that runs in another tab or window without switching to it first. The
extension uses only the tab's id from the click; the page address, selected text and link passed with the click are
not used or stored.»

**The other justifications in the Privacy tab** (read 2026-11-09, not changed by the agent; when they were written is
not recorded):
- `tabCapture`: «Records the audio of the browser tab the user selected. This is the tab-audio recording feature the extension is built for. The tab-audio stream is used only while the user is actively recording and only from the specific tab they picked; no page content, DOM, or navigation data is accessed.»
- `offscreen`: «The recording pipeline (Web Audio, MediaRecorder / WebCodecs encoder, and the OPFS writer) lives in an offscreen document so that the capture continues even when the tab the user is recording, or the popup, is closed. Manifest V3 service workers cannot own long-lived MediaStreams, so an offscreen document is the only way to keep a recording running for an entire meeting.»
- `storage`: «Stores the user's own settings (audio device, encoder choice, bitrate, segment length, and the consent-screen versions they accepted) in chrome.storage.local. Also stores the per-session recording journal so a session can be recovered after a Chrome restart, and, if the user chose to sign in via the optional Transcribe flow, the IronMemo authentication tokens for that account.»
- `unlimitedStorage`: «The extension writes each recording to the browser's Origin Private File System. Chrome's default temporary-storage quota for an extension can drop under 100 MB on a nearly-full disk, which is not enough for a workday of meetings. At 48 kbps Opus times three role files this is about 64 MB per hour. unlimitedStorage is requested so the practical limit is the user's available disk space, not the shared browser quota. Local files stay on disk; a recording is only sent to IronMemo when the user clicks Transcribe on it.»
- Remote code: «No, I am not using Remote code» (selected; its justification field is empty).
- The optional host permission `https://app.ironmemo.com/*` has no justification field in the tab.

**Before adding a permission**, measure what it adds. «When a new permission that triggers a warning
is added, the extension will be disabled until the user accepts the new permission»
([permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)).
Measured 2026-10-17 on Chrome for Testing with `chrome.management.getPermissionWarningsByManifest`:

| Added to 2.2.0 | New install warning |
|---|---|
| `tabs` | none: the `tabCapture` line already covers it |
| `activeTab` | none |
| `desktopCapture` | «Capture content of your screen» |
| `downloads` | «Manage your downloads» |
| `notifications` | «Display notifications» |

## Remote code

None. All JavaScript ships in the package. A grep of `apps/extension-audio` on 2026-10-17 found no
remote `<script src>`, remote `import()`, `importScripts` from the network, `eval` or `new Function`.
The answer saved in the dashboard has not been copied here yet.

## Privacy and data use

As shown on the public listing on 2026-10-17:

- Declared data: personally identifiable information, authentication information, personal communications, website content.
- Certifications, all three: not sold to third parties; not used for purposes unrelated to the core function; not used for creditworthiness or lending.

What leaves the device: nothing, until the user clicks Transcribe on one recording and accepts the
cloud consent. Then that recording goes to app.ironmemo.com and its speech-to-text sub-processors,
which are named in privacy policy §3.

Privacy policy: https://igorsaevets.github.io/ironmemo-recorder/privacy-policy.html (`docs/privacy-policy.html`).
On 2026-10-17 it answered HTTP 200, contained the Limited Use statement, and showed «Effective date: 8 October 2026».

## Distribution and developer

- Visibility: public, the listing opens without signing in. Regions: not recorded.
- Publisher: Ironmemo. The contact e-mail and address are kept in the dashboard and not copied here.
- Support: https://github.com/igorsaevets/ironmemo-recorder/issues
- Homepage (`homepage_url`): https://igorsaevets.github.io/ironmemo-recorder/

## In 2.2.6 — the server's reason for a failed recording (P300-30 / BACKLOG P300-7; code 2026-11-13; release prepared 2026-11-13, P300-30b; never uploaded: ships as 2.2.7 with the P300-30c fix `2edca3c`)

- A recording the server failed for a reason it names gets that reason and the one action that helps, instead of
  «Failed: IronMemo could not process the recording» + Retry (which re-sent a finished upload): «IronMemo is looking
  into this recording» (staff were notified; the row reads the recording again about once a minute while the
  Recordings page is visible, and on «Check again»), «IronMemo needs this recording uploaded again» and «The upload did
  not finish» («Upload again» sends the local recording as a new one), «Already on IronMemo» («Open the earlier
  recording»), «IronMemo could not read this file». A key this version does not know keeps the old row. Keys and their
  server texts: iron-note-backend origin/main `b6f0d182` (`recordings_ext/errors.py`, `views.py` `_recording_to_dto`).
- A 429 / 503 with `Retry-After` (header or `params.retry_after`) is not retried earlier than asked, and the page's
  once-a-minute re-read of a parked or held row waits it out too; a wait over 5 minutes ends the background retries
  with «too many requests — try later». The upload gates' 403 `error.403.email_required` pauses the upload with
  «verify your e-mail», like the local check.
- Measured on the mock server only (`.claude/scripts/test_ingest.py` on CfT 152; project folder
  `03-research/2026-11-13-p300-30-server-reasons/RESULT.md`): these outcomes come from storage loss, holds and staff
  verdicts, which cannot be caused on production on demand.
- No new permission, no privacy-policy change: the two fields now kept (`failure_under_investigation`,
  `duplicate_of`) come from the recording's status answer that the extension already reads and stores. The manifest
  differs from 2.2.5 only in `version`.

## In 2.2.5 — «Meeting or voice note» for an old «Microphone only» (P300-23c, P300-10; release prepared 2026-11-09, P300-29; draft uploaded 2026-11-13, P300-29b; submitted by the owner 2026-11-13, pending review)

- Settings storage keeps only the values that differ from the build's defaults (Options used to store the whole
  object, so every default of its day stayed pinned); Reset removes the stored object. A stored «Microphone only» the
  user never confirmed (`ironmemo.sourceChoice.v1` holds the answer) makes Start ask once: «Meeting: record tab audio
  too» or «Voice note: microphone only»; the answer starts the recording. Start ships disabled and is enabled when the
  popup is ready (P300-10: an early click was lost).
- Measured on CfT 152 and 157: `tests/test_p300_23c_mode_choice.py` 34/34 each, the pre-change code 14/34
  (`03-research/2026-11-09-p300-23c-mode-choice/RESULT.md`, project folder). Every store version since 0.6.0 has the
  same 68 settings and the same defaults as 2.2.5 except `source.mode` (`mic` up to 2.2.0) — so an old whole object
  holds no other stale default.
- No new permission, no privacy-policy change: the answer is a recording preference in `chrome.storage.local`, which
  the policy's §1, §4 and §9 already name. The manifest differs from 2.2.4 only in `version`.

## In 2.2.4 — «Record this tab» (P300-28d; release prepared 2026-11-09, P300-28e; not submitted while 2.2.3 is in review)

- A right-click item «Record this tab with IronMemo» on web pages and, from Chrome 150, on a tab in the tab strip, and
  the shortcut Ctrl+Shift+Y (⌘⇧Y on Mac): IronMemo records exactly that tab (plus the microphone per settings), in
  any window, also a background tab. Before the recording notice is accepted, the item opens the popup with the notice
  and starts after Continue. During a recording it starts nothing and the popup says so. Under «Microphone only» this
  one recording also takes the tab; the saved setting is unchanged and the capture report records it.
- Measured on CfT 152.0.7977.82 and 157.0.8103.38 with a tone per tab: every entry recorded the intended tab (margin
  ≥ 67 dB over the other tones), a never-invoked tab is refused with a readable message, install warnings unchanged,
  START benches green. `03-research/2026-11-09-p300-28d-record-this-tab/RESULT.md` (project folder, not this repo).
- Privacy policy §9 names `contextMenus` and the shortcut «from version 2.2.4». The manifest differs from 2.2.3 in
  `version`, `permissions` (+ `contextMenus`) and the new `commands` key; one file added (`src/shared/record-entry.js`).
- The dashboard lets a draft change during a review only through «Cancel review» (developer.chrome.com/docs/webstore/update,
  read 2026-11-09), so 2.2.4 is uploaded after Google publishes 2.2.3. Owner's cadence (2026-11-09): a new version
  every other day.

## In 2.2.3 — changes of 2026-11-06 and 2026-11-08 (release prepared 2026-11-08, P300-27)

- P300-23c (capture-build subtask, 2026-11-08): every recording's `capture-report.json`
  (now `version: 3`) names the build that CREATED it: `build.version`,
  `build.installType` (`chrome.management.getSelf()`; `null` + `installTypeNote` when
  unknown, never a guess), `build.storeItem`, `capturedAt`, `capturedBy`. The service
  worker snapshots it when Start arrives (the offscreen document has only
  `chrome.runtime`), bounded at 1 s; the same object goes into the report written at
  Start, the final report and the journal's `session_open` line, so an update or a
  later recovery never relabels a recording. Version-2 reports have no `build`.
- Measured with `tests/test_p300_23c_build.py` (real synthetic capture in CfT 152: fake
  microphone + local tone tab, no device, no network): 43/43 (23/43 on the unchanged
  code — every build check failed, so the old comment saying the data was saved was
  wrong). Includes getSelf hanging (Start 1.1 s, `installType: null` with the reason)
  and throwing, an update between recordings (the old report stays byte-identical), an
  update DURING a recording (the new build checks the orphan; its report keeps the old
  version) and an old version-2 report. Regressions: `test_p300_25.py` 96/96 (all six
  engine cases carry `build`), `tests/test_p300_23c_sources.py` 25/25, mock ingest bench
  `.claude/scripts/test_ingest.py` 137/137. No permissions,
  privacy/data-flow or API changes: the report stays in OPFS and is never uploaded.
- P300-26 (2026-11-08): a recording the server ends as **no speech** (backend since
  2026-11-04: `failure_message_key` `error.409.recording_no_speech`, reason `no_speech`,
  or `empty_transcript` for failures from before stapel-recordings 0.43.0) now reads
  **No speech heard — nothing to transcribe.** with what to check: a muted, blocked or
  wrong microphone, or a silent tab. Retry and Dismiss are gone from that row, since
  sending the same file again gets the same answer; **Delete on server** stays. Every
  other server error renders as before. The local job record now keeps the DTO's
  `failure_reason` and `failure_message_key`.
- Measured with the mock bench `.claude/scripts/test_ingest.py` in CfT 152: 137/137
  (131/131 on the unchanged code; 6 new gates: no speech by key, by the legacy reason,
  by the reason alone, Delete on server, and two controls that must stay generic).
  Production has 3 `no_speech` failures since 2026-11-02, all web uploads (read-only
  DB count). No permissions, privacy/data flow or API changes.
- P300-23c (source-label subtask, 2026-11-06): Recordings shows **Microphone only** with
  **No tab audio track in this recording.** when the saved source evidence supports
  it. A microphone-only mix is supported; ambiguous mixes, contradictory tab
  evidence and active/paused captures are left unclassified. Rename/reopen retains
  the label. The mix asset is called **Mix**, since it can contain one source.
- Measured with offline metadata/filename fixtures in CfT 152: 25/25 checks,
  including legacy `.part` and recovered files. This is UI/source classification,
  not an audio-audibility test. Test: `tests/test_p300_23c_sources.py`.
- These three changes ship in manifest **2.2.3** (P300-27); the manifest differs from
  2.2.2 only in `version`. No permissions, privacy/data flow or cloud API changes.
  The store screenshots still show the 2.1.0 Recordings page (see Graphics).

## Version history

| Version | Submitted | Status | Summary |
|---|---|---|---|
| 2.2.6 | **Never uploaded — superseded by 2.2.7.** The pre-upload review (P300-30c, 2026-11-14) found that a lost create after «Upload again» could adopt the old failed server row or stop at `ambiguous_create`; fixed in `2edca3c` (mock bench 162/162 on CfT 152). Do not upload this zip. Release commit `6911c94` (2026-11-13, P300-30b). Zip `builds/ironmemo-recorder-v2.2.6.zip`: 49 files, 249 266 B, SHA-256 `d55ee9c8f69828c8dc97dda05226655a00ea633e500cd48792fc6f05c78a40d0`, built from the pushed commit and byte-equal to it; the manifest differs from 2.2.5 only in `version`; 6 files differ from the 2.2.5 zip = `git diff 3ecc439..6911c94`. Benches: mock ingest 155/155 on CfT 152, 157 and 158; smoke 8/8, first start OK, recording 20/20, sources 25/25, build 43/43, engines 96/96, P300-23 19/19, mode choice on the unpacked zip 34/34 on CfT 152, 157 and 158; «Record this tab» on the unpacked zip 13/16 on each in the suite (the tab-strip menu never opened for UI Automation), re-runs of that step 5/5 on CfT 152 and 157, on CfT 158 every step but S5b (three tries, the menu not found each time; menu code unchanged since 2.2.4). Production 22/22 on a fresh account (completed, transcript stored, delete 404, sign-out 401, every request tagged 2.2.6). EN + RU texts ready: EN `ce927694…` (4 679 UTF-16), RU `6d372a8d…` (4 718); `03-research/2026-11-13-p300-30b-release-226/RESULT.md` (project folder) | Prepared; uploaded after 2.2.5 is published | A recording the server failed for a reason it names shows that reason and the one action that helps — «Upload again» (sends the local recording as a new one), a link to the earlier recording of a duplicate, «nothing to do» while IronMemo looks into it — instead of «could not process» with Retry; a server's `Retry-After` is honoured; an upload refused with «verify your e-mail» pauses for the e-mail |
| 2.2.5 | **PUBLISHED** (store date 2026-11-13; the update service served 2.2.5 by 07:28 UTC 11-14, gate `public_version.py --expect 2.2.5` → OK; listing 42 users); the public CRX = this zip, 49/49 byte-equal (`compare_crx.py` VERDICT OK, P300-30c, 2026-11-14). Draft uploaded by the agent on 2026-11-13 at 13:02 UTC (P300-29b), after 2.2.4 was published; the owner pressed «Submit for review» the same day between 13:04 and 13:34 UTC. `compare_crx.py → VERDICT: OK` (draft CRX 251 637 B, SHA-256 `6be6e093…`, 49/49 byte-equal to the zip; the store adds only `_metadata/verified_contents.json` and `update_url`). The console held exactly the 2.2.4 texts before the change (EN `8b4fee75…`, RU `74c1c10c…`); after a reload EN `81b2642a…` (4 203 UTF-16 chars) and RU `928e7cda…` (4 251), the texts of `3ecc439`. Package page: Draft 2.2.5, permissions unchanged (`tabCapture, offscreen, storage, unlimitedStorage, contextMenus`); no error after the upload. Also on Chrome for Testing 158 (Chrome 158 reached Stable 2026-11-12): mode choice on the unpacked zip 34/34; «Record this tab» 16/16 after a re-run of the tab-strip steps, whose UI Automation menu had not opened (13/16, then 5/5). `03-research/2026-11-13-p300-29b-upload-225/RESULT.md` (project folder). Release commit `3ecc439` (2026-11-09, P300-29). Zip `builds/ironmemo-recorder-v2.2.5.zip`: 49 files, 246 267 B, SHA-256 `c6af530ef21eee0194a89b854946ffec0aaae822024b1f82eacfd291122a8fb5`, byte-equal to the commit; the manifest differs from 2.2.4 only in `version`. Benches green (smoke 8/8, first start OK, recording 20/20, sources 25/25, build 43/43, engines 96/96, mock ingest 137/137, P300-23 19/19, mode choice on the unpacked zip 34/34 on CfT 152 and 157, «Record this tab» on the unpacked zip 16/16 on CfT 152 and on CfT 157 after a re-run of the tab-strip step, whose UI Automation menu had not opened); an update over profiles that 2.2.0 and 2.2.4 themselves wrote asks once, records the tab after «Meeting», keeps only the user's own change (CfT 152/157, 74/74; the same with 2.2.4 as the target 23/37); production 22/22 on a fresh account. `03-research/2026-11-09-p300-29-release-225/RESULT.md` (project folder) | Pending review: the console read `Status: Pending review` at 13:34 UTC on 2026-11-13, before and after a reload («Submit for review» and «Save draft» disabled); the update service still served 2.2.4 at 13:33 UTC, and the item stays `Published - public` at 2.2.4 until Google publishes 2.2.5 | A «Microphone only» setting left by an older version makes the first Start ask once «Meeting» (tab audio too) or «Voice note» (microphone only); settings keep only what differs from the defaults; Start is enabled when the popup is ready |
| 2.2.4 | Draft uploaded by the agent on 2026-11-09 at 10:36 UTC, at the owner's request (P300-28f); the owner pressed «Submit for review» the same day. `compare_crx.py → VERDICT: OK` (draft CRX 249 804 B, SHA-256 `8ed91a0c…`, 49/49 byte-equal to the zip; the store adds only `_metadata/verified_contents.json` and `update_url`). The package page lists the permissions `tabCapture, offscreen, storage, unlimitedStorage, contextMenus`; EN + RU descriptions and the `contextMenus` justification saved (hashes checked after a reload). Release commit `b0b2d80` (2026-11-09, P300-28e). Zip `builds/ironmemo-recorder-v2.2.4.zip`: 49 files, 244 431 B, SHA-256 `5d18459f6997baee899af3e053295c5de52e671711a5274b69ac1d6fcbf70e01`, byte-equal to the commit; the manifest differs from 2.2.3 only in `version`, `permissions` (+ `contextMenus`) and `commands`. Benches green (smoke 8/8, first start OK, recording 20/20, sources 25/25, build 43/43, engines 96/96, mock ingest 137/137, «Record this tab» on the unpacked zip 16/16 on CfT 152 and 157); an update 2.2.3 → 2.2.4 keeps the id and gets Ctrl+Shift+Y and the menu item (CfT 152/157, 6/6); production 22/22 on a fresh account. `03-research/2026-11-09-p300-28e-release-224/RESULT.md` (project folder) | Published: the owner submitted it on 2026-11-09 between 10:40 and 10:49 UTC (the console read `Status: Pending review` at 10:49 UTC); the public listing reads Version 2.2.4, «Updated November 9, 2026», 42 users (read 2026-11-13); the owner's Chrome took 2.2.4 on 2026-11-11 at 02:31 UTC (profile fields, read-only), enabled. The public CRX fetched 2026-11-13 is the same file as the draft CRX (249 804 B, SHA-256 `8ed91a0c…`), 49/49 byte-equal to the zip: `compare_crx.py → VERDICT: OK`. A real store update 2.2.3 → 2.2.4 (Chrome for Testing 152, the kept P300-27b store install, 2026-11-13): `requestUpdateCheck()` answered `update_available` 2.2.4, Chrome applied it at the next start; the item stayed enabled, the «Record this tab» menu item exists (an unknown id answers «Cannot find menu item»), and a recording wrote `build` = {2.2.4, normal, storeItem true} (P300-29b) | «Record this tab with IronMemo» on the right-click menu of a tab (Chrome 150+) and of a page, and Ctrl+Shift+Y: records that tab, in any window, also a background one, without switching to it |
| 2.2.3 | 2026-11-08 (owner submitted; the console read `Status: Pending review`, Draft 2.2.3, at 2026-11-09 00:21 UTC). Draft uploaded and descriptions saved by the agent with the owner's go-ahead. `compare_crx.py → VERDICT: OK` (draft CRX 244 913 B, 48/48 byte-equal to `builds/ironmemo-recorder-v2.2.3.zip`, SHA-256 `71905dff…`; the store adds only `_metadata/verified_contents.json` and `update_url`). Benches on the release tree all green (smoke 8/8, first start OK, recording 20/20, sources 25/25, build 43/43, engines 96/96, mock ingest 137/137); production 22/22 twice on fresh accounts: a normal recording (completed, `build.version` 2.2.3 in the capture report) and a silent one (the server answered `error.409.recording_no_speech`, the row read «No speech heard», no credit charged) — `03-research/2026-11-08-p300-27-release-223/RESULT.md` | Published 2026-11-09 (the update service served 2.2.2 at 09:41 UTC and 2.2.3 at 10:34 UTC; the public listing reads Version 2.2.3, «Updated November 9, 2026», 40 users). The public CRX (244 913 B, SHA-256 `f0dd4009…`, the same file as the draft CRX) is 48/48 byte-equal to the zip: `compare_crx.py → VERDICT: OK`. A store install reports `installType: "normal"`: Chrome for Testing 152 installed 2.2.3 from the store page, a 6-s recording wrote `build` = {version 2.2.3, installType normal, storeItem true} into its `capture-report.json`, and the popup hid its build line (P300-27b, 2026-11-09; `03-research/2026-11-09-p300-27b-store-install/RESULT.md`, project folder) | A recording the server ends as «no speech» reads «No speech heard — nothing to transcribe.» with what to check and no Retry; the Recordings page marks microphone-only recordings «Microphone only»; every `capture-report.json` names the build that created it |
| 2.2.2 | 2026-10-30 (owner submitted, dialog «Your extension was submitted for review»; `Status: Pending review`, Submit button disabled). Draft uploaded + descriptions saved by the agent, `compare_crx.py → VERDICT: OK` (48/48 byte-equal, store adds only `_metadata/verified_contents.json` and `update_url`). Prod bench 21/21 on a fresh `+p222prod` account (`03-research/2026-10-30-p300-24c-release-222/RESULT.md`) | Published: the listing says «Updated October 31, 2026» (40 users on 2026-11-08). The public CRX fetched 2026-11-08 through `clients2.google.com/service/update2/crx` (242 208 B, SHA-256 `8916eb77468ac82e1189fe1e9f9636e1545396e264ff303a39f3a6156b90a741`) matches `builds/ironmemo-recorder-v2.2.2.zip`, 48 of 48 files byte-equal. A production run of that zip on 2026-11-08 passed 21/21: the upload reached MinIO on our own host (server log), and the DELETE removed both the database row and the stored objects (`03-research/2026-11-08-upload-check/RESULT.md`) | A link in the popup footer and the Recordings header to `ironmemo.com/transcribe` (UTM-tagged for traffic analytics only, no user data); the small «Chrome Web Store» build line is hidden for a normal store install (it stays visible with the orange highlight for unpacked / sideload / admin builds, which is the only case where the diagnostic is useful) |
| 2.2.1 | 2026-10-20 (Igor submitted); 2026-10-21 (approved; «Updated October 21, 2026») | Published. The public CRX (via `clients2.google.com/service/update2/crx`, 241 435 B, SHA-256 `2391cb4566309773a32e50478e50a79da85efab6d8115dcd5073dfdab027b1cd`) matches `builds/ironmemo-recorder-v2.2.1.zip`, 48 of 48 files byte-equal; the store adds only `_metadata/verified_contents.json` and `update_url` in the manifest (`runs/p300-24b/`). Igor's own Chrome has auto-updated to 2.2.1 (store install, no saved settings → records mic + tab by default) | A new install records microphone + tab; its first Start no longer fails after the microphone permission page; a profile with no saved settings records WebCodecs/Ogg; the popup shows the version and warns on «Microphone only»; WebM downloads seek. Production run 21/21 with an Ogg upload |
| 2.2.0 | 2026-10-08 | Published. The listing says «Updated October 8, 2026»; seen live 2026-10-11; 57 users on 2026-10-17 | The account line, the price before an upload, «waiting for payment», accounts with several workspaces. The store's draft CRX matched the tested zip, 46 of 46 files byte-equal, and so did the published CRX on 2026-10-20 |
| 2.1.0 | 2026-09-28 | Published the same day; superseded | Player, trim, rename, markers, mic picker, level meter |
| 0.6.0 | 2026-09-13 | Published 2026-09-14; superseded | Opt-in cloud transcription, e-mail claim, cloud consent |
| 0.5.0 | 2026-09-12 | Superseded by 0.6.0; whether it went public is not recorded | New title, EN and RU descriptions |
| 0.4.0 | 2026-09-10 | Published by 2026-09-12; superseded | First submission |

Versions 2.1.1–2.1.5 were local builds and were never submitted. Their changes shipped in 2.2.0.

## Review notes

- Rejections: none recorded for this item.
- Open listing questions, kept in `docs/cws-listing-draft.md` → «Items NOT changed»:
  - the title wording (a keyword-spam risk flagged 2026-09-22; the owner decides);
  - platform detection, which stays dead code without `activeTab` or `tabs`.
- The descriptions say the extension «requests no host permissions at install». That is true of the
  manifest, but the install dialog still shows the `tabCapture` line «Read and change all your data on
  all websites». The descriptions do not explain that line yet.
