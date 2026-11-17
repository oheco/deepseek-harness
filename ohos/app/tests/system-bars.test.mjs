/** Ability window lifecycle regressions; device rendering remains separate acceptance. */
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
const modes = { COLOR_MODE_NOT_SET: -1, COLOR_MODE_LIGHT: 1, COLOR_MODE_DARK: 0 };
const resourceModes = { DARK: 0, LIGHT: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));

function abilityEnvironment({ rejectFollowSystem = false, rejectResourceConfig = false,
  rejectEvent = false, initialMode = modes.COLOR_MODE_LIGHT, resourceMode = resourceModes.LIGHT } = {}) {
  const events = [];
  const storage = new Map();
  const listeners = new Map();
  const control = { resourceMode, rejectResourceConfig };
  const eventHub = {
    on(name, callback) { listeners.set(name, callback); },
    off(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    emit(name, ...payload) {
      if (rejectEvent) throw new Error('context unavailable');
      events.push(['event', name, ...payload]);
      listeners.get(name)?.(...payload);
    }
  };
  class UIAbility {
    constructor() {
      this.context = {
        config: { colorMode: initialMode }, eventHub,
        getApplicationContext: () => ({
          setColorMode(mode) {
            events.push(['follow-system', mode]);
            if (rejectFollowSystem) throw new Error('context unavailable');
          },
          resourceManager: { getConfigurationSync() {
            if (control.rejectResourceConfig) throw new Error('resource context unavailable');
            return { colorMode: control.resourceMode };
          } }
        })
      };
    }
  }
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const filename = path.join(ets, relative + '.ets');
    const exports = {};
    cache.set(relative, exports);
    const emitted = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
    }, reportDiagnostics: true });
    assert.equal(emitted.diagnostics?.length ?? 0, 0, 'ability and helper parse as TypeScript');
    vm.runInNewContext(emitted.outputText, {
      exports, LocalStorage,
      AppStorage: { setOrCreate(key, value) { storage.set(key, value); } },
      require(name) {
        if (name === 'libdsh_launcher.so') return { __esModule: true, default: { brokerRelease: () => Promise.resolve() } };
        if (name === '@ohos.window') return { __esModule: true,
          default: { Orientation: { PORTRAIT: 1, AUTO_ROTATION: 5, AUTO_ROTATION_RESTRICTED: 8 } } };
        if (name === '@ohos.app.ability.UIAbility') return { __esModule: true, default: UIAbility };
        if (name === '@ohos.app.ability.ConfigurationConstant') return { __esModule: true, default: { ColorMode: modes } };
        if (name === '@ohos.resourceManager') return { __esModule: true, default: { ColorMode: resourceModes } };
        assert.ok(name.startsWith('.'), 'only expected SDK runtime imports are mocked');
        return load(path.posix.join(path.posix.dirname(relative), name));
      }
    }, { filename });
    return exports;
  }
  const entry = load('entryability/EntryAbility');
  const ability = new entry.default();
  return { ability, events, storage, listeners, control, colorModeKey: entry.COLOR_MODE_KEY,
    helper: load('launcher/SystemBars'), activity: load('launcher/AppActivity'),
    configuration(config) { ability.context.config = config; ability.onConfigurationUpdate(config); } };
}

function stageEnvironment({ rejectBackground = false, rejectLayout = false, rejectBars = false,
  throwLayout = false, throwBars = false, missingWindow = false } = {}) {
  const calls = [];
  let contentReady;
  const mainWindow = {
    setPreferredOrientation(mode) { calls.push(['orientation', mode]); return Promise.resolve(); },
    setWindowBackgroundColor(color) {
      calls.push(['background', color]);
      if (rejectBackground) throw new Error('window destroyed');
    },
    setWindowLayoutFullScreen(enabled) {
      calls.push(['layout', enabled]);
      assert.equal(enabled, false, 'interactive content must retain normal system safe areas');
      if (throwLayout) throw new Error('window destroyed');
      return rejectLayout ? Promise.reject(new Error('layout unavailable')) : Promise.resolve();
    },
    setWindowSystemBarProperties(properties) {
      calls.push(['bars', { ...properties }]);
      if (throwBars) throw new Error('window destroyed');
      return rejectBars ? Promise.reject(new Error('bar styling unsupported')) : Promise.resolve();
    }
  };
  const stage = {
    loadContent(page, storage, callback) {
      assert.ok(storage instanceof LocalStorage, 'each window passes its own LocalStorage');
      calls.push(['load', page]); contentReady = callback;
    },
    getMainWindowSync() {
      calls.push(['main-window']);
      if (missingWindow) throw new Error('window unavailable');
      return mainWindow;
    }
  };
  return { stage, calls, ready(code = 0) { contentReady({ code }); } };
}

function frames(calls) {
  return calls.filter(([operation]) => operation === 'bars').map(([, properties]) => properties);
}

function expectedFrame(dark) {
  return {
    statusBarColor: '#00000000', navigationBarColor: '#00000000',
    statusBarContentColor: dark ? '#FFFFFFFF' : '#FF0F1115',
    navigationBarContentColor: dark ? '#FFFFFFFF' : '#FF0F1115'
  };
}

for (const [label, mode] of [['light', modes.COLOR_MODE_LIGHT], ['dark', modes.COLOR_MODE_DARK]]) {
  test(`${label} window colors apply after content loads with readable bars and normal safe areas`, () => {
    const env = abilityEnvironment({ initialMode: mode });
    const window = stageEnvironment();
    env.ability.onCreate();
    assert.equal(env.storage.get(env.colorModeKey), mode);
    env.ability.onWindowStageCreate(window.stage);
    assert.deepEqual(window.calls, [['main-window'], ['orientation', 1], ['load', 'pages/Index']]);
    assert.deepEqual(env.events, []);
    window.ready();
    assert.deepEqual(env.events, [['follow-system', modes.COLOR_MODE_NOT_SET]]);
    assert.deepEqual(frames(window.calls), [expectedFrame(mode === modes.COLOR_MODE_DARK)]);
    assert.equal(window.calls.find(([name]) => name === 'background')[1], env.helper.appWindowBackground(mode));
    assert.ok(window.calls.some(([name, value]) => name === 'layout' && value === false));
  });
}

test('native window and launch colors match the page resources in both modes', () => {
  const { helper } = abilityEnvironment();
  for (const [directory, mode] of [['base', modes.COLOR_MODE_LIGHT], ['dark', modes.COLOR_MODE_DARK]]) {
    const file = path.join(ets, `../resources/${directory}/element/color.json`);
    const colors = new Map(JSON.parse(fs.readFileSync(file, 'utf8')).color.map(({ name, value }) => [name, value]));
    assert.equal(helper.appWindowBackground(mode), colors.get('background'));
    assert.equal(colors.get('start_window_background'), colors.get('background'));
    assert.deepEqual({ ...helper.systemBarProperties(mode) }, expectedFrame(mode === modes.COLOR_MODE_DARK));
  }
});

test('omitted and follow-system ability modes resolve the application resource configuration', () => {
  for (const initialMode of [undefined, modes.COLOR_MODE_NOT_SET]) {
    const env = abilityEnvironment({ resourceMode: resourceModes.DARK });
    env.ability.context.config = { colorMode: initialMode };
    env.ability.onCreate();
    assert.equal(env.storage.get(env.colorModeKey), modes.COLOR_MODE_DARK);
    assert.deepEqual(env.events, []);
  }
});

test('an unavailable initial resource configuration uses the SDK default light mode', () => {
  const env = abilityEnvironment({ initialMode: modes.COLOR_MODE_NOT_SET, rejectResourceConfig: true });
  env.ability.onCreate();
  assert.equal(env.storage.get(env.colorModeKey), modes.COLOR_MODE_LIGHT);
});

test('explicit configuration modes take priority over a stale application resource mode', () => {
  const env = abilityEnvironment({ initialMode: modes.COLOR_MODE_DARK, resourceMode: resourceModes.LIGHT });
  env.ability.onCreate();
  assert.equal(env.storage.get(env.colorModeKey), modes.COLOR_MODE_DARK);
  env.configuration({ colorMode: modes.COLOR_MODE_LIGHT });
  assert.equal(env.storage.get(env.colorModeKey), modes.COLOR_MODE_LIGHT);
});

test('configuration changes switch the frame in both directions without forcing theme or orientation', async () => {
  const env = abilityEnvironment();
  const window = stageEnvironment();
  env.ability.onCreate();
  env.ability.onWindowStageCreate(window.stage);
  window.ready();
  await tick();
  env.configuration({ colorMode: modes.COLOR_MODE_DARK });
  env.configuration({ colorMode: modes.COLOR_MODE_LIGHT });
  assert.deepEqual(frames(window.calls), [expectedFrame(false), expectedFrame(true), expectedFrame(false)]);
  assert.deepEqual(window.calls.filter(([name]) => name === 'orientation'), [['orientation', 1]]);
  assert.deepEqual(env.events, [['follow-system', modes.COLOR_MODE_NOT_SET]]);
});

test('foregrounding rereads the current system mode before emitting the no-payload activity event', async () => {
  const env = abilityEnvironment();
  const window = stageEnvironment();
  env.ability.onCreate();
  env.ability.onWindowStageCreate(window.stage);
  window.ready();
  await tick();
  env.ability.context.config = { colorMode: modes.COLOR_MODE_NOT_SET };
  env.control.resourceMode = resourceModes.DARK;
  const observations = [];
  env.listeners.set(env.activity.APP_FOREGROUND_EVENT, (...payload) => {
    observations.push({ payload, frame: frames(window.calls).at(-1), orientation: window.calls.at(-1) });
  });
  env.ability.onForeground();
  assert.equal(env.storage.get(env.colorModeKey), modes.COLOR_MODE_DARK);
  assert.deepEqual(observations, [{ payload: [], frame: expectedFrame(true), orientation: ['orientation', 1] }]);
  env.ability.context.config = { colorMode: modes.COLOR_MODE_LIGHT };
  env.ability.onForeground();
  assert.deepEqual(frames(window.calls), [expectedFrame(false), expectedFrame(true), expectedFrame(false)]);
  assert.deepEqual(env.events, [['follow-system', modes.COLOR_MODE_NOT_SET],
    ['event', env.activity.APP_FOREGROUND_EVENT], ['event', env.activity.APP_FOREGROUND_EVENT]]);
});

test('an unspecified update and unavailable resources preserve the cached actual dark mode', () => {
  const env = abilityEnvironment({ initialMode: modes.COLOR_MODE_DARK });
  const window = stageEnvironment();
  env.ability.onCreate();
  env.ability.onWindowStageCreate(window.stage);
  window.ready();
  env.control.rejectResourceConfig = true;
  env.configuration({ colorMode: modes.COLOR_MODE_NOT_SET });
  env.configuration({ language: 'en-US' });
  env.ability.onForeground();
  assert.equal(env.storage.get(env.colorModeKey), modes.COLOR_MODE_DARK);
  assert.deepEqual(frames(window.calls), Array(4).fill(expectedFrame(true)));
});

test('background events have no payload and activity callback failures stay contained', () => {
  const env = abilityEnvironment();
  env.listeners.set(env.activity.APP_BACKGROUND_EVENT, () => { throw new Error('page callback failed'); });
  env.listeners.set(env.activity.APP_FOREGROUND_EVENT, () => { throw new Error('page callback failed'); });
  assert.doesNotThrow(() => env.ability.onBackground());
  assert.doesNotThrow(() => env.ability.onForeground());
  assert.deepEqual(env.events, [['event', env.activity.APP_BACKGROUND_EVENT], ['event', env.activity.APP_FOREGROUND_EVENT]]);
  const rejected = abilityEnvironment({ rejectEvent: true });
  assert.doesNotThrow(() => rejected.ability.onForeground());
  assert.doesNotThrow(() => rejected.ability.onBackground());
});

test('destroyed and replaced stages cannot publish late content callbacks or receive later styling', () => {
  const env = abilityEnvironment();
  const oldWindow = stageEnvironment();
  env.ability.onWindowStageCreate(oldWindow.stage);
  env.ability.onWindowStageDestroy();
  const currentWindow = stageEnvironment();
  env.ability.onWindowStageCreate(currentWindow.stage);
  oldWindow.ready();
  assert.deepEqual(oldWindow.calls, [['main-window'], ['orientation', 1], ['load', 'pages/Index']]);
  assert.deepEqual(env.events, []);
  currentWindow.ready();
  assert.equal(frames(currentWindow.calls).length, 1);
  env.ability.onWindowStageDestroy();
  env.configuration({ colorMode: modes.COLOR_MODE_DARK });
  env.ability.onForeground();
  assert.equal(frames(currentWindow.calls).length, 1);
  assert.equal(env.storage.get(env.colorModeKey), modes.COLOR_MODE_DARK);
});

test('ability destruction also invalidates a pending content callback', () => {
  const env = abilityEnvironment();
  const window = stageEnvironment();
  env.ability.onWindowStageCreate(window.stage);
  env.ability.onDestroy();
  window.ready();
  assert.deepEqual(window.calls, [['main-window'], ['orientation', 1], ['load', 'pages/Index']]);
  assert.deepEqual(env.events, []);
});

test('failed content or unavailable main windows keep lifecycle callbacks usable', () => {
  const env = abilityEnvironment();
  const failed = stageEnvironment();
  env.ability.onWindowStageCreate(failed.stage);
  failed.ready(1300002);
  env.ability.onForeground();
  assert.equal(frames(failed.calls).length, 0);
  const missing = stageEnvironment({ missingWindow: true });
  env.ability.onWindowStageCreate(missing.stage);
  assert.doesNotThrow(() => missing.ready());
  env.configuration({ colorMode: modes.COLOR_MODE_DARK });
  assert.deepEqual(missing.calls, [['main-window'], ['load', 'pages/Index'], ['main-window']]);
});

test('unsupported window operations do not skip other frame settings or leak rejected promises', async () => {
  for (const failure of [{ rejectBackground: true, rejectLayout: true, rejectBars: true },
    { rejectBackground: true, throwLayout: true, throwBars: true }]) {
    const env = abilityEnvironment();
    const window = stageEnvironment(failure);
    env.ability.onWindowStageCreate(window.stage);
    assert.doesNotThrow(() => window.ready());
    await tick();
    assert.equal(frames(window.calls).length, 1);
    assert.ok(window.calls.some(([name, value]) => name === 'layout' && value === false));
    assert.doesNotThrow(() => env.ability.onForeground());
    await tick();
    assert.equal(frames(window.calls).length, 2);
  }
});

test('a refused follow-system setter still allows the loaded window frame to be styled', () => {
  const env = abilityEnvironment({ rejectFollowSystem: true });
  const window = stageEnvironment();
  env.ability.onWindowStageCreate(window.stage);
  assert.doesNotThrow(() => window.ready());
  assert.equal(frames(window.calls).length, 1);
});
