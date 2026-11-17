import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = readFileSync(new URL('../entry/src/main/ets/launcher/PathActions.ets', import.meta.url), 'utf8');
const script = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, '')).replaceAll('export ', '');
const home = '/storage/Users/currentUser';
const file = home + '/.oheco/packages/sdk/include/oh_file_uri.h';
const folder = file.slice(0, file.lastIndexOf('/'));

function harness({ launchCode = 0, inspectCode = 0, symlink = '' } = {}) {
  const wants = [];
  const fs = {
    async lstat(path) {
      if (inspectCode) throw { code: inspectCode };
      return { isSymbolicLink: () => path === symlink, isFile: () => path === file,
        isDirectory: () => path !== file };
    },
    async open() { assert.fail('Viewing a folder must not open or authorize a file'); },
  };
  const fileUri = { getUriFromPath: path => 'file://docs' + path };
  const api = new Function('fs', 'fileUri', 'console', script + ';return {viewInFileManager};')(
    fs, fileUri, { warn() {} });
  const context = { async startAbility(want) { wants.push(want); if (launchCode) throw { code: launchCode }; } };
  return { wants, run: (path = file) => api.viewInFileManager(context, path) };
}

test('files reveal their parent folder without editor intents or URI grants', async () => {
  const h = harness();
  assert.equal((await h.run()).opened, true);
  assert.deepEqual(h.wants, [{ bundleName: 'com.huawei.hmos.filemanager', abilityName: 'MainAbility',
    parameters: { fileUri: 'file://docs' + folder } }]);
  assert.doesNotMatch(source, /authMode|DocumentViewPicker|uniformTypeDescriptor|ohos.want.action.viewData/);
});

test('directories are shown directly', async () => {
  const h = harness();
  assert.equal((await h.run(folder)).opened, true);
  assert.equal(h.wants[0].parameters.fileUri, 'file://docs' + folder);
});

test('abbreviations, escaped paths and symlinks are not launched', async () => {
  for (const path of ['/etc', home + '/../other', home + '/...', home + '/…']) {
    const h = harness();
    assert.equal((await h.run(path)).reason, 'invalid-path');
    assert.equal(h.wants.length, 0);
  }
  const h = harness({ symlink: home + '/.oheco' });
  assert.equal((await h.run()).reason, 'unsupported-path');
  assert.equal(h.wants.length, 0);
});

test('file inspection and application launch failures stay distinguishable', async () => {
  const missing = await harness({ inspectCode: 13900002 }).run();
  assert.equal(missing.reason, 'not-found');
  assert.equal(missing.stage, 'inspect');
  const handler = await harness({ launchCode: 16000019 }).run();
  assert.equal(handler.reason, 'no-handler');
  assert.equal(handler.stage, 'launch');
});

test('the menu exposes only folder viewing and errors use transient toasts', () => {
  const page = readFileSync(new URL('../entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /context_editor|case 'editor'|actionError|actionDetail|unopened/);
  assert.match(page, /viewInFileManager/);
  assert.match(page, /showToast\(\{ message: message, duration: 3000, bottom: 24 \}\)/);
});
