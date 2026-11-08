"""Capture-build provenance (P300-23c): which extension build CREATED a recording, read from the recording itself.

A real synthetic capture in Chrome for Testing: the copy of apps/extension-audio is loaded unpacked through CDP, a
local tone page is the captured tab (CDP Extensions.triggerAction = the toolbar click that grants tabCapture), the
microphone is Chrome's fake device; --disable-audio-output, so no real input or output device is opened. Nothing
leaves the machine; no account, no upload. Each run keeps a NEW profile and a SHA-checked source copy under runs/.

Sessions, all in one profile:
  A  normal start: report written at Start and at Stop + the journal's session_open line carry the same build
  B  chrome.management.getSelf() never answers: Start is bounded, installType is null WITH a reason
  C  chrome.management.getSelf() throws: same, with the error as the reason
  D  the copy's manifest version is raised and the extension reloaded BETWEEN recordings: D carries the new version,
     A's report is byte-identical to before (an update does not relabel an old recording)
  E  the version is raised and the extension reloaded DURING a recording: E becomes an orphan, the new build checks
     it (recovery.json), and E's report still names the build that recorded it
  F  an old-format report (no `build`, version 2): readers still pick the same asset and the Recordings page renders
     every session without page errors

Run: python tests/test_p300_23c_build.py [--chrome PATH] [--output DIRECTORY] [--seconds 3]
Prints one PASS/FAIL line per check, then VERDICT: OK | FAIL; result.json goes to the output directory.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from lib.browser import (
    close_real_chrome,
    find_chrome_for_testing,
    launch_chrome_cdp,
    tone_server,
    trigger_action,
)
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / 'apps' / 'extension-audio'
STORE_ID = 'epnajjfddhbhgabhmcaomfnjhnhjnchd'
BUILD_KEYS = {'version', 'installType', 'storeItem', 'capturedAt', 'capturedBy'}

PERM_JS = """async () => chrome.storage.local.set({ 'ironmemo.micPermissionGranted':
  { granted: true, at: Date.now(), via: 'test-bench:p300-23c-build' } })"""
STATE_JS = "async () => (await chrome.storage.local.get('ironmemo.captureState.v1'))['ironmemo.captureState.v1'] ?? null"
SEND_JS = """async ([msg, ms]) => Promise.race([chrome.runtime.sendMessage(msg),
  new Promise((ok) => setTimeout(() => ok({ ok: false, error: 'bench: no answer in ' + ms + ' ms' }), ms))])"""
SELF_JS = """async () => { const s = await chrome.management.getSelf();
  return { installType: s.installType, id: chrome.runtime.id, version: chrome.runtime.getManifest().version }; }"""
VERSION_JS = '() => chrome.runtime.getManifest().version'
PATCH_JS = """(mode) => {
  const m = chrome.management;
  if (!globalThis.__benchGetSelf) globalThis.__benchGetSelf = m.getSelf;
  if (mode === 'hang') m.getSelf = () => new Promise(() => {});
  else if (mode === 'throw') m.getSelf = () => { throw new Error('bench: management unavailable'); };
  else m.getSelf = globalThis.__benchGetSelf;
  return { mode, patched: m.getSelf !== globalThis.__benchGetSelf };
}"""
READ_JS = """async (sid) => {
  const root = await navigator.storage.getDirectory();
  let dir;
  try { dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle(sid); }
  catch (e) { return { error: 'no session dir: ' + e }; }
  const files = []; let reportText = null, journalFirst = null, recovery = null;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file') continue;
    const f = await h.getFile();
    files.push({ name, size: f.size, lastModified: f.lastModified });
    if (name === 'capture-report.json') reportText = await f.text();
    if (name === 'journal.jsonl') { const t = await f.text(); journalFirst = t.split('\\n')[0] || null; }
    if (name === 'recovery.json') { try { recovery = JSON.parse(await f.text()); } catch (e) { recovery = { parseError: String(e) }; } }
  }
  let report = null;
  try { report = reportText ? JSON.parse(reportText) : null; } catch (e) { report = { parseError: String(e) }; }
  let pick = null;
  try {
    const up = await import('/src/ingest/upload.js');
    const a = up.pickAsset({ files, report, recovery: null, status: report?.final ? 'ok' : 'orphan' });
    pick = { role: a.role, name: a.name, ext: a.ext, kind: a.kind };
  } catch (e) { pick = { error: String(e && e.message || e) }; }
  let journal = null;
  try { journal = journalFirst ? JSON.parse(journalFirst) : null; } catch (e) { journal = { parseError: String(e) }; }
  return { files, reportText, report, journalFirst: journal, recovery, pick };
}"""
OLD_FIXTURE_JS = """async ([fromSid, toSid]) => {
  const sessions = await (await navigator.storage.getDirectory()).getDirectoryHandle('sessions');
  const from = await sessions.getDirectoryHandle(fromSid);
  const to = await sessions.getDirectoryHandle(toSid, { create: true });
  for await (const [name, h] of from.entries()) {
    if (h.kind !== 'file' || name === 'meta.json') continue;
    let bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
    if (name === 'capture-report.json') {
      const r = JSON.parse(new TextDecoder().decode(bytes));
      delete r.build; r.version = 2; r.sessionId = toSid;
      bytes = new TextEncoder().encode(JSON.stringify(r, null, 2));
    }
    const w = await (await to.getFileHandle(name, { create: true })).createWritable();
    await w.write(bytes); await w.close();
  }
  return true;
}"""


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def watchdog(pid: int, result: dict, path: Path):
    # Only kills by PID and writes what it has (E-276: Playwright calls stay on the main thread). A dead Playwright
    # driver leaves the main thread blocked, so the watchdog also ends the process.
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
    ap.add_argument('--seconds', type=float, default=3.0)
    args = ap.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run = REPO / 'runs' / f'p300-23c-build-{stamp}-{uuid.uuid4().hex[:6]}'
    ext = run / 'extension-audio'
    shutil.copytree(SOURCE, ext)
    hashes = {p.relative_to(SOURCE).as_posix(): sha(p) for p in SOURCE.rglob('*') if p.is_file()}
    assert all(sha(ext / p) == h for p, h in hashes.items()), 'source copy differs from the repo'
    manifest_path = ext / 'manifest.json'
    v1 = json.loads(manifest_path.read_text(encoding='utf-8'))['version']
    v2, v3 = f'{v1}.1', f'{v1}.2'
    output = args.output or run / 'evidence'
    output.mkdir(parents=True, exist_ok=True)
    result = {'at_utc': stamp, 'run': str(run), 'source_sha256': hashes, 'versions': [v1, v2, v3],
              'scope': 'fake microphone + local tone tab; no real device, no network, no account',
              'checks': [], 'sessions': {}, 'page_errors': [], 'external_requests': [], 'watchdog': []}

    def check(name, ok, detail=None):
        result['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f' -- {detail}' if not ok and detail is not None else ''), flush=True)

    def set_version(v):
        m = json.loads(manifest_path.read_text(encoding='utf-8'))
        m['version'] = v
        manifest_path.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding='utf-8')

    def update_to(v):
        # The bench's «update»: raise the copy's version and load the same path again. Measured 2026-11-08 (CfT 152,
        # runs/2026-11-08-p300-23c/probe_reload.py): same id, storage kept, old pages closed, new worker in 0.5 s.
        # chrome.runtime.reload() instead left the CDP-loaded extension DISABLED at the old version.
        set_version(v)
        return h['cdp'].send('Extensions.loadUnpacked', {'path': str(ext)})

    srv, base = tone_server()
    h = None
    timer = None
    try:
        with sync_playwright() as pw:
            chrome = args.chrome or find_chrome_for_testing()
            h = launch_chrome_cdp(pw, ext, run / 'profile', exe=chrome, extra_args=[
                '--use-fake-device-for-media-stream', '--disable-audio-output', '--autoplay-policy=no-user-gesture-required',
                '--disable-field-trial-config', '--disable-background-networking', '--lang=en-US'])
            timer = threading.Timer(300, watchdog, args=(h['proc'].pid, result, output / 'result.json'))
            timer.daemon = True
            timer.start()
            result['browser'] = h['version']
            ctx, ext_id = h['context'], h['ext_id']
            ctx.on('request', lambda r: result['external_requests'].append(r.url)
                   if r.url.startswith(('http:', 'https:')) and not r.url.startswith(base) else None)
            ctx.grant_permissions(['microphone'])
            tone = ctx.pages[0] if ctx.pages else ctx.new_page()
            tone.goto(f'{base}/tone.html')
            env = {}

            def worker_with(version, timeout_s=25.0, skip=None):
                # `skip` = the worker of the previous load: evaluating it while Chrome tears it down killed the
                # Playwright driver («Connection closed while reading from the driver», 2026-11-08 baseline run 2).
                deadline = time.time() + timeout_s
                while time.time() < deadline:
                    for w in reversed(ctx.service_workers):
                        if w is skip or not w.url.startswith(f'chrome-extension://{ext_id}/'):
                            continue
                        try:
                            if w.evaluate(VERSION_JS) == version:
                                return w
                        except Exception as e:  # noqa: BLE001 - a worker that is going away
                            result.setdefault('workerProbeErrors', []).append(type(e).__name__)
                    tone.wait_for_timeout(300)
                raise RuntimeError(f'no service worker with version {version}')

            def open_control():
                if env.get('ctl') and not env['ctl'].is_closed():
                    env['ctl'].close()
                ctl = ctx.new_page()
                ctl.on('pageerror', lambda e: result['page_errors'].append(str(e)))
                ctl.goto(f'chrome-extension://{ext_id}/src/popup/popup.html')
                ctl.wait_for_timeout(800)
                env['ctl'] = ctl

            def state():
                return env['sw'].evaluate(STATE_JS) or {}

            def start(label):
                tone.bring_to_front()
                trigger_action(h, base)
                tone.wait_for_timeout(400)
                tone.bring_to_front()
                t0 = time.time()
                ans = env['ctl'].evaluate(SEND_JS, [{'target': 'background', 'type': 'START',
                                                     'clickedAt': int(time.time() * 1000)}, 30000])
                st = {}
                while time.time() - t0 < 25:
                    st = state()
                    if st.get('status') in ('recording', 'error'):
                        break
                    tone.wait_for_timeout(200)
                info = {'answerOk': (ans or {}).get('ok'), 'answerError': (ans or {}).get('error'),
                        'status': st.get('status'), 'error': st.get('error'), 'sessionId': st.get('sessionId'),
                        'startSeconds': round(time.time() - t0, 2),
                        'swTotalMs': (st.get('startTimings') or {}).get('totalMs'),
                        'marks': (st.get('startTimings') or {}).get('marks')}
                result['sessions'][label] = info
                check(f'{label}: Start reaches recording', st.get('status') == 'recording', info)
                return st.get('sessionId') if st.get('status') == 'recording' else None

            def read(sid):
                return env['ctl'].evaluate(READ_JS, sid)

            def stop(label, sid):
                ans = env['ctl'].evaluate(SEND_JS, [{'target': 'background', 'type': 'STOP'}, 30000])
                t0 = time.time()
                st = {}
                while time.time() - t0 < 15:
                    st = state()
                    if st.get('status') == 'idle':
                        break
                    tone.wait_for_timeout(200)
                got = {}
                while time.time() - t0 < 25:
                    got = read(sid)
                    if (got.get('report') or {}).get('final'):
                        break
                    tone.wait_for_timeout(250)
                result['sessions'][label].update({'stopOk': (ans or {}).get('ok'), 'stopStatus': st.get('status'),
                                                  'stopSeconds': round(time.time() - t0, 2)})
                check(f'{label}: Stop ends idle with a final report',
                      st.get('status') == 'idle' and (got.get('report') or {}).get('final') is True,
                      {'status': st.get('status'), 'final': (got.get('report') or {}).get('final')})
                return got

            def build_ok(label, rep, version, install_type):
                b = (rep or {}).get('build')
                check(f'{label}: report names the creating version {version}', isinstance(b, dict) and b.get('version') == version, b)
                check(f'{label}: report installType = {install_type!r}', isinstance(b, dict) and b.get('installType') == install_type, b)
                check(f'{label}: report build has every field', isinstance(b, dict) and BUILD_KEYS <= set(b), sorted(b) if isinstance(b, dict) else b)
                return b

            env['sw'] = worker_with(v1)
            env['sw'].evaluate(PERM_JS)
            open_control()
            page_self = env['ctl'].evaluate(SELF_JS)
            result['pageSelf'] = page_self
            check('extension page: management.getSelf() answers', bool(page_self.get('installType')), page_self)

            # ── A: normal start ──
            sid_a = start('A')
            if sid_a:
                tone.wait_for_timeout(1500)
                live = read(sid_a)
                rep0 = live.get('report') or {}
                check('A: report written at Start is not final yet', rep0.get('final') is False, rep0.get('final'))
                b0 = build_ok('A at Start', rep0, v1, page_self.get('installType'))
                check('A: installType is development (unpacked)', (b0 or {}).get('installType') == 'development', b0)
                check('A: storeItem false for this id', (b0 or {}).get('storeItem') is False and page_self.get('id') != STORE_ID, b0)
                check('A: snapshot taken by the service worker', (b0 or {}).get('capturedBy') == 'service-worker', b0)
                check('A: report version 3', rep0.get('version') == 3, rep0.get('version'))
                j = live.get('journalFirst') or {}
                check('A: journal session_open carries the same build',
                      j.get('t') == 'session_open' and isinstance(b0, dict) and bool(b0) and j.get('build') == b0,
                      {'t': j.get('t'), 'build': j.get('build')})
                tone.wait_for_timeout(int(args.seconds * 1000))
                fin = stop('A', sid_a)
                check('A: final report keeps the Start snapshot (same capturedAt)',
                      isinstance(b0, dict) and bool(b0) and (fin.get('report') or {}).get('build') == b0,
                      (fin.get('report') or {}).get('build'))
                env['a_text'] = fin.get('reportText')
                env['a_pick'] = fin.get('pick')
                result['sessions']['A']['build'] = (fin.get('report') or {}).get('build')

            # ── B: getSelf never answers ──
            patch = env['sw'].evaluate(PATCH_JS, 'hang')
            check('B: getSelf patched to hang', patch.get('patched') is True, patch)
            sid_b = start('B')
            if sid_b:
                live = read(sid_b)
                b = (live.get('report') or {}).get('build') or {}
                check('B: version still recorded', b.get('version') == v1, b)
                check('B: installType null when getSelf hangs', 'installType' in b and b.get('installType') is None, b)
                check('B: the reason is written', 'answer' in str(b.get('installTypeNote') or ''), b.get('installTypeNote'))
                a_ms = result['sessions'].get('A', {}).get('swTotalMs') or 0
                b_ms = result['sessions']['B'].get('swTotalMs') or 0
                check('B: Start delayed by at most ~1.5 s', b_ms - a_ms <= 1500, {'A': a_ms, 'B': b_ms})
                tone.wait_for_timeout(1000)
                fin = stop('B', sid_b)
                check('B: final report keeps the unknown', bool(b) and (fin.get('report') or {}).get('build') == b,
                      (fin.get('report') or {}).get('build'))
                result['sessions']['B']['build'] = b

            # ── C: getSelf throws ──
            patch = env['sw'].evaluate(PATCH_JS, 'throw')
            check('C: getSelf patched to throw', patch.get('patched') is True, patch)
            sid_c = start('C')
            if sid_c:
                live = read(sid_c)
                b = (live.get('report') or {}).get('build') or {}
                check('C: installType null when getSelf throws', 'installType' in b and b.get('installType') is None, b)
                check('C: the error is the reason', 'bench: management unavailable' in str(b.get('installTypeNote') or ''), b.get('installTypeNote'))
                tone.wait_for_timeout(1000)
                stop('C', sid_c)
                result['sessions']['C']['build'] = b
            env['sw'].evaluate(PATCH_JS, 'restore')

            # ── D: update between recordings ──
            a_before = read(sid_a).get('reportText') if sid_a else None
            old_sw = env['sw']
            result['updateD'] = update_to(v2)
            tone.wait_for_timeout(1000)
            env['sw'] = worker_with(v2, skip=old_sw)
            open_control()
            sid_d = start('D')
            if sid_d:
                tone.wait_for_timeout(int(args.seconds * 1000))
                fin = stop('D', sid_d)
                build_ok('D', fin.get('report'), v2, page_self.get('installType'))
                result['sessions']['D']['build'] = (fin.get('report') or {}).get('build')
            if sid_a:
                a_after = read(sid_a)
                check('D: A report unchanged by the update (bytes)', a_after.get('reportText') == a_before)
                check('D: A still names its own version', ((a_after.get('report') or {}).get('build') or {}).get('version') == v1,
                      (a_after.get('report') or {}).get('build'))

            # ── E: update during a recording → orphan → check by the new build ──
            sid_e = start('E')
            if sid_e:
                tone.wait_for_timeout(2500)
                old_sw = env['sw']
                result['updateE'] = update_to(v3)
                tone.wait_for_timeout(1000)
                env['sw'] = worker_with(v3, skip=old_sw)
                open_control()
                got, how, t0 = {}, 'automatic (onInstalled)', time.time()
                while time.time() - t0 < 20:
                    got = read(sid_e)
                    if got.get('recovery'):
                        break
                    tone.wait_for_timeout(500)
                if not got.get('recovery'):
                    how = 'manual RECOVER_SESSION'
                    env['ctl'].evaluate(SEND_JS, [{'target': 'background', 'type': 'RECOVER_SESSION', 'sessionId': sid_e}, 60000])
                    got = read(sid_e)
                rep = got.get('report') or {}
                result['sessions']['E'].update({'recoveredHow': how, 'recoveryOk': (got.get('recovery') or {}).get('ok'),
                                                'reportFinal': rep.get('final'), 'build': rep.get('build')})
                check('E: the interrupted session was checked (recovery.json)', bool(got.get('recovery')), how)
                check('E: report still names the build that recorded it', (rep.get('build') or {}).get('version') == v2, rep.get('build'))
                check('E: report not marked final by the new build', rep.get('final') is False, rep.get('final'))
                st = state()
                check('E: service worker is idle after the reload', st.get('status') == 'idle', st.get('status'))

            # ── F: an old-format report ──
            if sid_a:
                old = 'p300-23c-old-report-' + uuid.uuid4().hex[:8]
                env['ctl'].evaluate(OLD_FIXTURE_JS, [sid_a, old])
                o = read(old)
                check('F: old report has no build and version 2', 'build' not in (o.get('report') or {}) and (o.get('report') or {}).get('version') == 2)
                check('F: pickAsset picks the same asset as for the new report', o.get('pick') == env.get('a_pick') and not (o.get('pick') or {}).get('error'),
                      {'old': o.get('pick'), 'new': env.get('a_pick')})
                page = ctx.new_page()
                page.on('pageerror', lambda e: result['page_errors'].append(str(e)))
                page.goto(f'chrome-extension://{ext_id}/src/session-list/session-list.html?readonly=1')
                want = [s for s in (sid_a, sid_b, sid_c, sid_d, sid_e, old) if s]
                seen = []
                for _ in range(40):
                    seen = page.evaluate("() => [...document.querySelectorAll('.session[data-sid]')].map((e) => e.dataset.sid)")
                    if all(s in seen for s in want):
                        break
                    page.wait_for_timeout(250)
                check('F: Recordings lists every session, old and new', all(s in seen for s in want), {'want': want, 'seen': seen})
                page.screenshot(path=str(output / 'recordings.png'))
            check('no page errors', not result['page_errors'], result['page_errors'])
            check('no request left the machine', not result['external_requests'], result['external_requests'])
    except Exception as e:  # noqa: BLE001 - the verdict must still be written
        result['error'] = f'{type(e).__name__}: {str(e)[:500]}'
        check('bench completed', False, result['error'])
    finally:
        if timer:
            timer.cancel()
        if h and 'Connection closed' in str(result.get('error', '')):
            h['proc'].kill()  # browser.close() over a dead driver blocks forever
        elif h:
            close_real_chrome(h)
        srv.shutdown()
    result['watchdogFired'] = bool(result['watchdog'])
    result['passed'] = sum(c['ok'] for c in result['checks'])
    result['total'] = len(result['checks'])
    result['ok'] = all(c['ok'] for c in result['checks']) and not result.get('error')
    (output / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f"VERDICT: {'OK' if result['ok'] else 'FAIL'} ({result['passed']}/{result['total']}); {output}")
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
