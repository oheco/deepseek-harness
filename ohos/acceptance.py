#!/usr/bin/env python3
"""Exercise an installed HarmonyOS dsh through shipped profiles and a local provider."""
import argparse
from contextlib import contextmanager
import http.cookiejar
import http.server
from html import unescape
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dsh', type=Path, required=True, help='installed npm bin/dsh entry')
parser.add_argument('--tmp-parent', type=Path, required=True, help='writable application-private directory')
parser.add_argument('--logs', type=Path, required=True)
parser.add_argument('--scenario', action='append', choices=['headless', 'search', 'ptc', 'persistent', 'web'])
args = parser.parse_args()
dsh = str(args.dsh.absolute())
args.logs.mkdir(parents=True, exist_ok=True)
command = 'typeset -a values=(alpha beta); print -r -- "$values[1]" > harness-zsh.txt; cat harness-zsh.txt'


def environment(root):
    env = {key: value for key, value in os.environ.items()
           if not re.search('KEY|TOKEN|SECRET|PASSWORD', key, re.I)
           and not key.startswith(('DSH_', 'DEEPSEEK_'))}
    env.update(DSH_HOME=str(root / 'state'), TMPDIR=str(root), NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
    env.pop('KEEP', None)
    return env


def stop(child):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)


@contextmanager
def provider(calls, ptc):
    requests = []
    errors = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                tools = {item['function']['name']: item['function'] for item in body.get('tools', [])}
                completed = sum(message.get('role') == 'tool' for message in body.get('messages', []))
                if not tools:
                    assert any('Create a concise title' in str(message.get('content'))
                               for message in body.get('messages', [])), 'unexpected request without tools'
                elif ptc:
                    assert list(tools) == ['run_code'], list(tools)
                else:
                    assert 'zsh' in tools['bash']['description'], tools['bash']['description']
                if tools:
                    requests.append(body)
                if not tools:
                    delta = {'content': 'Local acceptance'}
                    finish = 'stop'
                elif completed < len(calls):
                    name, values = calls[completed]
                    assert name in tools, (name, list(tools))
                    delta = {'tool_calls': [{'index': 0, 'id': f'ohos-call-{completed}', 'type': 'function',
                                            'function': {'name': name, 'arguments': json.dumps(values)}}]}
                    finish = 'tool_calls'
                else:
                    assert completed == len(calls), completed
                    delta = {'content': 'OHOS_ACCEPTANCE_OK'}
                    finish = 'stop'
                chunks = [{'choices': [{'delta': delta}]}, {'choices': [{'delta': {}, 'finish_reason': finish}],
                          'usage': {'prompt_tokens': 10, 'completion_tokens': 4}}]
                output = (''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(output)))
                self.end_headers()
                self.wfile.write(output)
            except Exception as error:
                errors.append(repr(error))
                self.close_connection = True

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', requests, errors
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)
        assert not thread.is_alive(), 'provider did not stop'


def read_session(path):
    if path.suffix != '.zstd':
        return path.read_text()
    import compression.zstd
    with compression.zstd.open(path, 'rt') as stream:
        return stream.read()


def headless(scenario):
    with tempfile.TemporaryDirectory(prefix=f'dsh {scenario} ', dir=args.tmp_parent) as tmp:
        root = Path(tmp)
        workspace = root / 'workspace with spaces'
        workspace.mkdir()
        calls = [('bash', {'command': command, 'description': 'Check native zsh arrays'})]
        extra = []
        if scenario == 'search':
            calls += [('glob', {'pattern': '**/*.txt'}), ('grep', {'pattern': 'alpha', 'include': '*.txt'})]
        elif scenario == 'ptc':
            calls = [('run_code', {'description': 'Check zsh through PTC',
                      'code': 'const result = await tools.bash(' + json.dumps(calls[0][1]) + '); return result;'})]
        elif scenario == 'persistent':
            commands = [
                'typeset -a values=(alpha beta); export KEEP=ohos; mkdir nested; cd nested; print -r -- "$values[1]" > ../harness-zsh.txt',
                'print -r -- "$KEEP:$values[1]:${PWD:t}"; cat ../harness-zsh.txt',
                'f() { return 7; }; f', 'exit',
                'print -r -- "${KEEP-unset}:${PWD:t}"',
            ]
            calls = [('bash', {'command': text, 'description': 'Check persistent zsh state'}) for text in commands]
            patch = root / 'persistent.patch.yml'
            patch.write_text("- id: tool-bash\n  disabled: true\n- insert:\n    - id: ohos-terminal\n      name: '@deepseek-ai/dsh-terminal'\n    - id: ohos-terminal-bash\n      name: '@deepseek-ai/dsh-terminal-bash'\n    - id: ohos-persistent-bash\n      name: '@deepseek-ai/dsh-tool-bash-persistent'\n      config:\n        timeoutMs: 10000\n")
            extra = ['--patch', str(patch)]
        with provider(calls, scenario == 'ptc') as (url, requests, errors):
            env = environment(root)
            env.update(DEEPSEEK_API_KEY='local-test-only', DEEPSEEK_BASE_URL=url)
            if scenario == 'ptc':
                env['DSH_TOOLS_MODE'] = 'ptc'
            child = subprocess.Popen([dsh, '--profile', 'headless', *extra, 'Use the requested tools and finish.'],
                                     cwd=workspace, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                out, err = child.communicate(timeout=120)
            finally:
                stop(child)
                out, err = child.communicate(timeout=10)
                (args.logs / f'{scenario}.stdout').write_bytes(out)
                (args.logs / f'{scenario}.stderr').write_bytes(err)
            assert not errors, errors
            assert child.returncode == 0, (child.returncode, err.decode()[-3000:])
            assert b'OHOS_ACCEPTANCE_OK' in out, out
            assert (workspace / 'harness-zsh.txt').read_text() == 'alpha\n'
            messages = [m for m in requests[-1]['messages'] if m.get('role') == 'tool']
            assert len(messages) == len(calls), messages
            outputs = '\n'.join(str(m['content']) for m in messages)
            assert 'alpha' in outputs, outputs
            if scenario == 'search':
                assert 'harness-zsh.txt' in str(messages[1]['content']), messages
                assert 'harness-zsh.txt' in str(messages[2]['content']) and 'alpha' in str(messages[2]['content']), messages
            if scenario == 'persistent':
                for expected in ['ohos:alpha:nested', '[Command finished with exit code 7]', 'shell was reset', 'unset:workspace with spaces']:
                    assert expected in outputs, (expected, outputs)
                assert '__DSH_PERSISTENT_BASH' not in outputs, outputs
            logs = list((root / 'state/sessions').rglob('*.jsonl')) + list((root / 'state/sessions').rglob('*.jsonl.zstd'))
            assert logs, 'no durable session'
            persisted = '\n'.join(read_session(path) for path in logs)
            assert 'harness-zsh.txt' in persisted and 'OHOS_ACCEPTANCE_OK' in persisted
            if scenario == 'ptc':
                assert 'tool/ptc-dispatch' in persisted
        print(f'PASS installed {scenario}: real profile, provider round trip, zsh/file effects, durable session, exit', flush=True)


def web():
    with tempfile.TemporaryDirectory(prefix='dsh web ', dir=args.tmp_parent) as tmp:
        root = Path(tmp)
        child = subprocess.Popen([dsh, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], cwd=root,
                                 env=environment(root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        output = ''
        success = False
        try:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                ready, _, _ = select.select([child.stdout], [], [], 0.2)
                if ready:
                    data = os.read(child.stdout.fileno(), 65536)
                    if not data:
                        break
                    output += data.decode(errors='replace')
                match = re.search(r'dsh web:\s*(http://127\.0\.0\.1:\d+/[^\s\x1b]*)', output)
                if match:
                    cookies = http.cookiejar.CookieJar()
                    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(cookies))
                    with client.open(match.group(1), timeout=15) as response:
                        html = response.read().decode()
                        assert response.status == 200 and '<html' in html.lower()
                        page_url = response.url
                    assert list(cookies), 'no authentication cookie'
                    scripts = re.findall(r'<script[^>]+src="([^"]+)"', html)
                    assert scripts, 'no Web JavaScript assets'
                    for path in scripts:
                        path = unescape(path)
                        print(f'Checking Web script {path}', flush=True)
                        with client.open(urllib.parse.urljoin(page_url, path), timeout=15) as response:
                            assert response.status == 200 and len(response.read()) > 0
                    success = True
                    break
                if child.poll() is not None:
                    break
            assert success, f'Web readiness failed; exit={child.poll()}'
        finally:
            stop(child)
            output += child.stdout.read().decode(errors='replace')
            child.stdout.close()
            output = re.sub(r'(https?://[^\s?]+)\?[^\s]+', r'\1?[REDACTED]', output)
            (args.logs / 'web.log').write_text(output)
        print('PASS installed Web: startup, authentication cookie, HTML and fetched JavaScript assets, shutdown', flush=True)


node = json.loads(subprocess.check_output(['node', '-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'], text=True))
assert node['platform'] == 'openharmony' and node['arch'] == 'arm64', node
subprocess.run([dsh, '--help'], env=environment(args.tmp_parent), stdout=subprocess.DEVNULL, check=True, timeout=30)
scenarios = args.scenario or ['headless', 'search', 'ptc', 'persistent', 'web']
for scenario in scenarios:
    if scenario == 'web':
        web()
    else:
        headless(scenario)
(args.logs / 'acceptance.json').write_text(json.dumps({
    'node': node, 'python': sys.version.split()[0], 'python_platform': sys.platform,
    'provider': 'local deterministic DeepSeek-compatible stream', 'passed': scenarios,
    'live_remote_provider': 'not tested',
}, indent=2) + '\n')
print('PASS selected installed HarmonyOS acceptance scenarios', flush=True)
