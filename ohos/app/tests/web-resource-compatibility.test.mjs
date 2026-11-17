import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../entry/src/main/ets/launcher/WebResourceCompatibility.ets', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source).replaceAll('export ', '');
const script = new Function(executable + '\nreturn WEB_RESOURCE_COMPATIBILITY_SCRIPT;')();
const nativeDescriptors = Object.getOwnPropertyDescriptors(URL.prototype);
const readNative = (name, receiver) => Reflect.apply(nativeDescriptors[name].get, receiver, []);

function harness({ brokenSchemes = ['dsh-resource', 'sidebar'], brokenProperties = ['hostname', 'pathname'],
  locked, failInstallation = false, rejectInternal = false } = {}) {
  // The fixture retains real native URL slots, methods and setters; only the two ArkWeb getters differ.
  class NativeURL extends URL {
    constructor(input, base) {
      super(input, base);
      if (rejectInternal && /^(?:dsh-resource|sidebar):$/.test(readNative('protocol', this))) {
        throw new TypeError('unsupported scheme');
      }
    }
  }
  const descriptors = { ...nativeDescriptors };
  delete descriptors.constructor;
  Object.defineProperties(NativeURL.prototype, descriptors);
  for (const name of brokenProperties) {
    Object.defineProperty(NativeURL.prototype, name, { ...descriptors[name], get() {
      const native = readNative(name, this);
      const protocol = readNative('protocol', this);
      const href = readNative('href', this);
      if (!brokenSchemes.includes(protocol.slice(0, -1)) || !href.startsWith(protocol + '//')) return native;
      return name === 'hostname' ? '' : href.slice(protocol.length).split(/[?#]/, 1)[0];
    } });
  }
  if (locked) Object.defineProperty(NativeURL.prototype, locked, { configurable: false });
  const before = Object.getOwnPropertyDescriptors(NativeURL.prototype);
  const window = { URL: NativeURL };
  const context = vm.createContext({ window, URL: NativeURL });
  let installations = 0;
  if (failInstallation) {
    const objectAPI = Object.create(Object);
    objectAPI.defineProperties = (target, replacement) => {
      installations++;
      if (installations === 1) {
        Object.defineProperty(target, 'hostname', replacement.hostname);
        throw new TypeError('pathname replacement failed');
      }
      return Object.defineProperties(target, replacement);
    };
    context.Object = objectAPI;
  }
  return { NativeURL, window, context, before, install: () => vm.runInContext(script, context),
    installations: () => installations };
}

// These are the URL-based consumers shipped before the internal-scheme parser change.
function protocolOf(URLClass, address) {
  try {
    const url = new URLClass(address);
    return url.protocol === 'dsh-resource:' ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function pathOf(URLClass, address) {
  try {
    return new URLClass(address).pathname;
  } catch {
    return undefined;
  }
}

function values(url) {
  return Object.fromEntries(['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port',
    'pathname', 'search', 'hash', 'origin'].map(name => [name, url[name]]));
}

function outcome(URLClass, address) {
  try { return values(new URLClass(address)); }
  catch (error) { return { error: error.name }; }
}

function assertOriginalGetters(h) {
  for (const name of ['hostname', 'pathname']) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(h.NativeURL.prototype, name), h.before[name]);
  }
}

test('document-start repair restores the old resource protocol and sidebar path consumers', () => {
  const h = harness();
  const resource = 'dsh-resource://FiLe/session/s//home/me/a%20b.md?q=1#L2';
  assert.equal(protocolOf(h.NativeURL, resource), '');
  assert.equal(pathOf(h.NativeURL, resource), '//FiLe/session/s//home/me/a%20b.md');
  assert.equal(pathOf(h.NativeURL, 'sidebar://guide'), '//guide');
  h.install();
  for (const address of [resource, 'DSH-RESOURCE://file/absolute//server/share/a%23b.txt?view=1#L4',
    'sidebar://terminal/session/s', 'sidebar://guide', 'sidebar://guide?view=1#start', 'dsh-resource://file']) {
    const expected = new URL(address);
    assert.equal(pathOf(h.NativeURL, address), expected.pathname, address);
    assert.equal(protocolOf(h.NativeURL, address), protocolOf(URL, address), address);
  }
  assert.equal(protocolOf(h.NativeURL, resource), 'file');
  assert.equal(protocolOf(h.NativeURL, 'sidebar://guide'), undefined);
});

test('the repair preserves ordinary URLs, relative construction and native parse failures', () => {
  const h = harness();
  const cases = [
    ['https://user:pass@example.test:8443/a%20b?q=1#part'],
    ['wss://example.test/socket'], ['file:///home/me/a.txt'], ['data:text/plain,a%20b'],
    ['blob:https://example.test/owned'], ['widget://Other/a?q=1'], ['dsh-resource:opaque?q=1'],
    ['../b?q=1#part', 'https://example.test/a/c']
  ];
  const before = cases.map(args => values(new h.NativeURL(...args)));
  const invalid = ['not a URL', 'https://[broken', 'https://example.test:invalid/'];
  const failures = invalid.map(address => outcome(h.NativeURL, address));
  h.install();
  for (const [index, args] of cases.entries()) {
    assert.deepEqual(values(new h.NativeURL(...args)), before[index], args.join(' '));
  }
  assert.deepEqual(invalid.map(address => outcome(h.NativeURL, address)), failures);
  const relative = ['../b.md', 'dsh-resource://file/session/s/a.md'];
  assert.deepEqual(values(new h.NativeURL(...relative)), values(new URL(...relative)));
});

test('URL identity, native branding, subclassing and static methods survive installation', () => {
  const h = harness();
  const constructor = h.window.URL;
  const prototype = constructor.prototype;
  const instance = new constructor('dsh-resource://file/session/s/a.md');
  const methods = Object.fromEntries(['canParse', 'parse', 'createObjectURL', 'revokeObjectURL']
    .map(name => [name, constructor[name]]));
  const searchParams = instance.searchParams;
  h.install();
  assert.equal(h.window.URL, constructor);
  assert.equal(h.window.URL.prototype, prototype);
  assert.equal(instance.constructor, constructor);
  assert.ok(instance instanceof constructor && instance instanceof URL);
  assert.equal(Object.prototype.toString.call(instance), '[object URL]');
  assert.equal(instance.hostname, 'file', 'existing native instances use the repaired getters');
  assert.equal(instance.searchParams, searchParams);
  assert.equal(instance.toString(), instance.href);
  assert.equal(instance.toJSON(), instance.href);
  class Derived extends h.window.URL {}
  const derived = new Derived('sidebar://guide');
  assert.ok(derived instanceof Derived && derived instanceof constructor && derived instanceof URL);
  assert.equal(derived.pathname, '');
  for (const [name, method] of Object.entries(methods)) assert.equal(constructor[name], method, name);
  assert.equal(constructor.canParse('https://example.test/'), true);
  assert.equal(constructor.canParse('not a URL'), false);
  assert.equal(constructor.parse('https://example.test/a').href, 'https://example.test/a');
  assert.throws(() => constructor('https://example.test/'), TypeError);
  for (const name of ['hostname', 'pathname']) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    assert.equal(descriptor.set, h.before[name].set);
    assert.equal(descriptor.enumerable, h.before[name].enumerable);
    assert.equal(descriptor.configurable, h.before[name].configurable);
    assert.throws(() => descriptor.get.call({ href: 'dsh-resource://file/forged' }), TypeError);
  }
});

test('getters recompute from native href after property and searchParams updates', () => {
  const h = harness();
  h.install();
  const actual = new h.NativeURL('dsh-resource://file/session/s/a.md?q=1#L2');
  const expected = new URL(actual.href);
  const changes = [
    ['hostname', 'terminal'], ['pathname', '/session/s//new%20name.md'], ['search', '?next=1'],
    ['hash', '#L12'], ['protocol', 'sidebar:'], ['href', 'https://example.test/ordinary?q=2'],
    ['href', 'dsh-resource://file/absolute/home/me/new.txt'], ['href', 'sidebar://guide?view=2#start'],
    ['href', 'dsh-resource:opaque'], ['href', 'widget://other/path']
  ];
  for (const [name, value] of changes) {
    actual[name] = value;
    expected[name] = value;
    assert.deepEqual(values(actual), values(expected), name + '=' + value);
  }
  actual.href = expected.href = 'dsh-resource://file/session/s/a.txt';
  const params = actual.searchParams;
  params.set('name', 'a b');
  expected.searchParams.set('name', 'a b');
  assert.equal(actual.searchParams, params);
  assert.deepEqual(values(actual), values(expected));
  let conversions = 0;
  const converted = new h.NativeURL({ toString() { conversions++; return actual.href; } });
  assert.equal(converted.hostname, 'file');
  assert.equal(converted.pathname, '/session/s/a.txt');
  assert.equal(conversions, 1, 'getter reads do not repeat input conversion');
});

test('authority rejection leaves native behavior intact and other legal type names remain usable', () => {
  const h = harness();
  const addresses = [];
  for (const scheme of ['dsh-resource', 'sidebar']) {
    for (const authority of ['', 'user@file', 'user:secret@file', 'file:123', '[::1]', 'file\\other',
      'file<other', 'file>other', 'file^other', 'file|other', 'file other']) {
      addresses.push(scheme + '://' + authority + '/session/s/a.md');
    }
  }
  const before = addresses.map(address => outcome(h.NativeURL, address));
  h.install();
  for (const [index, address] of addresses.entries()) {
    assert.deepEqual(outcome(h.NativeURL, address), before[index], address);
  }
  for (const authority of ['plugin+name', 'plugin!name', 'file_2', '%66ile', '插件',
    'file\u0001other', 'file\u007fother']) {
    const address = 'dsh-resource://' + authority + '/session/s/a.md';
    assert.equal(new h.NativeURL(address).hostname, new URL(address).hostname, address);
    assert.equal(pathOf(h.NativeURL, address), '/session/s/a.md');
  }
});

test('feature probes leave working engines unchanged and repeated installation is idempotent', () => {
  const working = harness({ brokenSchemes: [] });
  working.install();
  working.install();
  assertOriginalGetters(working);
  assert.deepEqual(Object.keys(working.window), ['URL']);
  const broken = harness();
  broken.install();
  const installed = Object.getOwnPropertyDescriptors(broken.NativeURL.prototype);
  broken.install();
  for (const name of ['hostname', 'pathname']) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(broken.NativeURL.prototype, name), installed[name]);
  }
  assert.deepEqual(Object.keys(broken.window), ['URL']);
});

test('probes limit each repair to the affected schemes and getter', () => {
  for (const scheme of ['dsh-resource', 'sidebar']) {
    for (const property of ['hostname', 'pathname']) {
      const h = harness({ brokenSchemes: [scheme], brokenProperties: [property] });
      h.install();
      for (const address of ['dsh-resource://file/session/s/a.md', 'sidebar://guide']) {
        assert.deepEqual(values(new h.NativeURL(address)), values(new URL(address)), scheme + ' ' + property);
      }
    }
  }
});

test('unpatchable descriptors and rejected internal constructors retain native behavior', () => {
  for (const locked of ['hostname', 'pathname']) {
    const h = harness({ locked });
    const address = 'dsh-resource://file/session/s/a.md';
    const before = outcome(h.NativeURL, address);
    h.install();
    assertOriginalGetters(h);
    assert.deepEqual(outcome(h.NativeURL, address), before);
  }
  const rejected = harness({ rejectInternal: true });
  rejected.install();
  assertOriginalGetters(rejected);
  assert.throws(() => new rejected.NativeURL('dsh-resource://file/a.md'), TypeError);
  assert.doesNotThrow(() => vm.runInNewContext(script, { window: {} }));
});

test('failure after the first getter replacement restores both original descriptors', () => {
  const h = harness({ failInstallation: true });
  const address = 'dsh-resource://file/session/s/a.md';
  const before = outcome(h.NativeURL, address);
  assert.doesNotThrow(h.install);
  assert.equal(h.installations(), 2, 'failed installation is followed by descriptor restoration');
  assertOriginalGetters(h);
  assert.deepEqual(outcome(h.NativeURL, address), before);
});
