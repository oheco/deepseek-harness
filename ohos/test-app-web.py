#!/usr/bin/env python3
"""Check the release App command against an installed dsh, without a HAP."""
import argparse
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('app_project', root / 'ohos/package-app-project.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)
url_parser = root / 'ohos/app/entry/src/main/ets/launcher/RunLogUrl.ets'
probe = """
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(fs.readFileSync(process.argv[1], 'utf8'));
const parser = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const url = parser.readinessUrl(fs.readFileSync(process.argv[2], 'utf8'));
if (!url || !parser.loopbackOrigin(url)) throw new Error('App cannot parse the actual Web readiness line');
process.stdout.write(url);
"""
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dsh', type=Path, help='installed dsh launcher to place first on PATH')
parser.add_argument('--home', type=Path, help='shared user home recorded in the App command')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix="dsh app '017' ", dir=os.environ['TMPDIR']) as temporary:
    # The App command writes under the shared home; the isolated runtime state
    # never touches the user's own DSH_HOME, and no port 9000 service is used.
    shared = args.home.resolve() if args.home else Path(temporary) / 'shared'
    (shared / 'Documents').mkdir(parents=True, exist_ok=True)
    config = packaging.runtime_defaults(shared)
    command = json.loads(re.search(r'static runCommand: string = (.+);', config)[1])
    log = shared / 'Documents' / packaging.RUN_LOG_NAME
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('DSH_', 'DEEPSEEK_')) and not re.search('KEY|TOKEN|SECRET|PASSWORD', key, re.I)}
    env.update(DSH_HOME=str(Path(temporary) / 'dsh-home'), NO_PROXY='127.0.0.1,localhost')
    if args.dsh is not None:
        launcher = args.dsh.resolve()
        if not launcher.is_file():
            parser.error(f'installed dsh launcher does not exist: {launcher}')
        env['PATH'] = str(launcher.parent) + ':' + env.get('PATH', '')
    child = subprocess.Popen(['/usr/bin/zsh', '-f', '-c', command + '\nwait'], cwd=temporary,
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            text = log.read_text() if log.exists() else ''
            if 'dsh: fatal uncaught exception:' in text or child.poll() is not None:
                raise RuntimeError('App command failed before Web readiness')
            if re.search(r'dsh web: http://127\.0\.0\.1:\d+/\?token=[^\n]+\n', text):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('App command did not announce Web readiness')
        address = subprocess.check_output(['node', '--input-type=module', '-e', probe,
                                           str(url_parser), str(log)], text=True, stderr=subprocess.PIPE).strip()
        assert ':9000/' not in address
        cookies = http.cookiejar.CookieJar()
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(cookies))
        with client.open(address, timeout=15) as response:
            assert response.status == 200 and '<title>DeepSeek Harness</title>' in response.read().decode()
        assert list(cookies), 'missing authentication cookie'
        assert (Path(temporary) / 'dsh-home').is_dir(), 'isolated dsh state was not used'
        print('PASS App release command: installed dsh, quoted paths, announced log, isolated state and non-9000 port')
        print('PASS actual RunLogUrl.ets parser: real readiness URL, authentication cookie and original-brand Web page')
        print('Not a HAP, ArkWeb or device interaction test')
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate(timeout=10)
