#!/usr/bin/env python3
"""Build/sign/run the native broker client on HarmonyOS without launching a HAP.

--control-fixture optionally runs a prebuilt real oheco control/SQLite/TURN test
fixture from its own private directory. No external service or account is used.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time


def run(*args, **kwargs):
    print('+', ' '.join(str(arg) for arg in args), flush=True)
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', required=True, type=Path)
    parser.add_argument('--control-fixture', type=Path)
    parser.add_argument('--reuse-build', action='store_true', help='rebuild an existing test-owned private directory')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    source = root / 'ohos/app/entry/src/main/cpp'
    build = args.build_dir.resolve()
    cache = Path(os.environ['XDG_CACHE_HOME']).resolve()
    if not build.is_relative_to(cache) or (build.exists() and not args.reuse_build):
        parser.error('build-dir must be new and inside private XDG_CACHE_HOME')
    run('cmake', '-S', source, '-B', build, '-G', 'Ninja',
        '-DCMAKE_C_COMPILER=clang', '-DCMAKE_CXX_COMPILER=clang++',
        '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY', '-DCMAKE_BUILD_TYPE=Debug',
        '-DDSH_BUILD_BROKER_TESTS=ON')
    run('cmake', '--build', build, '--parallel', '4')
    binary = build / 'dsh_broker_test'
    signed = build / 'dsh_broker_test.signed'
    signed.unlink(missing_ok=True)
    run('binary-sign-tool', 'sign', '-inFile', binary, '-outFile', signed, '-selfSign', '1')
    signed.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix='dsh-broker-acceptance-', dir=os.environ['TMPDIR']) as temporary:
        env = dict(os.environ, TMPDIR=temporary)
        fixture = None
        try:
            if args.control_fixture:
                original = args.control_fixture.resolve()
                fixture_binary = Path(temporary) / 'control-fixture'
                run('binary-sign-tool', 'sign', '-inFile', original, '-outFile', fixture_binary, '-selfSign', '1')
                fixture_binary.chmod(0o700)
                ready = Path(temporary) / 'ready.json'
                env['OHECO_BROKER_ADMIN_TOKEN'] = secrets.token_hex(32)
                env['OB_PEER_TEST_ADMIN_TOKEN'] = env['OHECO_BROKER_ADMIN_TOKEN']
                with (Path(temporary) / 'control.log').open('w') as log:
                    fixture = subprocess.Popen([str(fixture_binary), '--db', str(Path(temporary) / 'control.sqlite'),
                                                '--ready', str(ready), '--account-token-ttl', '8s',
                                                '--auth-refresh-ttl', '2m', '--auth-access-overlap', '1s'], stdout=log, stderr=log, env=env)
                deadline = time.monotonic() + 20
                while True:
                    if fixture.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('test control fixture failed startup')
                    try:
                        api = json.loads(ready.read_text())['api']
                        break
                    except (FileNotFoundError, json.JSONDecodeError, KeyError):
                        # The fixture creates its receipt before completing the write.
                        time.sleep(.03)
                if not api.startswith('http://127.0.0.1:'):
                    raise RuntimeError('control fixture must publish numeric loopback')
                env['DSH_BROKER_FIXTURE_PORT'] = api.rsplit(':', 1)[1]
            run(signed, env=env, timeout=180)
        finally:
            if fixture and fixture.poll() is None:
                fixture.terminate()
                try:
                    fixture.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    fixture.kill()
                    fixture.wait(timeout=5)
    print(f'PASS native broker probes and SDK NAPI bridge link; build retained at {build}', flush=True)
    print('HAP import/ArkTS cleanup, ordinary app sandbox networking, background suspension and physical WebView await app verification.', flush=True)


if __name__ == '__main__':
    main()
