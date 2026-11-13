# CWS Listing Description — v2.2.6 draft

v2.2.6 (2026-11-13, P300-30b): the «New in» line names the one user-visible change in 2.2.6 — a recording the
server failed for a reason it names shows that reason and the one action that helps («Upload again», a link to the
earlier recording, «nothing to do») instead of a general error with Retry (P300-30); the 2.2.5, 2.2.4, 2.2.3, 2.2.2,
2.2.1 and 2.2.0 items stay in the same paragraph.
v2.2.5 (2026-11-09, P300-29): the «New in» line names the one user-visible change in 2.2.5 — a «Microphone only»
setting left by an older version makes the first Start ask once «Meeting» or «Voice note» (P300-23c); the 2.2.4,
2.2.3, 2.2.2, 2.2.1 and 2.2.0 items stay in the same paragraph.
v2.2.4 (2026-11-09, P300-28e): the «New in» line names the one user-visible change in 2.2.4 — «Record this tab with
IronMemo» on the tab's and the page's right-click menu, and the Ctrl+Shift+Y shortcut (P300-28d); the 2.2.3, 2.2.2,
2.2.1 and 2.2.0 items stay in the same paragraph.
v2.2.3 (2026-11-08, P300-27): the «New in» line names the two user-visible changes in 2.2.3 — the «No speech heard»
row (P300-26) and the «Microphone only» label (P300-23c); the 2.2.2, 2.2.1 and 2.2.0 items stay in the same paragraph.
v2.2.2 (2026-10-30): the «New in» line adds the one user-visible change in 2.2.2 — a link in the popup and the
Recordings page that opens the service's own transcription landing (ironmemo.com/transcribe). The 2.2.1 and 2.2.0
items stay in the same paragraph.
v2.2.1 (2026-10-20, P300-24): the «New in» line names what 2.2.1 changes for users — a new install records the
microphone and the tab together, and the popup warns when only the microphone is recorded; the 2.2.0 items stay
in the same paragraph.
v2.2.0 (2026-10-08, P300-17): the cloud section describes what 2.1.1–2.1.5 added — the account line (credits +
free minutes), the price before an upload, «waiting for payment», accounts with several workspaces. «No time limit»
became «no artificial time limit; the real limit is free disk space» (CLAUDE.md, claims about unlimited).
v2.1.0 (2026-09-22): fixed re-audit findings R15 (stale guest-account claim) and R16 (overclaim about dialog naming
sub-processors).

These go into the CWS console textarea (per locale), NOT into the extension code.
Title and summary come from `_locales/<lang>/messages.json` and require a zip rebuild.
Every other Developer Dashboard field (permissions, privacy, version history): `../CHROMEWEBSTORE.md`.

---

## EN description (for CWS console, en locale)

```
Record meetings, lectures, interviews — no bot joins the call, nothing leaves your device unless you say so.

🎙 What it does

• Records microphone and browser tab audio at the same time
• Records while the popup is closed — your meeting is not interrupted
• Recovers audio after a Chrome crash (power-loss recovery is designed but not yet fully tested)
• Lets you play, rename, trim, and download recordings from a built-in session list
• Add timeline markers during playback for quick navigation later
• Choose which microphone to use
• Live level meter shows whether your mic is actually picking up sound

☁️ Optional cloud transcription

Click Transcribe on any recording to send it to IronMemo for a text transcript and AI summary. Before your first transcription, you verify your e-mail with a one-time code — IronMemo creates an account (or links to an existing one) so your transcripts are durable.

• First 10 minutes of transcription are free — per account, granted once your e-mail is verified
• See your IronMemo credits and remaining free minutes right on the Recordings page
• Know the price before you upload: the extension asks IronMemo what the recording will cost, and if the account cannot pay for all of it, it stops and lets you top up, send anyway, or cancel
• A recording that is waiting for payment says so — pay on IronMemo and it is processed without uploading it again
• Works with accounts in several IronMemo workspaces: the recording goes to your preferred or default workspace, otherwise to your personal one
• Each upload is a separate decision: a consent dialog explains what is sent, where, and links the privacy policy for the detailed list of speech-to-text and AI providers involved
• The local recording stays on your device — the upload is a copy, not a move
• You can delete the server copy at any time from the Recordings page

🆕 New in 2.2.6: when IronMemo cannot process a recording and says why, the Recordings page shows that reason and the one step that helps, instead of a general error with Retry: "The upload did not finish" and "IronMemo needs this recording uploaded again" offer "Upload again" (the recording in your browser goes up as a new one), "Already on IronMemo" links to the recording you uploaded earlier, and "IronMemo is looking into this recording" tells you there is nothing to do. New in 2.2.5: if an older version left IronMemo recording only your microphone, the first Start asks once whether it is a meeting ("Meeting: record tab audio too", so the other people are in the recording) or a voice note ("Voice note: microphone only"), and your answer starts the recording. New in 2.2.4: record a meeting from another tab or window without switching to it: right-click that tab and choose "Record this tab with IronMemo". The same item is on the page's right-click menu, and Ctrl+Shift+Y (⌘+Shift+Y on a Mac) records the tab you are on. New in 2.2.3: when a recording has no speech in it (say, a muted or blocked microphone), the Recordings page says so and tells you what to check, instead of offering to send the same file again; recordings that hold only your microphone are marked "Microphone only". New in 2.2.2: a link to transcribe your recordings on ironmemo.com — in the popup and the Recordings page. New in 2.2.1: a new install records your microphone and the tab together (before, only the microphone), and the popup warns you when only your microphone is being recorded. New in 2.2.0: credits and free minutes on the Recordings page, the price before an upload, a clear "waiting for payment" state, and accounts with several workspaces.

⛔ What it does NOT do

• Does not upload anything automatically — you choose which recordings to transcribe, one at a time
• Does not use your recordings to train any AI model
• Does not read page text, passwords, or browsing history
• Does not run analytics or crash-reporting inside the extension
• No bot joins the call — nothing appears in the participant list

💰 Pricing

Install and record for free, with no artificial time limit on local recordings — the real limit is your free disk space. Cloud transcription: first 10 minutes free per account; after that, recordings are processed only if the account has IronMemo credits. No subscription.

🔒 Privacy

All audio stays in your browser’s local storage (OPFS) until you choose to transcribe. The extension requests no host permissions at install — access to app.ironmemo.com is requested only when you accept the cloud consent on a specific recording.

Full details: https://igorsaevets.github.io/ironmemo-recorder/privacy-policy.html
Source code (MIT): https://github.com/igorsaevets/ironmemo-recorder
```

---

## RU description (for CWS console, ru locale)

```
Записывайте совещания, лекции, интервью — никакой бот не подключается к звонку, ничего не покидает ваше устройство без вашего решения.

🎙 Что делает

• Записывает микрофон и звук вкладки браузера одновременно
• Запись продолжается при закрытом попапе — совещание не прерывается
• Восстанавливает аудио после краша Chrome (восстановление после отключения питания спроектировано, но пока не полностью протестировано)
• Встроенный список сессий: воспроизведение, переименование, обрезка и скачивание записей
• Маркеры на временной шкале — расставляйте во время воспроизведения для быстрой навигации
• Выбор микрофона
• Индикатор уровня в реальном времени показывает, работает ли микрофон

☁️ Облачная транскрибация (опционально)

Нажмите «Транскрибировать» на любой записи, чтобы отправить её в IronMemo для получения текстовой расшифровки и AI-саммари. Перед первой транскрибацией вы подтверждаете e-mail одноразовым кодом — IronMemo создаёт аккаунт (или привязывает к существующему), чтобы ваши расшифровки сохранялись.

• Первые 10 минут транскрибации бесплатно — на аккаунт, после верификации e-mail
• Баланс кредитов IronMemo и оставшиеся бесплатные минуты видны прямо на странице «Записи»
• Цена — до загрузки: расширение спрашивает у IronMemo, сколько будет стоить запись, и если на счёте не хватает на всю запись, останавливается и предлагает пополнить счёт, отправить всё равно или отменить
• Запись, которая ждёт оплаты, так и помечена — оплатите на IronMemo, и она обработается без повторной загрузки
• Работает с аккаунтами в нескольких рабочих пространствах IronMemo: запись попадает в предпочтительное или основное пространство, а если их нет — в личное
• Каждая загрузка — отдельное решение: диалог согласия объясняет, что отправляется и куда, и ссылается на политику конфиденциальности для списка провайдеров
• Локальная запись остаётся на устройстве — загружается копия, не оригинал
• Серверную копию можно удалить в любой момент со страницы «Записи»

🆕 Новое в 2.2.6: если IronMemo не может обработать запись и называет причину, страница «Записи» показывает эту причину и один шаг, который поможет, а не общую ошибку с кнопкой Retry: при «The upload did not finish» и «IronMemo needs this recording uploaded again» есть кнопка «Upload again» (запись из браузера уйдёт как новая), «Already on IronMemo» ведёт к записи, загруженной раньше, а «IronMemo is looking into this recording» означает, что делать ничего не нужно. Новое в 2.2.5: если старая версия оставила запись только с микрофона, первое нажатие Start один раз спросит, встреча это («Meeting: record tab audio too» — тогда собеседники тоже попадут в запись) или голосовая заметка («Voice note: microphone only»), и ваш ответ сразу запускает запись. Новое в 2.2.4: встречу в другой вкладке или окне можно записать, не переключаясь на неё: нажмите на эту вкладку правой кнопкой и выберите «Записать эту вкладку в IronMemo». Тот же пункт есть в меню страницы, а Ctrl+Shift+Y (⌘+Shift+Y на Mac) записывает открытую вкладку. Новое в 2.2.3: если в записи нет речи (например, микрофон был выключен или заблокирован), страница «Записи» прямо говорит об этом и подсказывает, что проверить, а не предлагает отправить тот же файл ещё раз; записи только с вашего микрофона помечены «Microphone only». Новое в 2.2.2: ссылка на расшифровку записей на ironmemo.com — в окне расширения и на странице «Записи». Новое в 2.2.1: после установки записываются сразу микрофон и звук вкладки (раньше — только микрофон), а окно расширения предупреждает, когда записывается только ваш микрофон. Новое в 2.2.0: кредиты и бесплатные минуты на странице «Записи», цена до загрузки, понятный статус «ждёт оплаты» и аккаунты с несколькими рабочими пространствами.

⛔ Чего НЕ делает

• Ничего не загружает автоматически — вы сами выбираете, какую запись транскрибировать
• Не использует ваши записи для обучения AI-моделей
• Не читает текст страниц, пароли и историю браузера
• Не содержит аналитики и крэш-репортинга
• Бот не подключается к звонку — ничего не видно в списке участников

💰 Стоимость

Установка и локальная запись бесплатны, без искусственного ограничения по времени — реальный предел задаёт свободное место на диске. Облачная транскрибация: 10 бесплатных минут на аккаунт; далее — только при наличии кредитов IronMemo. Без подписки.

🔒 Конфиденциальность

Всё аудио хранится в локальном хранилище браузера (OPFS), пока вы сами не решите транскрибировать. Расширение не запрашивает разрешений на сайты при установке — доступ к app.ironmemo.com запрашивается только при согласии на загрузку конкретной записи.

Подробнее: https://igorsaevets.github.io/ironmemo-recorder/privacy-policy.html
Исходный код (MIT): https://github.com/igorsaevets/ironmemo-recorder
```

---

## Changes from v2.2.5 listing (v2.2.6)

1. **«New in» line** (EN + RU), runtime-tested on the mock server with Chrome for Testing 152.0.7977.82
   (`.claude/scripts/test_ingest.py` 155/155, 18 checks new; `03-research/2026-11-13-p300-30-server-reasons/RESULT.md`
   in the project folder), each status answer built from iron-note-backend origin/main `b6f0d182`, still its head on
   2026-11-13: each named outcome shows its own row and button; «Upload again» makes one new recording and leaves the
   old one; the «Already on IronMemo» link points at the earlier recording's page; an unknown key keeps the old row
   with Retry. Release suite and production run: `03-research/2026-11-13-p300-30b-release-226/RESULT.md`.
2. **No new permission**: the manifest differs from 2.2.5 only in `version`.
3. **Not claimed**: that the web app opens the earlier recording when it sits in another workspace (not tested); that
   a server's «try again later» wait is honoured (`Retry-After`: measured on the mock server only, and whether
   production sends it is not known); the «verify your e-mail» pause of an upload (the extension asks for the e-mail
   before the first upload, so users do not meet it); «IronMemo could not read this file» (in the build, left out of
   the sentence for length).

## Changes from v2.2.4 listing (v2.2.5)

1. **«New in» line** (EN + RU), runtime-tested in CfT 152.0.7977.82 and 157.0.8103.38 with Chrome's fake microphone
   and a tone tab (P300-23c bench 34/34 on each; the same bench on the pre-change code 14/34): a stored «Microphone
   only» without the user's own answer makes Start ask instead of recording; «Meeting» records the microphone and the
   tab (the tone is in the tab track), «Voice note» the microphone only, and the answer is not asked again
   (`03-research/2026-11-09-p300-23c-mode-choice/RESULT.md` in the project folder). An update over a profile whose
   settings an older version wrote: `03-research/2026-11-09-p300-29-release-225/RESULT.md`.
2. **No new permission**: the manifest differs from 2.2.4 only in `version`.
3. **Not claimed**: that settings now keep only what differs from the defaults (nothing a user sees), and that Start
   stays disabled until the popup is ready (P300-10; an early click was lost before, now it is refused).

## Changes from v2.2.3 listing (v2.2.4)

1. **«New in» line** (EN + RU), runtime-tested in CfT 152.0.7977.82 and 157.0.8103.38 with a different tone in every
   tab (P300-28d): the tab strip's menu on a BACKGROUND tab, the page menu and a real Ctrl+Shift+Y each recorded
   exactly the intended tab, and the background tab stayed in the background
   (`03-research/2026-11-09-p300-28d-record-this-tab/RESULT.md` in the project folder). Not measured: ⌘+Shift+Y on
   a Mac (the manifest's `suggested_key.mac`; there is no Mac here) and the tab strip item before Chrome 150 (it
   does not exist there; the page menu does). The 2.2.3, 2.2.2, 2.2.1 and 2.2.0 items stay.
2. **New permission `contextMenus`** and the `commands` manifest key: no new install warning (CfT 152 and 157,
   P300-28d). The dashboard asks for a justification of the new permission; the text is in `../CHROMEWEBSTORE.md`
   → Permissions.
3. **Not claimed**: what happens during a recording (the popup explains, nothing new starts), the one-recording
   «Microphone only» override, the hint in the popup.

## Changes from v2.2.2 listing (v2.2.3)

1. **«New in» line** (EN + RU), each part runtime-tested in CfT 152:
   - a recording the server ends as «no speech» reads «No speech heard — nothing to transcribe.» with what to check,
     and offers no Retry (mock bench `.claude/scripts/test_ingest.py` 137/137, P300-26; the production run of the
     2.2.3 zip with a silent recording: `03-research/2026-11-08-p300-27-release-223/RESULT.md`);
   - the Recordings page marks a recording that holds only the microphone «Microphone only»
     (`tests/test_p300_23c_sources.py` 25/25, P300-23c).
   The 2.2.2, 2.2.1 and 2.2.0 items stay.
2. **Not claimed**: the creating build in every `capture-report.json` (P300-23c, a diagnostic with no user action),
   the «Mix» asset name.
3. **No new permissions**: the manifest differs from 2.2.2 only in `version`.

## Changes from v2.2.1 listing (v2.2.2)

1. **«New in» line** (EN + RU): one short sentence about the new link in the popup and Recordings page to
   `ironmemo.com/transcribe` (UTM query for traffic analytics only, no user data). The 2.2.1 and 2.2.0 items stay.
2. **Not claimed**: the hidden-for-store `v2.2.2 · Chrome Web Store` build line (silent UI polish, no user action).
3. **No new permissions**: install warning for 2.2.2 is identical to 2.2.1 — one line, `tabCapture`.

## Changes from v2.2.0 listing (v2.2.1)

1. **«New in» line** (EN + RU): what 2.2.1 changes for users, each part runtime-tested in CfT 152 on 2026-10-20:
   a profile with no saved settings records `local_mic` + `remote_tab` + `compatibility_mix`
   (`.claude/scripts/test_p300_25.py`, case `fresh`; default `a40cb02`); a stored «Microphone only» shows
   «Microphone only: other people on a call will not be in the recording.» before Start, with a one-click switch
   (`.claude/scripts/test_p300_23.py`; `5105d66`). The 2.2.0 items stay, marked «New in 2.2.0».
2. **Not claimed**: seekable downloads (`5105d66` concerns WebM files, which a default recording no longer
   produces after `5967268`), the version line in the popup, the recording engine.

## Changes from v2.1.0 listing (v2.2.0)

1. **Cloud section**: four bullets for what 2.1.1–2.1.5 changed for users, each checked in code and on the mock bench,
   the price and the account line also on production (P300-17 run): the account line shows the server's balance and
   free minutes (`session-list.js allowanceText`); «Transcribe» reads the price first and stops only when the account
   cannot pay for all of it, with Send anyway / Top up / Cancel (`quoteThenStart`); a parked recording shows «Waiting
   for payment» and the server re-queues it after a payment (iron-recordings `actions.py payment_completed`, read in
   code; the web app's own copy says «nothing to upload again»); the workspace chain preferred → default → first
   personal → first (`workspace.js`, measured on prod 2026-10-06).
2. **Not claimed**: an exact price (the UI says «about N credits»), parking reproduced on production (mock only).
3. **«no time limit» → «no artificial time limit — the real limit is your free disk space»** (CLAUDE.md «About
   unlimited»).
4. The «10 free minutes» copy stays (owner ruling 2026-10-07, P300-20: the free minutes are the granted free credits).

## Changes from v0.6.0 listing (R15 + R16 fixes)

1. **R15 FIXED**: Removed "creates a guest account that you can claim with your e-mail."
   Now says: email verification with a one-time code before first transcription,
   IronMemo creates or links an account. This matches `upload.authMode = 'email'` default.

2. **R16 FIXED**: Removed claim that the dialog "names which speech-to-text providers."
   Now says: dialog "explains what is sent, where, and links the privacy policy
   for the detailed list of providers." This matches the actual dialog text in
   `session-list.html` line 47.

3. **Timing**: Removed "transcript comes back in a few seconds." Not claimed.
   The UI says "usually under a minute" and a 3-hour queue was measured 2026-09-13.

4. **Pricing clarity**: "No subscription" and "credits" are no longer in the same
   sentence. Separated into a pricing section.

5. **New features added**: player, trim, rename, markers, mic picker, level meter —
   all v2.1.0 local features now mentioned.

6. **R19 FIXED**: Limited Use compliance statement added to privacy policy §6.
   Initially assessed as a false finding (tabCapture not a restricted scope API),
   but 3/4 reviewers (Spark, MiMo, Agy) corrected this: CWS Limited Use applies
   to ALL extensions handling user data, not only restricted-scope Google Account
   APIs. Cost was one paragraph — zero risk to add, removal risk if absent.

## Items NOT changed (flagged for Igor)

- **Title keyword stuffing (Agy finding)**: `_locales/en/messages.json` title is
  "IronMemo: Free Audio Recorder & Transcribe Meetings & AI Notetaker" (66 chars).
  Agy 3.8 Flash flagged this as CWS Listing Requirements §4 keyword spam risk.
  Changing the title requires editing `_locales`, rebuilding the zip, and re-uploading.
  **This is a product decision** — the current title has SEO value. Igor decides.

- **"legal, medical, HR" mention**: Grok Build noted the listing invites recording
  "legal, medical, HR" calls while privacy declares no health data. Removed in this
  draft to avoid the tension. Igor can add back if desired.

- **tab.url confirmed undefined at runtime (2026-09-28)**: Tested on CfT 152 —
  `tab.url` is not present in the Tab object without `tabs` or `activeTab` permission.
  Platform detection (zoom/meet/teams) is dead code; all tab recordings get `other`.
  Privacy policy §3 updated to remove the platform enum. The detection code remains
  (safe fallback to `other`) and will activate if `activeTab` is added in a future
  version. No manifest change or zip rebuild needed for this submission.
  Test results: `runs/tab-url-test-results.json`.
