/** Transport and actual Index lifecycle regressions; mocks do not replace device acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cryptoFramework, ListScroller, LocalStorage, windowStorage } from './harmony-mocks.mjs';

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
    .replace(/^@(Entry|Component)\s*$/gm, '').replace(/@StorageProp\([^\n]+\)\s*/g, '').replace(/@(State|Prop)\s*/g, '');
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
  let homePrepare;
  let homeDisconnect;
  let returnConnections;
  let disconnect;
  let retry;
  let webSource;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) &&
        ['onPageEnd', 'onPageBegin', 'onRenderExited', 'onControllerAttached', 'onHttpErrorReceive', 'onErrorReceive'].includes(expression.name.text)) {
        callbacks.set(expression.name.text, node.arguments[0]);
      }
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'onClick') {
        const callback = node.arguments[0].getText(file);
        if (callback.includes('this.hideWeb();')) returnConnections = node.arguments[0];
        if (callback.includes('this.disconnectConnection(this.retainedConnectionId)')) disconnect = node.arguments[0];
        if (callback.includes('this.retryConnection()')) retry = node.arguments[0];
      }
      if (expression.getText(file) === 'Web' && ts.isObjectLiteralExpression(node.arguments[0])) {
        const property = node.arguments[0].properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(file) === 'src');
        if (property) webSource = property.initializer;
      }
      if (expression.getText(file) === 'ConnectionHome' && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const property of node.arguments[0].properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = property.name.getText(file);
          if (name === 'onOpen') homeOpen = property.initializer;
          if (name === 'onPrepare') homePrepare = property.initializer;
          if (name === 'onDisconnect') homeDisconnect = property.initializer;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(callbacks.size, 6);
  assert(webSource, 'the actual Web constructor must declare its initial navigation');
  assert.ok(!source.includes('.onFirstScreenPaint('), 'a blank first paint cannot hide the loading cover');
  assert(homeOpen, 'Index must receive the actual connection profile in its Home handoff');
  assert(returnConnections, 'a failed page must expose a soft return to the connection flow');
  assert(homePrepare && homeDisconnect, 'the mounted Home must prepare and explicitly release retained connections');
  assert(disconnect && retry, 'retained errors expose disconnect and SDK recovery actions');
  const sourceText = 'export function bind(generation) { return { pageEnd: ' + callbacks.get('onPageEnd').getText(file) +
    ', exited: ' + callbacks.get('onRenderExited').getText(file) +
    ', initialSource: ' + webSource.getText(file) +
    ', attached: ' + callbacks.get('onControllerAttached').getText(file) +
    ', pageBegin: ' + callbacks.get('onPageBegin').getText(file) +
    ', httpError: ' + callbacks.get('onHttpErrorReceive').getText(file) +
    ', networkError: ' + callbacks.get('onErrorReceive').getText(file) +
    ', homeOpen: ' + homeOpen.getText(file) +
    ', homePrepare: ' + homePrepare.getText(file) +
    ', homeDisconnect: ' + homeDisconnect.getText(file) +
    ', disconnect: ' + disconnect.getText(file) +
    ', retry: ' + retry.getText(file) +
    ', returnConnections: ' + returnConnections.getText(file) + ' }; }';
  const exports = {};
  const code = ts.transpileModule(sourceText, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  } }).outputText;
  vm.runInNewContext(code, { exports, loopbackOrigin: address => page.testLoopbackOrigin(address), connectionDiagnostic() {},
    $r: (name, ...params) => ({ name, params }) });
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
  const cookieCalls = [];
  const lifecycle = [];
  const plans = { status: [], reconnect: [], connect: [], close: [], probe: [] };
  const control = { runScriptRejects: false, runScriptThrows: false, engineReady: false,
    badInitialization: false, cookieRead: undefined, cookieFailure: undefined, cookies: [],
    cookieWriteFailure: undefined, navigationFailure: undefined, historyFailure: '', backwardAvailable: undefined };
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
    history = ['about:blank', ADDRESS];
    historyIndex = 1;
    historyCalls = [];
    clearedMatches = 0;
    bound = false;
    loaded = [];
    currentAddress = 'about:blank';
    initialBlankPending = false;
    constructor() { controllers.push(this); }
    loadUrl(address) {
      assert.ok(this.bound && control.engineReady, 'authenticated navigation requires a successfully bound controller');
      if (control.navigationFailure) throw control.navigationFailure;
      lifecycle.push('navigate');
      this.loaded.push(address);
      this.currentAddress = address;
    }
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
    navigate(address) {
      this.history.splice(this.historyIndex + 1);
      this.history.push(address);
      this.historyIndex += 1;
      this.currentAddress = address;
    }
    historyOperation(name) {
      this.historyCalls.push(name);
      if (control.historyFailure === name) throw new Error('history API unavailable');
    }
    accessBackward() {
      this.historyOperation('access');
      return control.backwardAvailable ?? this.historyIndex > 0;
    }
    getBackForwardEntries() {
      this.historyOperation('entries');
      return { size: this.history.length, currentIndex: this.historyIndex, getItemAtIndex: position => {
        this.historyOperation('item');
        assert.ok(position >= 0 && position < this.history.length);
        return { historyUrl: this.history[position] };
      } };
    }
    backward() {
      this.historyOperation('backward');
      assert.ok(this.historyIndex > 0);
      this.currentAddress = this.history[--this.historyIndex];
    }
    clearMatches() { this.clearedMatches += 1; }
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
    '@ohos.web.webview': { WebviewController, WebCookieManager: {
      async fetchAllCookies(incognito) {
        assert.equal(incognito, false);
        cookieCalls.push(['read']);
        lifecycle.push('cookies');
        if (!control.engineReady) {
          control.badInitialization = true;
          throw new Error('cold CookieManager would initialize the engine on its worker');
        }
        if (control.cookieFailure) throw control.cookieFailure;
        return control.cookieRead ? await control.cookieRead() : control.cookies;
      },
      configCookieSync(...args) {
        assert.ok(control.engineReady);
        if (control.cookieWriteFailure) throw control.cookieWriteFailure;
        cookieCalls.push(['expire', ...args]);
        lifecycle.push('expire');
      }
    } },
    '@ohos.security.cryptoFramework': cryptoFramework,
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
    const scope = { exports, URL, NavPathStack, ListScroller, LocalStorage, native, getContext: () => context,
      $r: (name, ...params) => ({ name, id: 1, params }), webview: mocks['@ohos.web.webview'],
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
      load('launcher/OverlayAppearance'), load('launcher/RunLogUrl'), load('launcher/ConnectionCookies'),
      load('launcher/ConnectionDiagnostics'), load('launcher/WebConnectionDiagnostics'), load('launcher/WindowRegistry'), {
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
    const storage = windowStorage(7);
    index.getUIContext = () => ({ getHostContext: () => context, getSharedLocalStorage: () => storage,
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
  function blankBegin(controller, callbacks) {
    // The constructor's queued blank navigation replaces an earlier accepted loadUrl.
    controller.currentAddress = 'about:blank';
    callbacks.pageBegin({ url: 'about:blank' });
  }
  function blankEnd(controller, callbacks) {
    if (controller.initialBlankPending) {
      controller.currentAddress = 'about:blank';
      controller.initialBlankPending = false;
    }
    callbacks.pageEnd({ url: 'about:blank' });
  }
  function attach(index, callbacks, { completeBlank = true, beginBlank = true } = {}) {
    assert.equal(callbacks.initialSource, 'about:blank');
    control.engineReady = true;
    const controller = index.controller;
    controller.bound = true;
    controller.initialBlankPending = true;
    lifecycle.push('attached');
    const work = callbacks.attached();
    if (beginBlank) blankBegin(controller, callbacks);
    if (completeBlank) blankEnd(controller, callbacks);
    return work;
  }
  return { calls, changes, plans, control, context, eventHub, listeners, registrations, publications, timers, controllers, toasts,
    cookieCalls, lifecycle, attach, blankBegin, blankEnd, states: connectionModule.WebConnectionState, activity, helper, page, profile, load,
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

test('activation after a backgrounded old page resumes status polling for the new owner', async () => {
  const h = harness();
  const { value } = h.helper();
  value.background();
  await value.close();
  value.activate(h.profile(), ORIGIN);
  h.plans.status.push(sdkStatus('retry_wait'));
  await value.check();
  assert.equal(h.count('status'), 1);
  assert.equal(h.changes.at(-1).state, h.states.Recovering);
  await value.close();
});

test('polling a paused SDK stops recovery indication until a manual wake is requested', async () => {
  const h = harness();
  const { value } = h.helper();
  h.plans.status.push(sdkStatus('reconnecting'), sdkStatus('paused'), sdkStatus('paused'));
  await value.check();
  assert.equal(h.changes.at(-1).state, h.states.Recovering);
  await value.check();
  assert.equal(h.changes.at(-1).state, h.states.Disconnected);
  assert.equal(h.count('reconnect'), 0);
  await value.foregrounded();
  assert.equal(h.count('reconnect'), 1);
  assert.equal(h.changes.at(-1).state, h.states.Recovering);
  await value.close();
});

test('authentication failure on a paused snapshot requires login and cannot wake the SDK', async () => {
  const h = harness();
  const { value } = h.helper();
  h.plans.status.push(sdkStatus('paused', { errorCode: 'DSH_BROKER_AUTH' }));
  await value.foregrounded();
  assert.equal(h.changes.at(-1).state, h.states.AuthenticationRequired);
  assert.equal(h.count('reconnect'), 0);
  await value.close();
});

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
    assert.equal(h.changes.at(-1).state, snapshot.errorCode === 'DSH_BROKER_AUTH' ?
      h.states.AuthenticationRequired : h.states.Disconnected);
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
    closing.then(() => { settled = true; }, () => { settled = true; });
    assert.equal(value.close(), closing);
    await tick();
    assert.equal(h.count('close'), 1);
    assert.equal(settled, false, 'native cancellation precedes the join of pending work');
    manual.resolve(sdkStatus('connected', { localUrl: 'http://127.0.0.1:54321/', localPort: 54321 }));
    await recovery;
    if (rejectClose) await assert.rejects(closing, /SDK close failed/);
    else await closing;
    assert.equal(h.changes.length, before);
    assert.equal(h.count('probe'), 0);
    assert.equal(h.count('close'), 1, 'retired results cannot issue a later close');
    if (rejectClose) {
      assert.throws(() => value.activate(h.profile(), ORIGIN), /cleanup has not completed/);
      await value.close();
      value.activate(h.profile(), ORIGIN);
      await value.close();
    }
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

test('soft return and repeated same-config opens retain actual local and remote WebViews without new probes', async () => {
  for (const remote of [false, true]) {
    const h = harness();
    const { index, adopted, bind } = h.page(remote);
    await h.attach(index, bind());
    bind().pageEnd({ url: ROUTE });
    index.searchText = 'kept search';
    index.searchCount = 3;
    const before = preserve(index);
    const probes = h.count('probe');
    const cookies = h.cookieCalls.length;
    const loads = index.controller.loaded.length;
    for (let reopen = 0; reopen < 5; reopen += 1) {
      assert.equal(index.onBackPress(), true);
      assert.equal(index.webVisible, false);
      assert.equal(index.retainedConnectionId, adopted.id);
      unchanged(index, before);
      const updated = h.profile(remote);
      updated.name = 'renamed while retained';
      updated.localPort = 54321;
      assert.equal(await bind().homePrepare(updated), true);
      await tick();
      assert.equal(index.webVisible, true);
      unchanged(index, before);
      assert.equal(index.controller.loaded.length, loads);
    }
    assert.equal(h.count('probe'), probes);
    assert.equal(h.cookieCalls.length, cookies);
    assert.equal(h.controllers.length, 2);
    sdkOwnsRecovery(h);
    await closePage(h, index);
  }
});

test('bootstrap blank history returns to Home and the mounted flow restores the same local or remote workspace', async () => {
  for (const remote of [false, true]) {
    const h = harness();
    const { index, adopted, bind } = h.page(remote);
    const callbacks = bind();
    await h.attach(index, callbacks);
    callbacks.pageEnd({ url: ADDRESS });
    const controller = index.controller;
    assert.deepEqual(controller.history, ['about:blank', ADDRESS]);
    const before = preserve(index);
    const reads = h.cookieCalls.length;
    const flow = new (h.load('pages/ConnectionHome').ConnectionHome)();
    flow.onPrepare = callbacks.homePrepare;
    flow.onDisconnect = callbacks.homeDisconnect;
    flow.onOpen = () => { assert.fail('same configuration must resume the retained owner'); };
    flow.aboutToAppear();
    await flow.pendingWork;
    for (let round = 0; round < 3; round += 1) {
      assert.equal(index.onBackPress(), true);
      assert.equal(index.webVisible, false);
      assert.equal(controller.currentAddress, ADDRESS, 'Back cannot load the bootstrap blank');
      assert.equal(controller.historyIndex, 1);
      assert.equal(controller.historyCalls.includes('backward'), false);
      unchanged(index, before);
      await flow.openConnection(adopted);
      await tick();
      assert.equal(index.webVisible, true);
      assert.equal(flow.transferred, true);
      assert.equal(flow.busy, false);
      unchanged(index, before);
      assert.deepEqual(controller.loaded, [ADDRESS]);
    }
    assert.equal(h.cookieCalls.length, reads);
    assert.equal(h.count('probe'), 0);
    sdkOwnsRecovery(h);
    await closePage(h, index);
  }
});

test('Back while initial blank is pending retains preparation until the same connection resumes', async () => {
  for (const delayedCookies of [false, true]) {
    const h = harness();
    const { index, adopted, bind } = h.page(false);
    const callbacks = bind();
    const read = deferred();
    if (delayedCookies) h.control.cookieRead = () => read.promise;
    const preparation = h.attach(index, callbacks, { completeBlank: false });
    if (!delayedCookies) await preparation;
    const controller = index.controller;
    const generation = index.webGeneration;
    assert.equal(index.onBackPress(), true);
    assert.equal(index.webVisible, false);
    assert.equal(index.pageLoaded, false);
    assert.deepEqual(controller.historyCalls, []);
    assert.equal(await callbacks.homePrepare(adopted), true);
    assert.equal(index.controller, controller);
    assert.equal(index.webGeneration, generation);
    h.blankEnd(controller, callbacks);
    read.resolve([pendingCookie()]);
    await preparation;
    await callbacks.attached();
    assert.deepEqual(controller.loaded, [ADDRESS]);
    assert.equal(index.navigationGeneration, generation);
    assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 1);
    callbacks.pageEnd({ url: ADDRESS });
    assert.equal(index.pageLoaded, true);
    assert.equal(index.webVisible, true);
    assert.equal(h.count('probe'), 0);
    sdkOwnsRecovery(h);
    await closePage(h, index);
  }
});

test('Back follows the immediately previous same-origin entry before returning over the bootstrap blank', async () => {
  const h = harness();
  const { index, bind } = h.page();
  const callbacks = bind();
  await h.attach(index, callbacks);
  callbacks.pageEnd({ url: ADDRESS });
  const controller = index.controller;
  controller.navigate(ROUTE);
  callbacks.pageEnd({ url: ROUTE });
  controller.navigate(ORIGIN + '/sessions/forward');
  controller.historyIndex = 2;
  controller.currentAddress = ROUTE;
  assert.equal(index.onBackPress(), true);
  assert.equal(index.webVisible, true);
  assert.equal(controller.currentAddress, ADDRESS);
  assert.equal(controller.historyIndex, 1);
  assert.deepEqual(controller.historyCalls, ['access', 'entries', 'item', 'backward']);
  callbacks.pageEnd({ url: controller.currentAddress });
  assert.equal(index.currentWebAddress, ADDRESS);
  assert.equal(index.onBackPress(), true);
  assert.equal(index.webVisible, false);
  assert.equal(controller.currentAddress, ADDRESS);
  assert.equal(controller.historyCalls.filter(name => name === 'backward').length, 1);
  sdkOwnsRecovery(h);
  await closePage(h, index);
});

test('Back only accepts the previous exact connection origin and never scans across other history', async () => {
  for (const previous of ['about:blank', '', 'https://elsewhere.invalid/page', 'http://localhost:43219/page',
    'http://127.0.0.1:54321/page', 'https://127.0.0.1:43219/page', 'http://127.0.0.1:43219@elsewhere.invalid/page']) {
    const h = harness();
    const { index, bind } = h.page(false);
    const callbacks = bind();
    await h.attach(index, callbacks);
    callbacks.pageEnd({ url: ROUTE });
    const controller = index.controller;
    controller.history = [ADDRESS, previous, ROUTE];
    controller.historyIndex = 2;
    controller.currentAddress = ROUTE;
    assert.equal(index.onBackPress(), true, previous);
    assert.equal(index.webVisible, false, previous);
    assert.equal(controller.currentAddress, ROUTE, previous);
    assert.equal(controller.historyIndex, 2);
    assert.deepEqual(controller.historyCalls, ['access', 'entries', 'item']);
    assert.equal(h.count('close'), 0);
    await closePage(h, index);
  }
});

test('history API failures retain the workspace and return to connections without throwing', async () => {
  for (const failure of ['access', 'entries', 'item', 'backward']) {
    const h = harness();
    const { index, bind } = h.page();
    const callbacks = bind();
    await h.attach(index, callbacks);
    index.controller.navigate(ROUTE);
    callbacks.pageEnd({ url: ROUTE });
    const before = preserve(index);
    h.control.historyFailure = failure;
    assert.equal(index.onBackPress(), true, failure);
    assert.equal(index.webVisible, false, failure);
    assert.equal(index.controller.historyCalls.at(-1), failure);
    assert.equal(index.controller.historyIndex, 2);
    unchanged(index, before);
    sdkOwnsRecovery(h);
    await closePage(h, index);
  }
});

test('empty or unavailable previous history returns directly to connections', async () => {
  for (const available of [false, true]) {
    const h = harness();
    const { index, bind } = h.page(false);
    await h.attach(index, bind());
    bind().pageEnd({ url: ADDRESS });
    index.controller.history = [ADDRESS];
    index.controller.historyIndex = 0;
    h.control.backwardAvailable = available;
    assert.equal(index.onBackPress(), true);
    assert.equal(index.webVisible, false);
    assert.deepEqual(index.controller.historyCalls, available ? ['access', 'entries'] : ['access']);
    await closePage(h, index);
  }
});

test('Back dismisses the native menu, then search, then navigates history and finally delegates to Home', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  await h.attach(index, bind());
  index.controller.navigate(ROUTE);
  bind().pageEnd({ url: ROUTE });
  index.menuVisible = true;
  index.searchVisible = true;
  index.searchCount = 4;
  index.searchIndex = 2;
  let menuClosed = 0;
  index.menuResult = { closeContextMenu() { menuClosed += 1; } };
  assert.equal(index.onBackPress(), true);
  assert.equal(menuClosed, 1);
  assert.equal(index.menuVisible, false);
  assert.equal(index.searchVisible, true);
  assert.equal(index.webVisible, true);
  assert.deepEqual(index.controller.historyCalls, []);
  assert.equal(index.onBackPress(), true);
  assert.equal(index.searchVisible, false);
  assert.equal(index.searchCount, 0);
  assert.equal(index.searchIndex, 0);
  assert.equal(index.controller.clearedMatches, 1);
  assert.deepEqual(index.controller.historyCalls, []);
  assert.equal(index.onBackPress(), true);
  assert.equal(index.controller.currentAddress, ADDRESS);
  assert.equal(index.webVisible, true);
  bind().pageEnd({ url: ADDRESS });
  assert.equal(index.onBackPress(), true);
  assert.equal(index.webVisible, false);
  let homeBack = 0;
  index.homeController.onBack = () => { homeBack += 1; return false; };
  assert.equal(index.onBackPress(), false);
  assert.equal(homeBack, 1);
  assert.equal(h.count('close'), 0);
  await closePage(h, index);
});

test('every transport configuration change retires the retained page before new ownership', async () => {
  const fields = { id: 'other-profile', mode: 'local', port: 3091, token: 'new-dsh-token',
    serviceUrl: 'https://other.invalid', account: 'other-account', brokerId: 'other-broker', peerPassword: 'other-peer',
    relayMode: 'force', authSessionId: '12345678-1234-4234-8234-123456789abc', accessToken: 'other-legacy-bearer' };
  for (const [field, next] of Object.entries(fields)) {
    const h = harness();
    const { index } = h.page();
    index.hideWeb();
    const updated = h.profile();
    updated[field] = next;
    assert.equal(await index.prepareConnection(updated), false, field);
    assert.equal(index.webUrl, '', field);
    assert.equal(index.retainedConnectionId, '', field);
    assert.equal(h.count('close'), 1, field);
    assert.equal(index.closingWeb, false, field);
    await closePage(h, index);
  }
});

test('the retained configuration is a snapshot even when a caller edits the adopted profile in place', async () => {
  const h = harness();
  const { index, adopted } = h.page();
  index.hideWeb();
  adopted.token = 'edited-token';
  assert.equal(await index.prepareConnection(adopted), false);
  assert.equal(h.count('close'), 1);
  await closePage(h, index);
});

test('switch preparation merges repeated clicks and waits for actual SDK teardown', async () => {
  const h = harness();
  const { index, bind } = h.page();
  index.hideWeb();
  const cleanup = deferred();
  h.plans.close.push(cleanup.promise);
  const next = h.profile();
  next.id = 'next-profile';
  const preparation = bind().homePrepare(next);
  assert.equal(bind().homePrepare(next), preparation);
  let finished = false;
  preparation.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  assert.equal(index.closingWeb, true);
  assert.equal(index.webVisible, false);
  assert.equal(index.openWeb(ADDRESS, true, next), false);
  assert.equal(h.count('close'), 1);
  cleanup.resolve();
  assert.equal(await preparation, false);
  assert.equal(index.openWeb(ADDRESS, true, next), true);
  assert.equal(index.retainedConnectionId, next.id);
  await closePage(h, index);
});

test('explicit Home disconnect and deleting its retained id join one real close while unrelated ids remain intact', async () => {
  const h = harness();
  const { index, adopted, bind } = h.page();
  const before = preserve(index);
  index.hideWeb();
  await bind().homeDisconnect('unrelated-profile');
  unchanged(index, before);
  assert.equal(h.count('close'), 0);
  const cleanup = deferred();
  h.plans.close.push(cleanup.promise);
  const closing = bind().homeDisconnect(adopted.id);
  assert.equal(bind().homeDisconnect(adopted.id), closing);
  await tick();
  assert.equal(index.webUrl, '');
  assert.equal(index.retainedConnectionId, '');
  assert.equal(index.closingWeb, true);
  cleanup.resolve();
  await closing;
  assert.equal(index.closingWeb, false);
  assert.equal(h.count('close'), 1);
  await closePage(h, index);
});

test('a visible manual retry wakes the paused SDK once without replacing the retained document', async () => {
  const h = harness();
  const { index, bind } = h.page();
  bind().pageEnd({ url: ROUTE });
  const before = preserve(index);
  h.plans.status.push(sdkStatus('paused'));
  await index.checkRemote();
  assert.equal(index.connectionState, h.states.Disconnected);
  const waking = deferred();
  h.plans.status.push(sdkStatus('paused'));
  h.plans.reconnect.push(waking.promise);
  bind().retry();
  bind().retry();
  await tick();
  assert.equal(h.count('reconnect'), 1);
  assert.equal(index.connectionState, h.states.Recovering);
  waking.resolve(sdkStatus('retry_wait'));
  await index.retryConnection();
  unchanged(index, before);
  sdkOwnsRecovery(h);
  await closePage(h, index);
});

test('returning from an expired broker login releases its failed map for the Home login flow', async () => {
  const h = harness();
  const { index } = h.page();
  h.plans.status.push(sdkStatus('failed', { errorCode: 'DSH_BROKER_AUTH' }));
  await index.checkRemote();
  assert.equal(index.connectionMessage().name, 'app.string.broker_login_expired');
  index.returnFromConnection();
  await index.closeWork;
  assert.equal(index.webVisible, false);
  assert.equal(index.retainedConnectionId, '');
  assert.equal(h.count('close'), 1);
  assert.equal(h.count('reconnect'), 0);
  await closePage(h, index);
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
    assert.equal(index.connectionState, remote ? h.states.AuthenticationRequired : h.states.Disconnected);
    assert.equal(index.connectionMessage().name, remote ? 'app.string.broker_login_expired' : 'app.string.connection_disconnected');
    assert.equal(index.activeConnection, adopted);
    unchanged(index, before);
    assert.equal(h.count('reconnect'), 0);
    sdkOwnsRecovery(h);
    await closePage(h, index);
  }
});

test('explicit disconnect clears page immediately and a failed native close continues blocking new ownership', async () => {
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
    const closing = index.disconnectConnection(index.retainedConnectionId);
    assert.equal(index.closeWeb(), closing);
    assert.equal(index.webUrl, '');
    assert.equal(index.activeConnection, undefined);
    assert.equal(index.webGeneration, generation + 1);
    assert.equal(h.publications.filter(item => item.name === 'dshWebViewActive').at(-1).args[0], false);
    await tick();
    assert.equal(h.count('close'), 1);
    assert.equal(index.closingWeb, true);
    assert.equal(index.openWeb(ADDRESS, true, h.profile()), false, 'new ownership waits for native quiescence');
    manual.resolve(sdkStatus('connected'));
    await recovery;
    if (rejectClose) {
      await assert.rejects(closing, /SDK close failed/);
      assert.equal(index.closingWeb, true);
      assert.equal(index.openWeb(ADDRESS, true, h.profile()), false);
      assert.equal(await index.prepareConnection(h.profile()), false, 'a later preparation retries unfinished teardown');
    } else {
      await closing;
    }
    assert.equal(index.closingWeb, false);
    assert.equal(oldController.events.length, 0, 'retired completion cannot notify the old DOM');
    assert.equal(h.count('close'), rejectClose ? 2 : 1);
    assert.equal(index.openWeb(ADDRESS, true, h.profile()), true);
    assert.equal(h.count('close'), rejectClose ? 2 : 1);
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
    assert.equal(h.timers.has(index.remoteTimer), false);
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

test('one mounted Home restores the retained local page before any second probe or handoff', async () => {
  const h = harness();
  const { index, adopted, bind } = h.page(false);
  await h.attach(index, bind());
  bind().pageEnd({ url: ROUTE });
  const before = preserve(index);
  const flow = new (h.load('pages/ConnectionHome').ConnectionHome)();
  flow.onPrepare = bind().homePrepare;
  flow.onDisconnect = bind().homeDisconnect;
  let handoffs = 0;
  flow.onOpen = (...args) => { handoffs += 1; return bind().homeOpen(...args); };
  flow.aboutToAppear();
  await flow.pendingWork;
  const reads = h.cookieCalls.length;
  for (let reopen = 0; reopen < 3; reopen += 1) {
    index.hideWeb();
    await flow.openConnection(adopted);
    assert.equal(flow.busy, false);
    assert.equal(flow.transferred, true);
    assert.equal(index.webVisible, true);
    unchanged(index, before);
  }
  assert.equal(h.count('probe'), 0);
  assert.equal(h.count('connect'), 0);
  assert.equal(handoffs, 0);
  assert.equal(h.cookieCalls.length, reads);
  await closePage(h, index);
});

test('build bindings keep Home mounted and hide the retained Web without changing its creation generation', () => {
  const source = fs.readFileSync(path.join(ets, 'pages/Index.ets'), 'utf8');
  const file = ts.createSourceFile('Index.ets', source.replace('struct Index', 'class Index'), ts.ScriptTarget.Latest, true);
  const nodes = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ['Web', 'ConnectionHome'].includes(node.expression.getText(file))) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  const web = nodes.find(node => node.expression.getText(file) === 'Web');
  const home = nodes.find(node => node.expression.getText(file) === 'ConnectionHome');
  assert(web && home);
  function enclosingConditions(node) {
    const conditions = [];
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isIfStatement(ancestor)) conditions.push(ancestor.expression.getText(file));
    }
    return conditions;
  }
  assert.deepEqual(enclosingConditions(home), [], 'Home remains in the tree while the WebView is shown');
  assert.deepEqual(enclosingConditions(web), ["this.webUrl !== ''"], 'visibility cannot remove the retained Web');
  assert.match(source, /\.visibility\(this\.webVisible \? Visibility\.Visible : Visibility\.Hidden\)/);
  assert.match(source, /\.visibility\(this\.webVisible \? Visibility\.Hidden : Visibility\.Visible\)/);
});

test('the recovery indicator stays in its recovering branch and its top overlay permits page hit testing', () => {
  const source = fs.readFileSync(path.join(ets, 'pages/Index.ets'), 'utf8');
  const start = source.indexOf('  private connectionStatus()');
  const end = source.indexOf('\n  @Builder', start);
  const builder = source.slice(start, end);
  const file = ts.createSourceFile('connection-status.ts', builder, ts.ScriptTarget.Latest, true);
  const spinners = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'LoadingProgress') spinners.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(spinners.length, 1);
  let recovering;
  for (let ancestor = spinners[0].parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isIfStatement(ancestor)) { recovering = ancestor.expression.getText(file); break; }
  }
  assert.equal(recovering, 'this.connectionState === WebConnectionState.Recovering');
  assert.match(builder, /position\(\{ x: 0, y: 12 \}\)/);
  assert.match(builder, /Recovering \? HitTestMode\.None : HitTestMode\.Transparent/);
  assert.match(builder, /app\.string\.reconnecting/);
  assert.match(builder, /app\.string\.retry_connection/);
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
  flow.onPrepare = bind().homePrepare;
  flow.onDisconnect = bind().homeDisconnect;
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

function failedRequest(url = ADDRESS, mainFrame = true) {
  return { getRequestUrl: () => url, isMainFrame: () => mainFrame };
}

function httpFailure(status, request = failedRequest()) {
  return { request, response: { getResponseCode: () => status } };
}

function networkFailure(code, request = failedRequest()) {
  return { request, error: { getErrorCode: () => code } };
}

test('HTTP 431 stays visible through paint, PageEnd and the later generic load error, with a working exit', async () => {
  const h = harness();
  const { index, bind } = h.page();
  const callbacks = bind();
  await h.attach(index, callbacks);
  const controller = index.controller;
  index.searchVisible = true;
  callbacks.httpError(httpFailure(431));
  assert.equal(index.webError.name, 'app.string.web_http_error');
  assert.deepEqual(Array.from(index.webError.params), [431]);
  assert.equal(index.searchVisible, false);
  callbacks.pageEnd({ url: 'about:blank' });
  callbacks.pageEnd({ url: ADDRESS });
  callbacks.networkError(networkFailure(-379));
  assert.equal(index.webError.name, 'app.string.web_http_error');
  assert.deepEqual(Array.from(index.webError.params), [431]);
  assert.equal(index.pageLoaded, false);
  assert.equal(index.webPainted, false);
  assert.equal(index.controller, controller);
  assert.equal(index.webUrl, ADDRESS);
  callbacks.returnConnections();
  assert.equal(index.webVisible, false);
  assert.equal(index.webUrl, ADDRESS);
  assert.equal(index.webError.name, 'app.string.web_http_error');
  assert.equal(h.count('close'), 0);
  callbacks.disconnect();
  await index.closeWork;
  assert.equal(index.webUrl, '');
  assert.equal(index.webError, undefined);
  assert.equal(h.count('close'), 1);
  index.aboutToDisappear();
});

test('subresources, foreign origins and retired WebViews cannot replace the current page with an error', async () => {
  const h = harness();
  const { index, adopted, bind } = h.page();
  const old = bind();
  for (const request of [failedRequest(ORIGIN + '/missing-icon', false), failedRequest('https://other.invalid/')]) {
    old.httpError(httpFailure(404, request));
    old.networkError(networkFailure(-2, request));
    assert.equal(index.webError, undefined);
  }
  await index.closeWeb();
  assert.equal(index.openWeb(ADDRESS, true, adopted), true);
  old.httpError(httpFailure(431));
  old.networkError(networkFailure(-379));
  assert.equal(index.webError, undefined);
  const current = bind();
  current.networkError(networkFailure(-2));
  assert.equal(index.webError.name, 'app.string.web_network_error');
  assert.deepEqual(Array.from(index.webError.params), [-2]);
  current.httpError(httpFailure(503));
  assert.equal(index.webError.name, 'app.string.web_http_error');
  assert.deepEqual(Array.from(index.webError.params), [503]);
  current.pageEnd({ url: ADDRESS });
  assert.equal(index.pageLoaded, false);
  await closePage(h, index);
});

/** The connection origin's DSH Web cookie; other authorities' cookies are never expired. */
function pendingCookie(authority = '127.0.0.1:43219') {
  const cookie = { name: 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url'),
    domain: '127.0.0.1', path: '/', isHttpOnly: true };
  Object.defineProperty(cookie, 'value', { get() { throw new Error('cookie values must not be inspected'); } });
  return cookie;
}

test('same-local explicit disconnect and reopen survives the queued blank navigation after fast cookies', async () => {
  const h = harness();
  const { index, adopted, bind } = h.page(false);
  for (let round = 0; round < 3; round += 1) {
    const callbacks = bind();
    const controller = index.controller;
    await h.attach(index, callbacks, { beginBlank: false, completeBlank: false });
    // Match the device order: attach, fast cookies, then the constructor's blank begin/end.
    // An early accepted loadUrl would be overwritten by these real callback bindings.
    h.blankBegin(controller, callbacks);
    h.blankEnd(controller, callbacks);
    assert.deepEqual(controller.loaded, [ADDRESS]);
    assert.equal(controller.currentAddress, ADDRESS, 'the late initial blank cannot replace the target navigation');
    assert.equal(index.diagnosticPhase, 3);
    callbacks.pageBegin({ url: controller.currentAddress });
    callbacks.pageEnd({ url: controller.currentAddress });
    assert.equal(index.pageLoaded, true);
    assert.equal(index.webPainted, true);
    assert.equal(index.diagnosticPhase, 0);
    await callbacks.homeDisconnect(adopted.id);
    assert.equal(index.closingWeb, false);
    if (round < 2) assert.equal(index.openWeb(ADDRESS, false, adopted), true);
  }
  assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 3);
  assert.equal(h.count('connect'), 0);
  assert.equal(h.count('close'), 0);
  await closePage(h, index);
});

test('blank completion during a delayed cookie read waits for cookies and dispatches one target', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  const callbacks = bind();
  const read = deferred();
  h.control.cookieRead = () => read.promise;
  const work = h.attach(index, callbacks, { completeBlank: false });
  assert.equal(index.diagnosticPhase, 2);
  h.blankEnd(index.controller, callbacks);
  assert.equal(index.diagnosticPhase, 2);
  assert.deepEqual(index.controller.loaded, []);
  read.resolve([pendingCookie()]);
  await work;
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(index.controller.currentAddress, ADDRESS);
  assert.equal(index.diagnosticPhase, 3);
  await closePage(h, index);
});

test('fast cookies wait in the blank phase and duplicate blank callbacks never reload a running page', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  const callbacks = bind();
  await h.attach(index, callbacks, { completeBlank: false });
  assert.equal(index.diagnosticPhase, 1);
  assert.equal(index.initialAuthentication, true);
  assert.deepEqual(index.controller.loaded, []);
  h.blankEnd(index.controller, callbacks);
  h.blankEnd(index.controller, callbacks);
  await callbacks.attached();
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 1);
  callbacks.pageEnd({ url: ROUTE });
  h.blankEnd(index.controller, callbacks);
  assert.equal(index.currentWebAddress, ROUTE);
  assert.equal(index.diagnosticPhase, 0);
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  callbacks.networkError(networkFailure(-2));
  h.blankEnd(index.controller, callbacks);
  await callbacks.attached();
  assert.equal(index.webError.name, 'app.string.web_network_error');
  assert.equal(index.pageLoaded, false);
  assert.deepEqual(index.controller.loaded, [ADDRESS], 'a failed target cannot trigger an unconditional retry');
  await closePage(h, index);
});

test('stale blank completion and stale cookies cannot unlock the next generation', async () => {
  const h = harness();
  const { index, adopted, bind } = h.page(false);
  const old = bind();
  const previous = index.controller;
  const read = deferred();
  h.control.cookieRead = () => read.promise;
  const pending = h.attach(index, old, { completeBlank: false });
  await index.closeWeb();
  h.control.cookieRead = undefined;
  assert.equal(index.openWeb(ADDRESS, false, adopted), true);
  const current = bind();
  await h.attach(index, current, { completeBlank: false });
  read.resolve([pendingCookie()]);
  await pending;
  h.blankEnd(previous, old);
  await old.attached();
  assert.deepEqual(previous.loaded, []);
  assert.deepEqual(index.controller.loaded, []);
  assert.equal(index.diagnosticPhase, 1);
  h.blankEnd(index.controller, current);
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'expire').length, 0);
  await closePage(h, index);
});

test('close cancels a pending initial blank without waiting for either blank or cookie completion', async () => {
  for (const delayedCookies of [false, true]) {
    const h = harness();
    const { index, bind } = h.page(false);
    const callbacks = bind();
    const controller = index.controller;
    const read = deferred();
    if (delayedCookies) h.control.cookieRead = () => read.promise;
    const pending = h.attach(index, callbacks, { completeBlank: false });
    if (!delayedCookies) await pending;
    let closed = false;
    const closing = index.closeWeb().then(() => { closed = true; });
    await tick();
    assert.equal(closed, true, 'closing cannot join an unresolved blank or cookie promise');
    await closing;
    assert.equal(index.webUrl, '');
    h.blankEnd(controller, callbacks);
    read.resolve([pendingCookie()]);
    await pending;
    assert.deepEqual(controller.loaded, []);
    assert.equal(h.cookieCalls.filter(call => call[0] === 'expire').length, 0);
    await closePage(h, index);
  }
});

test('renderer exit while blank is pending cancels navigation until its successor blank completes', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  const old = bind();
  const previous = index.controller;
  await h.attach(index, old, { completeBlank: false });
  old.exited();
  h.blankEnd(previous, old);
  assert.deepEqual(previous.loaded, []);
  await index.resumeWeb();
  assert.notEqual(index.controller, previous);
  assert.equal(index.initialAuthentication, true);
  const current = bind();
  await h.attach(index, current, { completeBlank: false });
  h.blankEnd(previous, old);
  assert.deepEqual(index.controller.loaded, []);
  h.blankEnd(index.controller, current);
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(index.initialAuthentication, false);
  await closePage(h, index);
});

test('blank completion while detached is retained without navigating until the same owner attaches again', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  const callbacks = bind();
  await h.attach(index, callbacks, { completeBlank: false });
  index.aboutToDisappear();
  h.blankEnd(index.controller, callbacks);
  assert.deepEqual(index.controller.loaded, []);
  assert.equal(index.initialAuthentication, true);
  index.aboutToAppear();
  await callbacks.attached();
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 1);
  await closePage(h, index);
});

test('a target error before the initial blank completes cancels the pending navigation', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  const callbacks = bind();
  await h.attach(index, callbacks, { completeBlank: false });
  callbacks.httpError(httpFailure(503));
  h.blankEnd(index.controller, callbacks);
  await callbacks.attached();
  assert.deepEqual(index.controller.loaded, []);
  assert.equal(index.webError.name, 'app.string.web_http_error');
  assert.equal(index.diagnosticPhase, 4);
  await closePage(h, index);
});

test('a cold engine first binds a blank Web, then prepares cookies once before authenticated navigation', async () => {
  const h = harness();
  const { index, bind } = h.page();
  const callbacks = bind();
  const read = deferred();
  h.control.cookieRead = () => read.promise;
  assert.equal(h.control.engineReady, false);
  assert.equal(h.control.badInitialization, false);
  assert.equal(h.cookieCalls.length, 0, 'creating Index and transferring ownership cannot initialize cookies on a worker');
  assert.equal(callbacks.initialSource, 'about:blank');
  assert.deepEqual(index.controller.loaded, []);
  index.menuVisible = true;
  callbacks.pageBegin({ url: 'about:blank' });
  callbacks.pageEnd({ url: 'about:blank' });
  assert.equal(index.menuVisible, true);
  assert.equal(index.pageLoaded, false);
  assert.equal(index.webPainted, false);
  assert.equal(index.currentWebAddress, ADDRESS);
  const work = h.attach(index, callbacks);
  assert.equal(callbacks.attached(), work, 'duplicate binding joins the exact pending operation');
  assert.deepEqual(h.lifecycle, ['attached', 'cookies']);
  assert.deepEqual(index.controller.loaded, []);
  read.resolve([pendingCookie('127.0.0.1:43220'), pendingCookie()]);
  await work;
  assert.deepEqual(h.lifecycle, ['attached', 'cookies', 'expire', 'navigate'], 'another window\'s port keeps its cookie');
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(index.initialAuthentication, false);
  assert.equal(h.control.badInitialization, false);
  await callbacks.attached();
  assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 1);
  assert.equal(index.controller.loaded.length, 1);
  callbacks.pageBegin({ url: ADDRESS });
  assert.equal(index.menuVisible, false);
  callbacks.pageEnd({ url: 'about:blank' });
  assert.equal(index.pageLoaded, false);
  callbacks.pageEnd({ url: ADDRESS });
  assert.equal(index.pageLoaded, true);
  assert.equal(index.webPainted, true);
  await closePage(h, index);
});

test('Back before controller attachment cannot read cookies or dispatch authentication', async () => {
  const h = harness();
  const { index, bind } = h.page();
  const old = bind();
  const controller = index.controller;
  await index.closeWeb();
  await old.attached();
  assert.equal(h.cookieCalls.length, 0);
  assert.equal(h.control.engineReady, false);
  assert.deepEqual(controller.loaded, []);
  assert.equal(h.count('close'), 1);
  index.aboutToDisappear();
});

test('Back during a cookie read retires its controller without touching or loading the next connection', async () => {
  const h = harness();
  const { index, adopted, bind } = h.page();
  const old = bind();
  const previous = index.controller;
  const read = deferred();
  h.control.cookieRead = () => read.promise;
  const pending = h.attach(index, old);
  await index.closeWeb();
  h.control.cookieRead = undefined;
  h.control.cookies = [pendingCookie()];
  assert.equal(index.openWeb(ADDRESS, true, adopted), true);
  const current = bind();
  await h.attach(index, current);
  const controller = index.controller;
  read.resolve([pendingCookie()]);
  await pending;
  await old.attached();
  assert.deepEqual(previous.loaded, []);
  assert.deepEqual(controller.loaded, [ADDRESS]);
  assert.equal(index.controller, controller);
  assert.equal(index.initialAuthentication, false);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'expire').length, 1);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 2);
  await closePage(h, index);
});

for (const failure of ['read', 'write', 'navigate']) {
  test(`a bound-page ${failure} failure remains visible until Back releases its mapping`, async () => {
    const h = harness();
    const { index, bind } = h.page();
    const callbacks = bind();
    h.control.cookies = [pendingCookie()];
    const error = new Error('owned failure');
    if (failure === 'read') h.control.cookieFailure = error;
    if (failure === 'write') h.control.cookieWriteFailure = error;
    if (failure === 'navigate') h.control.navigationFailure = error;
    await h.attach(index, callbacks);
    assert.equal(index.webError.name, failure === 'navigate' ? 'app.string.web_load_failed' :
      'app.string.connection_cookies_failed');
    assert.equal(index.initialAuthentication, true);
    assert.equal(index.controller.loaded.length, 0);
    assert.equal(h.count('close'), 0, 'Index retains mapping ownership for its visible error page');
    callbacks.pageEnd({ url: 'about:blank' });
    callbacks.pageEnd({ url: ADDRESS });
    await callbacks.attached();
    assert.equal(index.pageLoaded, false);
    assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 1);
    callbacks.returnConnections();
    assert.equal(index.webVisible, false);
    assert.equal(index.webUrl, ADDRESS);
    assert.equal(h.count('close'), 0);
    callbacks.disconnect();
    await index.closeWork;
    assert.equal(index.webUrl, '');
    assert.equal(index.webError, undefined);
    assert.equal(h.count('close'), 1);
    index.aboutToDisappear();
  });
}

test('restoring an authenticated renderer loads its clean route without expiring its session cookie', async () => {
  const h = harness();
  const { index, bind } = h.page();
  const first = bind();
  h.control.cookies = [pendingCookie()];
  await h.attach(index, first);
  first.pageEnd({ url: ROUTE });
  const previous = index.controller;
  first.exited();
  await index.checkRemote();
  assert.notEqual(index.controller, previous);
  assert.equal(index.webUrl, ROUTE);
  assert.equal(index.initialAuthentication, false);
  const restored = bind();
  await h.attach(index, restored);
  assert.deepEqual(index.controller.loaded, [ROUTE]);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'read').length, 1);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'expire').length, 1);
  sdkOwnsRecovery(h);
  await closePage(h, index);
});

test('renderer loss before authentication preserves preparation for its successor while retiring the old read', async () => {
  const h = harness();
  const { index, bind } = h.page();
  const first = bind();
  const previous = index.controller;
  const read = deferred();
  h.control.cookieRead = () => read.promise;
  const pending = h.attach(index, first);
  assert.equal(index.initialAuthentication, true);
  first.exited();
  await index.checkRemote();
  assert.notEqual(index.controller, previous);
  assert.equal(index.initialAuthentication, true);
  h.control.cookieRead = undefined;
  h.control.cookies = [pendingCookie()];
  await h.attach(index, bind());
  read.resolve([pendingCookie()]);
  await pending;
  assert.deepEqual(previous.loaded, []);
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(index.initialAuthentication, false);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'expire').length, 1);
  sdkOwnsRecovery(h);
  await closePage(h, index);
});

test('a detached preparation cannot expire cookies, and reattachment can finish the still-new authentication', async () => {
  const h = harness();
  const { index, bind } = h.page(false);
  const callbacks = bind();
  const read = deferred();
  h.control.cookieRead = () => read.promise;
  const pending = h.attach(index, callbacks);
  index.aboutToDisappear();
  read.resolve([pendingCookie()]);
  await pending;
  assert.equal(h.cookieCalls.filter(call => call[0] === 'expire').length, 0);
  assert.deepEqual(index.controller.loaded, []);
  assert.equal(index.initialAuthentication, true);
  h.control.cookieRead = undefined;
  h.control.cookies = [pendingCookie()];
  index.aboutToAppear();
  await h.attach(index, bind());
  assert.deepEqual(index.controller.loaded, [ADDRESS]);
  assert.equal(h.cookieCalls.filter(call => call[0] === 'expire').length, 1);
  await closePage(h, index);
});


test('an account authentication terminal state retires its retained peer before reopening', async () => {
  const h = harness();
  const { index, adopted } = h.page();
  index.connectionChanged(h.states.AuthenticationRequired, false);
  index.hideWeb();
  assert.equal(await index.prepareConnection(adopted), false);
  assert.equal(h.count('close'), 1);
  assert.equal(index.retainedConnectionId, '');
  await closePage(h, index);
});
