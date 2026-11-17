#!/usr/bin/env python3
"""Exercise a real isolated DSH Web runtime through the native broker map.

Requires an independent run-web.zsh, the current control fixture, a signed
native dsh_broker_test, Node 24, and the repository's installed ws dependency.
The fixture is signed into private temporary storage. All children run in owned
process groups; their logs, credentials, and DSH state are removed on every exit.
Only fixed diagnostics, HTTP statuses, booleans, and counts leave private storage.
--result creates a new sanitized JSON receipt and refuses to overwrite a file.
No model request or external broker service is used.
"""

import argparse
import errno
import http.client
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, urljoin, urlsplit


ROOT = Path(__file__).resolve().parent.parent
MAX_LOG_BYTES = 4 * 1024 * 1024
MAX_HTTP_BYTES = 16 * 1024 * 1024
WEB_READY = re.compile(rb'dsh web: http://127\.0\.0\.1:(\d+)/\?token=')
MAP_READY = re.compile(rb'(?:^|\n)MAP_READY=(\d+)\r?(?:\n|$)')
NATIVE_PASS = b'PASS real control HTTPS/WSS, account login/list, peer-password rejection'

# Cookie and authority arrive through stdin, never the Node command line.
WS_PROBE = r"""
import { createRequire } from 'node:module';
import { join } from 'node:path';

let socket;
let timer;
let settled = false;
const fail = (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  socket?.terminate();
  process.exitCode = code;
};
process.on('uncaughtException', () => fail(13));
process.on('unhandledRejection', () => fail(13));
let WebSocket;
try {
  WebSocket = createRequire(join(process.argv[2], 'packages/api/gateway/package.json'))('ws');
} catch {
  fail(10);
}
if (!settled) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (input.length > 65536) { fail(11); break; }
  }
  let config;
  try {
    config = JSON.parse(input);
    if (typeof config.origin !== 'string' || typeof config.cookie !== 'string') throw Error();
    const url = new URL(config.origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw Error();
  } catch {
    fail(11);
  }
  if (!settled) {
    const streamId = 'broker-web-events';
    let frames = 0;
    let ready = false;
    let upgradeStatus = 0;
    socket = new WebSocket(`${config.origin.replace('http:', 'ws:')}/api/remote.mux`, {
      headers: { Host: new URL(config.origin).host, Origin: config.origin, Cookie: config.cookie },
      handshakeTimeout: 15000,
      maxPayload: 1048576,
      perMessageDeflate: false,
    });
    timer = setTimeout(() => fail(14), 20000);
    socket.on('upgrade', response => { upgradeStatus = response.statusCode; });
    socket.on('unexpected-response', (_request, response) => { response.resume(); fail(12); });
    socket.on('error', () => fail(12));
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'open', streamId, endpoint: '$events', payload: { args: {} },
      }));
    });
    socket.on('message', (data, binary) => {
      if (settled || ready) return;
      frames += 1;
      if (binary || frames > 10000) { fail(13); return; }
      let frame;
      try { frame = JSON.parse(data.toString('utf8')); } catch { fail(13); return; }
      if (frame === null || typeof frame !== 'object') { fail(13); return; }
      if (frame.streamId !== streamId) return;
      if (frame.type !== 'item') { fail(13); return; }
      const value = frame.value;
      if (value?.type !== 'ready' || typeof value.clientId !== 'string' || !value.clientId
        || typeof value.host?.home !== 'string' || upgradeStatus !== 101) {
        fail(13); return;
      }
      ready = true;
      clearTimeout(timer);
      timer = setTimeout(() => fail(15), 5000);
      socket.send(JSON.stringify({ type: 'cancel', streamId }));
      socket.close(1000);
    });
    socket.on('close', code => {
      if (settled) return;
      if (!ready || code !== 1000) { fail(15); return; }
      settled = true;
      clearTimeout(timer);
      process.stdout.write(JSON.stringify({ ready: true, frames, upgrade_status: 101, close_code: 1000 }));
    });
  }
}
"""


class TestFailure(Exception):
    """A diagnostic authored by this runner; never carries child output."""


def require(condition, message):
    if not condition:
        raise TestFailure(message)


def private_log(path):
    require(path.stat().st_size <= MAX_LOG_BYTES, 'private child log exceeded the test output limit')
    return path.read_bytes()


class Children:
    """Own process groups and wait for their termination before deleting state."""

    def __init__(self, directory):
        self.directory = directory
        self.items = []

    def start(self, name, command, env, pipe=False):
        log_path = self.directory / (name + '.log')
        with log_path.open('xb', buffering=0) as log:
            child = subprocess.Popen(command, cwd=self.directory, env=env,
                                     stdin=subprocess.PIPE if pipe else subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True)
        self.items.append((child, log_path))
        return child, log_path

    @staticmethod
    def group_exists(child):
        try:
            os.killpg(child.pid, 0)
            return True
        except ProcessLookupError:
            return False

    @staticmethod
    def signal_group(child, sig):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass  # The complete owned group has already exited.

    def close(self):
        clean = True
        for child, _log in reversed(self.items):
            try:
                if child.stdin is not None and not child.stdin.closed:
                    try:
                        child.stdin.close()
                    except OSError:
                        pass  # A broken input pipe must not skip group termination.
                self.signal_group(child, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.signal_group(child, signal.SIGKILL)
                    child.wait(timeout=5)
                if self.group_exists(child):
                    self.signal_group(child, signal.SIGKILL)
                    deadline = time.monotonic() + 5
                    while self.group_exists(child) and time.monotonic() < deadline:
                        time.sleep(0.05)
                    clean = not self.group_exists(child) and clean
            except (OSError, subprocess.TimeoutExpired):
                clean = False
        return clean


def live(*children):
    require(all(child.poll() is None for child in children),
            'an owned service exited early; rebuild the independent runtime and current control fixture')


def wait_port(child, log, pattern, timeout, message, dependencies=()):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        live(child, *dependencies)
        match = pattern.search(private_log(log))
        if match:
            port = int(match[1])
            require(0 < port < 65536, 'child published an invalid loopback port')
            return port
        time.sleep(0.05)
    raise TestFailure(message)


def wait_exit(child, timeout, message, dependencies=()):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        live(*dependencies)
        code = child.poll()
        if code is not None:
            return code
        time.sleep(0.05)
    raise TestFailure(message)


def fixture_port(child, ready):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        live(child)
        try:
            require(ready.stat().st_size <= 65536, 'control ready receipt exceeded the test output limit')
            receipt = json.loads(ready.read_text(encoding='utf-8'))
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.03)
            continue  # The fixture may still be writing its ready receipt.
        require(isinstance(receipt, dict) and isinstance(receipt.get('api'), str),
                'current control fixture did not publish its API address')
        parsed = urlsplit(receipt['api'])
        require(parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'
                and parsed.username is None and parsed.password is None
                and parsed.path in ('', '/') and not parsed.query and not parsed.fragment,
                'current control fixture API address must be numeric loopback HTTP')
        require(parsed.port is not None and 0 < parsed.port < 65536,
                'current control fixture API port is invalid')
        return parsed.port
    raise TestFailure('control fixture was not ready within 20 seconds; supply the current control fixture')


def http_request(port, target, method='GET', cookie=None, body=None):
    origin = f'http://127.0.0.1:{port}'
    headers = {'Host': f'127.0.0.1:{port}', 'Origin': origin}
    if cookie is not None:
        headers['Cookie'] = cookie
    if body is not None:
        headers['Content-Type'] = 'application/json'
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)

    def timed_out(_sig, _frame):
        raise TestFailure('mapped HTTP request exceeded its 15 second deadline')

    previous_handler = signal.signal(signal.SIGALRM, timed_out)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, 15)
    try:
        connection.request(method, target, body=body, headers=headers)
        response = connection.getresponse()
        content = response.read(MAX_HTTP_BYTES + 1)
        require(len(content) <= MAX_HTTP_BYTES, 'mapped HTTP response exceeded the test output limit')
        return response.status, response.getheaders(), content
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        connection.close()


def auth_cookie(headers):
    jar = SimpleCookie()
    for name, value in headers:
        if name.lower() == 'set-cookie':
            jar.load(value)
    require(len(jar) == 1, 'real DSH token exchange must issue one fresh authentication cookie')
    name, morsel = next(iter(jar.items()))
    require(name.startswith('dsh-auth-') and bool(morsel.value) and morsel['path'] == '/'
            and bool(morsel['httponly']), 'real DSH token exchange returned an invalid session cookie')
    return name + '=' + morsel.coded_value


def listener_closed(port):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            connection = socket.create_connection(('127.0.0.1', port), timeout=0.3)
        except OSError as error:
            if error.errno == errno.ECONNREFUSED:
                return True
        else:
            connection.close()
        time.sleep(0.05)
    return False


def environment(directory):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('DSH_', 'DEEPSEEK_', 'ANTHROPIC_', 'OPENAI_'))
           and not re.search('KEY|TOKEN|SECRET|PASSWORD', key, re.I)
           and key not in ('NODE_OPTIONS', 'NODE_PATH', 'BROWSER', 'EDITOR', 'VISUAL')}
    env.update(TMPDIR=str(directory), DSH_021_HOME=str(directory / 'dsh-home'), DSH_021_PORT='0',
               NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
    return env


def exercise(args, directory, children, result):
    result['phase'] = 'sign-fixture'
    env = environment(directory)
    unsigned_fixture = directory / 'control-fixture.unsigned'
    stripper, _log = children.start('strip', ['llvm-objcopy', '--remove-section=.codesign',
                                              str(args.control_fixture), str(unsigned_fixture)], env)
    require(wait_exit(stripper, 30, 'fixture signature normalization timed out; check llvm-objcopy') == 0,
            'fixture signature normalization failed; check the LLVM tools PATH')
    signed_fixture = directory / 'control-fixture'
    signer, _log = children.start('sign', ['binary-sign-tool', 'sign', '-inFile', str(unsigned_fixture),
                                          '-outFile', str(signed_fixture), '-selfSign', '1'], env)
    require(wait_exit(signer, 30, 'fixture signing timed out; check binary-sign-tool') == 0,
            'fixture signing failed; check binary-sign-tool and the current fixture binary')
    signed_fixture.chmod(0o700)

    result['phase'] = 'web-startup'
    token = secrets.token_urlsafe(32) + ' +&?=#/%\'"\\汉字é🚀'
    web, web_log = children.start('web', ['/usr/bin/zsh', '-f', str(args.web_launcher),
                                        '--port', '0', '--token', token], env)
    web_port = wait_port(web, web_log, WEB_READY, 90,
                         'DSH Web was not ready within 90 seconds; rebuild the independent runtime')
    require((directory / 'dsh-home').is_dir(), 'launcher did not create isolated DSH_021_HOME state')
    result['isolated_web_ready'] = True

    result['phase'] = 'control-startup'
    broker_env = dict(env)
    broker_env['OHECO_BROKER_ADMIN_TOKEN'] = secrets.token_hex(32)
    broker_env['OB_PEER_TEST_ADMIN_TOKEN'] = broker_env['OHECO_BROKER_ADMIN_TOKEN']
    ready = directory / 'ready.json'
    fixture, _log = children.start('control', [str(signed_fixture), '--db', str(directory / 'control.sqlite'),
                                              '--ready', str(ready)], broker_env)
    control_port = fixture_port(fixture, ready)
    live(web, fixture)
    result['control_ready'] = True

    result['phase'] = 'native-map'
    driver_env = dict(broker_env, DSH_BROKER_REAL_DSH_PORT=str(web_port),
                      DSH_BROKER_REAL_DSH_TOKEN=token, DSH_BROKER_FIXTURE_PORT=str(control_port),
                      DSH_BROKER_HOLD='1')
    driver, driver_log = children.start('driver', [str(args.driver)], driver_env, pipe=True)
    map_port = wait_port(driver, driver_log, MAP_READY, 150,
                         'native driver did not publish MAP_READY within 150 seconds; check driver and fixture versions',
                         dependencies=(web, fixture))
    require(map_port != web_port, 'native mapping must use a separate local authority')
    result['native_map_ready'] = True
    origin = f'http://127.0.0.1:{map_port}'

    result['phase'] = 'mapped-authentication'
    status, headers, _content = http_request(map_port, '/?token=' + quote(token, safe=''))
    result['token_exchange_status'] = status
    require(status == 303, 'mapped real DSH token exchange did not return HTTP 303')
    locations = [value for name, value in headers if name.lower() == 'location']
    require(len(locations) == 1 and urljoin(origin + '/', locations[0]) == origin + '/',
            'mapped real DSH redirect did not resolve to the same authority root')
    cookie = auth_cookie(headers)
    result['fresh_cookie'] = True
    status, _headers, content = http_request(map_port, '/', cookie=cookie)
    result['homepage_status'] = status
    result['homepage_bytes'] = len(content)
    require(status == 200 and b'__DSH_BOOT__' in content,
            'mapped authenticated homepage did not return HTTP 200 with __DSH_BOOT__')
    result['homepage_boot'] = True
    # A separate connection and no cookie prevent prior authentication masking rejection.
    status, headers, _content = http_request(map_port, '/?token=' + quote('wrong-' + secrets.token_hex(32), safe=''))
    result['fresh_wrong_token_status'] = status
    require(status in (401, 403) and not any(name.lower() == 'set-cookie' for name, _value in headers),
            'fresh wrong DSH token was accepted or issued an authentication cookie')

    result['phase'] = 'mapped-settings-rpc'
    rpc_id = 'broker-web-settings-' + secrets.token_hex(8)
    request = {'type': 'client-request', 'rpcId': rpc_id,
               'method': 'settings/openSettingsDocument', 'payload': {'args': {}}}
    status, _headers, content = http_request(map_port, '/api/settings/openSettingsDocument',
                                            method='POST', cookie=cookie, body=json.dumps(request).encode())
    result['settings_status'] = status
    require(status == 200, 'mapped settings/openSettingsDocument did not return HTTP 200')
    response = json.loads(content)
    require(isinstance(response, dict) and response.get('type') == 'server-response'
            and response.get('rpcId') == rpc_id and isinstance(response.get('result'), dict),
            'mapped settings RPC response did not echo the request envelope')
    outcome = response['result']
    require(outcome.get('ok') is True and isinstance(outcome.get('value'), dict),
            'mapped settings RPC returned a failure; inspect the settings provider or native opener')
    value = outcome['value']
    require(type(value.get('opened')) is bool, 'mapped settings RPC omitted its opened result')
    result['settings_opened'] = value['opened']
    if not value['opened']:
        require(isinstance(value.get('path'), str), 'mapped settings RPC omitted its prepared document path')
        document = Path(value['path']).resolve()
        require(document.is_relative_to(directory) and document.is_file(),
                'mapped settings RPC did not prepare its document inside the owned temporary state')
        result['settings_document_isolated'] = True
    result['settings_rpc_ok'] = True

    result['phase'] = 'mapped-websocket'
    probe = directory / 'ws-probe.mjs'
    probe.write_text(WS_PROBE, encoding='utf-8')
    ws, ws_log = children.start('websocket', ['node', str(probe), str(ROOT)], env, pipe=True)
    ws.stdin.write(json.dumps({'origin': origin, 'cookie': cookie}).encode())
    ws.stdin.close()
    code = wait_exit(ws, 30, 'mapped WebSocket check timed out', dependencies=(web, fixture, driver))
    diagnostics = {10: 'Node could not load installed ws; install repository dependencies before this test',
                   11: 'WebSocket checker could not read its private input',
                   12: 'mapped WebSocket upgrade failed; check Cookie, Host, Origin, and /api/remote.mux',
                   13: 'mapped $events stream did not return the real ready item',
                   14: 'mapped $events stream was not ready within 20 seconds',
                   15: 'mapped WebSocket did not complete its normal close handshake'}
    require(code == 0, diagnostics.get(code, 'mapped WebSocket checker failed'))
    receipt = json.loads(private_log(ws_log))
    require(isinstance(receipt, dict) and receipt.get('ready') is True
            and type(receipt.get('frames')) is int and 0 < receipt['frames'] <= 10000
            and receipt.get('upgrade_status') == 101 and receipt.get('close_code') == 1000,
            'mapped WebSocket checker omitted its sanitized success receipt')
    result.update(websocket_ready=True, websocket_frames=receipt['frames'],
                  websocket_upgrade_status=101, websocket_close_code=1000)

    result['phase'] = 'native-close'
    live(web, fixture, driver)
    driver.stdin.write(b'\n')
    driver.stdin.flush()
    driver.stdin.close()
    code = wait_exit(driver, 120, 'native driver did not finish close/reconnect checks within 120 seconds',
                     dependencies=(web, fixture))
    result['native_exit_code'] = code
    require(code == 0 and NATIVE_PASS in private_log(driver_log),
            'native driver failed repeated connect/close or pending setup cancellation checks')
    require(listener_closed(map_port), 'native close left the mapped listener accepting connections')
    result['native_integration_pass'] = True
    result['mapped_listener_closed'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--web-launcher', required=True, type=Path)
    parser.add_argument('--control-fixture', required=True, type=Path)
    parser.add_argument('--driver', required=True, type=Path, help='already signed dsh_broker_test')
    parser.add_argument('--result', type=Path, help='create a new sanitized JSON receipt')
    args = parser.parse_args()
    for name in ('web_launcher', 'control_fixture', 'driver'):
        path = getattr(args, name).resolve()
        if not path.is_file():
            parser.error(name.replace('_', '-') + ' must name an existing file')
        setattr(args, name, path)
    private_parent = os.environ.get('TMPDIR')
    if not private_parent or not Path(private_parent).is_dir():
        parser.error('TMPDIR must name writable application-private temporary storage')
    if not os.environ.get('XDG_CONFIG_HOME'):
        parser.error('XDG_CONFIG_HOME must name application-private configuration storage')
    if args.result is not None and (args.result.exists() or args.result.is_symlink()):
        parser.error('result must name a new file; an existing receipt is never overwritten')

    result = {'status': 'fail', 'phase': 'private-storage'}
    diagnostic = None
    old_umask = os.umask(0o077)
    old_handlers = {}
    receipt_file = None

    def interrupted(_sig, _frame):
        raise TestFailure('test interrupted; owned services and private state are being removed')

    try:
        if args.result is not None:
            receipt_file = args.result.open('x', encoding='utf-8')
        for sig in (signal.SIGINT, signal.SIGTERM):
            old_handlers[sig] = signal.signal(sig, interrupted)
        with tempfile.TemporaryDirectory(prefix='dsh-broker-web-', dir=private_parent) as temporary:
            directory = Path(temporary).resolve()
            require(stat.S_IMODE(directory.stat().st_mode) == 0o700,
                    'TMPDIR does not enforce private permissions; use application-private temporary storage')
            children = Children(directory)
            try:
                exercise(args, directory, children, result)
            finally:
                for sig in old_handlers:
                    signal.signal(sig, signal.SIG_IGN)
                result['owned_process_groups_closed'] = children.close()
            require(result['owned_process_groups_closed'], 'owned process groups did not finish teardown')
        result['private_state_removed'] = not directory.exists()
        require(result['private_state_removed'], 'owned temporary state remained after teardown')
        result.update(status='pass', phase='complete')
    except TestFailure as error:
        diagnostic = str(error)
    except Exception:
        diagnostic = 'operation failed during ' + result['phase'] + '; verify the supplied runtime, fixture, driver, and private storage'
    finally:
        if 'directory' in locals():
            result['private_state_removed'] = not directory.exists()
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        os.umask(old_umask)
        if receipt_file is not None:
            try:
                json.dump(result, receipt_file, indent=2, sort_keys=True)
                receipt_file.write('\n')
                receipt_file.close()
            except OSError:
                result.update(status='fail', phase='result-receipt')
                diagnostic = 'could not write the sanitized result receipt; check its parent directory'
                try:
                    receipt_file.close()
                except OSError:
                    pass  # The receipt write failure already determines the test outcome.
    print(json.dumps(result, sort_keys=True), flush=True)
    if diagnostic is not None:
        print('FAIL ' + diagnostic, file=sys.stderr, flush=True)
        return 1
    print('PASS real DSH through native broker: token/cookie/homepage, settings RPC, $events WebSocket, and close', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
