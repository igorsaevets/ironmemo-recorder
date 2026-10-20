# Chrome Web Store record — IronMemo

> Last Updated: 2026-10-20 · item `epnajjfddhbhgabhmcaomfnjhnhjnchd` · publisher «Ironmemo»

This is the file Google's `chrome-extensions` agent skill (GoogleChrome/modern-web-guidance) keeps
for an extension: what the Developer Dashboard asks for, and where each value comes from. One home
per fact: the long EN and RU descriptions live in `docs/cws-listing-draft.md` and are edited there,
never copied here. This file sits outside `apps/extension-audio/`, so it never enters the store zip.

## Store listing

| Field | Value | Source |
|---|---|---|
| Name | `IronMemo: Free Audio Recorder & Transcribe Meetings & AI Notetaker` (66 of 75 chars; RU name 66) | `_locales/<lang>/messages.json` → `extensionName`. The store takes it from the package: it changes only with a new version |
| Summary | EN 121, RU 115 of 132 chars | `_locales/<lang>/messages.json` → `extensionDescription`, same rule |
| Detailed description | EN + RU saved with the 2.2.1 draft on 2026-10-20 (SHA-256 checked after a reload) | `docs/cws-listing-draft.md` |
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

## Version history

| Version | Submitted | Status | Summary |
|---|---|---|---|
| 2.2.1 | draft uploaded 2026-10-20; the owner submits | Draft. The draft CRX matched the tested zip, 48 of 48 files byte-equal | A new install records microphone + tab; its first Start no longer fails after the microphone permission page; a profile with no saved settings records WebCodecs/Ogg; the popup shows the version and warns on «Microphone only»; WebM downloads seek. Production run 21/21 with an Ogg upload |
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
