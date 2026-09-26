#!/usr/bin/env python3
"""Check the generated App command against the local Web runtime without a HAP."""
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
with tempfile.TemporaryDirectory(prefix="dsh app '017' ", dir=os.environ['TMPDIR']) as temporary:
    home = Path(temporary)
    (home / 'Documents').mkdir()
    config = packaging.runtime_defaults(home)
    command = json.loads(re.search(r'static runCommand: string = (.+);', config)[1])
    log = home / 'Documents' / packaging.RUN_LOG_NAME
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('DSH_', 'DEEPSEEK_')) and not re.search('KEY|TOKEN|SECRET|PASSWORD', key, re.I)}
    env.update(DSH_017_HOME=str(home / 'state'), DSH_017_PORT='0', NO_PROXY='127.0.0.1,localhost')
    child = subprocess.Popen(['/usr/bin/zsh', '-f', '-c', command + '\nwait'], cwd=home,
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
        assert (home / 'state').is_dir(), 'isolated 0.1.7 state was not used'
        print('PASS App command: local 0.1.7 launcher, quoted paths, matching new log, isolated state and non-9000 port')
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
