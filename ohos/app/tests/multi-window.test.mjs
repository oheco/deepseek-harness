/** Window routing, per-window broker channels and the shared connection list; device windows remain separate acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cryptoFramework, LocalStorage } from './harmony-mocks.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../entry/src/main/ets');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let index = 0; index < 20; index++) await tick(); };

function behaviorPrefix(source, name) {
  const offset = source.indexOf('\n  @Builder');
  assert.notEqual(offset, -1, 'page must expose its behavior before its builders');
  return (source.slice(0, offset) + '\n}\n').replace('export struct ' + name, 'export class ' + name)
    .replace(/^@(Entry|Component)\s*$/gm, '').replace(/@StorageProp\([^\n]+\)\s*/g, '').replace(/@(State|Prop)\s*/g, '');
}

/** One App process: two or more EntryAbility windows share modules, preferences and the window registry. */
function app() {
  const cache = new Map();
  const calls = [];
  const diagnostics = [];
  const started = [];
  const disk = new Map();
  const control = { startFailure: undefined };
  class NavPathStack {
    routes = [];
    pushPath(info) { this.routes.push(info); }
    pop() { return this.routes.pop(); }
    popToIndex(index) { this.routes.splice(index + 1); }
    getAllPathName() { return this.routes.map(info => info.name); }
    getIndexByName(name) { return this.routes.flatMap((info, index) => info.name === name ? [index] : []); }
    size() { return this.routes.length; }
    clear() { this.routes = []; }
  }
  const preferences = {
    async get(key, fallback) { return disk.get(key) ?? fallback; },
    async put(key, value) { await tick(); disk.set(key, value); },
    async flush() { await tick(); }
  };
  let nextPort = 43219;
  const native = {
    async brokerLogin(options) { calls.push(['login', options.channel]); return { accessToken: 'account-bearer', authSessionId: '', tokenType: 'Bearer' }; },
    async brokerList(options) { calls.push(['list', options.channel]); return [{ id: 'broker', name: 'Workstation', online: true }]; },
    async brokerConnect(options) {
      calls.push(['connect', options.channel, options.remotePort]);
      await tick();
      const port = nextPort++;
      return { state: 'connected', localUrl: 'http://127.0.0.1:' + port + '/', localPort: port,
        brokerId: options.brokerId, remotePort: options.remotePort, error: '', errorCode: '' };
    },
    async dshProbe(options) { calls.push(['probe', options.channel, options.origin]); return { state: 'ok', httpStatus: 200 }; },
    async brokerClose(channel) { calls.push(['close', channel]); },
    async brokerRelease(channel) { calls.push(['release', channel]); },
    writeConnectionDiagnostic(event, fields) { diagnostics.push([event, fields]); },
    configureConnectionDiagnostics() {}
  };
  const eventHubs = [];
  function eventHub() {
    const listeners = new Map();
    const hub = {
      on(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
      off(name, listener) { listeners.get(name)?.delete(listener); },
      emit(name, ...args) { for (const listener of [...(listeners.get(name) ?? [])]) listener(...args); }
    };
    eventHubs.push(hub);
    return hub;
  }
  class UIAbility {
    constructor() {
      this.context = { eventHub: eventHub(), config: { colorMode: 1 }, filesDir: '/private/files', tempDir: '/private/temp',
        abilityInfo: { bundleName: 'org.oheco.deepseekharness', name: 'EntryAbility' },
        resourceManager: { getStringByNameSync(name) { assert.equal(name, 'app_name'); return 'Deepseek Harness'; } },
        getApplicationContext: () => ({ setColorMode() {}, resourceManager: { getConfigurationSync: () => ({ colorMode: 1 }) } }),
        async startAbility(want) {
          if (control.startFailure) throw control.startFailure;
          started.push(JSON.parse(JSON.stringify(want)));
        } };
    }
  }
  class AbilityStage {}
  const mocks = {
    'libdsh_launcher.so': native,
    '@ohos.app.ability.UIAbility': UIAbility,
    '@ohos.app.ability.AbilityStage': AbilityStage,
    '@ohos.app.ability.ConfigurationConstant': { ColorMode: { COLOR_MODE_NOT_SET: -1, COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1 } },
    '@ohos.window': { Orientation: { PORTRAIT: 1, AUTO_ROTATION: 5, AUTO_ROTATION_RESTRICTED: 8 } },
    '@ohos.resourceManager': { ColorMode: { DARK: 0, LIGHT: 1 } },
    '@ohos.url': { URL },
    '@ohos.util': { generateRandomUUID: (() => { let id = 0; return () => 'connection-' + ++id; })() },
    '@ohos.data.preferences': { getPreferences: async () => preferences },
    '@ohos.security.cryptoFramework': cryptoFramework
  };
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const filename = path.join(ets, relative + '.ets');
    let source = fs.readFileSync(filename, 'utf8');
    if (relative === 'pages/ConnectionHome') source = behaviorPrefix(source, 'ConnectionHome');
    const emitted = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
    }, reportDiagnostics: true });
    assert.equal(emitted.diagnostics?.length ?? 0, 0);
    const exports = {};
    cache.set(relative, exports);
    vm.runInNewContext(emitted.outputText, { exports, URL, NavPathStack, LocalStorage, AppStorage: { setOrCreate() {} },
      getContext: component => component.testContext,
      $r: name => ({ name, id: 1 }), setInterval: () => 1, clearInterval() {},
      require(name) {
        if (name in mocks) return { __esModule: true, default: mocks[name] };
        assert.ok(name.startsWith('.'), 'only expected SDK imports are mocked: ' + name);
        return load(path.posix.join(path.posix.dirname(relative), name));
      } }, { filename });
    return exports;
  }
  const registryModule = load('launcher/WindowRegistry');
  const EntryAbility = load('entryability/EntryAbility').default;
  const Stage = load('abilitystage/AbilityStage').default;
  const profile = load('launcher/ConnectionProfile');
  const stage = new Stage();

  /** Launch through the AbilityStage key decision, creating an EntryAbility only for a new key. */
  function launch(want = { parameters: {} }) {
    const key = stage.onAcceptWant(want);
    const existing = windows.find(window => window.key === key);
    if (existing) return existing;
    const ability = new EntryAbility();
    ability.onCreate(want);
    const titles = [];
    let storage;
    let ready;
    ability.onWindowStageCreate({
      getMainWindowSync: () => ({ setPreferredOrientation: () => Promise.resolve(), setWindowBackgroundColor() {},
        setWindowLayoutFullScreen: () => Promise.resolve(), setWindowSystemBarProperties: () => Promise.resolve(),
        setWindowTitle(title) { titles.push(title); return Promise.resolve(); } }),
      loadContent(page, value, callback) { assert.equal(page, 'pages/Index'); storage = value; ready = callback; }
    });
    ready({ code: 0 });
    const channel = storage.get('dshWindowChannel');
    assert.equal(registryModule.windowRegistry().session(channel).key, key, 'the created instance carries its accepted key');
    const window = { key, ability, storage, titles, channel,
      home(onOpen = () => true) {
        const page = new (load('pages/ConnectionHome').ConnectionHome)();
        page.testContext = ability.context;
        page.channel = window.channel;
        page.onOpen = (address, remote, connection) => {
          const accepted = onOpen(address, remote, connection);
          if (accepted) registryModule.windowRegistry().hold(window.channel, connection.id);
          return accepted;
        };
        page.onTakeOpenRequest = () => registryModule.takeOpenRequest(storage);
        window.page = page;
        return page;
      } };
    windows.push(window);
    return window;
  }
  const windows = [];
  return { calls, diagnostics, started, disk, control, launch, windows, profile, registry: registryModule.windowRegistry(), registryModule };
}

function remoteConnection(h, id, port) {
  const value = new h.profile.ConnectionProfile();
  Object.assign(value, { id, name: 'Remote ' + id, mode: h.profile.ConnectionMode.Remote, port, token: 'token-' + id,
    serviceUrl: 'https://broker.example', account: 'tenant', accessToken: 'bearer', brokerId: 'broker',
    brokerName: 'Workstation', peerPassword: 'peer' });
  return value;
}

async function ready(page) {
  page.aboutToAppear();
  await page.pendingWork;
}

test('the first launch creates a window; a plain relaunch focuses the most recently active window', () => {
  const h = app();
  const first = h.launch();
  assert.equal(first.key, 'dsh-window-1');
  assert.equal(first.channel, 1);
  assert.equal(h.launch(), first, 'a launcher tap does not multiply windows');
  const second = h.launch({ parameters: { dshWindowKey: h.registry.createKey(), dshNewWindow: true } });
  assert.notEqual(second, first);
  assert.notEqual(second.channel, first.channel, 'every window owns a distinct native broker channel');
  assert.equal(h.launch(), second, 'the newest window is the most recently active one');
  first.ability.onForeground();
  assert.equal(h.launch(), first);
  assert.equal(h.launch({ parameters: { dshWindowKey: second.key } }), second, 'a live key always reaches its own window');
  assert.equal(h.launch({ parameters: { dshWindowKey: 'not-a-window-key', dshNewWindow: true } }).key, 'dsh-window-3',
    'malformed keys cannot name an instance');
});

test('closing a window releases only its own broker channel and frees its held connection', async () => {
  const h = app();
  const first = h.launch();
  const second = h.launch({ parameters: { dshNewWindow: true } });
  h.registry.hold(first.channel, 'shared');
  assert.equal(h.registry.holder('shared', second.channel), h.registry.session(first.channel));
  assert.deepEqual([...h.registry.heldElsewhere(second.channel)], ['shared']);
  first.ability.onWindowStageDestroy();
  first.ability.onDestroy();
  await tick();
  assert.deepEqual(h.calls.filter(call => call[0] === 'release'), [['release', first.channel]]);
  assert.equal(h.registry.holder('shared', second.channel), undefined);
  assert.equal(h.launch(), second, 'the remaining window receives later plain launches');
});

test('window titles name the held connection and return to the App name after it closes', () => {
  const h = app();
  const window = h.launch();
  window.ability.context.eventHub.emit('dshWindowTitle', 'Workstation');
  window.ability.context.eventHub.emit('dshWindowTitle', '');
  assert.deepEqual(window.titles, ['Workstation - Deepseek Harness', 'Deepseek Harness']);
});

test('two windows hold two remote connections at once on their own channels', async () => {
  const h = app();
  const first = h.launch();
  const second = h.launch({ parameters: { dshNewWindow: true } });
  const left = first.home();
  const right = second.home();
  await ready(left);
  await ready(right);
  const a = remoteConnection(h, 'a', 3080);
  const b = remoteConnection(h, 'b', 3081);
  await left.store.update(() => [a, b]);
  const opened = [];
  left.onOpen = (address, remote, connection) => { opened.push([first.channel, address]); h.registry.hold(first.channel, connection.id); return true; };
  right.onOpen = (address, remote, connection) => { opened.push([second.channel, address]); h.registry.hold(second.channel, connection.id); return true; };
  await Promise.all([left.openConnection(a), right.openConnection(b)]);
  assert.deepEqual(opened.map(([channel]) => channel).sort(), [first.channel, second.channel].sort());
  assert.notEqual(opened[0][1].split('/?')[0], opened[1][1].split('/?')[0], 'each window gets its own loopback origin');
  for (const [name, channel] of h.calls.filter(call => call[0] !== 'release')) {
    assert.ok(channel === first.channel || channel === second.channel, name + ' carries a window channel');
  }
  assert.deepEqual(h.calls.filter(call => call[0] === 'connect').map(call => [call[1], call[2]]).sort(),
    [[first.channel, 3080], [second.channel, 3081]].sort());
  assert.equal(h.calls.some(call => call[0] === 'close'), false, 'opening in one window never closes the other');
  assert.deepEqual([...h.registry.heldElsewhere(first.channel)], ['b']);
  assert.deepEqual([...h.registry.heldElsewhere(second.channel)], ['a']);
});

test('opening a connection held by another window switches to that window without a second mapping', async () => {
  const h = app();
  const first = h.launch();
  const second = h.launch({ parameters: { dshNewWindow: true } });
  const right = second.home();
  await ready(right);
  const a = remoteConnection(h, 'a', 3080);
  await right.store.update(() => [a]);
  h.registry.hold(first.channel, 'a');
  await right.openConnection(a);
  assert.equal(h.calls.some(call => call[0] === 'connect' || call[0] === 'probe'), false);
  assert.deepEqual(h.started, [{ bundleName: 'org.oheco.deepseekharness', abilityName: 'EntryAbility',
    parameters: { dshWindowKey: first.key } }]);
  assert.equal(right.message.name, 'app.string.connection_switched_window');
  assert.deepEqual(h.diagnostics.filter(([event]) => event === 'home.switch_window'),
    [['home.switch_window', `channel=${second.channel} targetChannel=${first.channel}`]]);
  assert.ok(h.diagnostics.some(([event, fields]) => event === 'ability.created' && fields === `channel=${second.channel}`));
  assert.equal(h.launch(h.started[0]), first, 'the focus request reaches the holding window');
  h.control.startFailure = new Error('window service unavailable');
  await right.openConnection(a);
  assert.equal(right.message.name, 'app.string.window_action_failed');
  assert.equal(right.messageError, true);
});

test('a window that is still opening a connection makes other windows switch instead of mapping it again', async () => {
  const h = app();
  const first = h.launch();
  const second = h.launch({ parameters: { dshNewWindow: true } });
  const left = first.home();
  const right = second.home();
  await ready(left);
  await ready(right);
  const a = remoteConnection(h, 'a', 3080);
  await left.store.update(() => [a]);
  const pending = left.openConnection(a);
  await right.openConnection(a);
  await pending;
  assert.equal(h.calls.filter(call => call[0] === 'connect').length, 1);
  assert.equal(h.started.length, 1);
  assert.equal(h.registry.session(first.channel).pendingId, '', 'a finished open clears its claim');
});

test('Open in new window creates a window that opens the saved connection after loading the list', async () => {
  const h = app();
  const first = h.launch();
  const left = first.home();
  await ready(left);
  const a = remoteConnection(h, 'a', 3080);
  await left.store.update(() => [a]);
  await left.openNewWindow(a);
  assert.equal(h.started.length, 1);
  const want = h.started[0];
  assert.equal(want.parameters.dshNewWindow, true);
  assert.equal(want.parameters.dshOpenConnection, 'a');
  assert.match(want.parameters.dshWindowKey, /^dsh-window-\d+$/);
  const created = h.launch(want);
  assert.notEqual(created, first);
  assert.equal(created.key, want.parameters.dshWindowKey);
  const opened = [];
  const page = created.home((address, remote, connection) => { opened.push(connection.id); return true; });
  await ready(page);
  assert.deepEqual(opened, ['a']);
  assert.deepEqual(h.calls.filter(call => call[0] === 'connect').map(call => call[1]), [created.channel]);
  assert.equal(created.storage.get('dshOpenConnection'), '', 'the request opens once');
  await left.openNewWindow(a);
  assert.deepEqual(h.started[1].parameters, { dshWindowKey: created.key }, 'a held connection switches instead');
});

test('saved-list changes in one window refresh the other and concurrent edits keep both entries', async () => {
  const h = app();
  const first = h.launch();
  const second = h.launch({ parameters: { dshNewWindow: true } });
  const left = first.home();
  const right = second.home();
  await ready(left);
  await ready(right);
  for (const [page, name] of [[left, 'Left'], [right, 'Right']]) {
    page.addConnection();
    page.chooseMode(h.profile.ConnectionMode.Local);
    page.name = name;
    page.token = 'token';
  }
  await Promise.all([left.saveConnection(), right.saveConnection()]);
  await settle();
  const committed = JSON.parse(h.disk.get('connections_v1')).connections.map(item => item.name).sort();
  assert.deepEqual(committed, ['Left', 'Right']);
  assert.deepEqual([...left.connections.map(item => item.name)].sort(), ['Left', 'Right']);
  assert.deepEqual([...right.connections.map(item => item.name)].sort(), ['Left', 'Right']);
  const held = right.connections.find(item => item.name === 'Left');
  h.registry.hold(first.channel, held.id);
  right.editConnection(held);
  right.name = 'Renamed elsewhere';
  await right.saveConnection();
  assert.equal(right.message.name, 'app.string.connection_open_elsewhere');
  await right.deleteConnection();
  assert.equal(right.message.name, 'app.string.connection_open_elsewhere');
  assert.equal(JSON.parse(h.disk.get('connections_v1')).connections.length, 2, 'a connection open elsewhere is not edited');
  left.aboutToDisappear();
  right.addConnection();
  right.chooseMode(h.profile.ConnectionMode.Local);
  right.name = 'Third';
  right.token = 'token';
  await right.saveConnection();
  await settle();
  assert.equal(left.connections.length, 2, 'a detached page no longer observes the list');
});
