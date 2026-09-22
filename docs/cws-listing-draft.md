# CWS Listing Description — v2.1.0 draft

Prepared 2026-09-22 to fix re-audit findings R15 (stale guest-account claim)
and R16 (overclaim about dialog naming sub-processors).

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
• Add timeline markers during a recording for quick navigation later
• Choose which microphone to use
• Live level meter shows whether your mic is actually picking up sound

☁️ Optional cloud transcription

Click Transcribe on any recording to send it to IronMemo for a text transcript and AI summary. Before your first transcription, you verify your e-mail with a one-time code — IronMemo creates an account (or links to an existing one) so your transcripts are durable.

• First 10 minutes of transcription are free — per account, granted once your e-mail is verified
• Each upload is a separate decision: a consent dialog explains what is sent, where, and links the privacy policy for the detailed list of speech-to-text and AI providers involved
• The local recording stays on your device — the upload is a copy, not a move
• You can delete the server copy at any time from the Recordings page

⛔ What it does NOT do

• Does not upload anything automatically — you choose which recordings to transcribe, one at a time
• Does not use your recordings to train any AI model
• Does not read page text, passwords, or browsing history
• Does not run analytics or crash-reporting inside the extension
• No bot joins the call — nothing appears in the participant list

💰 Pricing

Install and record for free, with no time limit on local recordings. Cloud transcription: first 10 minutes free per account; after that, recordings are processed only if the account has IronMemo credits. No subscription.

🔒 Privacy

All audio stays in your browser's local storage (OPFS) until you choose to transcribe. The extension requests no host permissions at install — access to app.ironmemo.com is requested only when you accept the cloud consent on a specific recording.

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
• Маркеры на временной шкале — расставляйте прямо во время записи для быстрой навигации
• Выбор микрофона
• Индикатор уровня в реальном времени показывает, работает ли микрофон

☁️ Облачная транскрибация (опционально)

Нажмите «Транскрибировать» на любой записи, чтобы отправить её в IronMemo для получения текстовой расшифровки и AI-саммари. Перед первой транскрибацией вы подтверждаете e-mail одноразовым кодом — IronMemo создаёт аккаунт (или привязывает к существующему), чтобы ваши расшифровки сохранялись.

• Первые 10 минут транскрибации бесплатно — на аккаунт, после верификации e-mail
• Каждая загрузка — отдельное решение: диалог согласия объясняет, что отправляется и куда, и ссылается на политику конфиденциальности для списка провайдеров
• Локальная запись остаётся на устройстве — загружается копия, не оригинал
• Серверную копию можно удалить в любой момент со страницы «Записи»

⛔ Чего НЕ делает

• Ничего не загружает автоматически — вы сами выбираете, какую запись транскрибировать
• Не использует ваши записи для обучения AI-моделей
• Не читает текст страниц, пароли и историю браузера
• Не содержит аналитики и крэш-репортинга
• Бот не подключается к звонку — ничего не видно в списке участников

💰 Стоимость

Установка и локальная запись бесплатны, без ограничения по времени. Облачная транскрибация: 10 бесплатных минут на аккаунт; далее — только при наличии кредитов IronMemo. Без подписки.

🔒 Конфиденциальность

Всё аудио хранится в локальном хранилище браузера (OPFS), пока вы сами не решите транскрибировать. Расширение не запрашивает разрешений на сайты при установке — доступ к app.ironmemo.com запрашивается только при согласии на загрузку конкретной записи.

Подробнее: https://igorsaevets.github.io/ironmemo-recorder/privacy-policy.html
Исходный код (MIT): https://github.com/igorsaevets/ironmemo-recorder
```

---

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

- **tab.url access without activeTab**: Agy flagged that `tab.url` may be undefined
  at runtime because neither `tabs` nor `activeTab` is declared. If true, meeting
  platform detection (zoom/meet/teams) is dead code — all tab recordings get `other`.
  Needs a runtime test before submission. If `activeTab` is added, CWS listing must
  disclose web browsing activity collection per Limited Use Item 4.
