/** Transport and actual Index lifecycle regressions; mocks do not replace device acceptance. */
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
const ORIGIN = 'http://127.0.0.1:43219';
const ADDRESS = ORIGIN + '/?token=owned-token';
const ROUTE = ORIGIN + '/sessions/owned-route?view=messages#latest';
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function behaviorPrefix(source, name) {
  const offset = source.indexOf('\n  @Builder');
  assert.notEqual(offset, -1, 'page must expose its behavior before its builders');
  return (source.slice(0, offset) + '\n}\n').replace('struct ' + name, 'class ' + name)
    .replace(/^@(Entry|Component)\s*$/gm, '').replace(/@StorageProp\([^\n]+\)\s*/g, '').replace(/@State\s*/g, '');
}

function indexBehavior(source, filename) {
  const file = ts.createSourceFile(filename, behaviorPrefix(source, 'Index'), ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, 'all prebuilder Index behavior must parse without recovery');
  const page = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'Index');
  assert(page);
  return ts.createPrinter().printNode(ts.EmitHint.Unspecified,
    ts.factory.updateClassDeclaration(page, [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
      page.name, page.typeParameters, page.heritageClauses, page.members), file);
}

function renderBindings(source, filename, page, generation) {
  const file = ts.createSourceFile(filename, source.replace('struct Index', 'class Index'), ts.ScriptTarget.Latest, true);
  const callbacks = new Map();
  let homeOpen;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) && ['onPageEnd', 'onRenderExited'].includes(expression.name.text)) {
        callbacks.set(expression.name.text, node.arguments[0]);
      }
      if (expression.getText(file) === 'ConnectionHome' && ts.isObjectLiteralExpression(node.arguments[0])) {
        const property = node.arguments[0].properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(file) === 'onOpen');
        if (property) homeOpen = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(callbacks.size, 2);
  assert(homeOpen, 'Index must receive the actual connection profile in its Home handoff');
  const sourceText = 'export function bind(generation) { return { pageEnd: ' + callbacks.get('onPageEnd').getText(file) +
    ', exited: ' + callbacks.get('onRenderExited').getText(file) + ', homeOpen: ' + homeOpen.getText(file) + ' }; }';
  const exports = {};
  const code = ts.transpileModule(sourceText, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  } }).outputText;
  vm.runInNewContext(code, { exports, loopbackOrigin: address => page.testLoopbackOrigin(address) });
  return exports.bind.call(page, generation);
}

function harness({ callbackThrows = false } = {}) {
  const calls = [];
  const changes = [];
  const listeners = new Map();
  const registrations = [];
  const publications = [];
  const timers = new Map();
  const controllers = [];
  const toasts = [];
  const plans = { status: [], reconnect: [], connect: [], close: [], probe: [] };
  const control = { runScriptRejects: false, runScriptThrows: false };
  const mapping = (state = 'connected') => ({ state, localUrl: ORIGIN + '/', localPort: 43219,
    brokerId: 'owned-broker', remotePort: 3080, error: '', errorCode: '' });
  function reply(name, args, fallback) {
    calls.push({ name, args });
    const value = plans[name].length ? plans[name].shift() : fallback();
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(args) : value;
  }
  const native = {
    async brokerStatus() { return await reply('status', undefined, mapping); },
    async brokerReconnect() { return await reply('reconnect', undefined, () => mapping('reconnecting')); },
    async brokerConnect(options) { return await reply('connect', options, mapping); },
    async brokerClose() { return await reply('close', undefined, () => undefined); },
    async dshProbe(options) { return await reply('probe', options, () => ({ state: 'ok', httpStatus: 200 })); }
  };
  const eventHub = {
    on(name, listener) {
      registrations.push(['on', name, listener]);
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    off(name, listener) {
      registrations.push(['off', name, listener]);
      listeners.get(name)?.delete(listener);
    },
    emit(name, ...args) {
      publications.push({ name, args });
      for (const listener of [...(listeners.get(name) ?? [])]) listener.call(eventHub, ...args);
    }
  };
  const context = { eventHub, tempDir: '/owned/temp', filesDir: '/owned/files' };
  class WebviewController {
    scripts = [];
    events = [];
    document = { identity: 'owned-dom', selection: 'keep selection' };
    history = [ADDRESS, ROUTE];
    constructor() { controllers.push(this); }
    runJavaScript(script) {
      this.scripts.push(script);
      if (control.runScriptThrows) throw new Error('renderer detached');
      if (control.runScriptRejects) return Promise.reject(new Error('renderer not ready'));
      if (script.includes('new Event("online")')) {
        vm.runInNewContext(script, { window: { dispatchEvent: event => this.events.push(event.type) },
          Event: class { constructor(type) { this.type = type; } } });
      }
      return Promise.resolve('');
    }
    accessBackward() { return false; }
    clearMatches() {}
  }
  class NavPathStack {
    paths = [];
    getAllPathName() { return this.paths.map(item => item.name); }
    getIndexByName(name) { return this.paths.flatMap((item, index) => item.name === name ? [index] : []); }
    pushPath(item) { this.paths.push(item); }
    pop() { return this.paths.pop(); }
    popToIndex(index) { this.paths.splice(index + 1); }
    clear() { this.paths = []; }
    size() { return this.paths.length; }
  }
  const cache = new Map();
  let nextTimer = 0;
  const mocks = {
    'libdsh_launcher.so': native,
    '@ohos.url': { URL },
    '@ohos.util': { generateRandomUUID: () => 'owned-profile' },
    '@ohos.data.preferences': { getPreferences: async () => ({ get: async (_key, fallback) => fallback }) }
  };
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const filename = path.join(ets, relative + '.ets');
    let source = fs.readFileSync(filename, 'utf8');
    if (relative === 'pages/ConnectionHome') source = behaviorPrefix(source, 'ConnectionHome');
    if (relative === 'pages/Index') source = indexBehavior(source, filename);
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
    }, reportDiagnostics: true });
    assert.equal(code.diagnostics?.length ?? 0, 0);
    const exports = {};
    cache.set(relative, exports);
    const index = relative === 'pages/Index';
    const scope = { exports, URL, NavPathStack, native, getContext: () => context,
      $r: name => ({ name, id: 1 }), webview: { WebviewController },
      setInterval(callback) { const id = ++nextTimer; timers.set(id, { kind: 'interval', callback }); return id; },
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, { kind: 'timeout', callback }); return id; },
      clearInterval(id) { timers.delete(id); }, clearTimeout(id) { timers.delete(id); },
      require(name) {
        if (name in mocks) return { __esModule: true, default: mocks[name] };
        assert.ok(name.startsWith('.'), 'only expected SDK dependencies are mocked');
        return load(path.posix.join(path.posix.dirname(relative), name));
      }
    };
    if (index) Object.assign(scope, load('launcher/AppActivity'), load('launcher/WebConnection'),
      load('launcher/OverlayAppearance'), load('launcher/RunLogUrl'), {
        WEB_VIEW_ACTIVE_EVENT: 'dshWebViewActive',
        ConfigurationConstant: { ColorMode: { COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1, COLOR_MODE_NOT_SET: -1 } },
        ConnectionHomeController: load('pages/ConnectionHome').ConnectionHomeController
      });
    vm.runInNewContext(code.outputText, scope, { filename });
    return exports;
  }
  const profileModule = load('launcher/ConnectionProfile');
  const connectionModule = load('launcher/WebConnection');
  const activity = load('launcher/AppActivity');
  function profile(remote = true) {
    const value = new profileModule.ConnectionProfile();
    Object.assign(value, { id: 'owned-profile', name: 'Owned connection', token: 'fresh token+&中文', port: remote ? 3080 : 43219 });
    if (remote) Object.assign(value, { mode: profileModule.ConnectionMode.Remote,
      serviceUrl: 'https://owned.invalid', accessToken: 'owned-access', account: 'owned-account',
      brokerId: 'owned-broker', brokerName: 'Owned broker', peerPassword: 'owned-peer' });
    return value;
  }
  function helper(remote = true) {
    const value = new connectionModule.WebConnection((state, recovered) => {
      changes.push({ state, recovered });
      if (callbackThrows) throw new Error('detached UI callback');
    });
    const adopted = profile(remote);
    value.activate(adopted, ORIGIN);
    return { value, adopted };
  }
  function page(remote = true) {
    const index = new (load('pages/Index').Index)();
    index.getUIContext = () => ({ getHostContext: () => context,
      getPromptAction: () => ({ showToast: toast => toasts.push(toast) }),
      getFocusController: () => ({ requestFocus() {} }) });
    index.testLoopbackOrigin = load('launcher/RunLogUrl').loopbackOrigin;
    index.aboutToAppear();
    const adopted = profile(remote);
    assert.equal(index.openWeb(ADDRESS, remote, adopted), true);
    const filename = path.join(ets, 'pages/Index.ets');
    const source = fs.readFileSync(filename, 'utf8');
    return { index, adopted, bind: () => renderBindings(source, filename, index, index.webGeneration) };
  }
  return { calls, changes, plans, control, context, eventHub, listeners, registrations, publications, timers, controllers, toasts,
    states: connectionModule.WebConnectionState, activity, helper, page, profile, load,
    count: name => calls.filter(call => call.name === name).length };
}

function preserve(index) {
  return { url: index.webUrl, origin: index.webOrigin, generation: index.webGeneration,
    controller: index.controller, document: index.controller.document, history: index.controller.history,
    search: index.searchText, visible: index.searchVisible, count: index.searchCount, selection: index.searchIndex,
    palette: index.overlayPalette, route: index.currentWebAddress };
}
function unchanged(index, before) {
  assert.equal(index.webUrl, before.url);
  assert.equal(index.webOrigin, before.origin);
  assert.equal(index.webGeneration, before.generation);
  assert.equal(index.controller, before.controller);
  assert.equal(index.controller.document, before.document);
  assert.equal(index.controller.history, before.history);
  assert.equal(index.searchText, before.search);
  assert.equal(index.searchVisible, before.visible);
  assert.equal(index.searchCount, before.count);
  assert.equal(index.searchIndex, before.selection);
  assert.equal(index.overlayPalette, before.palette);
  assert.equal(index.currentWebAddress, before.route);
}
async function closePage(h, index) {
  await index.closeWeb();
  index.aboutToDisappear();
  await index.detachedWork;
  await tick();
  assert.equal(h.timers.size, 0, 'the test page releases its polling and overlay timers');
}

function sdkStatus(state, fields = {}) {
  return { state, localUrl: ORIGIN + '/', localPort: 43219, error: '', errorCode: '', ...fields };
}
function sdkOwnsRecovery(h) {
  assert.equal(h.count('connect'), 0, 'an adopted SDK handle must not be recreated by the App');
  assert.equal(h.count('close'), 0, 'outage recovery must not destroy the SDK handle');
}

test('automatic SDK recovery states retain the handle and never request manual reconnect', async () => {
  for (const state of ['connecting', 'reconnecting', 'retry_wait']) {
    const h = harness();
    const { value } = h.helper();
    h.plans.status.push(sdkStatus(state));
    await value.foregrounded();
    assert.equal(h.changes.at(-1).state, h.states.Recovering);
    assert.equal(h.count('reconnect'), 0);
    assert.equal(h.count('probe'), 0, 'HTTP is probed only once the SDK reports connected');
    sdkOwnsRecovery(h);
    await value.close();
  }
});

test('paused foreground requests SDK manual reconnect and accepts its recovering status', async () => {
  for (const acceptedState of ['paused', 'reconnecting']) {
    const h = harness();
    const { value, adopted } = h.helper();
    h.plans.status.push(sdkStatus('paused'));
    h.plans.reconnect.push(sdkStatus(acceptedState));
    await value.foregrounded();
    assert.deepEqual(h.calls.map(call => call.name), ['status', 'reconnect']);
    assert.equal(h.changes.at(-1).state, h.states.Recovering, acceptedState);
    assert.equal(h.count('probe'), 0, 'acceptance does not imply the endpoint has recovered');
    sdkOwnsRecovery(h);
    h.plans.status.push(sdkStatus('connected'));
    await value.check();
    assert.equal(h.changes.at(-1).state, h.states.Connected);
    assert.equal(h.changes.at(-1).recovered, true);
    assert.equal(h.calls.find(call => call.name === 'probe').args.origin, ORIGIN);
    assert.equal(h.calls.find(call => call.name === 'probe').args.token, adopted.token);
    await value.check();
    await value.check();
    assert.equal(h.count('probe'), 1, 'ordinary connected polling does not repeat endpoint recovery');
    assert.equal(h.changes.filter(change => change.state === h.states.Connected && change.recovered).length, 1);
    sdkOwnsRecovery(h);
    await value.close();
  }
});

test('failed, closed, idle, and failed-auth handles remain disconnected without App revival', async () => {
  for (const snapshot of [sdkStatus('failed'), sdkStatus('closed'), sdkStatus('idle'),
    sdkStatus('failed', { errorCode: 'DSH_BROKER_AUTH', error: 'owned authentication failure' })]) {
    const h = harness();
    const { value } = h.helper();
    h.plans.status.push(snapshot, snapshot, snapshot);
    await value.foregrounded();
    await value.check();
    await value.foregrounded();
    assert.equal(h.changes.at(-1).state, h.states.Disconnected);
    assert.equal(h.count('reconnect'), 0);
    assert.equal(h.count('probe'), 0);
    sdkOwnsRecovery(h);
    await value.close();
  }
});

test('status errors and rejected DSH probes do not recreate or close the SDK session', async () => {
  const h = harness();
  const { value } = h.helper();
  h.plans.status.push(new Error('status unavailable'));
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.Disconnected);
  h.plans.probe.push(new Error('endpoint temporarily unavailable'));
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.Disconnected);
  assert.equal(h.count('reconnect'), 0);
  sdkOwnsRecovery(h);
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.Connected);
  await value.close();
});

test('healthy foreground verification probes the retained endpoint without changing SDK ownership', async () => {
  const h = harness();
  const { value } = h.helper();
  await value.foregrounded();
  assert.deepEqual(h.calls.map(call => call.name), ['status', 'probe']);
  assert.equal(h.changes.at(-1).state, h.states.Connected);
  sdkOwnsRecovery(h);
  await value.close();
});

test('local failure retains its endpoint and later foreground succeeds without broker activity', async () => {
  const h = harness();
  const { value } = h.helper(false);
  h.plans.probe.push({ state: 'unreachable', httpStatus: 0 });
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.Disconnected);
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.Connected);
  assert.equal(h.count('status'), 0);
  assert.equal(h.count('reconnect'), 0);
  sdkOwnsRecovery(h);
  await value.close();
});

test('foreground events share the same pending manual request without resetting SDK recovery', async () => {
  const h = harness();
  const { value } = h.helper();
  const manual = deferred();
  h.plans.status.push(sdkStatus('paused'));
  h.plans.reconnect.push(manual.promise);
  const first = value.foregrounded();
  await tick();
  assert.equal(value.foregrounded(), first);
  assert.equal(value.foregrounded(), first);
  assert.equal(h.count('reconnect'), 1);
  sdkOwnsRecovery(h);
  manual.resolve(sdkStatus('retry_wait'));
  await first;
  assert.equal(h.changes.at(-1).state, h.states.Recovering);
  assert.equal(h.count('probe'), 0);
  await value.close();
});

test('background suppresses completion callbacks and the next foreground updates the retained handle', async () => {
  const h = harness();
  const { value } = h.helper();
  const probe = deferred();
  value.disconnected();
  h.plans.probe.push(probe.promise);
  const work = value.foregrounded();
  await tick();
  const count = h.changes.length;
  value.background();
  probe.resolve({ state: 'ok', httpStatus: 200 });
  await work;
  assert.equal(h.changes.length, count);
  const before = h.calls.length;
  await value.check();
  assert.equal(h.calls.length, before);
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.Connected);
  assert.equal(h.changes.at(-1).recovered, true, 'recovery completed while hidden still reaches the foreground page');
  const notices = h.changes.filter(change => change.state === h.states.Connected && change.recovered).length;
  await value.check();
  assert.equal(h.changes.filter(change => change.state === h.states.Connected && change.recovered).length, notices);
  sdkOwnsRecovery(h);
  await value.close();
  const closedCalls = h.calls.length;
  await value.foregrounded();
  await value.check();
  assert.equal(h.calls.length, closedCalls, 'a retired owner starts no further work');
});

test('explicit close cancels before joining a pending manual request even when native close rejects', async () => {
  for (const rejectClose of [false, true]) {
    const h = harness();
    const { value } = h.helper();
    const manual = deferred();
    h.plans.status.push(sdkStatus('paused'));
    h.plans.reconnect.push(manual.promise);
    const recovery = value.foregrounded();
    await tick();
    if (rejectClose) h.plans.close.push(new Error('SDK close failed'));
    const before = h.changes.length;
    let settled = false;
    const closing = value.close();
    closing.then(() => { settled = true; });
    assert.equal(value.close(), closing);
    await tick();
    assert.equal(h.count('close'), 1);
    assert.equal(settled, false, 'native cancellation precedes the join of pending work');
    manual.resolve(sdkStatus('connected', { localUrl: 'http://127.0.0.1:54321/', localPort: 54321 }));
    await Promise.all([recovery, closing]);
    assert.equal(h.changes.length, before);
    assert.equal(h.count('probe'), 0);
    assert.equal(h.count('close'), 1, 'retired results cannot issue a later close');
  }
});

test('late polling results cannot publish into a new generation after explicit exit', async () => {
  const h = harness();
  const { value } = h.helper();
  const status = deferred();
  h.plans.status.push(status.promise);
  const checking = value.check();
  await value.close();
  value.activate(h.profile(), ORIGIN);
  const count = h.changes.length;
  status.resolve(sdkStatus('failed'));
  await checking;
  assert.equal(h.changes.length, count);
  assert.equal(h.count('close'), 1);
  await value.close();
});

test('mismatched SDK origins are rejected without adopting or destroying the retained handle', async () => {
  const h = harness();
  const { value } = h.helper();
  h.plans.status.push(sdkStatus('connected', { localUrl: 'http://127.0.0.1:54321/', localPort: 54321 }));
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.Disconnected);
  assert.equal(h.count('probe'), 0);
  assert.equal(h.count('reconnect'), 0);
  sdkOwnsRecovery(h);
  await value.foregrounded();
  assert.equal(h.calls.find(call => call.name === 'probe').args.origin, ORIGIN);
  await value.close();
});

test('callback and manual request failures are contained without App restart attempts', async () => {
  const h = harness({ callbackThrows: true });
  const { value } = h.helper();
  h.plans.status.push(sdkStatus('paused'));
  h.plans.reconnect.push(Object.assign(new Error('SDK authentication failed'), { code: 'DSH_BROKER_AUTH' }));
  await assert.doesNotReject(value.foregrounded());
  assert.equal(h.changes.at(-1).state, h.states.Disconnected);
  h.plans.status.push(sdkStatus('failed', { errorCode: 'DSH_BROKER_AUTH' }));
  await assert.doesNotReject(value.foregrounded());
  assert.equal(h.count('reconnect'), 1);
  sdkOwnsRecovery(h);
  await assert.doesNotReject(value.close());
});

test('SDK automatic recovery preserves actual Index DOM, history, search, route, and profile', async () => {
  const h = harness();
  const { index, adopted, bind } = h.page();
  bind().pageEnd({ url: ROUTE });
  await tick();
  index.searchVisible = true;
  index.searchText = 'keep this query';
  index.searchCount = 7;
  index.searchIndex = 3;
  index.overlayPalette = new (h.load('launcher/OverlayAppearance').OverlayPalette)();
  const before = preserve(index);
  for (const state of ['reconnecting', 'retry_wait']) {
    h.plans.status.push(sdkStatus(state));
    await index.checkRemote();
    assert.equal(index.connectionState, h.states.Recovering);
    unchanged(index, before);
    assert.equal(h.count('reconnect'), 0);
    sdkOwnsRecovery(h);
  }
  h.plans.status.push(sdkStatus('connected'));
  await index.checkRemote();
  await tick();
  assert.equal(index.connectionState, h.states.Connected);
  assert.equal(index.activeConnection, adopted);
  unchanged(index, before);
  assert.deepEqual(index.controller.events, ['online']);
  await index.checkRemote();
  await index.checkRemote();
  assert.deepEqual(index.controller.events, ['online'], 'healthy polling cannot repeatedly notify or rebuild the live page');
  assert.equal(h.controllers.length, 2);
  sdkOwnsRecovery(h);
  await closePage(h, index);
});

test('failed SDK handles and local probe failures keep actual Index pages until explicit exit', async () => {
  for (const remote of [false, true]) {
    const h = harness();
    const { index, adopted } = h.page(remote);
    const before = preserve(index);
    if (remote) h.plans.status.push(sdkStatus('failed', { errorCode: 'DSH_BROKER_AUTH' }));
    else h.plans.probe.push({ state: 'unreachable', httpStatus: 0 });
    await index.resumeWeb();
    assert.equal(index.connectionState, h.states.Disconnected);
    assert.equal(index.activeConnection, adopted);
    unchanged(index, before);
    assert.equal(h.count('reconnect'), 0);
    sdkOwnsRecovery(h);
    await closePage(h, index);
  }
});

test('actual Back clears page and orientation immediately while cancellation retains the cleanup barrier', async () => {
  for (const rejectClose of [false, true]) {
    const h = harness();
    const { index } = h.page();
    const manual = deferred();
    h.plans.status.push(sdkStatus('paused'));
    h.plans.reconnect.push(manual.promise);
    const recovery = index.resumeWeb();
    await tick();
    const generation = index.webGeneration;
    const oldController = index.controller;
    if (rejectClose) h.plans.close.push(new Error('SDK close failed'));
    assert.equal(index.onBackPress(), true);
    const closing = index.closeWeb();
    assert.equal(index.webUrl, '');
    assert.equal(index.activeConnection, undefined);
    assert.equal(index.webGeneration, generation + 1);
    assert.equal(h.publications.filter(item => item.name === 'dshWebViewActive').at(-1).args[0], false);
    await tick();
    assert.equal(h.count('close'), 1);
    assert.equal(index.closingWeb, true);
    assert.equal(index.openWeb(ADDRESS, true, h.profile()), false, 'new ownership waits for native quiescence');
    manual.resolve(sdkStatus('connected'));
    await Promise.all([recovery, closing]);
    assert.equal(index.closingWeb, false);
    assert.equal(oldController.events.length, 0, 'retired completion cannot notify the old DOM');
    assert.equal(h.count('close'), 1);
    assert.equal(index.openWeb(ADDRESS, true, h.profile()), true);
    assert.equal(h.count('close'), 1);
    await closePage(h, index);
  }
});

test('component disappearance unregisters exact listeners and reattachment resumes the same SDK handle', async () => {
  const h = harness();
  const { index } = h.page();
  const observer = () => {};
  h.eventHub.on(h.activity.APP_FOREGROUND_EVENT, observer);
  const before = preserve(index);
  const helper = index.webConnection;
  const manual = deferred();
  h.plans.status.push(sdkStatus('paused'));
  h.plans.reconnect.push(manual.promise);
  const recovery = index.resumeWeb();
  await tick();
  index.aboutToDisappear();
  await tick();
  assert.equal(h.count('close'), 0);
  for (const [event, callback] of [[h.activity.APP_FOREGROUND_EVENT, index.appForeground],
    [h.activity.APP_BACKGROUND_EVENT, index.appBackground]]) {
    assert.equal(h.listeners.get(event)?.has(callback), false);
    assert.ok(h.registrations.some(([operation, name, handler]) => operation === 'off' && name === event && handler === callback));
  }
  assert.equal(h.listeners.get(h.activity.APP_FOREGROUND_EVENT).has(observer), true);
  manual.resolve(sdkStatus('reconnecting'));
  await recovery;
  unchanged(index, before);
  index.aboutToAppear();
  await tick();
  await index.resumeWeb();
  assert.equal(index.webConnection, helper);
  assert.equal(h.count('reconnect'), 1);
  assert.equal(index.connectionState, h.states.Connected);
  unchanged(index, before);
  sdkOwnsRecovery(h);
  await closePage(h, index);
});

test('renderer loss retains the current route and recreation waits for SDK endpoint recovery', async () => {
  const h = harness();
  const { index, bind } = h.page();
  const oldHandlers = bind();
  oldHandlers.pageEnd({ url: ROUTE });
  await tick();
  const before = preserve(index);
  const creations = h.controllers.length;
  oldHandlers.exited();
  assert.equal(index.rendererAlive, false);
  assert.equal(index.webUrl, before.url);
  assert.equal(index.currentWebAddress, ROUTE);
  h.plans.status.push(sdkStatus('reconnecting'));
  await index.resumeWeb();
  assert.equal(index.controller, before.controller);
  assert.equal(h.controllers.length, creations);
  h.plans.status.push(sdkStatus('connected'));
  await index.checkRemote();
  await tick();
  assert.notEqual(index.controller, before.controller);
  assert.equal(h.controllers.length, creations + 1);
  assert.equal(index.webUrl, ROUTE);
  assert.equal(index.webOrigin, ORIGIN);
  assert.equal(index.webGeneration, before.generation + 1);
  assert.equal(index.rendererAlive, true);
  oldHandlers.pageEnd({ url: ORIGIN + '/stale-route' });
  oldHandlers.exited();
  assert.equal(index.currentWebAddress, ROUTE);
  assert.equal(index.rendererAlive, true);
  sdkOwnsRecovery(h);
  await closePage(h, index);
});

test('foreground event coalescing and notification failures preserve the live renderer', async () => {
  for (const failure of ['runScriptRejects', 'runScriptThrows']) {
    const h = harness();
    const { index } = h.page();
    const before = preserve(index);
    h.eventHub.emit(h.activity.APP_BACKGROUND_EVENT);
    assert.equal(h.timers.size, 0);
    h.control[failure] = true;
    const manual = deferred();
    h.plans.status.push(sdkStatus('paused'));
    h.plans.reconnect.push(manual.promise);
    h.eventHub.emit(h.activity.APP_FOREGROUND_EVENT);
    h.eventHub.emit(h.activity.APP_FOREGROUND_EVENT);
    await tick();
    assert.equal(h.count('reconnect'), 1);
    manual.resolve(sdkStatus('connected'));
    await assert.doesNotReject(index.resumeWeb());
    await tick();
    assert.equal(index.connectionState, h.states.Connected);
    unchanged(index, before);
    sdkOwnsRecovery(h);
    await closePage(h, index);
  }
});

test('Index Home handoff still forwards the exact profile and its boolean ownership result', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  await index.closeWeb();
  const flow = new (h.load('pages/ConnectionHome').ConnectionHome)();
  const profile = h.profile(false);
  const callback = bind().homeOpen;
  let accepted;
  flow.onOpen = (...args) => { accepted = callback(...args); return accepted; };
  flow.aboutToAppear();
  await flow.pendingWork;
  await flow.openConnection(profile);
  assert.equal(accepted, true);
  assert.equal(index.activeConnection, profile);
  assert.equal(index.remote, false);
  assert.equal(flow.transferred, true);
  assert.equal(index.webUrl, 'http://127.0.0.1:' + profile.port + '/?token=' + encodeURIComponent(profile.token));
  await closePage(h, index);
});
