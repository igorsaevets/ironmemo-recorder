"""
crash_matrix.py — I2 test bench: ONE recording, ONE injected failure, ONE measured cell of the
"strategy × failure" table (ADR-004).

    python ironmemo-recorder\\tests\\crash_matrix.py --strategy webcodecs_muxed --failure chrome_kill --seconds 60
    python ironmemo-recorder\\tests\\crash_matrix.py --strategy continuous --failure ext_kill --timeslice 5000
    python ironmemo-recorder\\tests\\crash_matrix.py --strategy rolling_finalized --failure none --segment-seconds 10 --handover start_then_stop

What one run does
  1. Chrome for Testing (CDP loadUnpacked, fake microphone from a 48 kHz WAV, tone tab for
     tabCapture, Extensions.triggerAction for the activeTab grant) — same bench as I1.
  2. Settings for the strategy, START through the popup page, mic+tab+mix, sampled every second.
  3. At T = --seconds the failure is injected PROGRAMMATICALLY (see FAILURES); Tc is taken
     from the bench clock right before the injection.
  4. Fatal failures: the browser is relaunched on the same profile → chrome.runtime.onStartup →
     the extension checks the orphaned session itself (recovery.js in a Worker). Non-fatal
     failures: the recording is observed for --observe seconds, then STOPped normally.
  5. Every file of the session is exported through the lab page and decoded by ffmpeg; the
     extension's own AudioDecoder count comes from recovery.json / decodeSession.
  6. Numbers per role: expected seconds = Tc − first frame wall; decoded seconds (ffmpeg and
     AudioDecoder); lost = expected − decoded; decodes fully = both decoders agree to one frame
     and neither reports an error; sync = spread of asset end times on the wall clock; recovery
     time; journal-vs-disk check. For MediaRecorder the naive byte concatenation is decoded too —
     the thing the previous plan called "crash-safe".

Outputs
  03-research/I2-crash-recovery/<label>/result.json, run.log, journal.jsonl, capture-report.json, recovery.json
  runs/i2/<label>/{cft-profile, ext, media}   (profile, extension copy, exported media — not committed)
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import psutil
from playwright.sync_api import sync_playwright


# Playwright sync API is greenlet-based and does NOT support cross-thread calls
# ("Cannot switch to a different thread") — measured 2026-09-08 in test-quota-wc.
# So there is no in-process way to time-bound a hanging evaluate/cdp.send. The two
# realistic mitigations, both used below:
#   1. Don't do risky evaluates after fatal injection at all (see the ext_kill branch).
#   2. Rely on `i2_run_matrix.py --cell-timeout` (default 360 s) + `_kill_tree` as a
#      hard outer safety net — the cell dies with rc=-999 and its subprocess tree is
#      swept, but the process itself never comes back.

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / ".claude" / "scripts"))
from browser import (close_real_chrome, find_chrome_for_testing, launch_chrome_cdp, prepare_test_extension,  # noqa: E402
                     real_chrome_context_note, run_context_note, tone_server, trigger_action, wait_service_worker)

OUT_ROOT = PROJECT / "03-research" / "I2-crash-recovery"
RUNS_ROOT = PROJECT / "runs" / "i2"
STATE_KEY = "ironmemo.captureState.v1"
RECOVERY_KEY = "ironmemo.recovery.v1"
STATE_JS = f"async () => (await chrome.storage.local.get('{STATE_KEY}'))['{STATE_KEY}']"
RECOVERY_JS = f"async () => (await chrome.storage.local.get('{RECOVERY_KEY}'))['{RECOVERY_KEY}']"
MB = 1024 * 1024

STRATEGIES = ("continuous", "rolling_finalized", "webcodecs_muxed")
FAILURES = ("none", "offscreen_close", "ext_kill", "sw_unload", "tab_crash", "chrome_kill", "quota", "device_lost", "freeze")
# Recording cannot continue after these; the extension must find the session at next start.
FATAL = {"offscreen_close", "ext_kill", "chrome_kill", "quota"}
RELAUNCH = {"ext_kill", "chrome_kill"}   # the browser (or the extension process) is gone: relaunch the profile

LOG_FP = None


def log(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    if LOG_FP:
        LOG_FP.write(line + "\n"); LOG_FP.flush()


def chrome_processes(profile: Path):
    key = str(profile).lower()
    out = []
    for p in psutil.process_iter(["name", "cmdline", "memory_info", "create_time"]):
        try:
            if not p.info["name"] or "chrome" not in p.info["name"].lower():
                continue
            cmd = " ".join(p.info["cmdline"] or []).lower()
            if key not in cmd:
                continue
            m = re.search(r"--type=(\w+)", cmd)
            ptype = m.group(1) if m else "browser"
            if "--extension-process" in cmd:
                ptype = "extension_renderer"
            elif ptype == "utility" and "audio" in cmd:
                ptype = "utility_audio"
            out.append({"pid": p.pid, "type": ptype, "rssMB": round(p.info["memory_info"].rss / MB, 1), "proc": p})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


def kill_all(profile: Path):
    """Stop-Process -Force for every Chrome process of the profile, browser process first."""
    procs = chrome_processes(profile)
    procs.sort(key=lambda x: 0 if x["type"] == "browser" else 1)
    t = time.time()
    killed = []
    for x in procs:
        try:
            x["proc"].kill(); killed.append({"pid": x["pid"], "type": x["type"]})
        except Exception as e:
            killed.append({"pid": x["pid"], "type": x["type"], "error": str(e)})
    gone, alive = psutil.wait_procs([x["proc"] for x in procs], timeout=10)
    return {"tcWall": t, "killed": killed, "aliveAfter": len(alive), "killMs": round((time.time() - t) * 1000)}


def ffmpeg_decode(path: Path) -> dict:
    out = {}
    try:
        pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration,size",
                             "-of", "json", str(path)], capture_output=True, text=True, timeout=120)
        out["ffprobe"] = json.loads(pr.stdout) if pr.stdout.strip() else {"error": pr.stderr[-300:]}
        out["ffprobeDuration"] = (out["ffprobe"].get("format") or {}).get("duration")
    except Exception as e:
        out["ffprobe"] = {"error": str(e)}
    try:
        t0 = time.time()
        p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
                           capture_output=True, timeout=1800)
        n = len(p.stdout) // 2
        out.update({"decodedSamples48k": n, "decodedSeconds": round(n / 48000, 3), "rc": p.returncode,
                    "stderr": p.stderr.decode("utf-8", "replace")[-300:].strip(), "wallS": round(time.time() - t0, 2),
                    "ok": p.returncode == 0 and n > 0})
    except Exception as e:
        out["error"] = str(e); out["ok"] = False
    return out


def wait_state(sw, pred, timeout_s, every=0.25):
    deadline = time.time() + timeout_s
    st = None
    while time.time() < deadline:
        try:
            st = sw.evaluate(STATE_JS) or {}
        except Exception:
            st = {"_evalError": True}
        if pred(st):
            return st
        time.sleep(every)
    return st


def export_session(ctx, ext_id, sid, out_dir: Path, media_dir: Path, want=(".opus", ".json", ".jsonl", ".part")):
    """Read every session file through the lab page via FileReader.readAsDataURL — direct byte
    transfer over CDP evaluate. Replaces the earlier `<a download>` + expect_download flow, which
    silently stalls when the browser is connected via connect_over_cdp (Chrome default download
    policy for chrome-extension:// origins does not fire the "download" event Playwright waits on).
    """
    import base64
    lab = ctx.new_page()
    lab.goto(f"chrome-extension://{ext_id}/src/lab/lab.html")
    lab.wait_for_timeout(800)
    files = lab.evaluate("async (sid) => (await window.ironmemoLab.listSessions()).find(s => s.session === sid)?.files ?? []", sid)
    out_dir.mkdir(parents=True, exist_ok=True)
    media_dir.mkdir(parents=True, exist_ok=True)
    exported = {}
    for f in files:
        if not f["name"].endswith(want):
            continue
        b64 = lab.evaluate(
            """async ([sid, name]) => {
                const fh = await (await (await navigator.storage.getDirectory())
                    .getDirectoryHandle('sessions')).getDirectoryHandle(sid);
                const file = await (await fh.getFileHandle(name)).getFile();
                return await new Promise((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => { const u = r.result; resolve(u.substring(u.indexOf(',') + 1)); };
                    r.onerror = () => reject(r.error);
                    r.readAsDataURL(file);
                });
            }""",
            [sid, f["name"]],
        )
        target = (out_dir if f["name"].endswith((".json", ".jsonl")) else media_dir) / f["name"]
        target.write_bytes(base64.b64decode(b64))
        exported[f["name"]] = {"path": str(target), "bytes": target.stat().st_size}
    return lab, files, exported


def main() -> int:
    global LOG_FP
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", required=True, choices=STRATEGIES)
    ap.add_argument("--failure", required=True, choices=FAILURES)
    ap.add_argument("--seconds", type=float, default=60, help="recording time before the failure is injected")
    ap.add_argument("--observe", type=float, default=20, help="non-fatal failures: keep recording this long after injection, then STOP")
    ap.add_argument("--timeslice", type=int, default=5000, help="MediaRecorder timeslice (ms)")
    ap.add_argument("--segment-seconds", type=int, default=10)
    ap.add_argument("--handover", default="start_then_stop", choices=["start_then_stop", "stop_then_start"])
    ap.add_argument("--flush-ms", type=int, default=1000)
    ap.add_argument("--frozen-ms", type=int, default=3000)
    ap.add_argument("--freeze-ms", type=int, default=8000, help="freeze failure: how long the input is frozen")
    ap.add_argument("--quota-mb", type=float, default=1.0, help="quota failure: headroom above current usage")
    ap.add_argument("--keep-unlimited", action="store_true", help="quota failure: keep the unlimitedStorage permission in the test build")
    ap.add_argument("--label", default=None)
    ap.add_argument("--mode", default="mic+tab", choices=["mic", "tab", "mic+tab"])
    ap.add_argument("--no-parts", action="store_true", help="do not export .part files")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    label = args.label or f"{args.strategy}--{args.failure}"
    out = OUT_ROOT / label
    media_dir = RUNS_ROOT / label / "media"
    profile = RUNS_ROOT / label / "cft-profile"
    for d in (out, media_dir):
        d.mkdir(parents=True, exist_ok=True)
    if profile.exists():
        shutil.rmtree(profile, ignore_errors=True)
    profile.mkdir(parents=True, exist_ok=True)
    LOG_FP = open(out / "run.log", "w", encoding="utf-8")

    engine = "webcodecs" if args.strategy == "webcodecs_muxed" else "mediarecorder"
    host_perms = ("<all_urls>",)
    ext = prepare_test_extension(host_permissions=host_perms, dest=RUNS_ROOT / label / "ext" / "extension-audio")
    # quota: this cell used to strip `unlimitedStorage` and set an origin quota through CDP
    # (Storage.overrideQuotaForOrigin). Both were removed 2026-09-08 after CfT 152 returned
    # "Internal error" from Storage.getUsageAndQuota for chrome-extension origins. Instead, the
    # cell now triggers `debug simulate_quota` in the offscreen document, which reaches
    # fatalStop() by the SAME code path as a real QuotaExceededError from OPFS/MediaRecorder write.
    srv, base = tone_server()
    wav = PROJECT / "runs" / "fake-audio" / "speechlike-48000.wav"
    extra = ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream",
             f"--use-file-for-fake-audio-capture={wav.resolve()}", "--disable-field-trial-config"]
    exe = find_chrome_for_testing()
    result = {"label": label, "strategy": args.strategy, "failure": args.failure, "engine": engine, "args": vars(args),
              "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "extensionPath": str(ext), "fakeMicWav": str(wav),
              "unlimitedStorage": True, "phases": []}
    samples = []
    real = None

    with sync_playwright() as pw:
        try:
            real = launch_chrome_cdp(pw, ext, profile, extra_args=extra, exe=exe)
            result["_runContext"] = {**real_chrome_context_note(real, is_cft=True), **run_context_note(exe)}
            ctx = real["context"]; cdp = real["cdp"]
            sw = wait_service_worker(ctx, ext_id=real["ext_id"])
            ext_id = real["ext_id"]
            result["extensionId"] = ext_id
            log(f"CfT {real['version']} ext {ext_id} strategy={args.strategy} failure={args.failure}")
            ctx.grant_permissions(["microphone"])

            # ── settings ──
            opts = ctx.new_page()
            opts.goto(f"chrome-extension://{ext_id}/src/options/options.html")
            opts.wait_for_timeout(1200)
            saved = opts.evaluate("""async (o) => {
                const m = await import('/src/shared/settings-store.js');
                const sch = await import('/src/shared/settings-schema.js');
                const s = await m.loadSettings();
                s.source.mode = o.mode; s.source.keepSeparate = true; s.source.produceMix = true;
                s.source.tabAudioPassthrough = false; s.source.micDeviceId = 'default';
                s.source.onDeviceLost = 'pause_and_notify'; s.source.onDeviceReturn = 'resume_fill_silence';
                s.source.frozenInputTimeoutMs = o.frozenMs; s.source.fillInputDropsWithSilence = true;
                s.audioProc.sampleRate = 48000; s.audioProc.channelCount = 1;
                s.audioEnc.impl = o.engine; s.audioEnc.codec = 'opus';
                s.audioEnc.container = o.engine === 'webcodecs' ? 'ogg' : 'webm';
                s.audioEnc.bitrateKbps = 48; s.audioEnc.bitrateMode = 'variable';
                s.audioEnc.opusApplication = 'voip'; s.audioEnc.opusFrameDurationUs = 20000; s.audioEnc.opusUseDTX = false;
                s.storage.backend = 'opfs'; s.storage.journalEnabled = true;
                s.storage.segmentStrategy = o.strategy; s.storage.timesliceMs = o.timeslice;
                s.storage.segmentSeconds = o.segmentSeconds; s.storage.rollingHandover = o.handover;
                s.storage.flushIntervalMs = o.flush; s.storage.muxerGapFillMs = 40;
                s.recovery.autoRecoverOnStart = true; s.recovery.remuxOnRecover = true; s.recovery.validateDecodeAfterRemux = true;
                s.experiment.profileId = 'i2-' + o.strategy;
                const issues = [...sch.validate(s), ...sch.checkRuntimeSupport(s), ...(await sch.checkWebCodecsSupport(s))];
                await m.saveSettings(s);
                return { issues };
            }""", {"mode": args.mode, "engine": engine, "strategy": args.strategy, "timeslice": args.timeslice,
                   "segmentSeconds": args.segment_seconds, "handover": args.handover, "flush": args.flush_ms, "frozenMs": args.frozen_ms})
            errors = [i for i in saved["issues"] if i["level"] == "error"]
            result["settingsIssues"] = saved["issues"]
            if errors:
                raise SystemExit(f"settings rejected: {errors}")
            sw.evaluate("async () => { await chrome.storage.local.set({'ironmemo.micPermissionGranted': {granted: true, at: Date.now()}}); }")

            # quota override via CDP removed 2026-09-08 — see the note at extension prep above.
            # The failure is now injected below with `debug simulate_quota`.

            # ── tab audio + activeTab grant ──
            tone = ctx.new_page()
            tone.goto(f"{base}/tone.html")
            tone.wait_for_timeout(1000)
            tone_tab = sw.evaluate("async (u) => (await chrome.tabs.query({url: u + '/*'}))[0]?.id ?? null", base)
            if args.mode != "mic":
                tone.bring_to_front()
                result["triggerAction"] = trigger_action(real, base)

            # ── START through the popup page ──
            popup = ctx.new_page()
            popup.goto(f"chrome-extension://{ext_id}/src/popup/popup.html")
            popup.wait_for_timeout(600)
            res = popup.evaluate("async (tabId) => chrome.runtime.sendMessage({ target: 'background', type: 'START', tabId, clickedAt: Date.now() })", tone_tab)
            if not res.get("ok"):
                raise SystemExit(f"START failed: {res}")
            st = wait_state(sw, lambda s: s.get("status") in ("recording", "error"), 15)
            if st.get("status") != "recording":
                raise SystemExit(f"not recording: {st}")
            sid = st["sessionId"]
            applied = st.get("appliedReport") or {}
            result.update({"sessionId": sid, "appliedReport": applied, "startTimings": st.get("startTimings")})
            first_wall = {}
            for t in applied.get("tracks", []):
                fw = (t.get("firstFrame") or {}).get("wall") or t.get("firstSegmentStartWall")
                if fw:
                    first_wall[t["role"]] = fw
            result["firstFrameWall"] = first_wall
            log(f"recording {sid}; first frame wall per role: {first_wall}")

            # ── record ──
            t0 = time.time()
            def sample(tag=""):
                s = sw.evaluate(STATE_JS) or {}
                pr = s.get("progress") or {}
                roles = pr.get("roles") or {}
                row = {"elapsedS": round(time.time() - t0, 1), "wall": time.time(), "status": s.get("status"), "tag": tag,
                       "bytes": pr.get("bytes"), "roles": {r: {k: v.get(k) for k in ("bytes", "mediaSec", "parts", "segments", "frozen", "ended", "pages")} for r, v in roles.items()},
                       "lastWarning": s.get("lastWarning"), "lastInfo": s.get("lastInfo"), "error": s.get("error")}
                samples.append(row)
                return s
            last_print = -10
            while time.time() - t0 < args.seconds:
                time.sleep(1)
                s = sample()
                el = samples[-1]["elapsedS"]
                if el - last_print >= 10:
                    last_print = el
                    log(f"{el:5.0f}s {s.get('status')} bytes={samples[-1]['bytes']} roles={json.dumps(samples[-1]['roles'])[:200]}"
                        + (f" WARN {s.get('lastWarning')[:100]}" if s.get('lastWarning') else ""))
                if args.failure == "quota" and s.get("status") == "error":
                    log(f"quota: status=error at {el}s: {s.get('error')}")
                    break

            # ── inject the failure ──
            tc = time.time()
            inj = {"kind": args.failure, "tcWall": tc, "elapsedS": round(tc - t0, 2)}
            result["injection"] = inj
            if args.failure == "none":
                pass
            elif args.failure == "offscreen_close":
                ctxs_before = sw.evaluate("async () => chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})")
                inj["tcWall"] = time.time()
                sw.evaluate("async () => chrome.offscreen.closeDocument()")
                inj["contextsBefore"] = len(ctxs_before)
                inj["contextsAfter"] = len(sw.evaluate("async () => chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})"))
                log(f"offscreen closed (contexts {inj['contextsBefore']} → {inj['contextsAfter']})")
            elif args.failure == "ext_kill":
                procs = chrome_processes(profile)
                ext_procs = [p for p in procs if p["type"] == "extension_renderer"]
                inj["extensionProcesses"] = [{"pid": p["pid"], "rssMB": p["rssMB"]} for p in ext_procs]
                inj["tcWall"] = time.time()
                for p in ext_procs:
                    p["proc"].kill()
                psutil.wait_procs([p["proc"] for p in ext_procs], timeout=5)
                log(f"killed extension renderer(s): {inj['extensionProcesses']}")
            elif args.failure == "sw_unload":
                before = sw.evaluate("() => ({ timeOrigin: performance.timeOrigin, age: performance.now() })")
                try:
                    cdp.send("ServiceWorker.enable")
                    r = cdp.send("ServiceWorker.stopAllWorkers")
                    inj["method"] = "ServiceWorker.stopAllWorkers"; inj["cdpResult"] = r
                except Exception as e:
                    inj["cdpError"] = str(e)
                    targets = cdp.send("Target.getTargets")["targetInfos"]
                    swt = [t for t in targets if t["type"] == "service_worker" and ext_id in t["url"]]
                    inj["method"] = "Target.closeTarget"
                    for t in swt:
                        cdp.send("Target.closeTarget", {"targetId": t["targetId"]})
                inj["swBefore"] = before
                log(f"service worker stopped via {inj['method']}")
            elif args.failure == "tab_crash":
                inj["tcWall"] = time.time()
                # `Page.crash` via CDP wedges the WebSocket for 5+ minutes on CfT 152
                # (measured 2026-09-08 continuous--tab_crash: `Page.crash raised: Connection
                # closed while reading from the driver` at 16:18:15, six minutes after START).
                # Navigating the tab to `chrome://kill` reaches the same renderer-crash outcome
                # and returns quickly — the tab is killed by the browser process before it can
                # answer the navigation, so page.goto raises "aborted"/"crashed" almost at once.
                try:
                    tone.goto("chrome://kill", timeout=3000)
                    inj["method"] = "chrome://kill (unexpectedly returned)"
                except Exception as e:
                    inj["method"] = f"chrome://kill: {str(e)[:120]}"
                log(f"tone tab crashed: {inj['method']}")
            elif args.failure == "chrome_kill":
                k = kill_all(profile)
                inj.update(k); inj["tcWall"] = k["tcWall"]
                log(f"killed {len(k['killed'])} chrome processes in {k['killMs']} ms; alive after: {k['aliveAfter']}")
            elif args.failure == "quota":
                # Reach fatalStop() via the offscreen debug hook. Same code path as a real
                # QuotaExceededError from write; the extension does not know it was simulated.
                r = popup.evaluate("async () => chrome.runtime.sendMessage({ target: 'background', type: 'DEBUG_OFFSCREEN', what: 'simulate_quota', role: 'session' })")
                inj["method"] = "DEBUG_OFFSCREEN simulate_quota"
                inj["hook"] = r
                log(f"quota: simulated → {json.dumps(r)[:160]}")
            elif args.failure == "device_lost":
                r = popup.evaluate("async () => chrome.runtime.sendMessage({ target: 'background', type: 'DEBUG_OFFSCREEN', what: 'end_track', role: 'local_mic' })")
                inj["endTrack"] = r
                log(f"end_track local_mic → {json.dumps(r)[:160]}")
            elif args.failure == "freeze":
                steps = {}
                if engine == "webcodecs":
                    steps["freeze_input"] = popup.evaluate("async (ms) => chrome.runtime.sendMessage({ target: 'background', type: 'DEBUG_OFFSCREEN', what: 'freeze_input', role: 'local_mic', sampleRate: ms })", args.freeze_ms)
                steps["suspend_context"] = popup.evaluate("async (ms) => chrome.runtime.sendMessage({ target: 'background', type: 'DEBUG_OFFSCREEN', what: 'suspend_context', role: 'compatibility_mix', sampleRate: ms })", args.freeze_ms)
                inj["steps"] = steps
                log(f"freeze {args.freeze_ms} ms: {json.dumps(steps)[:200]}")

            # ── after the failure ──
            recovery = None
            stop_result = None
            stop_wall = None
            if args.failure in RELAUNCH:
                # State as seen by whatever survived, then relaunch the same profile.
                if args.failure == "ext_kill":
                    # Do NOT try to read state through the same CDP session after killing the
                    # extension renderer. Measured 2026-09-08 (continuous--ext_kill/run.log
                    # 15:56:35): sw.evaluate hangs for ~5 minutes before Playwright raises
                    # "Connection closed while reading from the driver". Then close_real_chrome
                    # would hang again on browser.close() over the same sick CDP link.
                    # OS-level kill of every Chrome process on this profile is the safe path.
                    inj["afterKill"] = {"note": "skipped CDP-level teardown after ext_kill"}
                    log(f"after ext_kill: {inj['afterKill']['note']}")
                    k = kill_all(profile)
                    inj["cleanKill"] = k
                    real = None
                    time.sleep(1.5)
                log("relaunching the same profile…")
                t_relaunch = time.time()
                real = launch_chrome_cdp(pw, ext, profile, extra_args=extra, exe=exe)
                ctx = real["context"]; cdp = real["cdp"]
                sw = wait_service_worker(ctx, ext_id=ext_id)
                result["relaunch"] = {"ms": round((time.time() - t_relaunch) * 1000), "extId": real["ext_id"]}
                st = wait_state(sw, lambda s: s.get("orphaned") is not None or s.get("status") == "idle", 20)
                result["stateAfterRelaunch"] = {k: st.get(k) for k in ("status", "sessionId", "orphaned", "error")}
                log(f"state after relaunch: status={st.get('status')} orphaned={json.dumps(st.get('orphaned'))[:200]}")
                # Wait for the extension's own check (chrome.runtime.onStartup → recoverSession).
                rec = None
                deadline = time.time() + 180
                while time.time() < deadline:
                    rec = sw.evaluate(RECOVERY_JS)
                    if rec and rec.get("sessionId") == sid:
                        break
                    time.sleep(0.5)
                if not (rec and rec.get("sessionId") == sid):
                    log("no automatic recovery seen after relaunch — triggering RECOVER_SESSION manually")
                    pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext_id}/src/popup/popup.html"); pg.wait_for_timeout(400)
                    r = pg.evaluate("async (sid) => chrome.runtime.sendMessage({ target: 'background', type: 'RECOVER_SESSION', sessionId: sid })", sid)
                    rec = (r or {}).get("recovery"); result["recoveryTrigger"] = "manual"
                else:
                    result["recoveryTrigger"] = "onStartup"
                recovery = rec
            elif args.failure in ("offscreen_close", "quota"):
                if args.failure == "offscreen_close":
                    # What does the service worker believe? (It was never told.)
                    time.sleep(22)
                    st = sample("after_offscreen_close")
                    inj["swStateAfter22s"] = {"status": st.get("status"), "progressAgeS": round((time.time() * 1000 - (st.get("progressAt") or 0)) / 1000, 1)}
                    log(f"22 s after offscreen close the SW still says: {inj['swStateAfter22s']}")
                    stop_wall = time.time()
                    r = popup.evaluate("async () => chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })")
                    inj["stopResponse"] = {"ok": r.get("ok"), "error": (r.get("state") or {}).get("error") or r.get("error")}
                    log(f"STOP → {inj['stopResponse']}")
                else:
                    st = wait_state(sw, lambda s: s.get("status") == "error", 30)
                    inj["tcWall"] = (st.get("stoppedByFatal") or {}).get("at", time.time() * 1000) / 1000
                    inj["fatal"] = st.get("stoppedByFatal"); inj["error"] = st.get("error")
                    stop_result = st.get("lastResult")
                    log(f"quota: status={st.get('status')} error={st.get('error')}")
                pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext_id}/src/popup/popup.html"); pg.wait_for_timeout(400)
                # Force remux even when the session ended cleanly. For simulate_quota,
                # fatalStop() still writes capture-report final:true, so recovery.js
                # otherwise skips ("session ended cleanly") and returns an empty perRole.
                # Same reasoning for offscreen_close: if closeDocument raced with a normal
                # STOP that got through, the report may look final; force keeps the numbers.
                r = pg.evaluate("async (sid) => chrome.runtime.sendMessage({ target: 'background', type: 'RECOVER_SESSION', sessionId: sid, opts: { force: true, remux: true, validate: true } })", sid)
                recovery = (r or {}).get("recovery"); result["recoveryTrigger"] = "manual(force)"
                if not recovery:
                    result["recoverError"] = r
            else:
                # Non-fatal: keep going, then STOP normally.
                t1 = time.time()
                done = set()
                while time.time() - t1 < args.observe:
                    time.sleep(1)
                    s = sample("observe")
                    el = round(time.time() - t1, 1)
                    if args.failure == "device_lost" and el >= 10 and "return" not in done:
                        done.add("return")
                        r = popup.evaluate("async () => chrome.runtime.sendMessage({ target: 'background', type: 'DEBUG_OFFSCREEN', what: 'devicechange' })")
                        inj["deviceReturn"] = {"atWall": time.time(), "result": r}
                        log(f"devicechange → {json.dumps(r)[:120]}")
                    if args.failure == "sw_unload" and "swcheck" not in done and el >= 3:
                        done.add("swcheck")
                        try:
                            sw = wait_service_worker(ctx, ext_id=ext_id, timeout_s=10)
                            after = sw.evaluate("() => ({ timeOrigin: performance.timeOrigin, age: performance.now() })")
                            inj["swAfter"] = after; inj["swRestarted"] = after["timeOrigin"] != inj["swBefore"]["timeOrigin"]
                        except Exception as e:
                            inj["swAfter"] = {"error": str(e)[:200]}
                        log(f"service worker after unload: {inj.get('swAfter')} restarted={inj.get('swRestarted')}")
                    if el % 10 < 1:
                        log(f"observe {el:4.0f}s {s.get('status')} roles={json.dumps(samples[-1]['roles'])[:200]}" + (f" WARN {s.get('lastWarning')[:90]}" if s.get('lastWarning') else ""))
                popup.bring_to_front()
                stop_wall = time.time()
                r = popup.evaluate("async () => chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })")
                sw = wait_service_worker(ctx, ext_id=ext_id)
                st = sw.evaluate(STATE_JS) or {}
                stop_result = st.get("lastResult") or (r.get("state") or {}).get("lastResult")
                log(f"stopped: {json.dumps({k: v for k, v in (stop_result or {}).items() if k in ('durationMs', 'stopReason', 'fatal', 'frozenAtStop')})}")
                # For a clean session the extension's check is a no-op; run it with force to get the decode numbers anyway.
                pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext_id}/src/popup/popup.html"); pg.wait_for_timeout(400)
                rr = pg.evaluate("async (sid) => chrome.runtime.sendMessage({ target: 'background', type: 'RECOVER_SESSION', sessionId: sid, opts: { force: true, remux: true, validate: true } })", sid)
                recovery = (rr or {}).get("recovery"); result["recoveryTrigger"] = "manual(force)"
            result["recovery"] = recovery
            result["stopResult"] = stop_result
            result["stopWall"] = stop_wall
            if recovery:
                log(f"recovery: ok={recovery.get('ok')} ms={recovery.get('ms')} workerMs={recovery.get('workerMs')} roles={json.dumps(recovery.get('roles'))[:400]}")

            # ── export + decode ──
            lab, files, exported = export_session(ctx, ext_id, sid, out, media_dir,
                                                  want=(".opus", ".json", ".jsonl") if args.no_parts else (".opus", ".json", ".jsonl", ".part"))
            result["files"] = files
            result["exported"] = {k: v["bytes"] for k, v in exported.items()}
            log(f"exported {len(exported)} files: {list(exported)[:12]}")
            chrome_decode = lab.evaluate("async (sid) => window.ironmemoLab.decodeSession(sid)", sid)
            result["decodeChrome"] = chrome_decode
            ff = {}
            for name, info in exported.items():
                if name.endswith(".opus"):
                    ff[name] = ffmpeg_decode(Path(info["path"]))
                    log(f"ffmpeg {name}: {ff[name].get('decodedSeconds')} s rc={ff[name].get('rc')} dur={ff[name].get('ffprobeDuration')} {ff[name].get('stderr', '')[:80]}")
            # MediaRecorder: the naive concatenation, per role — the thing that was called crash-safe.
            naive = {}
            if engine == "mediarecorder" and not args.no_parts:
                by_role = {}
                for name, info in exported.items():
                    m = re.match(r"^(.+)\.(\d{3})\.(\d{6})\.part$", name)
                    if m:
                        by_role.setdefault(m.group(1), []).append((int(m.group(2)), int(m.group(3)), Path(info["path"])))
                for role, parts in by_role.items():
                    parts.sort()
                    concat = media_dir / f"{role}.naive-concat.webm"
                    with open(concat, "wb") as w:
                        for _, _, p in parts:
                            w.write(p.read_bytes())
                    d = ffmpeg_decode(concat)
                    segs = {}
                    for seg in sorted({p[0] for p in parts}):
                        sp = media_dir / f"{role}.seg{seg:03d}.webm"
                        with open(sp, "wb") as w:
                            for s_, _, p in parts:
                                if s_ == seg:
                                    w.write(p.read_bytes())
                        segs[seg] = ffmpeg_decode(sp)
                    naive[role] = {"parts": len(parts), "segments": len(segs), "allPartsConcat": d,
                                   "perSegment": {k: {"decodedSeconds": v.get("decodedSeconds"), "rc": v.get("rc"), "ffprobeDuration": v.get("ffprobeDuration")} for k, v in segs.items()},
                                   "sumOfSegmentsSeconds": round(sum(v.get("decodedSeconds") or 0 for v in segs.values()), 3)}
                    log(f"naive concat {role}: {d.get('decodedSeconds')} s rc={d.get('rc')} dur={d.get('ffprobeDuration')}; per-segment sum {naive[role]['sumOfSegmentsSeconds']} s over {len(segs)} segments")
            result["decodeFfmpeg"] = ff
            result["naiveConcat"] = naive

            # ── the numbers of the cell ──
            result["metrics"] = compute_metrics(result, engine, args)
            for role, m in result["metrics"]["roles"].items():
                log(f"  {role}: expected {m.get('expectedSec')} s, ffmpeg {m.get('ffmpegSec')} s, chrome {m.get('chromeSec')} s → lost {m.get('lostSec')} s; decodesFully={m.get('decodesFully')}")
            log(f"  sync spread {result['metrics'].get('endSpreadMs')} ms; recovery {result['metrics'].get('recoveryMs')} ms; journal consistent: {result['metrics'].get('journalConsistent')}")
        except SystemExit as e:
            result["fatal"] = str(e); log(f"FATAL: {e}")
        except Exception as e:
            import traceback
            result["fatal"] = f"{type(e).__name__}: {e}"; result["traceback"] = traceback.format_exc()[-3000:]
            log(f"FATAL: {type(e).__name__}: {e}")
        finally:
            result["samples"] = samples
            result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
            log(f"result: {out / 'result.json'}")
            if real:
                try:
                    close_real_chrome(real)
                except Exception:
                    pass
            srv.shutdown()
            LOG_FP.close()
    return 0 if not result.get("fatal") else 1


def journal_write_failed_wall(out_dir: Path):
    """Wall time of the first write_failed line in the exported journal (quota cell), if any."""
    p = out_dir / "journal.jsonl"
    if not p.exists():
        return None
    for line in p.read_text(encoding="utf-8").splitlines():
        try:
            j = json.loads(line)
        except Exception:
            continue
        if j.get("t") == "write_failed" or (j.get("event") == "event" and j.get("t") == "write_failed"):
            return (j.get("wall") or 0) / 1000 or None
    return None


def compute_metrics(result, engine, args):
    """Turn the raw exports into the cell's numbers. Every value says where it came from."""
    inj = result.get("injection") or {}
    tc = inj.get("tcWall")
    first = result.get("firstFrameWall") or {}
    rec_roles = (result.get("recovery") or {}).get("roles") or {}
    ff = result.get("decodeFfmpeg") or {}
    chrome = result.get("decodeChrome") or {}
    sr = result.get("stopResult") or {}
    fatal = args.failure in FATAL
    if args.failure == "quota":
        wf = journal_write_failed_wall(OUT_ROOT / result["label"])
        if wf:
            tc = wf; inj["tcWallFromJournal"] = wf
    # Where capture ended for a clean stop: the worker's common stop instant (webcodecs) or the
    # moment stop() was called (MediaRecorder finalises what it captured until then).
    stop_instant = None
    if sr.get("workerStopWall"):
        stop_instant = sr["workerStopWall"] / 1000
    elif sr.get("stopRequestedWall"):
        stop_instant = sr["stopRequestedWall"] / 1000
    elif result.get("stopWall"):
        stop_instant = result["stopWall"]
    end_wall = tc if fatal else stop_instant
    roles = {}
    for role, fw in first.items():
        m = {"firstFrameWall": fw}
        role_end = end_wall
        if args.failure == "tab_crash" and role == "remote_tab" and tc:
            role_end = tc   # the tab track ends with the crash; the other roles run on to STOP
        m["endWallUsed"] = role_end
        if role_end:
            m["expectedSec"] = round(role_end - fw / 1000, 3)
        # which file represents the role after recovery
        fname = f"{role}.opus" if engine == "webcodecs" else f"{role}.recovered.opus"
        f = ff.get(fname)
        m["file"] = fname
        m["ffmpegSec"] = f.get("decodedSeconds") if f else None
        m["ffmpegRc"] = f.get("rc") if f else None
        m["ffprobeDuration"] = f.get("ffprobeDuration") if f else None
        c = chrome.get(fname) or {}
        rr = rec_roles.get(role) or {}
        m["chromeSec"] = round(c["decodedFrames"] / 48000, 3) if c.get("decodedFrames") is not None else rr.get("secondsDecoded")
        m["chromeOk"] = c.get("ok") if c else rr.get("decodesFully")
        m["chromeStopped"] = (c.get("demux") or {}).get("stoppedBecause")
        m["recoveryAction"] = rr.get("action"); m["recoveryRoleMs"] = rr.get("ms")
        m["fillerPackets"] = rr.get("fillerPackets"); m["trimmedPackets"] = rr.get("trimmedPackets")
        dec = m["ffmpegSec"] if m["ffmpegSec"] is not None else m["chromeSec"]
        if dec is not None and m.get("expectedSec") is not None:
            m["lostSec"] = round(m["expectedSec"] - dec, 3)
        agree = (m["ffmpegSec"] is not None and m["chromeSec"] is not None and abs(m["ffmpegSec"] - m["chromeSec"]) <= 0.021)
        m["decodersAgree"] = agree
        m["decodesFully"] = bool(f and f.get("ok") and m["chromeOk"] and agree)
        if dec is not None:
            m["endWall"] = fw / 1000 + dec
        roles[role] = m
    ends = [m["endWall"] for m in roles.values() if m.get("endWall")]
    out = {"roles": roles, "fatal": fatal, "tcWall": tc, "endWall": end_wall,
           "endSpreadMs": round((max(ends) - min(ends)) * 1000) if len(ends) > 1 else None,
           "recoveryMs": (result.get("recovery") or {}).get("ms"), "recoveryWorkerMs": (result.get("recovery") or {}).get("workerMs"),
           "recoveryOk": (result.get("recovery") or {}).get("ok"), "recoveryTrigger": result.get("recoveryTrigger")}
    jc = (result.get("recovery") or {}).get("journalCheck")
    if isinstance(jc, dict):
        if "consistent" in jc:
            out["journalConsistent"] = jc["consistent"]
        else:
            out["journalConsistent"] = all(v.get("consistent", True) for v in jc.values() if isinstance(v, dict))
    out["journalCheck"] = jc
    naive = result.get("naiveConcat") or {}
    if naive:
        out["naive"] = {r: {"allPartsConcatSec": v["allPartsConcat"].get("decodedSeconds"), "rc": v["allPartsConcat"].get("rc"),
                            "ffprobeDuration": v["allPartsConcat"].get("ffprobeDuration"), "sumOfSegmentsSec": v["sumOfSegmentsSeconds"],
                            "segments": v["segments"]} for r, v in naive.items()}
    return out


if __name__ == "__main__":
    sys.exit(main())
