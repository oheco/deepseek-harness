/** Runs source Index activity methods and ConnectionHome handoffs with an actual ability owner. */
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
const tick = () => new Promise(resolve => setImmediate(resolve));
const VALID = 'http://127.0.0.1:43219/?token=owned-test-token';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function plainPageSource(source, name) {
  const startOfBuilders = source.indexOf('\n  @Builder');
  assert.notEqual(startOfBuilders, -1, 'page builders delimit the source behavior projection');
  return (source.slice(0, startOfBuilders) + '\n}\n').replace('struct ' + name, 'class ' + name)
    .replace(/^@(Entry|Component)\s*$/gm, '').replace(/@StorageProp\([^\n]+\)\s*/g, '').replace(/@State\s*/g, '');
}

function indexProjection(source, filename) {
  const file = ts.createSourceFile(filename, plainPageSource(source, 'Index'), ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, 'Index source behavior must parse without recovery');
  const page = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'Index');
  assert(page);
  const wanted = new Set(['updateWebOrientation', 'aboutToAppear', 'aboutToDisappear',
    'openWeb', 'closeWeb', 'checkRemote', 'dismissMenu']);
  const members = page.members.filter(member => ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member));
  for (const name of wanted) {
    assert.ok(members.some(member => ts.isMethodDeclaration(member) && member.name.getText(file) === name),
      'Index activity method remains present: ' + name);
  }
  const projected = ts.factory.updateClassDeclaration(page, [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    page.name, page.typeParameters, page.heritageClauses, members);
  return ts.createPrinter().printNode(ts.EmitHint.Unspecified, projected, file);
}

function harness() {
  const events = [];
  const modes = [];
  const calls = [];
  const timers = new Map();
  const listeners = new Map();
  const control = { close: undefined, probe: undefined, probeState: 'ok', failController: false, detached: false };
  let page;
  let nextTimer = 0;
  const eventHub = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    off(name, listener) { listeners.get(name)?.delete(listener); },
    emit(name, active) {
      events.push({ name, active, webUrl: page?.webUrl, attached: page?.attached });
      for (const listener of listeners.get(name) ?? []) listener.call(eventHub, active);
    }
  };
  const context = { eventHub, config: { colorMode: 1 }, filesDir: '/owned/files', tempDir: '/owned/temp',
    getApplicationContext: () => ({ setColorMode() {} }) };
  class UIAbility { constructor() { this.context = context; } }
  class WebviewController {
    constructor() { if (control.failController) throw new Error('renderer unavailable'); }
    runJavaScript(script) {
      assert.equal(script, 'window.dispatchEvent(new Event("online"));');
      return Promise.resolve('');
    }
  }
  class NavPathStack {
    routes = [];
    pushPath(info) { this.routes.push(info); }
    pop() { return this.routes.pop(); }
    clear() { this.routes = []; }
    getAllPathName() { return this.routes.map(info => info.name); }
    getIndexByName(name) { return this.routes.flatMap((info, index) => info.name === name ? [index] : []); }
    popToIndex(index) { this.routes.splice(index + 1); }
    size() { return this.routes.length; }
  }
  const native = {
    async brokerClose() { calls.push('close'); if (control.close) await control.close.promise; },
    async brokerReconnect() { calls.push('reconnect'); return { state: 'reconnecting', localUrl: 'http://127.0.0.1:43219/',
      localPort: 43219, error: '', errorCode: '' }; },
    async brokerConnect() { calls.push('connect'); return { state: 'connected', localUrl: 'http://127.0.0.1:43219/',
      localPort: 43219, brokerId: 'owned-broker', remotePort: 3080, error: '', errorCode: '' }; },
    async dshProbe() { calls.push('probe'); return control.probe ? await control.probe.promise :
      { state: control.probeState, httpStatus: control.probeState === 'ok' ? 200 : 401 }; },
    async brokerStatus() { return { state: 'connected', localUrl: 'http://127.0.0.1:43219/',
      localPort: 43219, brokerId: 'owned-broker', remotePort: 3080, error: '', errorCode: '' }; }
  };
  const cache = new Map();
  const mocks = {
    '@ohos.app.ability.UIAbility': UIAbility,
    '@ohos.app.ability.ConfigurationConstant': { ColorMode: { COLOR_MODE_NOT_SET: -1, COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1 } },
    '@ohos.window': { Orientation: { PORTRAIT: 1, AUTO_ROTATION: 5, AUTO_ROTATION_RESTRICTED: 8 } },
    '@ohos.resourceManager': { ColorMode: { DARK: 0, LIGHT: 1 } },
    '@ohos.url': { URL },
    '@ohos.util': { generateRandomUUID: () => 'owned-profile' },
    '@ohos.data.preferences': { getPreferences: async () => ({ get: async (_key, fallback) => fallback }) },
    'libdsh_launcher.so': native
  };
  function load(relative) {
    const filename = path.join(ets, relative + '.ets');
    if (cache.has(filename)) return cache.get(filename);
    let source = fs.readFileSync(filename, 'utf8');
    if (relative === 'pages/ConnectionHome') source = plainPageSource(source, 'ConnectionHome');
    if (relative === 'pages/Index') source = indexProjection(source, filename);
    const emitted = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
    }, reportDiagnostics: true });
    assert.equal(emitted.diagnostics?.length ?? 0, 0, 'source behavior projection emits without parser recovery');
    const exports = {};
    cache.set(filename, exports);
    const scope = { exports, URL, NavPathStack, AppStorage: { setOrCreate() {} }, getContext: () => context,
      $r: name => ({ name, id: 1 }), webview: { WebviewController }, native,
      loopbackOrigin: relative === 'pages/Index' ? load('launcher/RunLogUrl').loopbackOrigin : undefined,
      WEB_VIEW_ACTIVE_EVENT: relative === 'pages/Index' ? load('launcher/WebOrientation').WEB_VIEW_ACTIVE_EVENT : undefined,
      APP_FOREGROUND_EVENT: relative === 'pages/Index' ? load('launcher/AppActivity').APP_FOREGROUND_EVENT : undefined,
      APP_BACKGROUND_EVENT: relative === 'pages/Index' ? load('launcher/AppActivity').APP_BACKGROUND_EVENT : undefined,
      ConnectionHomeController: relative === 'pages/Index' ? load('pages/ConnectionHome').ConnectionHomeController : undefined,
      WebConnection: relative === 'pages/Index' ? load('launcher/WebConnection').WebConnection : undefined,
      WebConnectionState: relative === 'pages/Index' ? load('launcher/WebConnection').WebConnectionState : undefined,
      ConnectionProfile: relative === 'pages/Index' ? load('launcher/ConnectionProfile').ConnectionProfile : undefined,
      setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearInterval(id) { timers.delete(id); }, clearTimeout() {},
      require(name) {
        if (name in mocks) return { __esModule: true, default: mocks[name] };
        assert.ok(name.startsWith('.'), 'only expected SDK imports are mocked');
        return load(path.posix.join(path.posix.dirname(relative), name));
      }
    };
    vm.runInNewContext(emitted.outputText, scope, { filename });
    return exports;
  }
  const owner = new (load('entryability/EntryAbility').default)();
  owner.onCreate();
  const mainWindow = { setPreferredOrientation(mode) { modes.push(mode); return Promise.resolve(); },
    setWindowBackgroundColor() {}, setWindowLayoutFullScreen() { return Promise.resolve(); },
    setWindowSystemBarProperties() { return Promise.resolve(); } };
  owner.onWindowStageCreate({ getMainWindowSync: () => mainWindow, loadContent(_page, ready) { ready({ code: 0 }); } });
  page = new (load('pages/Index').Index)();
  page.getUIContext = () => ({ getHostContext() {
    if (control.detached) throw new Error('ability detached');
    return context;
  } });
  page.aboutToAppear();
  const event = load('launcher/WebOrientation').WEB_VIEW_ACTIVE_EVENT;
  const profile = load('launcher/ConnectionProfile');
  async function home() {
    const flow = new (load('pages/ConnectionHome').ConnectionHome)();
    flow.onOpen = (address, remote, connection) => page.openWeb(address, remote, connection);
    flow.aboutToAppear();
    await flow.pendingWork;
    return flow;
  }
  function localProfile() {
    const connection = new profile.ConnectionProfile();
    Object.assign(connection, { id: 'owned-local-profile', name: 'Owned local fixture',
      mode: profile.ConnectionMode.Local, port: 43219, token: 'owned-test-token' });
    return connection;
  }
  function remoteProfile() {
    const connection = new profile.ConnectionProfile();
    Object.assign(connection, { id: 'owned-profile', name: 'Owned fixture', mode: profile.ConnectionMode.Remote,
      token: 'owned-test-token', serviceUrl: 'https://owned.invalid', account: 'owned-account',
      accessToken: 'owned-access-token', brokerId: 'owned-broker', brokerName: 'Owned fixture', peerPassword: 'owned-peer' });
    return connection;
  }
  return { page, owner, control, calls, modes, events, event, timers, home, localProfile, remoteProfile,
    async ready() { await tick(); },
    async finish() {
      control.close = undefined;
      await page.closeWeb();
      page.aboutToDisappear();
      await page.detachedWork;
      owner.onDestroy();
      assert.equal(timers.size, 0, 'owned remote polling stops when the page closes');
      assert.equal([...listeners.values()].reduce((count, active) => count + active.size, 0), 0,
        'page activity and ability orientation listeners are removed during teardown');
    } };
}

test('invalid targets and an occupied Index cannot emit true or replace the active WebView', async () => {
  const h = harness();
  await h.ready();
  assert.equal(h.page.openWeb(VALID, false, h.localProfile()), true);
  await tick();
  const before = { url: h.page.webUrl, origin: h.page.webOrigin, generation: h.page.webGeneration,
    controller: h.page.controller, events: h.events.length };
  for (const target of [VALID, '', 'https://owned.invalid/', 'http://localhost:43219/', 'http://127.0.0.1:0/',
    'http://127.0.0.1:43219@owned.invalid/']) {
    assert.equal(h.page.openWeb(target, true, h.remoteProfile()), false);
    assert.equal(h.page.webUrl, before.url);
    assert.equal(h.page.webOrigin, before.origin);
    assert.equal(h.page.webGeneration, before.generation);
    assert.equal(h.page.controller, before.controller);
    assert.equal(h.events.length, before.events);
  }
  await h.finish();
});

test('valid local and remote Index opens publish true only after the URL and polling state are ready', async () => {
  for (const remote of [false, true]) {
    const h = harness();
    await h.ready();
    assert.equal(h.page.openWeb(VALID, remote, remote ? h.remoteProfile() : h.localProfile()), true);
    const publication = h.events.at(-1);
    assert.equal(publication.name, h.event);
    assert.equal(publication.active, true);
    assert.equal(publication.webUrl, VALID);
    assert.equal(h.timers.size, remote ? 1 : 0);
    await tick();
    assert.equal(h.modes.at(-1), 8, 'the actual ability receives Index activity and enables rotation that respects the system lock');
    await h.finish();
  }
});

test('a renderer creation failure cannot enable WebView rotation or change the target', async () => {
  const h = harness();
  await h.ready();
  h.control.failController = true;
  assert.throws(() => h.page.openWeb(VALID, true, h.remoteProfile()), /renderer unavailable/);
  await tick();
  assert.equal(h.page.webUrl, '');
  assert.equal(h.events.some(event => event.active), false);
  assert.deepEqual(h.modes, [1]);
  await h.finish();
});

test('remote close returns to portrait immediately while retaining ownership of pending cleanup', async () => {
  for (const reject of [false, true]) {
    const h = harness();
    await h.ready();
    h.page.openWeb(VALID, true, h.remoteProfile());
    await tick();
    h.control.close = deferred();
    const closing = h.page.closeWeb();
    await tick();
    assert.equal(h.page.webUrl, '');
    assert.equal(h.events.at(-1).active, false);
    assert.equal(h.modes.at(-1), 1);
    assert.equal(h.page.closingWeb, true);
    assert.equal(h.page.openWeb(VALID, true, h.remoteProfile()), false);
    assert.equal(h.timers.size, 0);
    if (reject) h.control.close.reject(new Error('mapping cleanup failed'));
    else h.control.close.resolve();
    await closing;
    await tick();
    assert.equal(h.events.at(-1).active, false);
    assert.equal(h.events.at(-1).webUrl, '');
    assert.equal(h.modes.at(-1), 1);
    await h.finish();
  }
});

test('page disappearance preserves the SDK handle and reattachment restores its WebView rotation', async () => {
  const h = harness();
  await h.ready();
  h.page.openWeb(VALID, true, h.remoteProfile());
  const adoptedHelper = h.page.webConnection;
  const adoptedController = h.page.controller;
  await tick();
  h.page.aboutToDisappear();
  await tick();
  assert.equal(h.events.at(-1).active, false);
  assert.equal(h.page.attached, false);
  assert.equal(h.page.webUrl, VALID);
  assert.equal(h.page.webConnection, adoptedHelper);
  assert.equal(h.page.controller, adoptedController);
  assert.equal(h.calls.includes('close'), false, 'component disappearance leaves the SDK handle active');
  assert.equal(h.timers.size, 0);
  assert.equal(h.modes.at(-1), 1);
  h.page.aboutToAppear();
  await tick();
  assert.equal(h.events.at(-1).active, true);
  assert.equal(h.page.attached, true);
  assert.equal(h.page.webConnection, adoptedHelper);
  assert.equal(h.page.controller, adoptedController);
  assert.equal(h.calls.includes('close'), false);
  assert.equal(h.calls.includes('connect'), false, 'reattachment resumes the adopted handle without recreating it');
  assert.equal(h.modes.at(-1), 8);
  await h.finish();
});

test('failed remote DSH probes never hand off to Index or publish automatic rotation', async () => {
  for (const outcome of ['unauthorized', 'not-dsh', 'throw']) {
    const h = harness();
    await h.ready();
    const flow = await h.home();
    h.control.probe = deferred();
    const opening = flow.openConnection(h.remoteProfile());
    await tick();
    assert.ok(h.calls.includes('probe'));
    assert.equal(h.page.webUrl, '');
    assert.equal(h.events.some(event => event.active), false);
    if (outcome === 'throw') h.control.probe.reject(new Error('probe transport failed'));
    else h.control.probe.resolve({ state: outcome, httpStatus: outcome === 'unauthorized' ? 401 : 200 });
    await opening;
    await tick();
    assert.equal(h.page.webUrl, '');
    assert.equal(h.events.some(event => event.active), false);
    assert.deepEqual(h.modes, [1]);
    assert.ok(h.calls.includes('close'), 'the failed mapping is released without enabling WebView rotation');
    await h.finish();
  }
});

test('a successful remote probe hands off to actual Index and activates the ability rotation policy', async () => {
  const h = harness();
  await h.ready();
  const flow = await h.home();
  h.control.probe = deferred();
  const opening = flow.openConnection(h.remoteProfile());
  await tick();
  assert.equal(h.events.some(event => event.active), false);
  h.control.probe.resolve({ state: 'ok', httpStatus: 200 });
  await opening;
  await tick();
  assert.equal(h.page.webUrl, VALID);
  assert.equal(h.events.at(-1).active, true);
  assert.equal(h.modes.at(-1), 8);
  await h.finish();
});

test('an unavailable host context does not interrupt page cleanup or emit into another ability', async () => {
  const h = harness();
  await h.ready();
  h.control.detached = true;
  const count = h.events.length;
  assert.doesNotThrow(() => h.page.aboutToDisappear());
  await tick();
  assert.equal(h.events.length, count);
  assert.equal(h.page.attached, false);
  await h.finish();
});
