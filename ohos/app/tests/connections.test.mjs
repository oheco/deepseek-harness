/** Launcher flows execute ArkTS methods. DSH_ARKUI_COMPILED_FIELD enables SDK-output render regressions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../entry/src/main/ets');

function harness() {
  const cache = new Map();
  const calls = [];
  const disk = new Map();
  const memory = new Map();
  const control = { failFlush: false, flushWait: undefined, probeState: 'ok', probe: undefined,
    connect: undefined, close: undefined, brokers: undefined, opened: [], cookies: [], cookieFetch: undefined,
    cookieFailure: undefined, expiredCookies: [], cookieReads: 0 };
  class NavPathStack {
    routes = [];
    operations = [];
    pushPath(info, animated) { this.routes.push(info); this.operations.push(['push', info.name, animated]); }
    pop(animated) { this.operations.push(['pop', animated]); return this.routes.pop(); }
    popToIndex(index, animated) { this.operations.push(['popToIndex', index, animated]); this.routes.splice(index + 1); }
    getAllPathName() { return this.routes.map(info => info.name); }
    getIndexByName(name) { return this.routes.flatMap((info, index) => info.name === name ? [index] : []); }
    size() { return this.routes.length; }
    clear(animated) { this.operations.push(['clear', animated]); this.routes = []; }
  }
  let nextId = 0;
  const context = { filesDir: '/private/files', tempDir: '/private/temp',
    resourceManager: { getStringSync: () => 'Local mode' } };
  const preferences = { async get(key, fallback) { return memory.get(key) ?? disk.get(key) ?? fallback; },
    async put(key, value) { memory.set(key, value); },
    async flush() { if (control.failFlush) throw new Error('disk full');
      if (control.flushWait) await control.flushWait;
      for (const [key, value] of memory) disk.set(key, value); } };
  const native = {
    async brokerLogin(options) { calls.push(['login', options]); return { accessToken: 'account-bearer', tokenType: 'Bearer' }; },
    async brokerList(options) { calls.push(['list', options]); return control.brokers ?? [
      { id: 'online-broker', name: 'Workstation', online: true },
      { id: 'offline-broker', name: 'Offline', online: false } ]; },
    async brokerConnect(options) { calls.push(['connect', options]);
      if (control.connect) return await control.connect();
      return { state: 'connected', localUrl: 'http://127.0.0.1:43219/', localPort: 43219,
        brokerId: options.brokerId, remotePort: options.remotePort, error: '' }; },
    async brokerClose() { calls.push(['close']); if (control.close) await control.close(); },
    async dshProbe(options) { calls.push(['probe', options]);
      if (control.probe) return await control.probe(options);
      return { state: control.probeState, httpStatus: control.probeState === 'ok' ? 200 : 401 }; }
  };
  function load(relative) {
    const filename = path.join(ets, relative + '.ets');
    if (cache.has(filename)) return cache.get(filename);
    let source = fs.readFileSync(filename, 'utf8');
    if (relative === 'pages/ConnectionHome') {
      source = source.slice(0, source.indexOf('\n  @Builder')) + '\n}\nexport { ConnectionTestState, LauncherPage };\n';
      source = source.replace('export struct ConnectionHome', 'export class ConnectionHome')
        .replace(/^@Component\s*$/gm, '').replace(/@StorageProp\([^\n]+\)\s*/g, '').replace(/@State\s*/g, '');
    }
    const output = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
    } });
    const exports = {};
    cache.set(filename, exports);
    vm.runInNewContext(output.outputText, { exports, URL, NavPathStack, getContext: () => context,
      $r: name => ({ name, id: 1 }), setInterval: () => 1, clearInterval() {},
      require(specifier) {
        if (specifier.startsWith('.')) return load(path.posix.join(path.posix.dirname(relative), specifier));
        const mocks = {
          '@ohos.url': { URL },
          '@ohos.web.webview': { WebCookieManager: {
            async fetchAllCookies(incognito) {
              assert.equal(incognito, false);
              control.cookieReads += 1;
              if (control.cookieFailure) throw control.cookieFailure;
              return control.cookieFetch ? await control.cookieFetch() : control.cookies;
            },
            configCookieSync(...args) { control.expiredCookies.push(args); }
          } },
          '@ohos.util': { generateRandomUUID: () => 'connection-' + ++nextId,
            TextDecoder: { create: (encoding, options) => ({ decodeToString: bytes => new TextDecoder(encoding, options).decode(bytes) }) } },
          '@ohos.data.preferences': { getPreferences: async () => preferences },
          'libdsh_launcher.so': native
        };
        if (specifier in mocks) return { __esModule: true, default: mocks[specifier] };
        throw new Error('unexpected import ' + specifier);
      }
    }, { filename });
    return exports;
  }
  const profile = load('launcher/ConnectionProfile');
  const store = load('launcher/ConnectionStore');
  const home = load('pages/ConnectionHome');
  const page = new home.ConnectionHome();
  page.onOpen = (address, remote) => { control.opened.push([address, remote]); return true; };
  async function ready() { page.aboutToAppear(); await page.pendingWork; }
  return { profile, store, states: home.ConnectionTestState, routes: home.LauncherPage, page, control, disk, memory, calls, ready };
}

function localDraft(h, name = 'On this device', token = 'local token & 中文') {
  h.page.addConnection();
  h.page.chooseMode(h.profile.ConnectionMode.Local);
  h.page.name = name;
  h.page.token = token;
}

function remoteDraft(h) {
  h.page.addConnection();
  h.page.chooseMode(h.profile.ConnectionMode.Remote);
  h.page.name = 'Home desktop';
  assert.equal(h.page.serviceUrl, '');
  h.page.serviceUrl = 'https://broker.example';
  h.page.account = 'tenant';
  h.page.password = 'account-password';
}

async function savedRemote(h) {
  remoteDraft(h);
  await h.page.login();
  h.page.selectBroker(h.page.brokers[0]);
  h.page.token = 'dsh-token';
  h.page.peerPassword = 'peer-password';
  await h.page.saveConnection();
  const saved = h.page.connections[0];
  h.page.editConnection(saved);
  return saved;
}

function renderedSave(page) {
  const compiled = process.env.DSH_ARKUI_COMPILED_HOME;
  const filename = compiled ?? path.join(ets, 'pages/ConnectionHome.ets');
  const source = fs.readFileSync(filename, 'utf8').replace('export struct ConnectionHome', 'export class ConnectionHome');
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (compiled) assert.equal(file.parseDiagnostics.length, 0, 'SDK-generated Save program must parse without recovery');
  let menu;
  function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
  visit(file, node => { if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'destinationMenu') menu = node; });
  assert(menu, 'Save must be owned by the native destination menu');
  let enabled, click;
  visit(menu, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text === 'enabled') enabled = node.arguments[0];
    if (node.expression.name.text === 'onClick') click = node.arguments[0];
  });
  assert(enabled && click);
  const script = ts.transpileModule('export function bind() { return { enabled: () => (' +
    enabled.getText(file) + '), click: ' + click.getText(file) + ' }; }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(script, { exports });
  return exports.bind.call(page);
}

function renderedConnectionRows(h) {
  const filename = process.env.DSH_ARKUI_COMPILED_HOME ?? path.join(ets, 'pages/ConnectionHome.ets');
  const source = fs.readFileSync(filename, 'utf8').replace('export struct ConnectionHome', 'export class ConnectionHome');
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const methods = new Map();
  function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
  visit(file, node => { if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(file), node); });
  let key;
  visit(methods.get('homePage'), node => {
    if (!ts.isCallExpression(node)) return;
    if (node.expression.getText(file) === 'ForEach') key = node.arguments[2];
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'forEachUpdateFunction') key = node.arguments[3];
  });
  const text = [];
  const clicks = [];
  visit(methods.get('connectionRow'), node => {
    if (!ts.isCallExpression(node)) return;
    if (node.expression.getText(file) === 'Text' ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(file) === 'Text' && node.expression.name.text === 'create')) text.push(node.arguments[0]);
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'onClick') clicks.push(node.arguments[0]);
  });
  assert(key && text.length >= 3 && clicks.length === 2);
  const exports = {};
  const javascript = ts.transpileModule('export function bind() { return ' + key.getText(file) + '; }\n' +
    'export function row(connection) { return { name: () => (' + text[0].getText(file) + '), detail: () => (' +
    text[2].getText(file) + '), open: ' + clicks[0].getText(file) + ', edit: ' + clicks[1].getText(file) + ' }; }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(javascript, { exports, ConnectionMode: h.profile.ConnectionMode });
  const identity = exports.bind.call(h.page);
  let rows = new Map();
  return { update() {
    const next = new Map();
    for (const connection of h.page.connections) {
      const id = identity(connection);
      // ArkUI ForEach retains an existing subtree and its captured builder argument while its key is unchanged.
      next.set(id, rows.get(id) ?? exports.row.call(h.page, connection));
    }
    rows = next;
    return [...rows.values()];
  } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const fieldFixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const compiledField = process.env.DSH_ARKUI_COMPILED_FIELD ?? path.join(fieldFixtures, 'connection-field.sdk.js');

/** Executes compiler-generated creation callbacks, including their native input update arguments. */
function renderedField(page, property, onEdited = () => {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(fieldFixtures, 'connection-field.sdk.json'), 'utf8'));
  const inputSource = fs.readFileSync(path.join(ets, 'pages/ConnectionField.ets'));
  assert.equal(createHash('sha256').update(inputSource).digest('hex'), metadata.sourceSha256,
    'ConnectionField changed: regenerate its SDK fixture before relying on render regressions');
  if (!process.env.DSH_ARKUI_COMPILED_FIELD) {
    assert.equal(createHash('sha256').update(fs.readFileSync(compiledField)).digest('hex'), metadata.fixtureSha256);
  }
  const input = { text: '', enabled: true, onChange: undefined };
  class ViewPU {
    callbacks = [];
    observeComponentCreation2(callback) { this.callbacks.push(callback); callback(this.callbacks.length, true); }
    updateDirtyElements() { this.callbacks.forEach((callback, index) => callback(index + 1, false)); }
  }
  class OneWay {
    constructor(value) { this.value = value; }
    get() { return this.value; }
    set(value) { this.value = value; }
    reset(value) { this.value = value; }
  }
  class TwoWay {
    constructor(source) { this.source = source; }
    get() { return this.source.get(); }
    set(value) { this.source.set(value); }
  }
  const inert = new Proxy({}, { get: () => () => {} });
  const textInput = new Proxy({
    create(options) { input.text = options.text; },
    enabled(value) { input.enabled = value; },
    onChange(callback) { input.onChange = callback; }
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const output = ts.transpileModule(fs.readFileSync(compiledField, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  } });
  const exports = {};
  vm.runInNewContext(output.outputText, { exports, ViewPU,
    SynchedPropertySimpleOneWayPU: OneWay, SynchedPropertySimpleTwoWayPU: TwoWay,
    Column: inert, Text: inert, TextInput: textInput,
    HorizontalAlign: { Start: 0 }, InputType: { Normal: 0, Password: 1 } }, { filename: compiledField });
  const source = { get: () => page[property], set: value => { page[property] = value; } };
  const field = new exports.ConnectionField(null, { value: source, secret: true, locked: false, onEdited });
  field.initialRender();
  return { input,
    edit(value) { input.text = value; input.onChange(value); },
    update() { field.updateStateVars({ secret: true, locked: page.busy }); field.rerender(); }
  };
}

for (const outcome of ['ok', 'unauthorized', 'throws']) {
  test(`a pending local test retains the draft and reports its final status: ${outcome}`, async () => {
    const h = harness();
    await h.ready();
    localDraft(h, 'Unchanged name', 'keep + this / token & 中文');
    h.page.port = '3091';
    const original = h.page.profile();
    const message = h.page.message.name;
    const blocked = deferred();
    h.control.probe = () => blocked.promise;
    h.page.runTask(() => h.page.testConnection());
    assert.equal(h.page.busy, true);
    assert.equal(h.page.testState, h.states.Testing);
    assert.equal(h.page.message.name, message, 'progress uses the test indicator without replacing status copy');
    assert.equal(h.page.token, original.token);
    assert.equal(h.page.name, original.name);
    assert.equal(h.page.port, '3091');
    assert.equal(h.calls.find(([name]) => name === 'probe')[1].token, original.token);
    await h.page.testConnection();
    assert.equal(h.calls.filter(([name]) => name === 'probe').length, 1, 'busy testing cannot start another probe');
    if (outcome === 'throws') blocked.reject(new Error('probe transport failed'));
    else blocked.resolve({ state: outcome, httpStatus: outcome === 'ok' ? 200 : 401 });
    await h.page.pendingWork;
    assert.equal(h.page.busy, false);
    assert.equal(h.page.testState, outcome === 'ok' ? h.states.Success : h.states.Failure);
    assert.equal(h.page.token, original.token);
    assert.equal(h.page.name, original.name);
    assert.equal(h.page.port, '3091');
    assert.deepEqual(h.control.opened, []);
    if (outcome === 'ok') assert.equal(h.page.message.name, message);
    else assert.equal(h.page.messageError, true);
  });
}

test('invalid drafts replace stale success with failure without opening native transport', async () => {
  for (const invalid of ['token', 'port', 'remote']) {
    const h = harness();
    await h.ready();
    localDraft(h, 'Validation draft', 'kept valid token');
    h.page.testState = h.states.Success;
    if (invalid === 'token') h.page.token = '';
    else if (invalid === 'port') h.page.port = '65536';
    else h.page.mode = h.profile.ConnectionMode.Remote;
    await h.page.testConnection();
    assert.equal(h.page.testState, h.states.Failure, invalid);
    assert.equal(h.page.busy, false);
    assert.equal(h.page.messageError, true);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.control.opened, []);
  }
});

test('a failed remote mapping close reports failure and unlocks the unchanged draft', async () => {
  const h = harness();
  await h.ready();
  remoteDraft(h);
  await h.page.login();
  h.page.selectBroker(h.page.brokers[0]);
  h.page.token = 'remote DSH token';
  h.page.peerPassword = 'peer password';
  const original = h.page.profile();
  h.control.close = async () => { throw new Error('mapping teardown failed'); };
  await h.page.testConnection();
  assert.equal(h.page.testState, h.states.Failure);
  assert.equal(h.page.busy, false);
  assert.equal(h.page.token, original.token);
  assert.equal(h.page.peerPassword, original.peerPassword);
  assert.equal(h.page.message.name, 'app.string.broker_connection_failed');
  assert.deepEqual(h.control.opened, []);
  h.control.close = undefined;
  await h.page.testConnection();
  assert.equal(h.page.testState, h.states.Success, 'a retry can complete after cleanup recovers');
});

test('leaving a pending test prevents a late success and preserves the typed token', async () => {
  const h = harness();
  await h.ready();
  localDraft(h, 'Pending local', 'kept across Back');
  const blocked = deferred();
  h.control.probe = () => blocked.promise;
  h.page.runTask(() => h.page.testConnection());
  const back = h.page.goBack();
  await tick();
  blocked.resolve({ state: 'ok', httpStatus: 200 });
  await back;
  assert.notEqual(h.page.testState, h.states.Success);
  assert.equal(h.page.token, 'kept across Back');
  h.page.chooseMode(h.profile.ConnectionMode.Local);
  assert.equal(h.page.testState, h.states.Idle);
});

test('new remote drafts require a user-entered service and reset prior test results', async () => {
  const h = harness();
  await h.ready();
  assert.equal(h.page.serviceUrl, '');
  h.page.serviceUrl = 'https://previous.example';
  h.page.testState = h.states.Failure;
  h.page.addConnection();
  assert.equal(h.page.serviceUrl, '');
  assert.equal(h.page.testState, h.states.Idle);
  h.page.chooseMode(h.profile.ConnectionMode.Remote);
  assert.equal(h.page.serviceUrl, '');
  h.page.account = 'tenant';
  h.page.password = 'account-password';
  await h.page.login();
  assert.equal(h.page.message.name, 'app.string.login_required');
  assert.deepEqual(h.calls, []);
});

test('version-one records retain connection settings while retired and unowned fields are dropped', async () => {
  const h = harness();
  await h.ready();
  remoteDraft(h);
  await h.page.login();
  h.page.selectBroker(h.page.brokers[0]);
  h.page.token = 'legacy DSH token';
  h.page.peerPassword = 'legacy peer password';
  const current = h.page.profile();
  const legacy = { ...current, caPath: '/private/retired-certificate.pem', extraSetting: 'unowned' };
  const raw = JSON.stringify({ version: 1, connections: [legacy] });
  h.disk.set('connections_v1', raw);
  const loaded = await new h.store.ConnectionStore().load({});
  assert.equal(loaded[0].id, current.id);
  assert.equal(loaded[0].token, current.token);
  assert.equal(loaded[0].accessToken, current.accessToken);
  assert.equal(loaded[0].serviceUrl, current.serviceUrl);
  assert.equal('caPath' in loaded[0], false);
  assert.equal('extraSetting' in loaded[0], false);
  const encoded = JSON.parse(h.profile.encodeConnections([legacy]));
  assert.equal(encoded.version, 1);
  assert.equal(encoded.connections[0].token, current.token);
  assert.equal('caPath' in encoded.connections[0], false);
  assert.equal('extraSetting' in encoded.connections[0], false);
});

test('SDK-generated input retains its edited value across busy and result updates', async () => {
  for (const outcome of ['ok', 'unauthorized']) {
    const h = harness();
    await h.ready();
    localDraft(h, 'Rendered draft', '');
    const field = renderedField(h.page, 'token', () => { h.page.testState = h.states.Idle; });
    assert.equal(field.input.text, '');
    const token = 'typed + token / & 中文';
    field.edit(token);
    assert.equal(h.page.token, token);
    const blocked = deferred();
    h.control.probe = () => blocked.promise;
    h.page.runTask(() => h.page.testConnection());
    field.update();
    assert.equal(field.input.enabled, false);
    assert.equal(field.input.text, token, 'the native update must read the edited link rather than its initial blank value');
    blocked.resolve({ state: outcome, httpStatus: outcome === 'ok' ? 200 : 401 });
    await h.page.pendingWork;
    field.update();
    assert.equal(field.input.enabled, true);
    assert.equal(field.input.text, token);
    assert.equal(h.page.testState, outcome === 'ok' ? h.states.Success : h.states.Failure);
  }
});

test('SDK-generated field callbacks invalidate identity before updating the parent link', async () => {
  for (const property of ['account', 'serviceUrl']) {
    const h = harness();
    await h.ready();
    remoteDraft(h);
    await h.page.login();
    h.page.selectBroker(h.page.brokers[0]);
    h.page.peerPassword = 'peer password';
    const previous = h.page[property];
    let observedBeforeEdit;
    const field = renderedField(h.page, property, value => {
      observedBeforeEdit = h.page[property];
      if (property === 'account') h.page.changeAccount(value);
      else h.page.changeService(value);
    });
    const next = property === 'account' ? 'other-account' : 'https://other-broker.example';
    field.edit(next);
    assert.equal(observedBeforeEdit, previous);
    assert.equal(h.page[property], next);
    for (const key of ['accessToken', 'brokerId', 'brokerName', 'peerPassword']) assert.equal(h.page[key], '');
    field.update();
    assert.equal(field.input.text, next);
  }
});

test('the home loads saved connections without opening WebView', async () => {
  const h = harness();
  await h.ready();
  assert.equal(h.page.loaded, true);
  assert.equal(h.page.connections.length, 0);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.control.opened, []);
  assert.equal(h.page.controller.back(), false);
});

test('a local connection survives restart, editing and a fresh authenticated open', async () => {
  const h = harness();
  await h.ready();
  localDraft(h);
  assert.equal(h.page.port, '3080');
  await h.page.testConnection();
  assert.equal(h.page.testState, h.states.Success);
  assert.equal(h.page.token, 'local token & 中文');
  await h.page.saveConnection();
  assert.equal(h.page.connections.length, 1);
  const { ConnectionStore } = h.store;
  const loaded = await new ConnectionStore().load({});
  assert.equal(loaded[0].name, 'On this device');
  assert.equal(loaded[0].token, 'local token & 中文');
  h.page.editConnection(loaded[0]);
  h.page.name = 'Personal';
  h.page.port = '3090';
  await h.page.saveConnection();
  assert.equal(h.page.connections.length, 1);
  assert.equal(h.page.connections[0].id, loaded[0].id);
  await h.page.openConnection(h.page.connections[0]);
  const address = new URL(h.control.opened[0][0]);
  assert.equal(address.origin, 'http://127.0.0.1:3090');
  assert.equal(address.searchParams.get('token'), 'local token & 中文');
  assert.equal(h.control.opened[0][1], false);
});

test('invalid port, missing token and authentication failure keep WebView closed', async () => {
  const h = harness();
  await h.ready();
  localDraft(h, 'Local', '');
  await h.page.testConnection();
  assert.equal(h.page.message.name, 'app.string.token_required');
  h.page.token = 'wrong';
  h.page.port = '65536';
  await h.page.testConnection();
  assert.equal(h.page.message.name, 'app.string.port_invalid');
  assert.equal(h.calls.length, 0);
  h.page.port = '3080';
  h.control.probeState = 'unauthorized';
  await h.page.testConnection();
  assert.equal(h.page.message.name, 'app.string.connection_token_failed');
  await h.page.openConnection(h.page.profile());
  assert.equal(h.control.opened.length, 0);
});

test('a failed flush retains the saved list and does not announce completion', async () => {
  const h = harness();
  await h.ready();
  localDraft(h, 'Existing', 'fixture');
  await h.page.saveConnection();
  const previous = h.disk.get('connections_v1');
  h.page.editConnection(h.page.connections[0]);
  h.page.name = 'Unsaved';
  h.control.failFlush = true;
  await h.page.saveConnection();
  assert.equal(h.page.message.name, 'app.string.connection_save_failed');
  assert.equal(h.page.connections[0].name, 'Existing');
  assert.equal(h.disk.get('connections_v1'), previous);
  assert.equal(h.memory.get('connections_v1'), previous);
});

test('corrupt or future preferences cannot be silently replaced by a new connection', async () => {
  for (const raw of ['{"version":2,"connections":[]}', '{', '{"version":1,"connections":[null]}']) {
    const h = harness();
    h.disk.set('connections_v1', raw);
    await h.ready();
    assert.equal(h.page.loaded, false);
    localDraft(h, 'New', 'fixture');
    await h.page.saveConnection();
    assert.equal(h.disk.get('connections_v1'), raw);
  }
});

test('remote login precedes broker selection and mapping to the chosen DSH port', async () => {
  const h = harness();
  await h.ready();
  remoteDraft(h);
  await h.page.login();
  assert.deepEqual(h.calls.map(call => call[0]), ['login', 'list']);
  assert.equal(h.page.password, '', 'account password is not retained after login');
  assert.equal(h.page.brokers.length, 2);
  h.page.selectBroker(h.page.brokers[0]);
  h.page.port = '3088';
  h.page.token = 'dsh-token';
  h.page.peerPassword = 'peer-password';
  await h.page.testConnection();
  assert.deepEqual(h.calls.map(call => call[0]), ['login', 'list', 'connect', 'probe', 'close']);
  const options = h.calls.find(call => call[0] === 'connect')[1];
  assert.equal(options.serviceUrl, 'https://broker.example');
  assert.equal('caPath' in options, false);
  assert(h.calls.filter(([name]) => name === 'login' || name === 'list').every(([, options]) => !('caPath' in options)));
  assert.equal(options.brokerId, 'online-broker');
  assert.equal(options.remotePort, 3088);
  assert.equal(options.tempDir, '/private/temp/dsh-broker');
  assert.equal(options.peerPassword, 'peer-password');
  assert.equal(h.calls.find(call => call[0] === 'probe')[1].origin, 'http://127.0.0.1:43219');
  await h.page.saveConnection();
  const record = JSON.parse(h.disk.get('connections_v1')).connections[0];
  assert.equal(record.accessToken, 'account-bearer');
  assert.equal('password' in record, false);
  await h.page.openConnection(h.page.connections[0]);
  h.page.aboutToDisappear();
  await tick();
  assert.deepEqual(h.control.opened, [['http://127.0.0.1:43219/?token=dsh-token', true]]);
  assert.equal(h.calls.filter(call => call[0] === 'close').length, 1,
    'a successful open transfers the mapping to the WebView parent');
});

test('editing a saved remote connection keeps its mode and clears navigation only after saving', async () => {
  const h = harness();
  await h.ready();
  const saved = await savedRemote(h);
  assert.equal(h.page.mode, h.profile.ConnectionMode.Remote);
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
  h.page.name = 'Renamed remote';
  await h.page.saveConnection();
  assert.equal(h.page.paths.size(), 0);
  assert.equal(h.page.page, h.routes.Home);
  assert.deepEqual(h.page.paths.operations.at(-1), ['clear', true]);
  const connection = h.page.connections[0];
  assert.equal(connection.mode, 'remote');
  assert.equal(connection.id, saved.id);
  for (const key of ['serviceUrl', 'account', 'accessToken', 'brokerId', 'brokerName', 'peerPassword']) {
    assert.equal(connection[key], saved[key], key);
  }
  assert.equal('caPath' in connection, false);
});

for (const mode of ['local', 'remote']) {
  test(`the rendered Save handler commits an edited ${mode} connection and returns to the navigation root`, async () => {
    const h = harness();
    await h.ready();
    let saved;
    if (mode === 'remote') saved = await savedRemote(h);
    else {
      localDraft(h);
      await h.page.saveConnection();
      saved = h.page.connections[0];
      h.page.editConnection(saved);
    }
    const previous = h.disk.get('connections_v1');
    h.page.name = 'Updated ' + mode;
    h.page.port = '3098';
    h.page.token = 'edited token ' + mode;
    const menu = renderedSave(h.page);
    assert.equal(menu.enabled(), true);
    const blocked = deferred();
    h.control.flushWait = blocked.promise;
    menu.click();
    assert.equal(h.page.busy, true);
    assert.equal(menu.enabled(), false);
    await tick();
    assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
    assert.equal(h.disk.get('connections_v1'), previous);
    blocked.resolve();
    await h.page.pendingWork;
    const stored = JSON.parse(h.disk.get('connections_v1')).connections;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, saved.id);
    assert.equal(stored[0].name, 'Updated ' + mode);
    assert.equal(stored[0].port, 3098);
    assert.equal(stored[0].token, 'edited token ' + mode);
    assert.equal(stored[0].mode, mode);
    assert.equal(h.page.paths.size(), 0);
    assert.equal(h.page.page, h.routes.Home);
    assert.equal(h.page.currentPage(), h.routes.Home);
    assert.equal(h.page.busy, false);
    assert.equal(h.page.message.name, 'app.string.connection_saved');
  });

  test(`a refused write from the rendered ${mode} Save handler retains the editor and stored connection`, async () => {
    const h = harness();
    await h.ready();
    if (mode === 'remote') await savedRemote(h);
    else {
      localDraft(h);
      await h.page.saveConnection();
      h.page.editConnection(h.page.connections[0]);
    }
    const previous = h.disk.get('connections_v1');
    h.page.name = 'Unsaved edit';
    h.control.failFlush = true;
    const menu = renderedSave(h.page);
    menu.click();
    await h.page.pendingWork;
    assert.equal(h.disk.get('connections_v1'), previous);
    assert.equal(h.memory.get('connections_v1'), previous);
    assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
    assert.equal(h.page.page, h.routes.Config);
    assert.equal(h.page.name, 'Unsaved edit');
    assert.equal(h.page.message.name, 'app.string.connection_save_failed');
    assert.equal(h.page.busy, false);
    assert.equal(menu.enabled(), true);
  });
}

for (const mode of ['local', 'remote']) {
  test(`saved ${mode} edits refresh cached Home text and Edit/Open handlers without restarting`, async () => {
    const h = harness();
    await h.ready();
    if (mode === 'remote') { await savedRemote(h); await h.page.goBack(); }
    else { localDraft(h); await h.page.saveConnection(); }
    const list = renderedConnectionRows(h);
    const before = list.update()[0];
    before.edit();
    h.page.name = 'Fresh Home ' + mode;
    h.page.port = '3099';
    h.page.token = 'fresh first token';
    renderedSave(h.page).click();
    await h.page.pendingWork;
    assert.equal(h.page.paths.size(), 0);
    const after = list.update()[0];
    assert.equal(after.name(), 'Fresh Home ' + mode);
    assert(after.detail().includes('3099'));
    after.edit();
    assert.equal(h.page.name, 'Fresh Home ' + mode);
    assert.equal(h.page.port, '3099');
    assert.equal(h.page.token, 'fresh first token');
    h.page.token = 'fresh token only';
    renderedSave(h.page).click();
    await h.page.pendingWork;
    const tokenOnly = list.update()[0];
    assert.equal(tokenOnly.name(), after.name());
    assert.equal(tokenOnly.detail(), after.detail());
    tokenOnly.open();
    await h.page.pendingWork;
    const probe = h.calls.findLast(([name]) => name === 'probe')[1];
    assert.equal(probe.token, 'fresh token only', 'an unchanged visible name must not preserve the old Open callback');
    assert.equal(h.control.opened.length, 1);
    assert.equal(new URL(h.control.opened[0][0]).searchParams.get('token'), 'fresh token only');
    tokenOnly.edit();
    assert.equal(h.page.token, 'fresh token only');
    assert.equal(JSON.parse(h.disk.get('connections_v1')).connections[0].token, 'fresh token only');
  });
}

test('routes use a single animated stack and system Back pops the current destination', async () => {
  const h = harness();
  await h.ready();
  assert.equal(h.page.controller.back(), false);
  h.page.addConnection();
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Mode]);
  h.page.chooseMode(h.profile.ConnectionMode.Local);
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Mode, h.routes.Config]);
  assert.deepEqual(h.page.paths.operations, [['push', h.routes.Mode, true], ['push', h.routes.Config, true]]);
  await h.page.goBack();
  assert.equal(h.page.page, h.routes.Mode);
  assert.equal(h.page.currentPage(), h.routes.Mode);
  assert.deepEqual(h.page.paths.operations.at(-1), ['pop', true]);
  await h.page.goBack();
  assert.equal(h.page.page, h.routes.Home);
  assert.equal(h.page.paths.size(), 0);
  assert.equal(h.page.controller.back(), false);
});

test('native Back awaits pending mapping work even when close rejects and prevents late handoff', async () => {
  const h = harness();
  await h.ready();
  const saved = await savedRemote(h);
  const blocked = deferred();
  h.control.connect = () => blocked.promise;
  h.control.close = async () => { throw new Error('close rejected'); };
  h.page.runTask(() => h.page.openConnection(saved));
  let backWork;
  const goBack = h.page.goBack.bind(h.page);
  h.page.goBack = () => { const work = goBack(); backWork ??= work; return work; };
  assert.equal(h.page.controller.back(), true, 'the synchronous handler owns asynchronous cleanup');
  assert.equal(h.page.controller.back(), true, 'a second Back must not pop another route');
  await tick();
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
  assert.equal(h.page.busy, true);
  assert.equal(h.page.paths.operations.filter(([action]) => action === 'pop').length, 0);
  blocked.resolve({ state: 'connected', localUrl: 'http://127.0.0.1:43219/' });
  await backWork;
  assert.equal(h.page.paths.size(), 0);
  assert.equal(h.page.page, h.routes.Home);
  assert.equal(h.page.busy, false);
  assert.equal(h.page.paths.operations.filter(([action]) => action === 'pop').length, 1);
  assert.deepEqual(h.control.opened, []);
  assert.equal(h.calls.some(([name]) => name === 'probe'), false);
});

test('cancelled service editing restores the authenticated identity and keeps other draft edits', async () => {
  const h = harness();
  await h.ready();
  const saved = await savedRemote(h);
  const durable = h.disk.get('connections_v1');
  h.page.name = 'Unsaved draft name';
  h.page.token = 'unsaved DSH token';
  h.page.port = '3091';
  h.page.modifyService();
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config, h.routes.Login]);
  h.page.changeService('https://changed-broker.example');
  h.page.changeAccount('changed-account');
  h.page.password = 'unsubmitted password';
  await h.page.goBack();
  for (const key of ['serviceUrl', 'account', 'accessToken', 'brokerId', 'brokerName', 'peerPassword']) {
    assert.equal(h.page[key], saved[key], key);
  }
  assert.equal(h.page.password, '');
  assert.equal(h.page.identityBeforeEdit, undefined);
  assert.equal(h.page.editingId, saved.id);
  assert.equal(h.page.name, 'Unsaved draft name');
  assert.equal(h.page.token, 'unsaved DSH token');
  assert.equal(h.page.port, '3091');
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
  assert.equal(h.disk.get('connections_v1'), durable);
});

test('reauthenticating the same service and account returns to its original Config with the selected online broker', async () => {
  const h = harness();
  await h.ready();
  const saved = await savedRemote(h);
  h.page.name = 'Preserved draft';
  h.page.token = 'preserved token';
  h.page.modifyService();
  h.page.password = 'new account password';
  await h.page.login();
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
  assert.deepEqual(h.page.paths.operations.at(-1), ['popToIndex', 0, true]);
  assert.equal(h.page.paths.operations.filter(([action, name]) => action === 'push' && name === h.routes.Config).length, 2,
    'one Config push created the connection and one opened its saved editor; reauthentication must not add another');
  assert.equal(h.page.editingId, saved.id);
  assert.equal(h.page.brokerId, saved.brokerId);
  assert.equal(h.page.peerPassword, saved.peerPassword);
  assert.equal(h.page.password, '');
  assert.equal(h.page.name, 'Preserved draft');
  assert.equal(h.page.token, 'preserved token');
});

test('changed service identities choose a broker and return to the same Config without persisting the draft', async () => {
  for (const changed of ['service', 'account']) {
    const h = harness();
    await h.ready();
    const saved = await savedRemote(h);
    const durable = h.disk.get('connections_v1');
    h.page.name = 'Changed identity draft';
    h.page.port = '3092';
    h.page.token = 'same DSH token';
    h.page.modifyService();
    if (changed === 'service') h.page.changeService('https://different-broker.example');
    else h.page.changeAccount('different-account');
    h.page.password = 'account password';
    await h.page.login();
    assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config, h.routes.Login, h.routes.Brokers]);
    h.page.selectBroker(h.page.brokers[0]);
    assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
    assert.deepEqual(h.page.paths.operations.at(-1), ['popToIndex', 0, true]);
    assert.equal(h.page.editingId, saved.id);
    assert.equal(h.page.name, 'Changed identity draft');
    assert.equal(h.page.port, '3092');
    assert.equal(h.page.token, 'same DSH token');
    assert.equal(h.page.peerPassword, '', 'peer credentials cannot be reused under another identity');
    assert.equal(h.disk.get('connections_v1'), durable);
  }
});

test('an unavailable previous broker requires selection before returning from service editing', async () => {
  const h = harness();
  await h.ready();
  await savedRemote(h);
  h.page.modifyService();
  h.control.brokers = [
    { id: 'online-broker', name: 'Old workstation', online: false },
    { id: 'new-broker', name: 'New workstation', online: true }
  ];
  h.page.password = 'account password';
  await h.page.login();
  assert.equal(h.page.page, h.routes.Brokers);
  h.page.selectBroker(h.page.brokers[1]);
  assert.equal(h.page.brokerId, 'new-broker');
  assert.equal(h.page.peerPassword, '');
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
});

test('broker editing retains the current peer password only when selecting the same online broker', async () => {
  const h = harness();
  await h.ready();
  const saved = await savedRemote(h);
  await h.page.changeBroker();
  const before = h.page.paths.getAllPathName();
  h.page.selectBroker(h.page.brokers[1]);
  assert.deepEqual(h.page.paths.getAllPathName(), before, 'offline rows cannot be selected');
  assert.equal(h.page.brokerId, saved.brokerId);
  h.page.busy = true;
  h.page.selectBroker({ id: 'new-broker', name: 'Other', online: true });
  assert.equal(h.page.brokerId, saved.brokerId);
  h.page.busy = false;
  h.page.selectBroker(h.page.brokers[0]);
  assert.equal(h.page.peerPassword, saved.peerPassword);
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
  await h.page.changeBroker();
  h.page.selectBroker({ id: 'new-broker', name: 'Other', online: true });
  assert.equal(h.page.peerPassword, '');
  assert.equal(h.page.brokerName, 'Other');
  assert.equal(h.page.editingId, saved.id);
  assert.deepEqual(h.page.paths.getAllPathName(), [h.routes.Config]);
});

test('Delete is unavailable for a new draft and returns a deleted saved connection to the root', async () => {
  const h = harness();
  await h.ready();
  localDraft(h);
  const before = h.page.paths.getAllPathName();
  await h.page.deleteConnection();
  assert.equal(h.disk.get('connections_v1'), undefined);
  assert.deepEqual(h.page.paths.getAllPathName(), before);
  await h.page.saveConnection();
  h.page.editConnection(h.page.connections[0]);
  await h.page.deleteConnection();
  assert.equal(h.page.connections.length, 0);
  assert.equal(h.page.paths.size(), 0);
  assert.equal(h.page.page, h.routes.Home);
  assert.deepEqual(h.page.paths.operations.at(-1), ['clear', true]);
  assert.equal(JSON.parse(h.disk.get('connections_v1')).connections.length, 0);
});

test('Back waits for cancelled remote work and prevents a late mapping transfer', async () => {
  const h = harness();
  await h.ready();
  remoteDraft(h);
  await h.page.login();
  h.page.selectBroker(h.page.brokers[0]);
  h.page.token = 'dsh-token';
  h.page.peerPassword = 'peer-password';
  const connection = h.page.profile();
  const blocked = deferred();
  h.control.connect = () => blocked.promise;
  h.page.runTask(() => h.page.openConnection(connection));
  const back = h.page.goBack();
  await tick();
  assert.equal(h.page.busy, true, 'navigation awaits the owner operation after cancellation');
  blocked.resolve({ state: 'connected', localUrl: 'http://127.0.0.1:43219/' });
  await back;
  assert.equal(h.page.busy, false);
  assert.deepEqual(h.control.opened, []);
  assert.equal(h.calls.some(call => call[0] === 'probe'), false);
  assert.equal(h.calls.filter(call => call[0] === 'close').length, 2);
});

test('Back during a committed save waits for persistence and reloads the committed connection', async () => {
  const h = harness();
  await h.ready();
  localDraft(h, 'Pending save', 'kept token');
  const blocked = deferred();
  h.control.flushWait = blocked.promise;
  h.page.runTask(() => h.page.saveConnection());
  await tick();
  assert.equal(h.disk.get('connections_v1'), undefined);
  const back = h.page.goBack();
  await tick();
  assert.equal(h.page.busy, true);
  assert.equal(h.disk.get('connections_v1'), undefined, 'Back must wait for durable persistence');
  blocked.resolve();
  await back;
  while (h.page.paths.size() > 0) await h.page.goBack();
  assert.equal(JSON.parse(h.disk.get('connections_v1')).connections[0].token, 'kept token');
  assert.equal(h.page.connections[0].name, 'Pending save');
});

test('detaching during a save preserves the completed write for the next appearance', async () => {
  const h = harness();
  await h.ready();
  localDraft(h, 'Detached save', 'persisted token');
  const blocked = deferred();
  h.control.flushWait = blocked.promise;
  h.page.runTask(() => h.page.saveConnection());
  await tick();
  h.page.aboutToDisappear();
  await tick();
  assert.equal(h.disk.get('connections_v1'), undefined);
  blocked.resolve();
  await h.page.pendingWork;
  await h.ready();
  assert.equal(h.page.connections[0].name, 'Detached save');
  assert.equal(h.page.connections[0].token, 'persisted token');
});

test('changing the remote account or service requires a fresh login before saving', async () => {
  for (const field of ['account', 'service']) {
    const h = harness();
    await h.ready();
    remoteDraft(h);
    await h.page.login();
    h.page.selectBroker(h.page.brokers[0]);
    h.page.token = 'dsh-token';
    h.page.peerPassword = 'peer-password';
    await h.page.saveConnection();
    const previous = h.disk.get('connections_v1');
    h.page.editConnection(h.page.connections[0]);
    if (field === 'account') {
      h.page.changeAccount(h.page.account);
      assert.equal(h.page.accessToken, 'account-bearer', 'unchanged account retains its authenticated identity');
      h.page.changeAccount('other-account');
    } else {
      h.page.changeService(h.page.serviceUrl);
      assert.equal(h.page.accessToken, 'account-bearer', 'unchanged service retains its authenticated identity');
      h.page.changeService('https://other-broker.example:18443');
    }
    for (const key of ['accessToken', 'brokerId', 'brokerName', 'peerPassword']) {
      assert.equal(h.page[key], '', `${field}: ${key} must belong to the new login`);
    }
    await h.page.saveConnection();
    assert.equal(h.page.message.name, 'app.string.remote_config_required');
    assert.equal(h.disk.get('connections_v1'), previous, 'old bearer cannot be saved under a different identity');
  }
});

test('expired broker authentication routes a saved remote connection to login while DSH token failures stay on home', async () => {
  for (const failure of ['broker-auth', 'dsh-token']) {
    const h = harness();
    await h.ready();
    remoteDraft(h);
    await h.page.login();
    h.page.selectBroker(h.page.brokers[0]);
    h.page.token = 'dsh-token';
    h.page.peerPassword = 'peer-password';
    await h.page.saveConnection();
    const connection = h.page.connections[0];
    const previous = h.disk.get('connections_v1');
    const homePage = h.page.page;
    if (failure === 'broker-auth') {
      h.control.connect = async () => { throw Object.assign(new Error('Account login has expired'), { code: 'DSH_BROKER_AUTH' }); };
    } else {
      h.control.probeState = 'unauthorized';
    }
    await h.page.openConnection(connection);
    assert.deepEqual(h.control.opened, []);
    assert.equal(h.disk.get('connections_v1'), previous, 'opening failure preserves the saved connection');
    if (failure === 'broker-auth') {
      assert.equal(h.page.message.name, 'app.string.broker_login_expired');
      assert.equal(h.page.title().name, 'app.string.remote_login');
      assert.equal(h.page.editingId, connection.id);
      assert.equal(h.page.accessToken, '');
      assert.equal(h.page.token, connection.token, 'broker expiry does not alter the independent DSH token');
      assert.equal(h.calls.some(call => call[0] === 'probe'), false);
    } else {
      assert.equal(h.page.message.name, 'app.string.connection_token_failed');
      assert.equal(h.page.page, homePage);
      assert.equal(h.page.connections[0].accessToken, 'account-bearer');
      assert.equal(h.calls.some(call => call[0] === 'probe'), true);
    }
    assert.equal(h.calls.filter(call => call[0] === 'close').length, 1, 'the failed remote mapping is released');
  }
});

for (const failure of ['callback throws', 'callback refuses', 'URL encoding throws']) {
  test(`a remote mapping is released when the WebView handoff fails: ${failure}`, async () => {
    const h = harness();
    await h.ready();
    remoteDraft(h);
    await h.page.login();
    h.page.selectBroker(h.page.brokers[0]);
    h.page.token = 'dsh-token';
    h.page.peerPassword = 'peer-password';
    const connection = h.page.profile();
    let callbacks = 0;
    h.page.onOpen = () => {
      callbacks += 1;
      if (failure === 'callback throws') throw new Error('WebView constructor failed');
      return false;
    };
    if (failure === 'URL encoding throws') connection.token = '\ud800';
    await h.page.openConnection(connection);
    assert.equal(callbacks, failure === 'URL encoding throws' ? 0 : 1);
    assert.equal(h.page.transferred, false);
    assert.equal(h.page.busy, false);
    assert.deepEqual(h.control.opened, []);
    assert.equal(h.page.message.name, 'app.string.broker_connection_failed');
    assert.deepEqual(h.calls.map(call => call[0]), ['login', 'list', 'connect', 'probe', 'close']);
  });
}

test('a successful WebView handoff can synchronously detach the child without closing the transferred mapping', async () => {
  const h = harness();
  await h.ready();
  remoteDraft(h);
  await h.page.login();
  h.page.selectBroker(h.page.brokers[0]);
  h.page.token = 'dsh-token';
  h.page.peerPassword = 'peer-password';
  h.page.onOpen = (address, remote) => {
    h.control.opened.push([address, remote]);
    h.page.aboutToDisappear();
    return true;
  };
  h.page.runTask(() => h.page.openConnection(h.page.profile()));
  await h.page.pendingWork;
  await tick();
  assert.equal(h.page.transferred, true);
  assert.deepEqual(h.control.opened, [['http://127.0.0.1:43219/?token=dsh-token', true]]);
  assert.equal(h.calls.some(call => call[0] === 'close'), false);
});

test('service addresses reject credential destinations with userinfo, paths or HTTP', () => {
  const { serviceOrigin, connectionPort } = harness().profile;
  assert.equal(serviceOrigin('broker.oheco.org'), 'https://broker.oheco.org');
  assert.equal(serviceOrigin('https://broker.example:18443/'), 'https://broker.example:18443');
  for (const address of ['http://127.0.0.1:18443', 'http://localhost:18443', 'http://[::1]:18443',
    'http://broker.oheco.org', 'https://user:secret@broker.example',
    'https://broker.example/v1', 'https://broker.example/?token=x', 'https://broker.example:0',
    'https://broker.example\\@evil.example', '']) assert.equal(serviceOrigin(address), '', address);
  for (const value of ['0', '-1', '65536', '3080suffix', '3e3', '']) assert.equal(connectionPort(value), 0, value);
});

test('Config keeps its actions below the scroll area and Save in the native title menu', () => {
  const filename = path.join(ets, 'pages/ConnectionHome.ets');
  const source = fs.readFileSync(filename, 'utf8').replace('export struct ConnectionHome', 'export class ConnectionHome');
  // TypeScript recovers ArkUI call/block syntax; SDK compilation separately validates the complete ArkTS program.
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const methods = new Map();
  function visit(node, action) { action(node); ts.forEachChild(node, child => visit(child, action)); }
  visit(file, node => { if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(file), node); });
  function calls(node, name) {
    const found = [];
    visit(node, child => {
      if (!ts.isCallExpression(child)) return;
      const callee = child.expression;
      if ((ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(file)) === name) found.push(child);
    });
    return found;
  }
  const config = methods.get('configPage');
  assert.equal(calls(config, 'chooseMode').length, 0);
  assert.equal(calls(config, 'modePage').length, 0);
  assert.equal(calls(config, 'modifyService').length, 1);
  assert.equal(calls(config, 'changeBroker').length, 1);
  assert.equal(calls(config, 'saveConnection').length, 0);
  const menu = methods.get('destinationMenu');
  assert.equal(calls(menu, 'saveConnection').length, 1);
  assert(menu.getText(file).includes("$r('app.string.save_connection')"));
  const destination = methods.get('destination');
  const scroll = calls(destination, 'Scroll')[0];
  const statement = scroll.parent;
  const siblings = statement.parent.statements;
  const body = siblings[siblings.indexOf(statement) + 1];
  assert(ts.isBlock(body), 'the Scroll declaration must own its content block');
  assert.equal(calls(body, 'configPage').length, 1);
  assert.equal(calls(body, 'configActions').length, 0);
  const pinnedActions = calls(destination, 'configActions')[0];
  assert(pinnedActions.getStart(file) > body.end, 'bottom actions follow the closed scroll area');
  const menus = calls(destination, 'menus');
  assert.equal(menus.length, 1);
  assert.equal(calls(menus[0], 'destinationMenu').length, 1);
  const back = calls(destination, 'onBackPressed');
  assert.equal(back.length, 1);
  assert.equal(calls(back[0], 'handleBack').length, 1);
  const actions = methods.get('configActions');
  assert.equal(calls(actions, 'testConnection').length, 1);
  assert.equal(calls(actions, 'saveConnection').length, 0);
  let editOnlyDelete = false;
  visit(actions, node => {
    if (ts.isIfStatement(node) && node.expression.getText(file) === 'this.editing' &&
      calls(node.thenStatement, 'deleteConnection').length === 1) editOnlyDelete = true;
  });
  assert(editOnlyDelete, 'Delete is rendered only for a saved connection editor');
  const resources = lang => JSON.parse(fs.readFileSync(path.resolve(ets, '..', `resources/${lang}/element/string.json`), 'utf8')).string;
  for (const locale of ['base', 'zh_CN']) {
    const hint = resources(locale).find(item => item.name === 'service_address_hint').value;
    assert.equal(/broker\.oheco\.org|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(hint), false);
  }
});

test('Test keeps one centered label across result states and matches the Delete font size', () => {
  const filename = process.env.DSH_ARKUI_COMPILED_HOME ?? path.join(ets, 'pages/ConnectionHome.ets');
  const source = fs.readFileSync(filename, 'utf8').replace('export struct ConnectionHome', 'export class ConnectionHome');
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let actions;
  function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
  visit(file, node => { if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'configActions') actions = node; });
  const text = [], fonts = [], stacks = [], translations = [], areas = [];
  visit(actions, node => {
    if (!ts.isCallExpression(node)) return;
    const expression = node.expression;
    const member = ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText(file);
    const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression.getText(file) : '';
    if (member === 'Text' || (receiver === 'Text' && member === 'create')) text.push(node);
    if (member === 'Stack' || (receiver === 'Stack' && member === 'create')) stacks.push(node);
    if (member === 'fontSize') fonts.push(node.arguments[0].getText(file));
    if (member === 'translate') translations.push(node.arguments[0]);
    if (member === 'onAreaChange') areas.push(node.arguments[0]);
  });
  assert.equal(text.length, 1, 'Test uses one label with a fixed center rather than a grouped row or duplicate placeholder');
  assert.deepEqual(fonts, ['14', '14'], 'Test and Delete use the same explicit font size');
  assert(stacks.some(node => node.arguments[0]?.getText(file).includes('Alignment.Center')));
  assert.equal(translations.length, 1);
  assert.equal(areas.length, 1);
  const exports = {};
  const script = ts.transpileModule('export function bind() { return { translated: () => (' +
    translations[0].getText(file) + '), measured: ' + areas[0].getText(file) + ' }; }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(script, { exports });
  const owner = { testLabelWidth: 0 };
  const placement = exports.bind.call(owner);
  for (const width of [28, 100, 180]) {
    placement.measured({}, { width });
    assert.equal(owner.testLabelWidth, width);
    const iconCenter = placement.translated().x;
    assert.equal(iconCenter + 10, -width / 2 - 8, 'the icon ends eight units before the independently centered label');
  }
});

test('native navigation uses the current system color mode instead of a fixed dark theme', () => {
  const filename = process.env.DSH_ARKUI_COMPILED_HOME ?? path.join(ets, 'pages/ConnectionHome.ets');
  const source = fs.readFileSync(filename, 'utf8').replace('export struct ConnectionHome', 'export class ConnectionHome');
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let theme;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (expression.getText(file) === 'WithTheme' || (ts.isPropertyAccessExpression(expression) &&
        expression.expression.getText(file) === 'WithTheme' && expression.name.text === 'create')) theme = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert(theme && ts.isObjectLiteralExpression(theme), 'native navigation must receive an explicit theme mode');
  const mode = theme.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(file) === 'colorMode');
  assert(mode);
  const exports = {};
  const code = ts.transpileModule('export function currentMode() { return (' + mode.initializer.getText(file) + '); }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const ThemeColorMode = { DARK: 'dark', LIGHT: 'light', SYSTEM: 'system' };
  vm.runInNewContext(code, { exports, ThemeColorMode });
  for (const [colorMode, expected] of [[0, ThemeColorMode.DARK], [1, ThemeColorMode.LIGHT], [-1, ThemeColorMode.SYSTEM]]) {
    assert.equal(exports.currentMode.call({ colorMode }), expected);
  }
});

test('all device forms provide matching light and dark page, window, and system-bar backgrounds', () => {
  const main = path.resolve(ets, '..');
  const module = JSON.parse(fs.readFileSync(path.join(main, 'module.json5'), 'utf8')).module;
  assert.deepEqual(module.deviceTypes, ['phone', 'tablet', '2in1']);
  for (const [locale, expected] of [['base', '#FFFFFF'], ['dark', '#151517']]) {
    const colors = JSON.parse(fs.readFileSync(path.join(main, `resources/${locale}/element/color.json`), 'utf8')).color;
    for (const name of ['background', 'panel', 'start_window_background']) {
      assert.equal(colors.find(color => color.name === name)?.value, expected, locale + '/' + name);
    }
  }
  const index = fs.readFileSync(path.join(ets, 'pages/Index.ets'), 'utf8');
  assert.match(index, /Column\(\)\s*\{\s*\}\.width\('100%'\)\.height\('100%'\)\.backgroundColor\(\$r\('app\.color\.background'\)\)/,
    'the background drawing layer resolves the system-themed resource');
  const resources = lang => JSON.parse(fs.readFileSync(path.join(main, `resources/${lang}/element/string.json`), 'utf8')).string;
  assert.deepEqual(resources('base').map(item => item.name), resources('zh_CN').map(item => item.name));
});

function authenticationCookie(index, overrides = {}) {
  const cookie = { name: 'dsh-auth-' + createHash('sha256').update('synthetic-map-' + index).digest('base64url'),
    domain: '127.0.0.1', path: '/', isHttpOnly: true, ...overrides };
  Object.defineProperty(cookie, 'value', { get() { throw new Error('cookie values must not be inspected'); } });
  return cookie;
}

test('a fresh authenticated open expires seventy matching cookies before handing off and retains other cookies', async () => {
  const h = harness();
  await h.ready();
  const connection = await savedRemote(h);
  const matching = Array.from({ length: 70 }, (_, index) => authenticationCookie(index,
    { domain: index % 2 ? '.127.0.0.1' : '127.0.0.1' }));
  const retained = [authenticationCookie(70, { domain: 'example.invalid' }),
    authenticationCookie(71, { domain: '::1' }), authenticationCookie(72, { path: '/other' }),
    authenticationCookie(73, { name: 'preferences' }), authenticationCookie(74, { name: 'dsh-auth-short' }),
    authenticationCookie(75, { name: 'dsh-auth-' + 'a'.repeat(44) }),
    authenticationCookie(76, { domain: '127.0.0.1.example.invalid' })];
  h.control.cookies = [...matching, ...retained];
  h.page.onOpen = (address, remote) => {
    assert.equal(h.control.expiredCookies.length, 70, 'cleanup settles before WebView ownership');
    h.control.opened.push([address, remote]);
    return true;
  };
  await h.page.openConnection(connection);
  assert.equal(h.control.cookieReads, 1);
  assert.equal(h.control.opened.length, 1);
  assert.equal(h.page.transferred, true);
  for (const [index, args] of h.control.expiredCookies.entries()) {
    assert.deepEqual(args, ['http://127.0.0.1:43219/',
      matching[index].name + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly', false, true]);
  }
});

test('cancelling while cookie metadata is pending cannot expire a cookie or transfer a WebView', async () => {
  const h = harness();
  await h.ready();
  const connection = await savedRemote(h);
  const read = deferred();
  h.control.cookieFetch = () => read.promise;
  const opening = h.page.openConnection(connection);
  await tick();
  assert.equal(h.control.cookieReads, 1);
  h.page.aboutToDisappear();
  read.resolve([authenticationCookie(0)]);
  await opening;
  assert.equal(h.control.expiredCookies.length, 0);
  assert.equal(h.control.opened.length, 0);
  assert.equal(h.page.transferred, false);
  assert.ok(h.calls.some(call => call[0] === 'close'), 'the untransferred remote map is closed');
});

test('failed authentication leaves the WebView cookie store untouched', async () => {
  const h = harness();
  await h.ready();
  const connection = await savedRemote(h);
  h.control.probeState = 'unauthorized';
  await h.page.openConnection(connection);
  assert.equal(h.control.cookieReads, 0);
  assert.equal(h.control.expiredCookies.length, 0);
  assert.equal(h.control.opened.length, 0);
});

test('cookie preparation failure stays in the connection flow and releases its untransferred mapping', async () => {
  const h = harness();
  await h.ready();
  const connection = await savedRemote(h);
  h.control.cookieFailure = new Error('cookie manager unavailable');
  await h.page.openConnection(connection);
  assert.equal(h.page.message.name, 'app.string.connection_cookies_failed');
  assert.equal(h.control.opened.length, 0);
  assert.equal(h.page.transferred, false);
  assert.equal(h.page.busy, false);
  assert.ok(h.calls.some(call => call[0] === 'close'));
});
