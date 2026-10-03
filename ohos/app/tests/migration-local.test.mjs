/** Local migration regressions; mocks do not replace ArkWeb or device acceptance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');
const ets = path.join(app, 'entry/src/main/ets');

function load(relative) {
  const filename = path.join(ets, relative + '.ets');
  const exports = {};
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  }});
  vm.runInNewContext(result.outputText, {exports, require(name) {
    assert.ok(name.startsWith('.'), 'only type-only SDK imports may be erased');
    return load(path.posix.join(path.posix.dirname(relative), name));
  }}, {filename});
  return exports;
}

test('completed desktop business sources remain byte-for-byte migrated', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ohos/app-migration.json'), 'utf8'));
  const migrated = Object.keys(manifest.source_file_sha256).filter(name =>
    name.startsWith('ohos/app/entry/src/main/ets/') && !name.includes('/config/'));
  assert.equal(migrated.length, 9, 'entry ability, page and all seven launcher modules');
  for (const name of [...migrated, 'ohos/app/entry/src/main/module.json5']) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
      manifest.source_file_sha256[name], name);
  }
});

test('external destinations leave the WebView while local page-owned addresses stay', () => {
  const {leavesWebView} = load('launcher/ExternalLink');
  const origin = 'http://127.0.0.1:43210';
  for (const address of ['', origin + '/?token=test', 'about:blank', 'blob:test',
    'data:text/plain,test', 'javascript:void(0)', 'file:///storage/Users/currentUser/Documents/test']) {
    assert.equal(leavesWebView(address, origin), false, address);
  }
  for (const address of ['https://example.com/docs', 'mailto:help@example.com',
    'http://127.0.0.1:43211/', 'http://127.0.0.1:43210.evil/', 'http://127.0.0.1:43210@evil/']) {
    assert.equal(leavesWebView(address, origin), true, address);
  }
});

test('external opening uses openLink first and a browsable VIEW fallback', async () => {
  const {openOutside} = load('launcher/ExternalLink');
  const address = 'https://example.com/docs';
  const calls = [];
  assert.equal(await openOutside({async openLink(url, options) {
    calls.push([url, options.appLinkingOnly]);
  }, async startAbility() { assert.fail('fallback is not needed'); }}, address), true);
  assert.deepEqual(calls, [[address, false]]);
  let want;
  assert.equal(await openOutside({async openLink() { throw new Error('no app link'); },
    async startAbility(value) { want = value; }}, address), true);
  assert.equal(want.action, 'ohos.want.action.viewData');
  assert.deepEqual(Array.from(want.entities), ['entity.system.browsable']);
  assert.equal(want.uri, address);
  assert.equal(await openOutside({async openLink() { throw new Error('no app link'); },
    async startAbility() { throw new Error('no handler'); }}, address), false);
});

test('overlay palette follows page colors only at the active service origin', () => {
  const {overlayPaletteScript, parseOverlayPalette} = load('launcher/OverlayAppearance');
  const origin = 'http://127.0.0.1:43210';
  const script = overlayPaletteScript(origin);
  const tokens = [];
  const environment = {location: {origin}, document: {body: {hasAttribute: () => true}},
    getComputedStyle: () => ({getPropertyValue(token) {
      tokens.push(token);
      return token === '--dsw-alias-border-l2' ? 'rgba(10, 20, 30, 0.5)' : 'rgb(12, 34, 56)';
    }})};
  const palette = parseOverlayPalette(vm.runInNewContext(script, environment));
  assert.equal(palette.surface, '#ff0c2238');
  assert.equal(palette.border, '#800a141e');
  assert.equal(palette.shadow, '#66000000');
  assert.equal(tokens.length, 7);
  environment.location.origin = 'https://example.com';
  assert.equal(vm.runInNewContext(script, environment), '');
});

test('invalid overlay colors are refused and system-theme fallback stays available', () => {
  const {OverlayPalette, parseOverlayPalette} = load('launcher/OverlayAppearance');
  for (const dark of [false, true]) {
    const palette = new OverlayPalette(dark);
    assert.ok(parseOverlayPalette(JSON.stringify(palette)));
    assert.ok(parseOverlayPalette(JSON.stringify(JSON.stringify(palette))));
    palette.surface = 'url(https://example.com/image)';
    assert.equal(parseOverlayPalette(JSON.stringify(palette)), undefined);
  }
  for (const value of ['', 'null', '{}', 'not json']) assert.equal(parseOverlayPalette(value), undefined);
  assert.notEqual(new OverlayPalette(false).surface, new OverlayPalette(true).surface);
});
