# Chrome Web Store record — IronMemo

> Last Updated: 2026-11-09 · item `epnajjfddhbhgabhmcaomfnjhnhjnchd` · publisher «Ironmemo»

This is the file Google's `chrome-extensions` agent skill (GoogleChrome/modern-web-guidance) keeps
for an extension: what the Developer Dashboard asks for, and where each value comes from. One home
per fact: the long EN and RU descriptions live in `docs/cws-listing-draft.md` and are edited there,
never copied here. This file sits outside `apps/extension-audio/`, so it never enters the store zip.

## Store listing

| Field | Value | Source |
|---|---|---|
| Name | `IronMemo: Free Audio Recorder & Transcribe Meetings & AI Notetaker` (66 of 75 chars; RU name 66) | `_locales/<lang>/messages.json` → `extensionName`. The store takes it from the package: it changes only with a new version |
| Summary | EN 121, RU 115 of 132 chars | `_locales/<lang>/messages.json` → `extensionDescription`, same rule |
| Detailed description | EN + RU saved with the 2.2.3 draft on 2026-11-08, the «New in» paragraph now opening with 2.2.3 (SHA-256 of each locale checked after a reload: EN `e0226459…`, RU `5766d684…`). The 2.2.4 text (the paragraph opening with «New in 2.2.4») is ready in the draft file and not in the console yet | `docs/cws-listing-draft.md` |
| Category | Workflow & Planning | public listing, 2026-10-17 |
| Languages | English, Russian | public listing, 2026-10-17 |
| Single purpose | **not recorded here yet** | Dashboard → Privacy tab; copy it in on the next console visit |

## Graphics

- Store icon: `apps/extension-audio/icons/icon128.png` (the package icon).
- Screenshots: 5 at 1280×800, uploaded 2026-09-28 for 2.1.0. Not compared with the 2.2.0 UI, which
  added the account line (credits and free minutes) and the price before an upload, or with 2.2.1, whose popup
  shows a version line and, for «Microphone only», a warning.
- Promo tiles: none uploaded as far as recorded.

## Permissions

The reason column is the public privacy policy, §«Permissions used, and why». The dashboard's own
justification texts have not been copied here yet.

| Permission | Type | Reason | Install warning (measured 2026-10-17) |
|---|---|---|---|
| `tabCapture` | permissions | Record audio from the tab the user selects | «Read and change all your data on all websites». It is the only install warning of 2.2.0 and 2.2.1 (same permissions) |
| `offscreen` | permissions | Manifest V3 needs it to keep the recording running while the popup is closed | none |
| `storage` | permissions | Recording settings, consent state and IronMemo tokens in `chrome.storage.local` | none |
| `unlimitedStorage` | permissions | Long recordings must not be cut by Chrome's default quota (up to ~65 MB per hour with all tracks) | none |
| `https://app.ironmemo.com/*` | optional_host_permissions | Requested only when the user clicks Transcribe and accepts the cloud consent | none once granted (covered by the line above) |
| `contextMenus` (from 2.2.4, P300-28d) | permissions | One item, «Record this tab with IronMemo», on page menus and on the tab strip's menu of a tab | none: the warning list equals 2.2.3's on CfT 152 and 157 (2026-11-09, `.claude/scripts/permission_warnings_p300_28d.py`) |
| `commands` → `record-this-tab` (same version; a manifest key, not a permission) | commands | Ctrl+Shift+Y (⌘⇧Y on Mac) records the open tab | none (same measurement) |

**Dashboard justification for `contextMenus` (paste it into the Privacy tab when 2.2.4 is uploaded; not in the console yet):**
«Adds one item, “Record this tab with IronMemo”, to the right-click menu of web pages and of tabs in the tab strip.
Choosing it starts recording the audio of that tab — the same action as pressing Start in the extension's popup on
that tab — so a user can record a meeting that runs in another tab or window without switching to it first. The
extension uses only the tab's id from the click; the page address, selected text and link passed with the click are
not used or stored.»

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
| 2.2.4 | Not yet. Release commit `b0b2d80` (2026-11-09, P300-28e). Zip `builds/ironmemo-recorder-v2.2.4.zip`: 49 files, 244 431 B, SHA-256 `5d18459f6997baee899af3e053295c5de52e671711a5274b69ac1d6fcbf70e01`, byte-equal to the commit; the manifest differs from 2.2.3 only in `version`, `permissions` (+ `contextMenus`) and `commands`. Benches green (smoke 8/8, first start OK, recording 20/20, sources 25/25, build 43/43, engines 96/96, mock ingest 137/137, «Record this tab» on the unpacked zip 16/16 on CfT 152 and 157); an update 2.2.3 → 2.2.4 keeps the id and gets Ctrl+Shift+Y and the menu item (CfT 152/157, 6/6); production 22/22 on a fresh account. `03-research/2026-11-09-p300-28e-release-224/RESULT.md` (project folder) | Waiting for 2.2.3 to be published (the update service still served 2.2.2 at 2026-11-09 05:46 UTC) | «Record this tab with IronMemo» on the right-click menu of a tab (Chrome 150+) and of a page, and Ctrl+Shift+Y: records that tab, in any window, also a background one, without switching to it |
| 2.2.3 | 2026-11-08 (owner submitted; the console read `Status: Pending review`, Draft 2.2.3, at 2026-11-09 00:21 UTC). Draft uploaded and descriptions saved by the agent with the owner's go-ahead. `compare_crx.py → VERDICT: OK` (draft CRX 244 913 B, 48/48 byte-equal to `builds/ironmemo-recorder-v2.2.3.zip`, SHA-256 `71905dff…`; the store adds only `_metadata/verified_contents.json` and `update_url`). Benches on the release tree all green (smoke 8/8, first start OK, recording 20/20, sources 25/25, build 43/43, engines 96/96, mock ingest 137/137); production 22/22 twice on fresh accounts: a normal recording (completed, `build.version` 2.2.3 in the capture report) and a silent one (the server answered `error.409.recording_no_speech`, the row read «No speech heard», no credit charged) — `03-research/2026-11-08-p300-27-release-223/RESULT.md` | Pending review | A recording the server ends as «no speech» reads «No speech heard — nothing to transcribe.» with what to check and no Retry; the Recordings page marks microphone-only recordings «Microphone only»; every `capture-report.json` names the build that created it |
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
