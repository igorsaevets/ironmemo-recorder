"""
after_boot.py — the observer half of the reboot (and sleep/wake) cells. Reads
runs/i2/reboot/pending.json written by prepare_reboot_test.py and finishes the measurement.

Reboot mode (default; launched from the Startup folder after logon):
  1. wait 45 s for the desktop to settle, read the Windows event log for the shutdown and
     boot instants (Tc = when the recording process was killed by the OS);
  2. relaunch Chrome for Testing on the same profile → chrome.runtime.onStartup → the
     extension's own orphan check runs (recovery.js); wait for ironmemo.recovery.v1;
  3. export the session, decode with ffmpeg, write 03-research/I2-crash-recovery/reboot/result.json;
  4. remove the Startup entry.

Sleep mode (--sleep; run by hand after the machine woke up):
  1. reconnect to the still-running Chrome through the saved CDP endpoint;
  2. read the state, STOP the recording normally, export, decode;
  3. pull the sleep/wake instants from the event log (Kernel-Power 506/507 = Modern Standby
     enter/exit on this machine, 42/107 = classic sleep/resume) and the worker journal's
     clock_jump / input_frozen / discontinuity lines → result.json in the same folder.

    python ironmemo-recorder\\tests\\reboot\\after_boot.py            # reboot mode
    python ironmemo-recorder\\tests\\reboot\\after_boot.py --sleep    # after a sleep/wake
    python ironmemo-recorder\\tests\\reboot\\after_boot.py --dry-run  # reboot mode without the 45 s wait (bench self-test)
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
sys.path.insert(0, str(PROJECT / "ironmemo-recorder" / "tests"))
from browser import close_real_chrome, find_chrome_for_testing, launch_chrome_cdp, wait_service_worker  # noqa: E402
from crash_matrix import export_session, ffmpeg_decode  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RUN = PROJECT / "runs" / "i2" / "reboot"
OUT = PROJECT / "03-research" / "I2-crash-recovery" / "reboot"
STARTUP = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
CMD_NAME = "ironmemo-i2-after-boot.cmd"
STATE_JS = "async () => (await chrome.storage.local.get('ironmemo.captureState.v1'))['ironmemo.captureState.v1']"
RECOVERY_JS = "async () => (await chrome.storage.local.get('ironmemo.recovery.v1'))['ironmemo.recovery.v1']"


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def event_log(since_iso: str) -> list:
    """Shutdown/boot/sleep events since `since_iso` (PowerShell Get-WinEvent, no elevation needed for System)."""
    ps = f"""
    $since = [datetime]::Parse('{since_iso}')
    $ids = 1074,6005,6006,6008,12,13,41,42,107,506,507
    Get-WinEvent -FilterHashtable @{{LogName='System'; StartTime=$since}} -ErrorAction SilentlyContinue |
      Where-Object {{ $ids -contains $_.Id }} |
      Select-Object @{{n='t';e={{$_.TimeCreated.ToString('o')}}}}, Id, ProviderName, @{{n='msg';e={{($_.Message -split "`n")[0]}}}} |
      Sort-Object t | ConvertTo-Json -Compress
    """
    try:
        r = subprocess.run(["pwsh", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60)
        txt = r.stdout.strip()
        if not txt:
            return []
        j = json.loads(txt)
        return j if isinstance(j, list) else [j]
    except Exception as e:
        return [{"error": str(e)}]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sleep", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--wait", type=int, default=45)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    pend_path = RUN / "pending.json"
    if not pend_path.exists():
        log("no pending.json — nothing to do"); return 0
    pending = json.loads(pend_path.read_text(encoding="utf-8"))
    mode = "sleep" if a.sleep else "reboot"
    result = {"mode": mode, "pending": pending, "observerStartedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "dryRun": a.dry_run}
    if mode == "reboot" and not a.dry_run:
        log(f"waiting {a.wait} s for the desktop to settle…"); time.sleep(a.wait)
    result["events"] = event_log(pending["preparedAt"])
    sid = pending["sessionId"]; profile = Path(pending["profile"]); ext = Path(pending["ext"]); ext_id = pending["extId"]
    media = RUN / "media"; media.mkdir(exist_ok=True)
    wav = PROJECT / "runs" / "fake-audio" / "speechlike-48000.wav"
    extra = ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream",
             f"--use-file-for-fake-audio-capture={wav.resolve()}", "--disable-field-trial-config"]
    with sync_playwright() as pw:
        real = None
        try:
            if mode == "sleep":
                # The recording should still be running: reconnect, read, STOP.
                browser = pw.chromium.connect_over_cdp(pending["cdpEndpoint"], timeout=10000)
                ctx = browser.contexts[0]
                real = {"browser": browser, "context": ctx, "proc": None}
                sw = wait_service_worker(ctx, ext_id=ext_id)
                st = sw.evaluate(STATE_JS) or {}
                result["stateOnWake"] = {k: st.get(k) for k in ("status", "sessionId", "lastWarning", "lastInfo", "progressAt", "error")}
                pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext_id}/src/popup/popup.html"); pg.wait_for_timeout(500)
                status = pg.evaluate("async () => chrome.runtime.sendMessage({ target: 'background', type: 'OFFSCREEN_STATUS' })")
                result["offscreenStatus"] = status
                t_stop = time.time()
                r = pg.evaluate("async () => chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })")
                result["stopWall"] = t_stop; result["stopResponse"] = {"ok": r.get("ok"), "error": r.get("error")}
                st = sw.evaluate(STATE_JS) or {}
                result["stopResult"] = st.get("lastResult")
                rr = pg.evaluate("async (sid) => chrome.runtime.sendMessage({ target: 'background', type: 'RECOVER_SESSION', sessionId: sid, opts: { force: true } })", sid)
                result["recovery"] = (rr or {}).get("recovery")
            else:
                t0 = time.time()
                real = launch_chrome_cdp(pw, ext, profile, extra_args=extra, exe=find_chrome_for_testing())
                ctx = real["context"]
                sw = wait_service_worker(ctx, ext_id=ext_id)
                result["relaunchMs"] = round((time.time() - t0) * 1000)
                deadline = time.time() + 180
                rec = None
                while time.time() < deadline:
                    rec = sw.evaluate(RECOVERY_JS)
                    if rec and rec.get("sessionId") == sid:
                        break
                    time.sleep(0.5)
                st = sw.evaluate(STATE_JS) or {}
                result["stateAfterRelaunch"] = {k: st.get(k) for k in ("status", "sessionId", "orphaned", "error")}
                if not (rec and rec.get("sessionId") == sid):
                    pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext_id}/src/popup/popup.html"); pg.wait_for_timeout(500)
                    rr = pg.evaluate("async (sid) => chrome.runtime.sendMessage({ target: 'background', type: 'RECOVER_SESSION', sessionId: sid })", sid)
                    rec = (rr or {}).get("recovery"); result["recoveryTrigger"] = "manual"
                else:
                    result["recoveryTrigger"] = "onStartup"
                result["recovery"] = rec
            lab, files, exported = export_session(ctx, ext_id, sid, OUT, media, want=(".opus", ".json", ".jsonl"))
            result["files"] = files; result["exported"] = {k: v["bytes"] for k, v in exported.items()}
            result["decodeChrome"] = lab.evaluate("async (sid) => window.ironmemoLab.decodeSession(sid)", sid)
            result["decodeFfmpeg"] = {n: ffmpeg_decode(Path(v["path"])) for n, v in exported.items() if n.endswith(".opus")}
            # Journal facts that matter for sleep/reboot: clock jumps, frozen input, discontinuities.
            jp = OUT / "journal.jsonl"
            if jp.exists():
                kinds = {}
                jumps = []
                for line in jp.read_text(encoding="utf-8").splitlines():
                    try:
                        j = json.loads(line)
                    except Exception:
                        continue
                    t = j.get("t") or j.get("event")
                    kinds[t] = kinds.get(t, 0) + 1
                    if t in ("clock_jump", "clock_jump_main", "input_frozen", "input_resumed", "track_ended", "device_lost", "write_failed") or (t == "discontinuity" and abs(j.get("deltaUs", 0)) > 500_000):
                        jumps.append(j)
                result["journalKinds"] = kinds; result["journalEvents"] = jumps[:100]
            # Loss per role against the wall clock.
            first = pending.get("firstFrameWall") or {}
            end = None
            if mode == "reboot":
                # Tc = the shutdown instant from the event log (1074 = restart initiated; 6006 = event log stopped).
                for ev in result["events"]:
                    if ev.get("Id") in (6006, 1074):
                        end = ev["t"]
                result["tcIso"] = end
                if end:
                    from datetime import datetime
                    end = datetime.fromisoformat(end).timestamp()
            else:
                end = result.get("stopWall")
            roles = {}
            for role, fw in first.items():
                fname = f"{role}.opus" if pending["engine"] == "webcodecs" else f"{role}.recovered.opus"
                f = result["decodeFfmpeg"].get(fname) or {}
                c = (result["decodeChrome"] or {}).get(fname) or {}
                m = {"file": fname, "ffmpegSec": f.get("decodedSeconds"), "chromeSec": round(c["decodedFrames"] / 48000, 3) if c.get("decodedFrames") is not None else None,
                     "chromeOk": c.get("ok"), "ffmpegOk": f.get("ok")}
                if end and fw:
                    m["expectedSec"] = round(end - fw / 1000, 3)
                    if m["ffmpegSec"] is not None:
                        m["lostSec"] = round(m["expectedSec"] - m["ffmpegSec"], 3)
                roles[role] = m
            result["metrics"] = {"roles": roles, "endWall": end}
            for role, m in roles.items():
                log(f"  {role}: expected {m.get('expectedSec')} s, ffmpeg {m.get('ffmpegSec')} s, chrome {m.get('chromeSec')} s, lost {m.get('lostSec')} s")
        except Exception as e:
            import traceback
            result["error"] = f"{type(e).__name__}: {e}"; result["traceback"] = traceback.format_exc()[-2000:]
            log(f"ERROR {result['error']}")
        finally:
            result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            (OUT / f"result-{mode}{'-dryrun' if a.dry_run else ''}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
            log(f"result: {OUT / f'result-{mode}.json'}")
            if real:
                try:
                    close_real_chrome(real) if real.get("proc") else real["browser"].close()
                except Exception:
                    pass
            cmd = STARTUP / CMD_NAME
            if cmd.exists() and mode == "reboot":
                cmd.unlink(); log("Startup entry removed")
            if mode == "reboot":
                pend_path.rename(RUN / f"pending-done-{time.strftime('%Y%m%d-%H%M%S')}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
