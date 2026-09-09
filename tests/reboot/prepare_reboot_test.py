"""
prepare_reboot_test.py — the half of the "OS reboot during recording" cell that can run
before the machine goes down. The other half (after_boot.py) is armed in the user's Startup
folder and runs itself after logon.

WHY TWO HALVES — the process that issues the reboot dies with it, so the measurement must be
completed by something that outlives the reboot. A scheduled task at logon would be the clean
tool, but `schtasks /create /sc onlogon` is refused without administrator rights on this
machine (measured 2026-09-08: "Access is denied"); the per-user Startup folder needs none.

    python ironmemo-recorder\\tests\\reboot\\prepare_reboot_test.py            # start recording, arm after_boot.py
    python ironmemo-recorder\\tests\\reboot\\prepare_reboot_test.py --reboot   # …and reboot 20 s later (DESTRUCTIVE)
    python ironmemo-recorder\\tests\\reboot\\prepare_reboot_test.py --disarm   # remove the Startup entry

Without --reboot nothing destructive happens: the recording keeps running in a detached Chrome
for Testing, and the pending.json tells after_boot.py what to check. Igor reboots when he
decides to (shutdown /r /t 0, or the Start menu); after logon, after_boot.py waits 45 s,
relaunches the same profile, lets the extension check the orphaned session, exports the
files, decodes them with ffmpeg and writes 03-research/I2-crash-recovery/reboot/result.json.

What the reboot measures that chrome_kill cannot: Chrome's own shutdown on WM_ENDSESSION
(it may flush or it may be killed by the OS after the 5 s grace period), the OPFS files
surviving an unclean unmount, and the extension's orphan check on a cold profile.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT / ".claude" / "scripts"))
from browser import find_chrome_for_testing, launch_chrome_cdp, prepare_test_extension, tone_server, trigger_action, wait_service_worker  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RUN = PROJECT / "runs" / "i2" / "reboot"
OUT = PROJECT / "03-research" / "I2-crash-recovery" / "reboot"
STARTUP = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
CMD_NAME = "ironmemo-i2-after-boot.cmd"
STATE_JS = "async () => (await chrome.storage.local.get('ironmemo.captureState.v1'))['ironmemo.captureState.v1']"


def arm():
    cmd = STARTUP / CMD_NAME
    py = sys.executable
    script = PROJECT / "ironmemo-recorder" / "tests" / "reboot" / "after_boot.py"
    log = RUN / "after-boot.log"
    cmd.write_text(f'@echo off\r\ncd /d "{PROJECT}"\r\n"{py}" "{script}" >> "{log}" 2>&1\r\n', encoding="utf-8")
    return cmd


def disarm():
    cmd = STARTUP / CMD_NAME
    if cmd.exists():
        cmd.unlink()
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reboot", action="store_true", help="reboot the machine 20 s after the recording started (DESTRUCTIVE)")
    ap.add_argument("--disarm", action="store_true")
    ap.add_argument("--strategy", default="webcodecs_muxed", choices=["continuous", "rolling_finalized", "webcodecs_muxed"])
    ap.add_argument("--sleep-test", action="store_true", help="prepare the sleep/wake cell instead: same recording, no Startup entry; after wake run after_boot.py --sleep")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if a.disarm:
        print("disarmed" if disarm() else "nothing to disarm"); return 0
    RUN.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
    profile = RUN / "cft-profile"
    ext = prepare_test_extension(dest=RUN / "ext" / "extension-audio")
    engine = "webcodecs" if a.strategy == "webcodecs_muxed" else "mediarecorder"
    wav = PROJECT / "runs" / "fake-audio" / "speechlike-48000.wav"
    extra = ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream",
             f"--use-file-for-fake-audio-capture={wav.resolve()}", "--disable-field-trial-config"]
    srv, base = tone_server()
    pending = {"preparedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "profile": str(profile), "ext": str(ext), "strategy": a.strategy,
               "engine": engine, "mode": "sleep" if a.sleep_test else "reboot"}
    with sync_playwright() as pw:
        real = launch_chrome_cdp(pw, ext, profile, extra_args=extra, exe=find_chrome_for_testing())
        ctx = real["context"]; ext_id = real["ext_id"]
        sw = wait_service_worker(ctx, ext_id=ext_id)
        ctx.grant_permissions(["microphone"])
        opts = ctx.new_page(); opts.goto(f"chrome-extension://{ext_id}/src/options/options.html"); opts.wait_for_timeout(1000)
        opts.evaluate("""async (o) => {
            const m = await import('/src/shared/settings-store.js');
            const s = await m.loadSettings();
            s.source.mode = 'mic+tab'; s.source.keepSeparate = true; s.source.produceMix = true; s.source.tabAudioPassthrough = false;
            s.audioEnc.impl = o.engine; s.audioEnc.codec = 'opus'; s.audioEnc.container = o.engine === 'webcodecs' ? 'ogg' : 'webm';
            s.storage.backend = 'opfs'; s.storage.journalEnabled = true; s.storage.segmentStrategy = o.strategy;
            s.storage.timesliceMs = 5000; s.storage.segmentSeconds = 10; s.storage.flushIntervalMs = 1000;
            s.recovery.autoRecoverOnStart = true; s.experiment.profileId = 'i2-' + o.mode + '-' + o.strategy;
            await m.saveSettings(s);
        }""", {"engine": engine, "strategy": a.strategy, "mode": pending["mode"]})
        sw.evaluate("async () => { await chrome.storage.local.set({'ironmemo.micPermissionGranted': {granted: true, at: Date.now()}}); }")
        tone = ctx.new_page(); tone.goto(f"{base}/tone.html"); tone.wait_for_timeout(1000)
        tone_tab = sw.evaluate("async (u) => (await chrome.tabs.query({url: u + '/*'}))[0]?.id ?? null", base)
        tone.bring_to_front(); trigger_action(real, base)
        popup = ctx.new_page(); popup.goto(f"chrome-extension://{ext_id}/src/popup/popup.html"); popup.wait_for_timeout(500)
        res = popup.evaluate("async (tabId) => chrome.runtime.sendMessage({ target: 'background', type: 'START', tabId, clickedAt: Date.now() })", tone_tab)
        if not res.get("ok"):
            raise SystemExit(f"START failed: {res}")
        time.sleep(2)
        st = sw.evaluate(STATE_JS) or {}
        pending.update({"sessionId": st.get("sessionId"), "status": st.get("status"), "startedAt": st.get("startedAt"),
                        "firstFrameWall": {t["role"]: (t.get("firstFrame") or {}).get("wall") or t.get("firstSegmentStartWall") for t in (st.get("appliedReport") or {}).get("tracks", [])},
                        "extId": ext_id, "cdpEndpoint": real["endpoint"], "chromePid": real["proc"].pid, "toneServer": base})
        (RUN / "pending.json").write_text(json.dumps(pending, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"recording {pending['sessionId']} status={pending['status']} in detached CfT pid {real['proc'].pid}; endpoint {real['endpoint']}")
        armed = None
        if not a.sleep_test:
            armed = arm()
            print(f"armed: {armed}")
        if a.reboot:
            print("REBOOT in 20 s (shutdown /r /t 20). Cancel with: shutdown /a")
            subprocess.run(["shutdown", "/r", "/t", "20", "/c", "IronMemo I2 reboot-during-recording test"], check=False)
        # Detach: leave the `with` block WITHOUT browser.close() — Chrome was spawned by subprocess.Popen
        # and is not owned by Playwright; the CDP connection simply drops and the recording goes on.
    print(json.dumps({"pending": str(RUN / "pending.json"), "armed": str(armed) if armed else None,
                      "next": "after_boot.py runs from the Startup folder after logon" if not a.sleep_test else
                              "sleep the machine, wake it, then: python ironmemo-recorder\\tests\\reboot\\after_boot.py --sleep"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
