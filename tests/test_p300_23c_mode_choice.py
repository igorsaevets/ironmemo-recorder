"""«Meeting or voice note» for a stored «Microphone only», and settings that keep only what differs from the defaults
(P300-23c remainder).

Before: Options (and the mic picker until P300-23b) stored the WHOLE settings object, so every default of the day was
pinned — a stored 'mic' outlived the mic+tab default (a40cb02), and the popup's warning about it could be ignored, so
a meeting was recorded without the other people. Now storage keeps only values that differ from the build's defaults,
and a stored 'mic' the user never confirmed makes Start ask once: «Meeting: record tab audio too» or «Voice note:
microphone only» (the answer is kept in ironmemo.sourceChoice.v1).

A real synthetic capture in Chrome for Testing: a copy of apps/extension-audio loaded unpacked through CDP, a local
tone page is the captured tab (CDP Extensions.triggerAction = the toolbar click that grants tabCapture), Chrome's fake
microphone, --disable-audio-output, no fake-UI flag: no real input or output device is opened. Nothing leaves the
machine. The popup is popup.html opened as a tab (the same page and code as the toolbar popup); its buttons are pressed
with element.click() because a background tab never runs the animation frames Playwright's click waits for.

  U  storage: a legacy whole object + a popup patch keeps only non-default keys; saving the defaults stores nothing;
     reset removes the stored object and the answer
  O  Options page: a legacy 'mic' + a changed bitrate stores those two keys only and is NOT an answer; choosing
     «Microphone only» there is an answer (the popup does not ask); Reset leaves nothing stored
  P1 legacy 'mic': Start asks instead of recording; «Voice note» stores the answer and records microphone only
  P2 the answered profile: no question, Start records at once
  P3 legacy 'mic' again: Start asks; «Meeting» records microphone + the tab (the tone is in the tab track) and stores
     no mode at all (mic+tab is the default)
  S  P300-10: Start clicked the moment the warning shows (the old popup had an enabled Start with no handler then)
     is refused by a disabled button or handled, never lost; popup.html ships Start disabled; then the asking state
     at the popup's width is saved as popup-asking.png

--source points at another extension folder: an older tree (git archive of a previous commit) is the negative
control — the same checks must FAIL there, or they do not see the change.

Run: python tests/test_p300_23c_mode_choice.py [--chrome PATH] [--output DIRECTORY] [--seconds 4] [--source DIR]
Prints one PASS/FAIL line per check, then VERDICT: OK | FAIL; result.json goes to the output directory.
"""
import argparse
import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from lib.browser import close_real_chrome, find_chrome_for_testing, launch_chrome_cdp, tone_server, trigger_action
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / 'apps' / 'extension-audio'
SETTINGS_KEY = 'ironmemo.settings.v1'
CHOICE_KEY = 'ironmemo.sourceChoice.v1'

SEED_JS = """async () => {
  const e = await import('/src/shared/record-entry.js');
  await chrome.storage.local.set({
    [e.CONSENT_KEY]: { version: e.CONSENT_VERSION, textShown: 'en-v4-cloud-note', acceptedAt: Date.now() },
    'ironmemo.updateNotice.v1': { id: 'cloud-option-2026-09', seenAt: Date.now(), via: 'test-bench:p300-23c-mode' },
    'ironmemo.micPermissionGranted': { granted: true, at: Date.now(), via: 'test-bench:p300-23c-mode' } });
  return e.CONSENT_VERSION;
}"""
# What a build ≤2.2.4 left behind: the WHOLE object (every default of its day) with mode 'mic', written raw.
LEGACY_JS = """async (mode) => {
  const s = await import('/src/shared/settings-schema.js');
  const o = s.defaultSettings();
  s.setByPath(o, 'source.mode', mode);
  o.__savedAt = new Date().toISOString();
  await chrome.storage.local.set({ 'ironmemo.settings.v1': o });
  await chrome.storage.local.remove('ironmemo.sourceChoice.v1');
  return s.SETTINGS.length;
}"""
STORED_JS = """async () => {
  const st = await import('/src/shared/settings-store.js');
  const got = await chrome.storage.local.get(['ironmemo.settings.v1', 'ironmemo.sourceChoice.v1']);
  const raw = got['ironmemo.settings.v1'];
  return { present: raw !== undefined, keys: st.storedKeys(raw), mode: raw?.source?.mode ?? null,
           savedAt: raw?.__savedAt ?? null, savedBy: raw?.__savedBy ?? null,
           effectiveMode: st.withDefaults(raw).source.mode, choice: got['ironmemo.sourceChoice.v1'] ?? null };
}"""
STATE_JS = "async () => (await chrome.storage.local.get('ironmemo.captureState.v1'))['ironmemo.captureState.v1'] ?? null"
SEND_JS = """async ([msg, ms]) => Promise.race([chrome.runtime.sendMessage(msg),
  new Promise((ok) => setTimeout(() => ok({ ok: false, error: 'bench: no answer in ' + ms + ' ms' }), ms))])"""
POPUP_JS = """() => { const w = document.getElementById('modeWarn'), t = (id) => document.getElementById(id)?.textContent ?? null;
  return { config: t('config'), warnHidden: w.hidden, asking: w.classList.contains('asking'), text: t('modeWarnText'),
           fix: t('modeFix'), keep: t('modeKeep'), startHidden: document.getElementById('start').hidden,
           fixDisabled: document.getElementById('modeFix').disabled }; }"""
CLICK_JS = "(id) => { const el = document.getElementById(id); if (!el) return false; el.click(); return true; }"
SELECT_JS = """([id, v]) => { const el = document.getElementById(id); if (!el) return false;
  el.value = v; el.dispatchEvent(new Event('change')); return el.value === v; }"""
READ_JS = """async (sid) => {
  const root = await navigator.storage.getDirectory();
  let dir;
  try { dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle(sid); }
  catch (e) { return { error: 'no session dir: ' + e }; }
  const files = [], tabB64 = {}; let report = null;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file') continue;
    const f = await h.getFile();
    files.push({ name, size: f.size });
    if (name === 'capture-report.json') { try { report = JSON.parse(await f.text()); } catch (e) { report = { parseError: String(e) }; } }
    if (/^remote_tab\\.(opus|webm)$/.test(name)) {
      const u = new Uint8Array(await f.arrayBuffer()); let t = '';
      for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      tabB64[name] = btoa(t);
    }
  }
  return { files, report, tabB64 };
}"""


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def peak_dbfs(path: Path):
    """ffmpeg → mono s16le; the loudest sample in dBFS (None = digital silence or no decode)."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 's16le', '-ac', '1', '-ar', '48000', '-'],
                       capture_output=True, check=False)
    n = len(p.stdout) // 2
    if p.returncode != 0 or n == 0:
        return None, round(n / 48000, 2)
    import array
    a = array.array('h')
    a.frombytes(p.stdout[: n * 2])
    peak = max(abs(min(a)), abs(max(a)))
    return (round(20 * math.log10(peak / 32768), 1) if peak else None), round(n / 48000, 2)


def watchdog(pid: int, result: dict, path: Path):
    result['watchdog'].append(f'watchdog killed pid {pid}')
    subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, check=False)
    result['ok'] = False
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str) + '\n', encoding='utf-8')
    print(f'VERDICT: FAIL (watchdog); {path}', flush=True)
    os._exit(3)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--chrome', type=Path)
    ap.add_argument('--output', type=Path)
    ap.add_argument('--seconds', type=float, default=4.0)
    ap.add_argument('--source', type=Path, default=SOURCE,
                    help='extension folder to test (default: the repo; an older tree = the negative control)')
    args = ap.parse_args()
    source = args.source
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run = REPO / 'runs' / f'p300-23c-mode-{stamp}-{uuid.uuid4().hex[:6]}'
    ext = run / 'extension-audio'
    shutil.copytree(source, ext)
    hashes = {p.relative_to(source).as_posix(): sha(p) for p in source.rglob('*') if p.is_file()}
    assert all(sha(ext / p) == h for p, h in hashes.items()), 'source copy differs from the repo'
    version = json.loads((ext / 'manifest.json').read_text(encoding='utf-8'))['version']
    output = args.output or run / 'evidence'
    output.mkdir(parents=True, exist_ok=True)
    result = {'at_utc': stamp, 'run': str(run), 'source': str(source), 'version': version, 'source_sha256': hashes,
              'scope': 'fake microphone + local tone tab; no real device, no network, no account',
              'checks': [], 'steps': {}, 'page_errors': [], 'external_requests': [], 'watchdog': []}

    def check(name, ok, detail=None):
        result['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f' -- {detail}' if not ok and detail is not None else ''), flush=True)

    srv, base = tone_server()
    h = None
    timer = None
    try:
        with sync_playwright() as pw:
            chrome = args.chrome or find_chrome_for_testing()
            h = launch_chrome_cdp(pw, ext, run / 'profile', exe=chrome, extra_args=[
                '--use-fake-device-for-media-stream', '--disable-audio-output', '--autoplay-policy=no-user-gesture-required',
                '--disable-field-trial-config', '--disable-background-networking', '--lang=en-US'])
            timer = threading.Timer(480, watchdog, args=(h['proc'].pid, result, output / 'result.json'))
            timer.daemon = True
            timer.start()
            result['browser'] = h['version']
            ctx, ext_id = h['context'], h['ext_id']
            ctx.on('request', lambda r: result['external_requests'].append(r.url)
                   if r.url.startswith(('http:', 'https:')) and not r.url.startswith(base) else None)
            ctx.grant_permissions(['microphone'])
            tone = ctx.pages[0] if ctx.pages else ctx.new_page()
            tone.goto(f'{base}/tone.html')
            deadline = time.time() + 20
            sw = None
            while sw is None and time.time() < deadline:
                sw = next((w for w in ctx.service_workers if w.url.startswith(f'chrome-extension://{ext_id}/')), None)
                if sw is None:
                    tone.wait_for_timeout(300)
            assert sw is not None, 'no service worker'
            ext_base = f'chrome-extension://{ext_id}/'

            def page(path):
                p = ctx.new_page()
                p.on('pageerror', lambda e: result['page_errors'].append(f'{path}: {e}'))
                p.goto(ext_base + path)
                return p

            ctl = page('src/session-list/session-list.html')  # a neutral extension page for storage calls
            check('consent and microphone flag seeded', ctl.evaluate(SEED_JS) is not None)

            def stored():
                return ctl.evaluate(STORED_JS)

            def state():
                return sw.evaluate(STATE_JS) or {}

            def wait(fn, timeout=10.0):
                end = time.time() + timeout
                while time.time() < end:
                    v = fn()
                    if v:
                        return v
                    time.sleep(0.2)
                return None

            # ── U: storage ──
            n_settings = ctl.evaluate(LEGACY_JS, 'mic')
            s0 = stored()
            check('U0 legacy object holds the whole schema', len(s0['keys']) > 20 and s0['mode'] == 'mic',
                  f"{len(s0['keys'])} of {n_settings} schema keys")
            ctl.evaluate("""async () => (await import('/src/shared/settings-store.js')).saveSettingsPatch(
                            { 'source.micDeviceId': 'bench-mic' })""")
            s1 = stored()
            result['steps']['U1'] = s1
            check('U1 a popup patch over the legacy object keeps only the non-default keys',
                  sorted(s1['keys']) == ['source.micDeviceId', 'source.mode'] and s1['effectiveMode'] == 'mic', s1['keys'])
            check('U1 the save names the build that wrote it', s1['savedBy'] == version, s1['savedBy'])
            ctl.evaluate("""async () => { const st = await import('/src/shared/settings-store.js');
                            const s = await import('/src/shared/settings-schema.js'); return st.saveSettings(s.defaultSettings()); }""")
            s2 = stored()
            check('U2 saving the defaults stores no setting', s2['present'] and s2['keys'] == [], s2['keys'])
            ctl.evaluate("""async () => { await chrome.storage.local.set({ 'ironmemo.sourceChoice.v1': { mode: 'mic' } });
                            return (await import('/src/shared/settings-store.js')).resetSettings(); }""")
            s3 = stored()
            check('U3 reset removes the stored object and the answer', not s3['present'] and s3['choice'] is None, s3)

            # ── O: Options page ──
            ctl.evaluate(LEGACY_JS, 'mic')
            opt = page('src/options/options.html')
            opt.on('dialog', lambda d: d.accept())
            check('O0 Options form rendered', wait(lambda: opt.evaluate("() => !!document.getElementById('f-source-mode')")))
            check('O1 bitrate changed in the form', opt.evaluate(SELECT_JS, ['f-audioEnc-bitrateKbps', '64']))
            before = stored()['savedAt']
            opt.evaluate(CLICK_JS, 'save')
            o1 = wait(lambda: (lambda s: s if s['savedAt'] != before else None)(stored()))
            result['steps']['O1'] = o1
            check('O1 Save stores only what differs from the defaults (mode + bitrate)',
                  o1 and sorted(o1['keys']) == ['audioEnc.bitrateKbps', 'source.mode'] and o1['mode'] == 'mic',
                  o1 and o1['keys'])
            check('O1 a stored mic the user did not touch is not an answer', o1 and o1['choice'] is None, o1 and o1['choice'])
            opt.evaluate(CLICK_JS, 'reset')
            o2 = wait(lambda: (lambda s: s if not s['present'] else None)(stored()))
            check('O2 Reset leaves nothing stored', o2 is not None, stored())
            opt.reload()
            wait(lambda: opt.evaluate("() => !!document.getElementById('f-source-mode')"))
            check('O3 «Microphone only» chosen in the form', opt.evaluate(SELECT_JS, ['f-source-mode', 'mic']))
            opt.evaluate(CLICK_JS, 'save')
            o3 = wait(lambda: (lambda s: s if s['present'] else None)(stored()))
            result['steps']['O3'] = o3
            check('O3 Save stores mode mic only', o3 and o3['keys'] == ['source.mode'] and o3['mode'] == 'mic', o3)
            o3c = wait(lambda: stored()['choice'])
            check('O3 …and it is the user\'s answer (via options)', (o3c or {}).get('via') == 'options', o3c)
            opt.close()
            pop = page('src/popup/popup.html')
            wait(lambda: pop.evaluate("() => document.getElementById('config').textContent.length > 0"))
            pop.wait_for_timeout(600)
            p0 = pop.evaluate(POPUP_JS)
            check('O4 popup: an answered mic shows no question', p0['warnHidden'] and not p0['startHidden'], p0)

            def click_start():
                """P300-10: Start is disabled until the popup is ready; a synthetic click on a disabled button does nothing."""
                wait(lambda: pop.evaluate("() => !document.getElementById('start').disabled"))
                return pop.evaluate(CLICK_JS, 'start')

            def record(label, click_id, expect_roles_has, expect_roles_not=()):
                """Press `click_id` in the popup page, wait for a recording, record, stop, read the session."""
                t0 = time.time()
                if click_id == 'start':
                    click_start()
                else:
                    pop.evaluate(CLICK_JS, click_id)
                st = wait(lambda: (lambda s: s if s.get('status') in ('recording', 'error') else None)(state()), 25) or {}
                info = {'status': st.get('status'), 'error': st.get('error'), 'sessionId': st.get('sessionId'),
                        'startSeconds': round(time.time() - t0, 2)}
                result['steps'][label] = info
                check(f'{label} recording starts', st.get('status') == 'recording', info)
                if st.get('status') != 'recording':
                    return None
                sid = st['sessionId']
                time.sleep(args.seconds)
                ctl.evaluate(SEND_JS, [{'target': 'background', 'type': 'STOP'}, 30000])
                st2 = wait(lambda: (lambda s: s if s.get('status') == 'idle' else None)(state()), 20) or {}
                roles = sorted({a.get('role') for a in ((st2.get('lastResult') or {}).get('assets') or [])})
                got = {}
                end = time.time() + 20
                while time.time() < end:
                    got = ctl.evaluate(READ_JS, sid)
                    if (got.get('report') or {}).get('final'):
                        break
                    time.sleep(0.3)
                info.update({'roles': roles, 'files': got.get('files')})
                check(f'{label} roles {sorted(expect_roles_has)} present' + (f', {list(expect_roles_not)} absent' if expect_roles_not else ''),
                      set(expect_roles_has) <= set(roles) and not (set(expect_roles_not) & set(roles)), roles)
                return got

            # ── P1: legacy mic → Start asks → «Voice note» records microphone only ──
            ctl.evaluate(LEGACY_JS, 'mic')
            pop.reload()
            wait(lambda: not pop.evaluate("() => document.getElementById('modeWarn').hidden"))
            p1a = pop.evaluate(POPUP_JS)
            result['steps']['P1-before'] = p1a
            check('P1 legacy mic: the warning offers both answers',
                  not p1a['warnHidden'] and p1a['fix'].startswith('Meeting') and p1a['keep'].startswith('Voice note'), p1a)
            tone.bring_to_front()
            trigger_action(h, base)
            tone.wait_for_timeout(400)
            tone.bring_to_front()
            click_start()
            pop.wait_for_timeout(1500)
            p1b = pop.evaluate(POPUP_JS)
            st = state()
            result['steps']['P1-asked'] = {'popup': p1b, 'status': st.get('status')}
            check('P1 Start does not record yet: it asks', st.get('status') in (None, 'idle') and p1b['asking'] and p1b['startHidden']
                  and p1b['text'].startswith('Choose once'), {'status': st.get('status'), **p1b})
            record('P1 «Voice note»', 'modeKeep', {'local_mic'}, ('remote_tab',))
            p1c = stored()
            check('P1 the answer is kept (via popup) and the mode stays mic',
                  (p1c['choice'] or {}).get('via') == 'popup' and p1c['mode'] == 'mic', p1c)

            # ── P2: answered → no question ──
            pop.reload()
            wait(lambda: pop.evaluate("() => document.getElementById('config').textContent.length > 0"))
            pop.wait_for_timeout(600)
            p2 = pop.evaluate(POPUP_JS)
            check('P2 answered: no warning, Start visible', p2['warnHidden'] and not p2['startHidden'], p2)
            record('P2 Start', 'start', {'local_mic'}, ('remote_tab',))

            # ── P3: legacy mic → Start asks → «Meeting» records microphone + tab ──
            ctl.evaluate(LEGACY_JS, 'mic')
            pop.reload()
            wait(lambda: not pop.evaluate("() => document.getElementById('modeWarn').hidden"))
            tone.bring_to_front()
            trigger_action(h, base)
            tone.wait_for_timeout(400)
            tone.bring_to_front()
            click_start()
            pop.wait_for_timeout(1500)
            p3a = pop.evaluate(POPUP_JS)
            check('P3 Start asks again for a legacy mic', p3a['asking'] and state().get('status') in (None, 'idle'), p3a)
            got = record('P3 «Meeting»', 'modeFix', {'local_mic', 'remote_tab'})
            p3b = stored()
            result['steps']['P3-stored'] = p3b
            check('P3 nothing is stored for the mode (mic+tab is the default) and no pinned defaults remain',
                  p3b['effectiveMode'] == 'mic+tab' and 'source.mode' not in p3b['keys'] and p3b['keys'] == [], p3b['keys'])
            check('P3 no answer stored', p3b['choice'] is None, p3b['choice'])
            if got and got.get('tabB64'):
                name, b64 = next(iter(got['tabB64'].items()))
                f = output / f'P3-{name}'
                f.write_bytes(base64.b64decode(b64))
                pk, secs = peak_dbfs(f)
                result['steps']['P3 «Meeting»']['tab'] = {'file': f.name, 'peakDbfs': pk, 'seconds': secs}
                check('P3 the tab track carries the tone page (peak above −40 dBFS)', pk is not None and pk > -40, {'peakDbfs': pk, 'seconds': secs})
            else:
                check('P3 the tab track carries the tone page (peak above −40 dBFS)', False, 'no remote_tab file')

            # ── S: the asking state at the popup's own width, for the eye (CSS of two stacked buttons) ──
            ctl.evaluate(LEGACY_JS, 'mic')
            pop.bring_to_front()
            pop.set_viewport_size({'width': 340, 'height': 640})
            pop.reload()
            wait(lambda: not pop.evaluate("() => document.getElementById('modeWarn').hidden"))
            # P300-10: click as soon as the warning shows — the moment the old popup had an enabled Start with no handler
            early = pop.evaluate("() => { const s = document.getElementById('start'); const d = s.disabled; s.click(); return d; }")
            pop.wait_for_timeout(1200)
            s_early = pop.evaluate(POPUP_JS)
            result['steps']['S-early-click'] = {'disabledAtClick': early, **s_early}
            check('S P300-10 an early Start click is refused by a disabled button or handled, never lost',
                  early or s_early['asking'], {'disabledAtClick': early, 'asking': s_early['asking']})
            html = ctl.evaluate("async () => (await fetch(chrome.runtime.getURL('src/popup/popup.html'))).text()")
            check('S P300-10 popup.html ships Start disabled', bool(re.search(r'<button id="start"[^>]*\bdisabled\b', html)))
            if not s_early['asking']:
                click_start()
                pop.wait_for_timeout(1200)
            s_state = pop.evaluate(POPUP_JS)
            check('S asking state shown (no recording)', s_state['asking'] and state().get('status') in (None, 'idle'), s_state)
            pop.screenshot(path=str(output / 'popup-asking.png'), full_page=True)
            check('no page errors', not result['page_errors'], result['page_errors'])
            check('no request left the machine', not result['external_requests'], result['external_requests'])
    finally:
        if timer:
            timer.cancel()
        if h:
            close_real_chrome(h)
        srv.shutdown()
    result['ok'] = bool(result['checks']) and all(c['ok'] for c in result['checks'])
    (output / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str) + '\n', encoding='utf-8')
    passed = sum(c['ok'] for c in result['checks'])
    print(f"{passed}/{len(result['checks'])} checks; {output / 'result.json'}")
    print('VERDICT: OK' if result['ok'] else 'VERDICT: FAIL')
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
