"""
smoke_test.py — verify the extension loads and its pages render after a clean git clone.

Setup (once):
    pip install -r tests/requirements.txt
    npx @puppeteer/browsers install chrome@152
    playwright install chromium

Run:
    python tests/smoke_test.py
    python tests/smoke_test.py --headed      # visible browser window
    python tests/smoke_test.py --cft-only    # fail if Chrome for Testing is missing

Checks:
  1. Extension loads in Chrome for Testing (or Playwright's bundled CfT)
  2. Service worker starts
  3. Popup page renders (Start button present)
  4. Options page renders (settings form present)
  5. Session list page renders (container present)
  6. Permission page renders
  7. Settings schema exports expected defaults

Does NOT test recording (needs fake microphone + CDP triggerAction for tabCapture).
For full crash-matrix testing see tests/crash_matrix.py.
"""

import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tests"))
from lib.browser import (describe, find_chrome_for_testing, launch_kwargs,
                          prepare_test_extension, wait_service_worker)

from playwright.sync_api import sync_playwright

CHECKS = []
FAILED = []


def check(name: str, ok: bool, detail: str = ""):
    status = "PASS" if ok else "FAIL"
    line = f"  [{status}] {name}"
    if detail:
        line += f" — {detail}"
    print(line, flush=True)
    CHECKS.append({"name": name, "ok": ok, "detail": detail})
    if not ok:
        FAILED.append(name)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="IronMemo extension smoke test")
    ap.add_argument("--headed", action="store_true", help="show browser window")
    ap.add_argument("--cft-only", action="store_true", help="fail if Chrome for Testing is not installed")
    a = ap.parse_args()

    cft = find_chrome_for_testing()
    print(f"Browser: {describe(cft)}")
    if a.cft_only and cft is None:
        print("FAIL: --cft-only but Chrome for Testing not found. Install with:")
        print("  npx @puppeteer/browsers install chrome@152")
        return 1

    ext = prepare_test_extension()
    print(f"Test extension: {ext}")
    profile = REPO_ROOT / "runs" / "smoke-profile"
    profile.mkdir(parents=True, exist_ok=True)

    kw = launch_kwargs(ext, profile, headless=not a.headed)
    kw["args"] += [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--lang=en-US",
    ]

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(str(profile), **kw)
        try:
            sw = wait_service_worker(ctx, timeout_s=15)
            ext_id = sw.url.split("/")[2]
            check("service_worker", True, f"ext_id={ext_id}")

            # 1. Popup
            popup = ctx.new_page()
            popup.goto(f"chrome-extension://{ext_id}/src/popup/popup.html")
            popup.wait_for_timeout(1500)
            has_start = popup.locator("#startBtn, #start, button").count() > 0
            title = popup.title()
            check("popup_renders", has_start, f"title={title!r}, buttons found={has_start}")

            # 2. Options
            opts = ctx.new_page()
            opts.goto(f"chrome-extension://{ext_id}/src/options/options.html")
            opts.wait_for_timeout(1500)
            has_form = opts.locator("select, input, .setting, .group").count() > 0
            check("options_renders", has_form, f"form elements found={has_form}")

            # 3. Session list
            sl = ctx.new_page()
            sl.goto(f"chrome-extension://{ext_id}/src/session-list/session-list.html")
            sl.wait_for_timeout(1500)
            has_list = sl.locator("#list").count() > 0
            check("session_list_renders", has_list, f"#list present={has_list}")

            # 4. Permission page
            perm = ctx.new_page()
            perm.goto(f"chrome-extension://{ext_id}/src/permission/permission.html")
            perm.wait_for_timeout(1000)
            has_grant = perm.locator("#grant, button").count() > 0
            check("permission_page_renders", has_grant)

            # 5. Settings schema loads
            schema_ok = False
            schema_detail = ""
            try:
                defaults = opts.evaluate("""async () => {
                    const m = await import('/src/shared/settings-schema.js');
                    const s = typeof m.defaultSettings === 'function' ? m.defaultSettings() : null;
                    if (!s) return { error: 'no defaultSettings export' };
                    return {
                        engine: s.audioEnc?.impl,
                        codec: s.audioEnc?.codec,
                        container: s.audioEnc?.container,
                        backend: s.storage?.backend,
                    };
                }""")
                if defaults and not defaults.get("error"):
                    expected = {"engine": "webcodecs", "codec": "opus", "container": "ogg", "backend": "opfs"}
                    schema_ok = all(defaults.get(k) == v for k, v in expected.items())
                    schema_detail = json.dumps(defaults, ensure_ascii=False)
                else:
                    schema_detail = str(defaults)
            except Exception as e:
                schema_detail = str(e)[:200]
            check("settings_schema_defaults", schema_ok, schema_detail)

            # 6. Manifest version readable
            mf = json.loads((REPO_ROOT / "apps" / "extension-audio" / "manifest.json").read_text(encoding="utf-8"))
            check("manifest_version", bool(mf.get("version")), f"v{mf['version']}")

        finally:
            ctx.close()

    print(f"\n{'='*50}")
    print(f"  {len(CHECKS)} checks, {len(CHECKS) - len(FAILED)} passed, {len(FAILED)} failed")
    if FAILED:
        print(f"  FAILED: {', '.join(FAILED)}")
    print(f"{'='*50}")

    result = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "browser": describe(cft),
        "checks": CHECKS,
        "passed": len(CHECKS) - len(FAILED),
        "failed": len(FAILED),
    }
    out = REPO_ROOT / "runs" / "smoke-result.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Result: {out}")

    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
