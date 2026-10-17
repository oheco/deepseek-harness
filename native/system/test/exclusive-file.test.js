/** OHOS exclusive creation through the built public entry and signed native addon. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openExclusive } from '@deepseek-ai/node-addon-system/exclusive-file';

const ohos = process.platform === 'openharmony';
const timeout = 60_000;
const root = fileURLToPath(new URL('../', import.meta.url));
const environment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|^NODE_PATH$/i.test(key)));

function temporary(t, beforeCleanup = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exclusive-file-'));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(dirname(dir), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout, env: environment(), ...options });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function oracle(t) {
  const dir = temporary(t);
  const headers = resolve(dirname(process.execPath), '../include/node');
  const compiled = join(dir, 'oracle.node');
  const unsigned = join(dir, 'oracle.unsigned.node');
  const signed = join(dir, 'oracle.signed.node');
  command('clang', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', headers,
    '-pthread', '-shared', '-o', compiled, join(root, 'test/fixtures/exclusive-file-oracle.c')]);
  command('llvm-objcopy', ['--remove-section=.codesign', compiled, unsigned]);
  command('binary-sign-tool', ['sign', '-inFile', unsigned, '-outFile', signed, '-selfSign', '1']);
  return createRequire(import.meta.url)(signed);
}

function errorCode(code, path) {
  return (error) => {
    assert.equal(error.code, code);
    assert.ok(error.errno > 0);
    assert.equal(error.syscall, 'open');
    assert.equal(error.path, path);
    return true;
  };
}

function writeOwned(path, data, inspect = () => {}) {
  const fd = openExclusive(path, 0o600);
  try {
    assert.ok(fd >= 0);
    assert.equal(fstatSync(fd).mode & 0o777, 0o600);
    inspect(fd);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(readFileSync(path), data);
}

test('exclusive-file and flock subpaths import without addon loading and fail closed on calls', { timeout }, (t) => {
  const dir = temporary(t);
  const installed = join(dir, 'node_modules/@deepseek-ai/node-addon-system');
  mkdirSync(installed, { recursive: true });
  cpSync(join(root, 'packages/entry/package.json'), join(installed, 'package.json'));
  cpSync(join(root, 'packages/entry/lib'), join(installed, 'lib'), { recursive: true });
  command(process.execPath, ['--no-addons', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    let loaded = 0;
    process.dlopen = () => { loaded++; throw new Error('unexpected native load'); };
    const api = await import('@deepseek-ai/node-addon-system/exclusive-file');
    const flock = await import('@deepseek-ai/node-addon-system/flock');
    assert.deepEqual(Object.keys(api), ['openExclusive']);
    assert.equal(typeof flock.tryLockExclusive, 'function');
    assert.equal(loaded, 0);
    await assert.rejects(import('@deepseek-ai/node-addon-system'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    Object.defineProperty(process, 'platform', {value:'win32', configurable:true});
    assert.throws(() => api.openExclusive('unused', 0o600), {code:'ERR_EXCLUSIVE_FILE_UNSUPPORTED_PLATFORM'});
    await assert.rejects(flock.tryLockExclusive(1), {code:'ERR_FLOCK_UNSUPPORTED_PLATFORM'});
    Object.defineProperty(process, 'platform', {value:'openharmony'});
    Object.defineProperty(process, 'arch', {value:'arm64'});
    assert.throws(() => api.openExclusive('unused', 0o600), {code:'MODULE_NOT_FOUND'});
    assert.equal(loaded, 0);
  `], { cwd: dir });
});

test('native exclusive-file creates complete private files during 32 concurrent child stdout callbacks', { timeout, skip: !ohos }, async (t) => {
  const children = new Map();
  const dir = temporary(t, async () => {
    for (const child of children.keys()) child.kill('SIGKILL');
    await Promise.all(children.values());
  });
  const probe = oracle(t);
  const planted = join(dir, 'planted');
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  const absent = join(dir, 'absent', 'file');
  writeFileSync(planted, 'existing-file');
  writeFileSync(target, 'symlink-target');
  symlinkSync(target, link);
  const before = new Map([planted, target, link].map(path => [path, lstatSync(path)]));
  let count = 0;
  async function sample(index) {
    const child = spawn('/usr/bin/zsh', ['-f', '-c', 'for i in {1..100}; do printf "line-%s\\n" "$i"; done'], {
      env: environment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failed, processError, checked = false;
    const done = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    children.set(child, done);
    child.on('error', error => { processError = error; });
    child.stderr.resume();
    child.stdout.on('data', () => {
      if (checked) return;
      checked = true;
      try {
        const payload = Buffer.from(`owned-${index}:` + 'full-byte-content-\u4e2d\u6587\n'.repeat(8192));
        // Compare every signal bit before/after each public operation, including errors.
        for (const blocked of [false, true]) {
          const original = probe.signalMask();
          probe.setChildBlocked(blocked);
          try {
            const mask = probe.signalMask();
            const path = join(dir, `fresh-${index}-${blocked}`);
            writeOwned(path, payload, fd => assert.equal(probe.descriptorFlags(fd) & 1, 1));
            assert.equal(probe.signalMask(), mask);
            for (const [path, code] of [[planted, 'EEXIST'], [link, 'EEXIST'], [absent, 'ENOENT']]) {
              assert.throws(() => openExclusive(path, 0o600), errorCode(code, path));
              assert.equal(probe.signalMask(), mask);
            }
          } finally {
            probe.setChildBlocked(original[constants.signals.SIGCHLD - 1] === '1');
          }
          assert.equal(probe.signalMask(), original);
        }
        count++;
      } catch (error) { failed = error; }
    });
    const result = await done;
    children.delete(child);
    assert.equal(processError, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.ok(checked);
    if (failed) throw failed;
  }
  for (let index = 0; index < 32; index += 4) {
    await Promise.all(Array.from({length:4}, (_, offset) => sample(index + offset)));
  }
  assert.equal(count, 32);
  assert.equal(readFileSync(planted, 'utf8'), 'existing-file');
  assert.equal(readFileSync(target, 'utf8'), 'symlink-target');
  for (const [path, old] of before) {
    const current = lstatSync(path);
    for (const key of ['ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) assert.equal(current[key], old[key]);
  }
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(existsSync(absent), false);
  for (const mode of [-1, 0o1000, 0.1, NaN]) assert.throws(() => openExclusive(join(dir, 'invalid'), mode), RangeError);
  assert.throws(() => openExclusive(join(dir, 'nul') + '\0tail', 0o600), TypeError);
  console.log(JSON.stringify({samples:count, freshFiles:count * 2, errorChecks:count * 6, maskChecks:count * 8, payload:'exact full UTF-8 bytes', mode:'0600'}));
});

test('exclusive-file mask and result failures preserve ownership without retries', { timeout, skip: !ohos }, (t) => {
  const dir = temporary(t);
  const probe = oracle(t);
  const original = probe.signalMask();
  for (const scenario of [1, 2, 3]) {
    const path = join(dir, `fault-${scenario}`);
    probe.configure(scenario);
    if (scenario === 3) {
      assert.throws(() => probe.openExclusive(path, 0o600), {code:'ERR_EXCLUSIVE_FILE_NAPI'});
    } else {
      const result = probe.openExclusive(path, 0o600);
      assert.equal(result.fd, -1);
      assert.equal(result.maskPhase, scenario);
      assert.ok(result.maskErrno > 0);
      assert.equal(result.errno, 0);
    }
    assert.equal(probe.signalMask(), original);
    const observed = probe.observed();
    assert.equal(observed.opens, scenario === 1 ? 0 : 1);
    assert.equal(observed.closes, scenario === 1 ? 0 : 1);
    assert.equal(observed.fdFlags, -1);
    assert.equal(existsSync(path), scenario !== 1);
    if (scenario !== 1) assert.equal(lstatSync(path).size, 0);
  }
  probe.configure(2);
  const failedOpen = probe.openExclusive(join(dir, 'absent', 'file'), 0o600);
  assert.equal(failedOpen.errno, 2);
  assert.equal(failedOpen.maskPhase, 2);
  assert.ok(failedOpen.maskErrno > 0);
  assert.equal(probe.signalMask(), original);
  assert.equal(probe.observed().opens, 1);
  assert.equal(probe.observed().closes, 0);
});
