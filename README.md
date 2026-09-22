# IronMemo Audio Recorder

Chrome MV3 extension for recording meetings and calls locally, with optional cloud transcription. Microphone and tab audio, works while the popup is closed, recovers after Chrome crashes.

**Status: v0.6.0 is live on the Chrome Web Store** ([listing](https://chromewebstore.google.com/detail/epnajjfddhbhgabhmcaomfnjhnhjnchd)). Also loads as an unpacked extension for development.

## What it does

- Captures **microphone** (`getUserMedia`) and **tab audio** (`chrome.tabCapture`).
- Records **while the popup is closed** — the captured streams are transferred to an offscreen document at start; closing the popup does not stop the recording. Closing the captured tab ends the tab-audio track but the microphone track continues.
- Writes to **OPFS** via a dedicated worker with `createSyncAccessHandle`. Durable page-level flushes every ~1 s.
- **Recovers after a crash**: `recovery.js` lifts truncated MediaRecorder `.part` files into complete, seekable output. Measured on 27 of 33 cells of the crash matrix (`tests/crash_matrix.py`); all 27 decode fully with `ffmpeg 9.0` and Chrome `AudioDecoder`. Remaining 6 cells (reboot + sleep × 3 strategies) are untested.

## Defaults

- **Engine**: WebCodecs (Opus)
- **Container**: Ogg
- **Segmentation**: `webcodecs_muxed`
- **Flush**: every 1000 ms
- **Runtime fallback**: if `AudioEncoder.isConfigSupported({codec:'opus', …})` returns false at start, the extension transparently falls back to `MediaRecorder` + WebM. `manifest.minimum_chrome_version=116` already guarantees WebCodecs; the fallback is a safety net.

## Install for development

Requires **Chrome for Testing 152+**. Stable Chrome ignores `--load-extension` since 137 (removed) and the `--disable-features=DisableLoadExtensionCommandLineSwitch` workaround since 142.

```
git clone https://github.com/igorsaevets/ironmemo-recorder.git
cd ironmemo-recorder
```

1. `chrome://extensions/` → Developer mode → Load unpacked → select `apps/extension-audio/`.
2. Click the extension icon → Start Recording.
3. Files land in **OPFS** (not the file system). Use the built-in session list to play, rename, trim, and download recordings.

## Testing

Requires Python 3.12+ and Chrome for Testing 152+.

```
pip install -r tests/requirements.txt
playwright install chromium
npx @puppeteer/browsers install chrome@152 --path runs/chrome-for-testing
```

**Smoke test** — verifies extension loads and all pages render:

```
python tests/smoke_test.py
python tests/smoke_test.py --headed     # visible browser
python tests/smoke_test.py --cft-only   # fail if CfT is missing
```

**Crash matrix** — measures recovery across strategy x failure combinations.
Requires the parent project directory structure (`03-research/`, `runs/fake-audio/`)
and `ffmpeg`/`ffprobe` on PATH. See `tests/crash_matrix.py` docstring for details.

```
python tests/crash_matrix.py --strategy webcodecs_muxed --failure chrome_kill --seconds 60
```

Test artifacts land in `runs/` (gitignored). Chrome for Testing goes in `runs/chrome-for-testing/`. To use a CfT binary from a custom location, set `IRONMEMO_CFT=/path/to/chrome`.

## What it does NOT do (yet)

- No CI pipeline (A7 — local test path works, CI is future work).
- No streaming SHA-256 for large files (I-3).
- No retention auto-delete executor (I-3 / A6).
- Power-loss and sleep recovery: 6 of 33 crash-matrix cells remain untested (I-2).

## Structure

```
apps/extension-audio/
  manifest.json            # MV3; permissions: tabCapture, offscreen, storage, unlimitedStorage
  src/
    background/            # service worker: orchestration, recovery, orphan detection on onStartup
    offscreen/             # owns MediaStream; MediaRecorder / WebCodecs pipeline; frozen-input detector
    popup/                 # user UI
    options/               # generated from settings-schema.js — do NOT hand-add fields
    shared/                # settings-schema.js (canonical), recovery.js, webm-demux.js
tests/                     # Python test bench (CfT + CDP + Playwright)
  lib/browser.py           # Chrome for Testing launcher and helpers
  smoke_test.py            # fast: load extension, verify pages render
  crash_matrix.py          # full crash-recovery measurement
```

## License

MIT. See [LICENSE](LICENSE).
