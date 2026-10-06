/** Exercises metadata-only expiration after the caller has bound a real Web controller. */
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
const ORIGIN = 'http://127.0.0.1:43219';

function authenticationCookie(index, overrides = {}) {
  const cookie = { name: 'dsh-auth-' + createHash('sha256').update('synthetic-map-' + index).digest('base64url'),
    domain: '127.0.0.1', path: '/', isHttpOnly: true, ...overrides };
  Object.defineProperty(cookie, 'value', { get() { throw new Error('cookie values must not be inspected'); } });
  return cookie;
}

function harness() {
  const expired = [];
  const control = { reads: 0, cookies: [], fetch: undefined, expire: undefined, failure: undefined };
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const filename = path.join(ets, relative + '.ets');
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
    } });
    const exports = {};
    cache.set(relative, exports);
    vm.runInNewContext(code.outputText, { exports, require(name) {
      if (name === '@ohos.url') return { __esModule: true, default: { URL } };
      if (name === '@ohos.web.webview') return { __esModule: true, default: { WebCookieManager: {
        async fetchAllCookies(incognito) {
          assert.equal(incognito, false);
          control.reads += 1;
          if (control.failure) throw control.failure;
          return control.fetch ? await control.fetch() : control.cookies;
        },
        configCookieSync(...args) {
          expired.push(args);
          if (control.expire) control.expire();
        }
      } } };
      assert.ok(name.startsWith('.'));
      return load(path.posix.join(path.posix.dirname(relative), name));
    } }, { filename });
    return exports;
  }
  return { control, expired, prepare: load('launcher/ConnectionCookies').prepareConnectionCookies };
}

test('seventy matching authentication cookies expire with HttpOnly access while other cookies and values are untouched', async () => {
  const h = harness();
  const matching = Array.from({ length: 70 }, (_, index) => authenticationCookie(index,
    { domain: index % 2 ? '.127.0.0.1' : '127.0.0.1' }));
  h.control.cookies = [...matching, authenticationCookie(70, { domain: 'example.invalid' }),
    authenticationCookie(71, { domain: '::1' }), authenticationCookie(72, { path: '/other' }),
    authenticationCookie(73, { name: 'preferences' }), authenticationCookie(74, { name: 'dsh-auth-short' }),
    authenticationCookie(75, { name: 'dsh-auth-' + 'a'.repeat(44) }),
    authenticationCookie(76, { domain: '127.0.0.1.example.invalid' })];
  assert.equal(await h.prepare(ORIGIN, () => true), true);
  assert.equal(h.control.reads, 1);
  assert.equal(h.expired.length, 70);
  for (const [index, args] of h.expired.entries()) {
    assert.deepEqual(args, [ORIGIN + '/',
      matching[index].name + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly', false, true]);
  }
});

test('IPv6 domain normalization selects only the current numeric loopback host', async () => {
  const h = harness();
  h.control.cookies = [authenticationCookie(0, { domain: '[::1]' }),
    authenticationCookie(1, { domain: '.::1' }), authenticationCookie(2)];
  assert.equal(await h.prepare('http://[::1]:43219', () => true), true);
  assert.equal(h.expired.length, 2);
  assert.ok(h.expired.every(args => args[0] === 'http://[::1]:43219/'));
});

test('an already cancelled owner cannot access the CookieManager', async () => {
  const h = harness();
  assert.equal(await h.prepare(ORIGIN, () => false), false);
  assert.equal(h.control.reads, 0);
  assert.equal(h.expired.length, 0);
});

test('cancellation during the metadata read prevents every expiration', async () => {
  const h = harness();
  let resolve;
  let current = true;
  h.control.fetch = () => new Promise(done => { resolve = done; });
  const work = h.prepare(ORIGIN, () => current);
  assert.equal(h.control.reads, 1);
  current = false;
  resolve([authenticationCookie(0)]);
  assert.equal(await work, false);
  assert.equal(h.expired.length, 0);
});

test('ownership is checked before each synchronous expiration', async () => {
  const h = harness();
  let current = true;
  h.control.cookies = [authenticationCookie(0), authenticationCookie(1)];
  h.control.expire = () => { current = false; };
  assert.equal(await h.prepare(ORIGIN, () => current), false);
  assert.equal(h.expired.length, 1);
});

test('CookieManager failure rejects to the navigation owner without inspecting cookie values', async () => {
  const h = harness();
  h.control.failure = new Error('cookie manager unavailable');
  await assert.rejects(h.prepare(ORIGIN, () => true), /cookie manager unavailable/);
  assert.equal(h.expired.length, 0);
});

test('non-loopback origins are refused before accessing cookies', async () => {
  const h = harness();
  for (const origin of ['http://localhost:43219', 'http://example.invalid:43219', 'http://127.0.0.1:0', ORIGIN + '/other']) {
    await assert.rejects(h.prepare(origin, () => true), /numeric loopback origin/);
  }
  assert.equal(h.control.reads, 0);
});
