"""
browser.py — Chrome for Testing launcher and test helpers for the IronMemo extension.

Works from a clean git clone: paths are relative to the repo root, not a parent
project container.  The original (.claude/scripts/browser.py) stays unchanged for
local development scripts that depend on the parent directory layout.

Chrome for Testing setup:
    cd <repo-root>
    npx @puppeteer/browsers install chrome@152
    # installs into runs/chrome-for-testing/ (gitignored)

Or set IRONMEMO_CFT to the chrome.exe path directly.
"""

import http.server
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CFT_ROOT = REPO_ROOT / "runs" / "chrome-for-testing"
SRC_EXT = REPO_ROOT / "apps" / "extension-audio"
TEST_EXT = REPO_ROOT / "runs" / "test-extension" / "extension-audio"
REAL_CHROME = Path(os.environ.get("CHROME_EXE", r"C:\Program Files\Google\Chrome\Application\chrome.exe"))

FAKE_MEDIA_ARGS = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
]


def find_chrome_for_testing() -> Path | None:
    env = os.environ.get("IRONMEMO_CFT")
    if env:
        p = Path(env)
        if p.exists():
            return p
    if not CFT_ROOT.exists():
        return None
    builds = sorted(CFT_ROOT.glob("win64-*/chrome-win64/chrome.exe"))
    builds += sorted(CFT_ROOT.glob("*/chrome-*/chrome"))
    return builds[-1] if builds else None


def describe(exe: Path | None) -> str:
    if exe is None:
        return ("Chrome for Testing not installed — using Playwright's bundled browser. "
                "Install with: npx @puppeteer/browsers install chrome@152")
    ver = exe.parent.parent.name.replace("win64-", "")
    return f"Chrome for Testing {ver} — {exe}"


def prepare_test_extension(host_permissions=("<all_urls>",), dest: Path | None = None) -> Path:
    dest = dest or TEST_EXT
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(SRC_EXT, dest, ignore=shutil.ignore_patterns("node_modules", "*.zip", "*.crx", "*.pem"))
    mp = dest / "manifest.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["host_permissions"] = sorted(set(m.get("host_permissions", [])) | set(host_permissions))
    m["name"] = m["name"].replace("(dev)", "(test build)")
    mp.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    return dest


def launch_kwargs(ext_path: Path, profile: Path, headless: bool = False) -> dict:
    exe = find_chrome_for_testing()
    kw = {
        "headless": headless,
        "args": [
            f"--disable-extensions-except={ext_path}",
            f"--load-extension={ext_path}",
            "--disable-field-trial-config",
        ],
    }
    if exe:
        kw["executable_path"] = str(exe)
    return kw


def run_context_note(exe: Path | None, user_chrome_version: str = "152.0.7977.83") -> dict:
    if exe is not None:
        ver = exe.parent.parent.name.replace("win64-", "")
        same_major = ver.split(".")[0] == user_chrome_version.split(".")[0]
        return {
            "browser": f"Google Chrome for Testing {ver}",
            "isRealChromeBuild": True,
            "userChrome": user_chrome_version,
            "sameMajorVersion": same_major,
            "flags": ["--disable-field-trial-config"],
        }
    return {
        "browser": "Chrome for Testing bundled with Playwright (version not pinned)",
        "isRealChromeBuild": True,
        "userChrome": user_chrome_version,
        "sameMajorVersion": False,
    }


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def tone_server(directory: Path | None = None) -> tuple[http.server.ThreadingHTTPServer, str]:
    directory = directory or (SRC_EXT / "src" / "lab")
    handler = lambda *a, **k: _QuietHandler(*a, directory=str(directory), **k)  # noqa: E731
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, f"http://127.0.0.1:{port}"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def real_chrome_version(exe: Path = REAL_CHROME) -> str | None:
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-Item '{exe}').VersionInfo.ProductVersion"],
            capture_output=True, text=True, timeout=20)
        return out.stdout.strip() or None
    except Exception:
        return None


def launch_chrome_cdp(pw, ext_path: Path, profile: Path, extra_args=(), exe: Path | None = None):
    if exe is None:
        exe = find_chrome_for_testing() or REAL_CHROME
    return launch_real_chrome_cdp(pw, ext_path, profile, extra_args=extra_args, exe=exe)


def trigger_action(h: dict, url_prefix: str) -> dict:
    targets = h["cdp"].send("Target.getTargets", {"filter": [{"type": "tab"}]})["targetInfos"]
    tab = next((t for t in targets if t["url"].startswith(url_prefix)), None)
    if tab is None:
        raise RuntimeError(f"no tab target with url prefix {url_prefix}; targets: {[t['url'] for t in targets]}")
    t0 = time.time()
    h["cdp"].send("Extensions.triggerAction", {"id": h["ext_id"], "targetId": tab["targetId"]})
    return {"targetId": tab["targetId"], "url": tab["url"], "ms": round((time.time() - t0) * 1000, 1)}


def launch_real_chrome_cdp(pw, ext_path: Path, profile: Path, extra_args=(), exe: Path = REAL_CHROME):
    if not exe.exists():
        raise FileNotFoundError(f"Chrome not found: {exe}")
    profile.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    args = [
        str(exe),
        f"--user-data-dir={profile}",
        f"--remote-debugging-port={port}",
        "--enable-unsafe-extension-debugging",
        "--no-first-run", "--no-default-browser-check",
        "--disable-features=Translate",
        "--window-size=1400,900",
        *extra_args,
        "about:blank",
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    endpoint = f"http://127.0.0.1:{port}"
    deadline = time.time() + 30
    browser = None
    while time.time() < deadline:
        try:
            browser = pw.chromium.connect_over_cdp(endpoint, timeout=5000)
            break
        except Exception:
            time.sleep(0.4)
    if browser is None:
        proc.kill()
        raise RuntimeError("Chrome did not start DevTools within 30 s")

    cdp = browser.new_browser_cdp_session()
    try:
        r = cdp.send("Extensions.loadUnpacked", {"path": str(ext_path)})
        ext_id = r["id"]
    except Exception:
        installed0 = cdp.send("Extensions.getExtensions")
        match = [x for x in installed0.get("extensions", []) if str(x.get("path", "")).lower() == str(ext_path).lower()]
        if not match:
            proc.kill()
            raise
        ext_id = match[0]["id"]
    installed = cdp.send("Extensions.getExtensions")
    ids = [e["id"] for e in installed.get("extensions", [])]
    if ext_id not in ids:
        proc.kill()
        raise RuntimeError(
            f"Extensions.loadUnpacked returned ok ({ext_id}), but getExtensions does not list it "
            f"— Chrome was likely launched without --enable-unsafe-extension-debugging. Response: {installed}")
    context = browser.contexts[0]
    return {
        "browser": browser, "context": context, "cdp": cdp, "ext_id": ext_id,
        "proc": proc, "version": browser.version, "install": installed, "endpoint": endpoint,
    }


def close_real_chrome(h: dict):
    try:
        h["browser"].close()
    except Exception:
        pass
    try:
        h["proc"].terminate()
        h["proc"].wait(timeout=10)
    except Exception:
        try:
            h["proc"].kill()
        except Exception:
            pass


def real_chrome_context_note(h: dict, is_cft: bool = False) -> dict:
    return {
        "browser": (f"Google Chrome for Testing {h['version']}" if is_cft else f"Google Chrome (stable) {h['version']}"),
        "isRealChromeBuild": True,
        "isCfT": is_cft,
        "loadedVia": "CDP Extensions.loadUnpacked over --remote-debugging-port + --enable-unsafe-extension-debugging",
        "installVerifiedBy": "Extensions.getExtensions",
    }


def wait_service_worker(context, timeout_s: float = 20.0, ext_id: str | None = None):
    def ours(w):
        return ext_id is None or w.url.startswith(f"chrome-extension://{ext_id}/")
    for w in context.service_workers:
        if ours(w):
            return w
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            w = context.wait_for_event("serviceworker", timeout=max(500, (deadline - time.time()) * 1000))
        except Exception:
            break
        if ours(w):
            return w
    for w in context.service_workers:
        if ours(w):
            return w
    raise RuntimeError(f"service worker of extension {ext_id} did not appear; present: {[w.url for w in context.service_workers]}")


def ext_url(ext_id: str, path: str) -> str:
    return f"chrome-extension://{ext_id}/{path}"
