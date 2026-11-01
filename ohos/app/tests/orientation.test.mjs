/** Orientation policy and request ownership; sensor rendering is a device check. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LocalStorage } from './harmony-mocks.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../entry/src/main/ets');
const Orientation = { PORTRAIT: 1, AUTO_ROTATION: 5, AUTO_ROTATION_RESTRICTED: 8 };
const ColorMode = { COLOR_MODE_NOT_SET: -1, COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));

function environment({ rejectOff = false } = {}) {
  const listeners = new Map();
  const eventHub = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    off(name, listener) {
      if (rejectOff) throw new Error('context destroyed');
      listeners.get(name)?.delete(listener);
    },
    emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); }
  };
  class UIAbility {
    constructor() {
      this.context = { eventHub, config: { colorMode: ColorMode.COLOR_MODE_LIGHT },
        getApplicationContext: () => ({ setColorMode() {} }) };
    }
  }
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const exports = {};
    cache.set(relative, exports);
    const filename = path.join(ets, relative + '.ets');
    const emitted = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
    }, reportDiagnostics: true });
    assert.equal(emitted.diagnostics?.length ?? 0, 0);
    vm.runInNewContext(emitted.outputText, { exports, LocalStorage, AppStorage: { setOrCreate() {} }, require(name) {
      if (name === 'libdsh_launcher.so') return { __esModule: true, default: { brokerRelease: () => Promise.resolve() } };
      if (name === '@ohos.window') return { __esModule: true, default: { Orientation } };
      if (name === '@ohos.app.ability.UIAbility') return { __esModule: true, default: UIAbility };
      if (name === '@ohos.app.ability.ConfigurationConstant') return { __esModule: true, default: { ColorMode } };
      if (name === '@ohos.resourceManager') return { __esModule: true, default: { ColorMode: { DARK: 0, LIGHT: 1 } } };
      assert.ok(name.startsWith('.'), 'only documented SDK runtime imports are mocked');
      return load(path.posix.join(path.posix.dirname(relative), name));
    } }, { filename });
    return exports;
  }
  const ability = new (load('entryability/EntryAbility').default)();
  const event = load('launcher/WebOrientation').WEB_VIEW_ACTIVE_EVENT;
  ability.onCreate();
  return { ability, eventHub, listeners, event, active(value) { eventHub.emit(event, value); } };
}

function stage({ manual = false, unavailableBeforeLoad = false, throwOrientation = false,
  rejectOrientation = false } = {}) {
  const requested = [];
  const pending = [];
  let contentReady;
  let loaded = false;
  const mainWindow = {
    setPreferredOrientation(mode) {
      requested.push(mode);
      if (throwOrientation) throw new Error('window unavailable');
      if (rejectOrientation) return Promise.reject(new Error('orientation unsupported'));
      if (manual) return new Promise((resolve, reject) => pending.push({ mode, resolve, reject }));
      return Promise.resolve();
    },
    setWindowBackgroundColor() {},
    setWindowLayoutFullScreen() { return Promise.resolve(); },
    setWindowSystemBarProperties() { return Promise.resolve(); }
  };
  const windowStage = {
    getMainWindowSync() {
      if (unavailableBeforeLoad && !loaded) throw new Error('window not ready');
      return mainWindow;
    },
    loadContent(_page, _storage, callback) { contentReady = callback; }
  };
  return { windowStage, requested, pending, ready() { loaded = true; contentReady({ code: 0 }); } };
}

test('App pages request portrait before content loads and do not enable automatic rotation', async () => {
  const env = environment();
  const window = stage();
  env.ability.onWindowStageCreate(window.windowStage);
  assert.deepEqual(window.requested, [Orientation.PORTRAIT]);
  window.ready();
  await tick();
  env.active(false);
  env.ability.onConfigurationUpdate({ colorMode: ColorMode.COLOR_MODE_DARK });
  assert.deepEqual(window.requested, [Orientation.PORTRAIT]);
  env.ability.onDestroy();
});

test('only an active WebView selects lock-respecting mode 8 and returning home restores portrait', async () => {
  const env = environment();
  const window = stage();
  env.ability.onWindowStageCreate(window.windowStage);
  window.ready();
  await tick();
  env.active(true);
  await tick();
  assert.deepEqual(window.requested, [1, 8], 'mode 8 delegates the system rotation lock to the native window manager');
  assert.ok(!window.requested.includes(5), 'the policy must never select mode 5, which ignores system rotation lock');
  env.active(false);
  await tick();
  assert.deepEqual(window.requested, [Orientation.PORTRAIT, Orientation.AUTO_ROTATION_RESTRICTED, Orientation.PORTRAIT]);
  env.ability.onDestroy();
});

test('the latest activity flag survives events before a main window is available', async () => {
  const env = environment();
  env.active(true);
  const window = stage({ unavailableBeforeLoad: true });
  env.ability.onWindowStageCreate(window.windowStage);
  env.active(false);
  env.active(true);
  env.ability.onForeground();
  assert.deepEqual(window.requested, []);
  window.ready();
  await tick();
  assert.deepEqual(window.requested, [Orientation.AUTO_ROTATION_RESTRICTED]);
  env.ability.onDestroy();
});

test('configuration changes issue no orientation requests and foregrounding restores lock-respecting WebView rotation', async () => {
  const env = environment();
  const window = stage();
  env.ability.onWindowStageCreate(window.windowStage);
  window.ready();
  await tick();
  env.active(true);
  await tick();
  env.ability.onConfigurationUpdate({ colorMode: ColorMode.COLOR_MODE_LIGHT });
  env.ability.onConfigurationUpdate({ direction: 1 });
  env.ability.onConfigurationUpdate({ direction: 0 });
  await tick();
  assert.deepEqual(window.requested, [1, 8], 'rotation configuration updates cannot enqueue an orientation self-loop');
  env.ability.onForeground();
  await tick();
  assert.deepEqual(window.requested, [Orientation.PORTRAIT, Orientation.AUTO_ROTATION_RESTRICTED, Orientation.AUTO_ROTATION_RESTRICTED]);
  env.ability.onDestroy();
});

test('rapid WebView open and close serialize SDK requests and finish in the latest mode', async () => {
  const env = environment();
  const window = stage({ manual: true });
  env.ability.onWindowStageCreate(window.windowStage);
  window.ready();
  env.active(true);
  env.active(false);
  assert.deepEqual(window.requested, [Orientation.PORTRAIT]);
  window.pending[0].resolve();
  await tick();
  assert.deepEqual(window.requested, [Orientation.PORTRAIT]);
  env.active(true);
  env.active(false);
  env.active(true);
  env.active(false);
  assert.deepEqual(window.requested, [Orientation.PORTRAIT, Orientation.AUTO_ROTATION_RESTRICTED]);
  window.pending[1].resolve();
  await tick();
  assert.deepEqual(window.requested, [Orientation.PORTRAIT, Orientation.AUTO_ROTATION_RESTRICTED, Orientation.PORTRAIT]);
  window.pending[2].resolve();
  await tick();
  env.ability.onDestroy();
});

test('completion from a destroyed stage cannot enqueue a request on the replacement window', async () => {
  const env = environment();
  const oldWindow = stage({ manual: true });
  env.ability.onWindowStageCreate(oldWindow.windowStage);
  oldWindow.ready();
  oldWindow.pending[0].resolve();
  await tick();
  env.active(true);
  env.active(false);
  env.ability.onWindowStageDestroy();
  const currentWindow = stage();
  env.ability.onWindowStageCreate(currentWindow.windowStage);
  currentWindow.ready();
  oldWindow.pending[1].resolve();
  await tick();
  assert.deepEqual(oldWindow.requested, [Orientation.PORTRAIT, Orientation.AUTO_ROTATION_RESTRICTED]);
  assert.deepEqual(currentWindow.requested, [Orientation.PORTRAIT]);
  env.ability.onDestroy();
});

test('ability teardown removes only its listener and pending completion cannot mutate a retired window', async () => {
  const env = environment();
  const observerValues = [];
  const observer = value => observerValues.push(value);
  env.eventHub.on(env.event, observer);
  const window = stage({ manual: true });
  env.ability.onWindowStageCreate(window.windowStage);
  window.ready();
  env.active(true);
  assert.equal(env.listeners.get(env.event).size, 2);
  env.ability.onDestroy();
  assert.equal(env.listeners.get(env.event).size, 1);
  env.active(false);
  window.pending[0].resolve();
  await tick();
  assert.deepEqual(window.requested, [Orientation.PORTRAIT]);
  assert.deepEqual(observerValues, [true, false]);
});

test('a failed in-flight request still applies a newer portrait request without retry loops', async () => {
  const env = environment();
  const window = stage({ manual: true });
  env.ability.onWindowStageCreate(window.windowStage);
  window.ready();
  window.pending[0].resolve();
  await tick();
  env.active(true);
  env.active(false);
  window.pending[1].reject(new Error('orientation service refused the request'));
  await tick();
  assert.deepEqual(window.requested, [Orientation.PORTRAIT, Orientation.AUTO_ROTATION_RESTRICTED, Orientation.PORTRAIT]);
  window.pending[2].resolve();
  await tick();
  env.ability.onDestroy();
});

test('synchronous and asynchronous SDK errors stay contained and foregrounding can retry', async () => {
  for (const failure of [{ throwOrientation: true }, { rejectOrientation: true }]) {
    const env = environment();
    const window = stage(failure);
    assert.doesNotThrow(() => env.ability.onWindowStageCreate(window.windowStage));
    window.ready();
    await tick();
    assert.doesNotThrow(() => env.active(true));
    await tick();
    assert.doesNotThrow(() => env.ability.onForeground());
    await tick();
    assert.deepEqual(window.requested, [Orientation.PORTRAIT, Orientation.AUTO_ROTATION_RESTRICTED, Orientation.AUTO_ROTATION_RESTRICTED]);
    env.ability.onDestroy();
  }
});

test('teardown disposes orientation ownership even when the context rejects listener removal', async () => {
  const env = environment({ rejectOff: true });
  const window = stage();
  env.ability.onWindowStageCreate(window.windowStage);
  window.ready();
  await tick();
  assert.doesNotThrow(() => env.ability.onDestroy());
  env.active(true);
  await tick();
  assert.deepEqual(window.requested, [Orientation.PORTRAIT]);
});
