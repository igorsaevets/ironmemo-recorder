"""
test_tab_url.py — Runtime check: is tab.url accessible without tabs/activeTab permission?

The manifest declares tabCapture, offscreen, storage, unlimitedStorage — but NOT tabs
and NOT activeTab.  The Chrome docs say tab.url is only populated when the extension has
the tabs permission, a matching host_permission, or activeTab.

This test launches CfT 152 with the REAL manifest permissions (no extra host_permissions),
navigates to a regular web page, and checks whether tab.url is defined from the service
worker — exactly the code path that service-worker.js:189-196 uses.

Run:
    python tests/test_tab_url.py
    python tests/test_tab_url.py --headed    # visible browser
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


def main():
    import argparse
    ap = argparse.ArgumentParser(description="tab.url accessibility test")
    ap.add_argument("--headed", action="store_true", help="show browser window")
    a = ap.parse_args()

    cft = find_chrome_for_testing()
    print(f"Browser: {describe(cft)}")
    if cft is None:
        print("FAIL: Chrome for Testing not found.")
        print("  Install with: npx @puppeteer/browsers install chrome@152")
        return 1

    # host_permissions=() preserves the real manifest: no tabs, no activeTab, no hosts
    ext = prepare_test_extension(host_permissions=())
    print(f"Test extension (no extra host_permissions): {ext}")

    # Verify the test manifest has empty host_permissions
    mf = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
    hp = mf.get("host_permissions", [])
    perms = mf.get("permissions", [])
    print(f"  permissions: {perms}")
    print(f"  host_permissions: {hp}")
    assert "tabs" not in perms, "manifest should NOT have tabs permission"
    assert "activeTab" not in perms, "manifest should NOT have activeTab permission"
    assert not hp or hp == [], "manifest should have empty host_permissions"

    profile = REPO_ROOT / "runs" / "tab-url-test-profile"
    profile.mkdir(parents=True, exist_ok=True)

    kw = launch_kwargs(ext, profile, headless=not a.headed)
    kw["args"] += ["--lang=en-US"]

    results = {}

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(str(profile), **kw)
        try:
            sw = wait_service_worker(ctx, timeout_s=15)
            ext_id = sw.url.split("/")[2]
            print(f"\nExtension loaded: {ext_id}")

            # Navigate the first tab to a regular web page
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto("https://example.com", wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(1500)

            # --- Test 1: chrome.tabs.query from the service worker ---
            t1 = sw.evaluate("""async () => {
                const tabs = await chrome.tabs.query({active: true, currentWindow: true});
                const tab = tabs[0] || null;
                if (!tab) return {tabFound: false};
                const keys = Object.keys(tab);
                return {
                    tabFound: true,
                    tabId: tab.id,
                    hasUrlKey: keys.includes('url'),
                    urlValue: tab.url === undefined ? '__UNDEFINED__' : tab.url,
                    urlType: typeof tab.url,
                    hasTitleKey: keys.includes('title'),
                    titleValue: tab.title === undefined ? '__UNDEFINED__' : tab.title,
                    hasFaviconKey: keys.includes('favIconUrl'),
                    allKeys: keys.sort(),
                };
            }""")

            results["query"] = t1
            print(f"\n--- Test 1: chrome.tabs.query (example.com) ---")
            print(f"  tab found: {t1.get('tabFound')}")
            if t1.get("tabFound"):
                print(f"  tab.id: {t1.get('tabId')}")
                print(f"  'url' in keys: {t1.get('hasUrlKey')}")
                print(f"  tab.url: {t1.get('urlValue')}")
                print(f"  typeof tab.url: {t1.get('urlType')}")
                print(f"  'title' in keys: {t1.get('hasTitleKey')}")
                print(f"  tab.title: {t1.get('titleValue')}")
                print(f"  all keys: {t1.get('allKeys')}")

            # --- Test 2: chrome.tabs.get(tabId) ---
            tab_id = t1.get("tabId")
            if tab_id:
                t2 = sw.evaluate("""async (id) => {
                    const tab = await chrome.tabs.get(id);
                    const keys = Object.keys(tab);
                    return {
                        hasUrlKey: keys.includes('url'),
                        urlValue: tab.url === undefined ? '__UNDEFINED__' : tab.url,
                        urlType: typeof tab.url,
                        allKeys: keys.sort(),
                    };
                }""", tab_id)
                results["get"] = t2
                print(f"\n--- Test 2: chrome.tabs.get({tab_id}) ---")
                print(f"  'url' in keys: {t2.get('hasUrlKey')}")
                print(f"  tab.url: {t2.get('urlValue')}")
                print(f"  typeof tab.url: {t2.get('urlType')}")
                print(f"  all keys: {t2.get('allKeys')}")

            # --- Test 3: sourceTypeFromUrl behavior with various inputs ---
            t3 = sw.evaluate("""() => {
                function sourceTypeFromUrl(url) {
                    try {
                        const host = new URL(url).hostname.toLowerCase();
                        if (host === 'meet.google.com') return 'meet';
                        if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
                        if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
                        return 'other';
                    } catch { return 'other'; }
                }
                return {
                    empty_string: sourceTypeFromUrl(''),
                    undefined_val: sourceTypeFromUrl(undefined),
                    null_val: sourceTypeFromUrl(null),
                    example_com: sourceTypeFromUrl('https://example.com'),
                    meet: sourceTypeFromUrl('https://meet.google.com/abc-defg-hij'),
                    zoom: sourceTypeFromUrl('https://us04web.zoom.us/j/1234567'),
                    teams: sourceTypeFromUrl('https://teams.microsoft.com/l/meetup-join/x'),
                    about_blank: sourceTypeFromUrl('about:blank'),
                    chrome_page: sourceTypeFromUrl('chrome://extensions'),
                };
            }""")
            results["sourceType"] = t3
            print(f"\n--- Test 3: sourceTypeFromUrl behavior ---")
            for k, v in t3.items():
                print(f"  {k}: '{v}'")

            # --- Test 4: the nullish coalescing path (tab.url ?? '') ---
            url_val = t1.get("urlValue", "__UNDEFINED__")
            is_undefined = url_val == "__UNDEFINED__" or t1.get("urlType") == "undefined"

            coalesced = "" if is_undefined else url_val
            t4_type = sw.evaluate("""(url) => {
                function sourceTypeFromUrl(u) {
                    try {
                        const host = new URL(u).hostname.toLowerCase();
                        if (host === 'meet.google.com') return 'meet';
                        if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
                        if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
                        return 'other';
                    } catch { return 'other'; }
                }
                return sourceTypeFromUrl(url);
            }""", coalesced)
            results["coalesced_type"] = t4_type
            print(f"\n--- Test 4: actual code path (tab.url ?? '') ---")
            print(f"  Input to sourceTypeFromUrl: '{coalesced}'")
            print(f"  Result: '{t4_type}'")

            # --- VERDICT ---
            url_accessible = t1.get("hasUrlKey", False) and t1.get("urlType") == "string" and t1.get("urlValue") != "__UNDEFINED__"

            print(f"\n{'='*70}")
            if url_accessible:
                actual_url = t1.get("urlValue", "")
                print(f"RESULT: tab.url IS accessible (value: '{actual_url}')")
                print(f"  Platform detection WORKS. Privacy policy claims are accurate.")
                print(f"  No manifest changes needed.")
            else:
                print(f"RESULT: tab.url is NOT accessible (undefined)")
                print(f"  Platform detection is DEAD CODE.")
                print(f"  Every tab recording gets source_type='other'.")
                print(f"  The internal-pages guard (chrome://) also doesn't work")
                print(f"  (but tabCapture itself likely rejects chrome:// tabs).")
                print(f"  ")
                print(f"  Options:")
                print(f"    (a) Add 'activeTab' to manifest.permissions")
                print(f"        + platform detection works after user clicks the popup")
                print(f"        + no install-time warning (activeTab is silent)")
                print(f"        + BUT: CWS may require web browsing activity disclosure")
                print(f"    (b) Remove platform enum from privacy policy §3")
                print(f"        + simpler, no manifest change, no zip rebuild")
                print(f"        + source_type stays 'other' for all tab recordings")
                print(f"        + server-side analytics lose meeting-platform breakdown")
            print(f"{'='*70}")

            results["verdict"] = "accessible" if url_accessible else "not_accessible"

            # Save results
            out_path = REPO_ROOT / "runs" / "tab-url-test-results.json"
            out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"\nResults saved to {out_path}")

        finally:
            ctx.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
