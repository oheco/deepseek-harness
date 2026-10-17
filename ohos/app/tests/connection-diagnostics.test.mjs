import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../entry/src/main/ets');

function harness() {
  const records = [], clipboard = [], cache = new Map();
  const control = { text: '', readFail: false, writeFail: false, copyFail: false, configured: '' };
  const native = {
    configureConnectionDiagnostics(directory) { control.configured = directory; },
    writeConnectionDiagnostic(event, fields) {
      if (control.writeFail) throw new Error('private error text');
      records.push({ event, fields });
    },
    readConnectionDiagnostics() {
      if (control.readFail) throw new Error('private error text');
      return control.text;
    }
  };
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const filename = path.join(ets, relative + '.ets');
    let source = fs.readFileSync(filename, 'utf8');
    if (relative === 'pages/DiagnosticLogs') source = (source.slice(0, source.indexOf('\n  build()')) + '\n}\n')
      .replace('export struct DiagnosticLogs', 'export class DiagnosticLogs')
      .replace(/^@Component\s*$/gm, '').replace(/@State\s*/g, '');
    const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    assert.equal(emitted.diagnostics?.length ?? 0, 0);
    const exports = {};
    cache.set(relative, exports);
    vm.runInNewContext(emitted.outputText, { exports, $r: name => ({ name }), require(name) {
      if (name === 'libdsh_launcher.so') return { __esModule: true, default: native };
      if (name === '@ohos.pasteboard') return { __esModule: true, default: {
        MIMETYPE_TEXT_PLAIN: 'text/plain', createData: (type, text) => ({ type, text }),
        getSystemPasteboard: () => ({ async setData(data) {
          if (control.copyFail) throw new Error('private clipboard failure');
          clipboard.push(data);
        } })
      } };
      assert.ok(name.startsWith('.'));
      return load(path.posix.join(path.posix.dirname(relative), name));
    } }, { filename });
    return exports;
  }
  return { records, clipboard, control, load, diag: load('launcher/ConnectionDiagnostics'),
    web: load('launcher/WebConnectionDiagnostics') };
}

test('journal initialization uses the private files directory and app records exclude exception text', () => {
  const h = harness();
  h.diag.initializeConnectionDiagnostics('/private/app/files');
  assert.equal(h.control.configured, '/private/app/files/connection-diagnostics');
  const error = Object.assign(new Error('https://private.invalid?token=secret-token'), { code: 503 });
  h.diag.connectionDiagnosticFailure('app.failed', error, { generation: 4 });
  assert.deepEqual(h.records.at(-1), { event: 'app.failed', fields: 'generation=4 code=503 errorType=0' });
  assert.ok(!JSON.stringify(h.records).includes('secret-token'));
  assert.equal(h.diag.diagnosticFailureCode(Object.assign(new Error('hidden'), { code: 'DSH_BROKER_AUTH' })), -2);
  h.control.writeFail = true;
  assert.doesNotThrow(() => h.diag.connectionDiagnosticFailure('app.failed', error));
});

test('console decoding retains only known event categories and integer measurements', () => {
  const h = harness();
  const prefix = '__DSH_CONNECTION_DIAGNOSTIC_V1__';
  h.web.recordWebConnectionDiagnostic(prefix + JSON.stringify({ kind: 4, code: 1006, clean: false,
    reason: 5, lastMessageMs: 6010, url: 'https://private.invalid', message: 'secret-token', chars: 'secret-token' }), 7, false);
  assert.deepEqual(h.records, [{ event: 'web.ws_closed',
    fields: 'generation=7 current=0 code=1006 clean=0 lastMessageMs=6010 reason=5' }]);
  for (const message of ['secret-token', prefix + '{', prefix + JSON.stringify({ kind: 'secret-token' }),
    prefix + JSON.stringify({ kind: 999 }), prefix + 'x'.repeat(3000)])
    h.web.recordWebConnectionDiagnostic(message, 7, true);
  assert.equal(h.records.length, 1);
});

function browserObserver(script, origin = 'http://127.0.0.1:3080') {
  const output = [], sockets = [];
  let now = 0, physicalOnline = false;
  class Original extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(address) {
      super();
      this.arguments = [...arguments];
      this.url = String(address);
      this.readyState = 0;
      sockets.push(this);
    }
    send(value) { if (!(this instanceof Original)) throw new TypeError('illegal receiver'); this.sent = value; }
    close() { if (!(this instanceof Original)) throw new TypeError('illegal receiver'); this.closeArguments = [...arguments]; }
  }
  const window = new EventTarget(); window.top = window; window.WebSocket = Original;
  const document = new EventTarget(); document.hidden = false;
  const navigator = Object.create({ get onLine() { return physicalOnline; } });
  const scope = { window, document, navigator, location: { origin }, URL, ArrayBuffer, Blob,
    performance: { now: () => now }, console: { info: value => output.push(value) } };
  vm.runInNewContext(script, scope);
  function dispatch(socket, type, fields) {
    const event = new Event(type); Object.assign(event, fields); socket.dispatchEvent(event);
  }
  return { window, Original, navigator, output, sockets, dispatch, setTime(value) { now = value; },
    setOnline(value) { physicalOnline = value; }, records: () => output.map(value => JSON.parse(value.slice(value.indexOf('{')))) };
}

test('mux observer preserves constructor/subclass/send/close behavior and excludes payloads, URLs and close reason text', () => {
  const h = harness();
  const b = browserObserver(h.web.WEB_CONNECTION_DIAGNOSTIC_SCRIPT);
  class Derived extends b.window.WebSocket {}
  const socket = new Derived('ws://127.0.0.1:3080/api/remote.mux?token=secret-token', ['subprotocol']);
  assert.ok(socket instanceof Derived && socket instanceof b.Original);
  assert.equal(b.window.WebSocket.OPEN, 1);
  assert.deepEqual(socket.arguments, ['ws://127.0.0.1:3080/api/remote.mux?token=secret-token', ['subprotocol']]);
  const payload = 'private-session-content';
  socket.send(payload); assert.equal(socket.sent, payload);
  socket.readyState = 1; b.dispatch(socket, 'open', {});
  for (let count = 0; count < 1000; count++) b.dispatch(socket, 'message', { data: payload });
  assert.equal(b.records().filter(record => record.kind === 6).length, 0, 'fast small messages do not flood the journal');
  b.setTime(6000); b.dispatch(socket, 'message', { data: payload.repeat(15000) });
  assert.equal(b.records().filter(record => record.kind === 7).length, 1);
  Object.defineProperty(b.navigator, 'onLine', { value: true });
  b.setTime(12010); socket.close(4002, 'private-close-reason');
  assert.deepEqual(socket.closeArguments, [4002, 'private-close-reason']);
  socket.readyState = 3; b.dispatch(socket, 'close', { code: 1006, wasClean: false, reason: 'private-close-reason' });
  const last = b.records().at(-1);
  assert.equal(last.code, 1006); assert.equal(last.clean, false); assert.equal(last.reason, 5);
  assert.equal(last.lastMessageMs, 6010); assert.equal(last.online, false, 'the original network getter survives the loopback override');
  assert.equal(last.received, 1001); assert.equal(last.sent, 1);
  assert.ok(!b.output.join().includes(payload) && !b.output.join().includes('secret-token') && !b.output.join().includes('private-close-reason'));
  const count = b.output.length;
  const other = new b.window.WebSocket('ws://127.0.0.1:3080/other');
  const external = new b.window.WebSocket('ws://elsewhere.invalid/api/remote.mux');
  assert.equal(Object.hasOwn(other, 'send'), false); assert.equal(Object.hasOwn(external, 'send'), false);
  b.dispatch(other, 'close', { code: 1000, wasClean: true });
  assert.equal(b.output.length, count);
});

test('mux binary frames report ArrayBuffer and Blob byte thresholds without reading their contents', () => {
  const h = harness();
  const b = browserObserver(h.web.WEB_CONNECTION_DIAGNOSTIC_SCRIPT);
  const socket = new b.window.WebSocket('ws://127.0.0.1:3080/api/remote.mux');
  const below = new ArrayBuffer(262143);
  b.dispatch(socket, 'message', { data: below });
  assert.equal(b.records().filter(record => record.kind === 7).length, 0);
  const buffer = new ArrayBuffer(262144);
  new Uint8Array(buffer).set(new TextEncoder().encode('private-binary-payload'));
  b.dispatch(socket, 'message', { data: buffer });
  const blob = new Blob([buffer, new Uint8Array(17)]);
  Object.defineProperties(blob, {
    text: { value() { assert.fail('binary content cannot be read'); } },
    arrayBuffer: { value() { assert.fail('binary content cannot be read'); } },
    stream: { value() { assert.fail('binary content cannot be read'); } }
  });
  b.dispatch(socket, 'message', { data: blob });
  const frames = b.records().filter(record => record.kind === 7);
  assert.deepEqual(frames.map(record => [record.chars, record.bytes, record.received, record.totalChars, record.maxChars]),
    [[0, 262144, 2, 0, 0], [0, 262161, 3, 0, 0]]);
  for (const message of b.output) h.web.recordWebConnectionDiagnostic(message, 9, true);
  const recorded = h.records.filter(record => record.event === 'web.ws_large_message');
  assert.equal(recorded.length, 2);
  assert.match(recorded[0].fields, /generation=9 current=1/);
  assert.match(recorded[0].fields, /bytes=262144/);
  assert.match(recorded[1].fields, /bytes=262161/);
  assert.ok(!JSON.stringify(h.records).includes('private-binary-payload'));
  b.setTime(6000);
  b.dispatch(socket, 'message', { data: new Blob([below]) });
  const summary = b.records().at(-1);
  assert.equal(summary.kind, 6);
  assert.equal(summary.received, 4);
  assert.equal(summary.totalChars, 0);
  assert.equal(summary.maxChars, 0);
});

test('secure mux origin is observed and repeated document installation does not wrap twice', () => {
  const h = harness(); const script = h.web.WEB_CONNECTION_DIAGNOSTIC_SCRIPT;
  const b = browserObserver(script, 'https://127.0.0.1:3080');
  new b.window.WebSocket('wss://127.0.0.1:3080/api/remote.mux');
  assert.equal(b.records().filter(record => record.kind === 14).length, 1);
  const wrapped = b.window.WebSocket;
  vm.runInNewContext(script, { window: b.window });
  assert.equal(b.window.WebSocket, wrapped);
});

test('viewer shows a bounded tail, copies the complete fresh journal, and exposes read/copy failures without exception text', async () => {
  const h = harness(); const view = new (h.load('pages/DiagnosticLogs').DiagnosticLogs)();
  h.control.text = 'older-record\n' + 'event=app.open generation=1\n'.repeat(6000);
  view.aboutToAppear();
  assert.equal(view.display.length, 96 * 1024); assert.equal(view.readable, true);
  h.control.text += 'event=web.ws_closed code=1006\n';
  await view.copyLogs();
  assert.equal(h.clipboard.at(-1).text, h.control.text);
  assert.equal(view.message.name, 'app.string.diagnostics_copied');
  h.control.copyFail = true; await view.copyLogs();
  assert.equal(view.message.name, 'app.string.diagnostics_copy_failed');
  h.control.readFail = true; assert.equal(view.refresh(), false);
  assert.equal(view.readable, false); assert.equal(view.display, '');
  assert.equal(view.message.name, 'app.string.diagnostics_read_failed');
  assert.ok(!JSON.stringify(h.records).includes('private clipboard failure'));
});
