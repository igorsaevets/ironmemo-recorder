# CWS Listing Description — v2.2.0 draft

v2.2.0 (2026-10-08, P300-17): the cloud section describes what 2.1.1–2.1.5 added — the account line (credits +
free minutes), the price before an upload, «waiting for payment», accounts with several workspaces. «No time limit»
became «no artificial time limit; the real limit is free disk space» (CLAUDE.md, claims about unlimited).
v2.1.0 (2026-09-22): fixed re-audit findings R15 (stale guest-account claim) and R16 (overclaim about dialog naming
sub-processors).

These go into the CWS console textarea (per locale), NOT into the extension code.
Title and summary come from `_locales/<lang>/messages.json` and require a zip rebuild.

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

🆕 New in 2.2.0: credits and free minutes on the Recordings page, the price before an upload, a clear "waiting for payment" state, and accounts with several workspaces.

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

🆕 Новое в 2.2.0: кредиты и бесплатные минуты на странице «Записи», цена до загрузки, понятный статус «ждёт оплаты» и аккаунты с несколькими рабочими пространствами.

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
