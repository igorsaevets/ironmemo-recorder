"""Offline Recordings UI regression: microphone-only source labels (P300-23c).

Metadata/filename fixtures only: this does not test captured audio or audibility.
Each run retains a new profile and byte-identical extension copy under runs/.
No existing recordings, physical devices, accounts or production API are used.
Run: python tests/test_p300_23c_sources.py [--chrome PATH] [--output DIRECTORY]
"""
import argparse
import hashlib
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from lib.browser import find_chrome_for_testing, launch_kwargs, wait_service_worker
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import expect, sync_playwright

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / 'apps/extension-audio'


def case(sid, files, sources=None, roles=None, report=True, expected=False):
    metadata = {'final': True, 'engine': 'webcodecs', 'settings': {'source': {'mode': 'mic+tab'}}}
    if sources is not None:
        metadata['appliedReport'] = {'sources': {s: {} for s in sources}, 'roles': roles or sources}
    if roles is not None:
        metadata['roles'] = {r: {'mediaSec': 4} for r in roles}
    return {'sid': sid, 'files': files, 'report': metadata if report else None, 'expected': expected}


CASES = [
    case('mic-and-mic-mix', ['local_mic.opus', 'compatibility_mix.opus'],
         ['local_mic'], ['local_mic', 'compatibility_mix'], expected=True),
    case('mic-mix-only', ['compatibility_mix.opus'], ['local_mic'], ['compatibility_mix'], expected=True),
    case('meeting', ['local_mic.opus', 'remote_tab.opus', 'compatibility_mix.opus'],
         ['local_mic', 'remote_tab'], ['local_mic', 'remote_tab', 'compatibility_mix']),
    case('tab-only', ['remote_tab.webm'], ['remote_tab']),
    case('ambiguous-mix', ['compatibility_mix.opus'], report=False),
    case('legacy-opus', ['local_mic.opus'], report=False, expected=True),
    case('legacy-parts', ['local_mic.000.000001.part'], report=False, expected=True),
    case('recovered-mic', ['local_mic.recovered.opus'], report=False, expected=True),
    case('missing-tab-file', ['local_mic.opus'], ['local_mic', 'remote_tab']),
    case('contradicting-tab-file', ['local_mic.opus', 'remote_tab.opus'], ['local_mic']),
    case('unknown-source', ['local_mic.opus'], ['local_mic', 'future_system_audio']),
    case('empty', [], ['local_mic']),
    case('active', ['local_mic.opus'], ['local_mic']),
    case('malformed-report-mix', ['local_mic.opus', 'compatibility_mix.opus'], report=False),
]

SETUP = """async cases => {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle('sessions', {create:true});
  const start = Date.now();
  for (let i=0; i<cases.length; i++) {
    const c = cases[i], dir = await sessions.getDirectoryHandle(c.sid, {create:true});
    const write = async (name, content) => {
      const h = await dir.getFileHandle(name, {create:true}), w = await h.createWritable();
      await w.write(content); await w.close();
    };
    for (const name of c.files) await write(name, new Uint8Array([79,103,103,83,1,2,3,4]));
    if (c.report) await write('capture-report.json', JSON.stringify({
      ...c.report, timeline:{t0Wall:start-i*1000}
    }));
    else await write('journal.jsonl', JSON.stringify({t:'session_stopped',wall:start-i*1000})+'\\n');
    if (c.sid === 'malformed-report-mix') await write('capture-report.json', '{invalid json');
  }
  await chrome.storage.local.set({
    'ironmemo.settings.v1':{upload:{enabled:false},source:{mode:'mic+tab'}},
    'ironmemo.captureState.v1':{status:'recording',sessionId:'active',startedAt:start}
  });
}"""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--chrome', type=Path)
    ap.add_argument('--output', type=Path)
    args = ap.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run = REPO / 'runs' / f'p300-23c-sources-{stamp}-{uuid.uuid4().hex[:6]}'
    extension = run / 'extension-audio'
    shutil.copytree(SOURCE, extension)
    hashes = {p.relative_to(SOURCE).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in SOURCE.rglob('*') if p.is_file()}
    assert all(hashlib.sha256((extension / p).read_bytes()).hexdigest() == h for p, h in hashes.items())
    output = args.output or run / 'evidence'
    output.mkdir(parents=True, exist_ok=True)
    result = {'at_utc': stamp, 'run': str(run), 'source_sha256': hashes,
              'fixture_scope': 'Metadata/filenames only; not valid media or a capture test',
              'cases': CASES, 'checks': [], 'page_errors': [], 'http_requests': []}

    def check(name, ok, detail=None):
        result['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
        print(f"{'PASS' if ok else 'FAIL'} {name}", flush=True)

    try:
        with sync_playwright() as pw:
            kw = launch_kwargs(extension, run / 'profile', headless=True)
            chrome = args.chrome or find_chrome_for_testing()
            if chrome:
                kw['executable_path'] = str(chrome)
            kw['args'] += ['--disable-background-networking', '--mute-audio']
            kw['viewport'] = {'width': 1100, 'height': 900}
            ctx = pw.chromium.launch_persistent_context(str(run / 'profile'), **kw)
            try:
                result['browser'] = ctx.browser.version

                def deny(route):
                    result['http_requests'].append(route.request.url)
                    route.abort()

                ctx.route('http://**/*', deny)
                ctx.route('https://**/*', deny)
                ctx.add_init_script("navigator.mediaDevices.getUserMedia = async () => { throw new Error('No devices in metadata test'); };")
                origin = 'chrome-extension://' + wait_service_worker(ctx).url.split('/')[2]
                page = ctx.new_page()
                page.on('pageerror', lambda e: result['page_errors'].append(str(e)))
                page.goto(origin + '/src/session-list/session-list.html?readonly=1')
                page.evaluate(SETUP, CASES)
                page.reload()
                expect(page.locator('.session')).to_have_count(len(CASES))
                result['rendered'] = {}
                for c in CASES:
                    card = page.locator(f'.session[data-sid="{c["sid"]}"]')
                    shown = card.locator('.session-source-hint').count() == 1
                    text = card.locator('.session-head').inner_text()
                    result['rendered'][c['sid']] = text
                    check('source label: ' + c['sid'], shown == c['expected'], text)
                page.screenshot(path=str(output / 'recordings.png'))
                mic = page.locator('.session[data-sid="mic-and-mic-mix"]')
                mic.screenshot(path=str(output / 'microphone-only.png'))
                hint = mic.locator('.session-source-hint')
                check('visible explanatory text', hint.count() == 1 and hint.is_visible()
                      and 'No tab audio track in this recording.' in hint.inner_text())
                check('mic-only mix does not claim tab audio', 'mic+tab' not in ' '.join(mic.locator('.role-name').all_inner_texts()))
                check('passive label has no alert or tab stop', mic.locator('.session-source-hint [role="alert"], .session-source-hint[role="alert"], .session-source-hint[tabindex]').count() == 0)
                active = page.locator('.session[data-sid="active"]')
                check('active fixture is really recording', active.get_by_text('Recording now', exact=True).is_visible())
                page.evaluate("""async () => {
                  await chrome.storage.local.set({'ironmemo.captureState.v1':{status:'paused',sessionId:'active'}});
                }""")
                expect(active.get_by_text('Paused', exact=True)).to_be_visible()
                check('paused recording is not classified prematurely', active.locator('.session-source-hint').count() == 0)
                before = page.evaluate("""async () => {
                  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sessions');
                  const mic = await dir.getDirectoryHandle('mic-and-mic-mix');
                  return [...new Uint8Array(await (await (await mic.getFileHandle('local_mic.opus')).getFile()).arrayBuffer())];
                }""")
                mic.hover()
                mic.locator('[data-action="rename"]').click()
                mic.locator('.rename-input').fill('Voice note <sample>')
                mic.locator('.rename-input').press('Enter')
                expect(mic.locator('.session-title')).to_have_text('Voice note <sample>')
                check('source label survives rename', mic.locator('.session-source-hint').count() == 1)
                check('rename stays plain text', mic.locator('.session-title sample').count() == 0)
                page.reload()
                mic = page.locator('.session[data-sid="mic-and-mic-mix"]')
                expect(mic.locator('.session-title')).to_have_text('Voice note <sample>')
                check('source label survives reload', mic.locator('.session-source-hint').count() == 1)
                after = page.evaluate("""async () => {
                  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sessions');
                  const mic = await dir.getDirectoryHandle('mic-and-mic-mix');
                  return [...new Uint8Array(await (await (await mic.getFileHandle('local_mic.opus')).getFile()).arrayBuffer())];
                }""")
                check('source asset unchanged', before == after)
                check('no page errors', not result['page_errors'], result['page_errors'])
                check('no page HTTP requests', not result['http_requests'], result['http_requests'])
            finally:
                ctx.close()
    except (AssertionError, OSError, PlaywrightError, ValueError) as e:
        result['error'] = repr(e)
        check('fixture completed', False, repr(e))
    result['passed'] = sum(c['ok'] for c in result['checks'])
    result['total'] = len(result['checks'])
    result['ok'] = all(c['ok'] for c in result['checks']) and not result.get('error')
    (output / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    print(f"VERDICT: {'OK' if result['ok'] else 'FAIL'} ({result['passed']}/{result['total']}); {output}")
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
