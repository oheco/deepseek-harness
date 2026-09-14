/** Keyless tests for the two-step page logic; not a replacement for ArkTS or device tests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const ets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../entry/src/main/ets');

/** Loads a .ets module with the HarmonyOS APIs the watcher needs, faked in memory. */
function harness() {
  const files = new Map();
  let tick;
  const cache = new Map();
  const handles = new Map();
  let nextFd = 1;
  const fsMock = {
    OpenMode: {READ_ONLY: 0},
    openSync(target) {
      const entry = files.get(target);
      if (entry === undefined) {
        const error = new Error('not found');
        error.code = 13900002;
        throw error;
      }
      if (entry.deny !== undefined) {
        const error = new Error('denied');
        error.code = entry.deny;
        throw error;
      }
      const fd = nextFd++;
      handles.set(fd, entry);
      return {fd};
    },
    statSync(fd) {
      return {size: handles.get(fd).content.length};
    },
    readSync(fd, buffer, options) {
      const bytes = Buffer.from(handles.get(fd).content, 'utf8');
      const start = options.offset;
      const length = Math.min(options.length, bytes.length - start);
      if (length <= 0) return 0;
      new Uint8Array(buffer).set(bytes.subarray(start, start + length));
      return length;
    },
    closeSync(file) {
      handles.delete(file.fd);
    }
  };
  const utilMock = {
    TextDecoder: {create() { return {decodeToString: (bytes) => Buffer.from(bytes).toString('utf8')}; }}
  };
  function load(filename) {
    const key = path.resolve(filename);
    if (cache.has(key)) return cache.get(key);
    const source = fs.readFileSync(key, 'utf8');
    const result = ts.transpileModule(source, {compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
    }});
    const exports = {};
    cache.set(key, exports);
    vm.runInNewContext(result.outputText, {
      exports,
      require(name) {
        if (name === '@ohos.file.fs') return {__esModule: true, default: fsMock};
        if (name === '@ohos.util') return {__esModule: true, default: utilMock};
        if (name.startsWith('.')) return load(path.resolve(path.dirname(key), name + '.ets'));
        throw new Error('Unexpected runtime import: ' + name);
      },
      setInterval(callback) { tick = callback; return 1; },
      clearInterval() { tick = undefined; },
      BusinessError: class {}
    }, {filename: key});
    return exports;
  }
  const url = load(path.join(ets, 'launcher/RunLogUrl.ets'));
  const watcherModule = load(path.join(ets, 'launcher/RunLogWatcher.ets'));
  return {url, watcherModule, files,
    newWatcher: () => new watcherModule.RunLogWatcher(),
    poll: () => { assert.ok(tick, 'the watcher is polling'); tick(); }
  };
}

const LOG_TARGET = '/home/user/Documents/dsh-run.log';
const FIRST = 'http://127.0.0.1:43210/?token=first-token_value';
const SECOND = 'http://127.0.0.1:43211/?token=second-token_value';

test('readiness parsing accepts only a complete loopback announcement', () => {
  const h = harness();
  const parse = h.url.readinessUrl;
  assert.equal(parse('dsh web: ' + FIRST + '\n'), FIRST);
  assert.equal(parse('booting\ndsh web: ' + FIRST + '\nready\n'), FIRST);
  assert.equal(parse('dsh web: ' + FIRST + ' (LAN: http://192.168.1.5:43210/?token=first-token_value)\n'), FIRST);
  assert.equal(parse(FIRST + '\n'), FIRST, 'a bare loopback URL line is accepted');
  assert.equal(parse(''), '');
  assert.equal(parse('dsh web: http://127.0.0.1:43210/?token=\n'), '', 'empty token');
  assert.equal(parse('dsh web: http://127.0.0.1:0/?token=x\n'), '', 'port zero');
  assert.equal(parse('dsh web: http://127.0.0.1:43210/?token=x extra\n'), '', 'trailing text');
  assert.equal(parse('dsh web: ' + FIRST + ' (LAN: http://192.168.1.5:43210/?token=first-token_value\n'), '', 'truncated LAN suffix');
  assert.equal(parse('dsh web: http://evil.example:43210/?token=x\n'), '', 'non-loopback authority');
  assert.equal(parse('dsh web: http://127.0.0.1:99999/?token=x\n'), '', 'port above the range');
  assert.equal(parse('dsh web: ' + FIRST), '', 'an unterminated line is not adopted');
  assert.equal(parse('dsh web: ' + FIRST + '\n'), FIRST, 'the same line is adopted once terminated');
});

test('loopback origin accepts only explicit IP loopback HTTP authorities', () => {
  const o = harness().url.loopbackOrigin;
  assert.equal(o('http://127.0.0.1:43210/?token=x'), 'http://127.0.0.1:43210');
  assert.equal(o('http://127.0.0.1:43210/'), 'http://127.0.0.1:43210');
  assert.equal(o('http://[::1]:43210/'), 'http://[::1]:43210');
  assert.equal(o('https://example.com/'), '');
  assert.equal(o('http://localhost:43210/'), '');
  assert.equal(o('http://127.0.0.1:43210.evil/'), '');
  assert.equal(o('http://127.0.0.1:43210@evil/'), '');
  assert.equal(o('http://127.0.0.1:43210\\@evil/'), '');
  assert.equal(o('http://127.0.0.1:0/'), '');
});

test('the watcher publishes an address only from a complete log line', () => {
  const h = harness();
  const watcher = h.newWatcher();
  let view;
  watcher.subscribe(next => { view = next; });
  watcher.setPath(LOG_TARGET);

  h.files.set(LOG_TARGET, {content: ''});
  h.poll();
  assert.equal(view.state, h.watcherModule.RunLogState.Waiting, 'empty log keeps waiting');
  assert.equal(view.url, '');

  h.files.set(LOG_TARGET, {content: 'starting up\ndsh web: http://127.0.0.1:43210/?token=par'});
  h.poll();
  assert.equal(view.url, '', 'a partially written address is never opened');
  assert.equal(view.state, h.watcherModule.RunLogState.Waiting);

  h.files.set(LOG_TARGET, {content: 'starting up\ndsh web: ' + FIRST + '\n'});
  h.poll();
  assert.equal(view.state, h.watcherModule.RunLogState.Found);
  assert.equal(view.url, FIRST);
});

test('a log left by an earlier run is replaced when the service restarts', () => {
  const h = harness();
  const watcher = h.newWatcher();
  let view;
  watcher.subscribe(next => { view = next; });
  watcher.setPath(LOG_TARGET);

  h.files.set(LOG_TARGET, {content: 'dsh web: ' + FIRST + '\n'});
  h.poll();
  assert.equal(view.url, FIRST);
  // The address stays stable across polls; the page only opens a target it has
  // not opened yet, so a log left behind cannot reload the view every second.
  h.poll();
  assert.equal(view.url, FIRST);
  assert.equal(view.state, h.watcherModule.RunLogState.Found);

  h.files.set(LOG_TARGET, {content: 'dsh web: ' + SECOND + '\n'});
  h.poll();
  assert.equal(view.url, SECOND, 'a restarted service on a new port replaces the address');
});

test('an unreadable log is reported and recovers through a picked file', () => {
  const h = harness();
  const watcher = h.newWatcher();
  let view;
  watcher.subscribe(next => { view = next; });
  watcher.setPath(LOG_TARGET);

  h.poll();
  assert.equal(view.state, h.watcherModule.RunLogState.Missing, 'the file does not exist yet');

  h.files.set(LOG_TARGET, {deny: 13900012});
  h.poll();
  assert.equal(view.state, h.watcherModule.RunLogState.Unreadable, 'a refused read is distinguished');

  h.files.set('file://docs/storage/Users/currentUser/Documents/dsh-run.log', {content: 'dsh web: ' + FIRST + '\n'});
  watcher.setUri('file://docs/storage/Users/currentUser/Documents/dsh-run.log');
  h.poll();
  assert.equal(view.state, h.watcherModule.RunLogState.Found, 'the picked file is read instead');
  assert.equal(view.url, FIRST);
});
