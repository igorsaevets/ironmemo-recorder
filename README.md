# IronMemo Audio Recorder

Chrome MV3 extension for recording meetings and calls locally: microphone and tab audio, works while the tab is closed, decodes the file after Chrome crashes.

**Status: early development.** Not yet on the Chrome Web Store. Ships as an unpacked extension.

## What it does

- Captures **microphone** (`getUserMedia`) and **tab audio** (`chrome.tabCapture`).
- Records **while the tab is closed** — the tab stream is transferred to an offscreen document at start; closing the tab does not stop the recording.
- Writes to **OPFS** via a dedicated worker with `createSyncAccessHandle`. Durable page-level flushes every ~1 s.
- **Decodes fully after a crash**: `recovery.js` lifts truncated MediaRecorder `.part` files into complete, seekable output. Measured on 21 of 27 cells of a 3-strategy × 9-failure matrix (`tests/crash_matrix.py`); all 21 decode fully with `ffmpeg 9.0` and Chrome `AudioDecoder`, journal is a subset of the disk in every cell.

## Defaults (v0.2.0)

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
2. Click the extension icon → «Начать запись».
3. Files land in **OPFS** (not the file system) — inspect via `chrome://inspect/#origin`. Physical export via `chrome.downloads` is planned.

## What it does NOT do (yet)

- No Chrome Web Store submission (privacy policy, screenshots, promo tile, DSA pending).
- No live waveform in the popup — a silently-empty file is possible if the OS/driver holds the microphone.
- No user-visible session list — files live in OPFS, invisible in Explorer/Finder.
- No backend upload — the recorder is 100 % local.

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
tests/                     # Python crash-matrix bench + reboot harness (CfT + CDP)
```

## License

MIT. See [LICENSE](LICENSE).
