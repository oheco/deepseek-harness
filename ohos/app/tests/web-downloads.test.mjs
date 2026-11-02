import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const launcher = new URL('../entry/src/main/ets/launcher/', import.meta.url);
const source = readFileSync(new URL('WebDownloads.ets', launcher), 'utf8');
const originSource = readFileSync(new URL('RunLogUrl.ets', launcher), 'utf8');
const executable = stripTypeScriptTypes((originSource + '\n' + source).replace(/^import .*;\n/gm, ''))
  .replaceAll('export ', '');
const origin = 'http://127.0.0.1:49152';
const tempDir = '/data/storage/el2/base/haps/entry/temp';
const output = 'file://docs/storage/Users/currentUser/Download/dsh-session-test.zip';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Every mocked I/O either settles immediately or is controlled by an explicit deferred promise.
const drain = () => new Promise(resolve => setImmediate(resolve));

function harness({ selected = [output], pickerWait, copyWait, cancelWait = false,
  installError = 0, startError = 0, openError = 0, copyError = 0, syncError = 0,
  cleanupError = 0, cancelError = 0, observerThrows = false } = {}) {
  const notices = [];
  const warnings = [];
  const picks = [];
  const opens = [];
  const closes = [];
  const removed = [];
  const files = new Map();
  const descriptors = new Map();
  let sequence = 0;
  let installations = 0;
  let currentDelegate;
  class Delegate {
    onBeforeDownload(fn) { this.before = fn; }
    onDownloadFinish(fn) { this.finish = fn; }
    onDownloadFailed(fn) { this.fail = fn; }
  }
  const controller = {
    setDownloadDelegate(delegate) {
      if (installError) throw { code: installError };
      currentDelegate = delegate;
      installations += 1;
    }
  };
  const fs = {
    OpenMode: { WRITE_ONLY: 1, CREATE: 64, TRUNC: 512 },
    mkdtempSync(prefix) {
      assert.equal(prefix, tempDir + '/dsh-web-download-XXXXXX');
      return prefix.replace('XXXXXX', String(++sequence).padStart(6, '0'));
    },
    async rmdir(directory) {
      removed.push(directory);
      const code = Array.isArray(cleanupError) ? cleanupError.shift() : cleanupError;
      if (code) throw { code };
      for (const path of files.keys()) if (path.startsWith(directory + '/')) files.delete(path);
    },
    async open(uri, mode) {
      opens.push({ uri, mode });
      if (openError) throw { code: openError };
      assert.deepEqual(selected, [uri], 'Only the system-selected URI authorizes writing');
      files.set(uri, Buffer.alloc(0));
      const file = { fd: ++sequence };
      descriptors.set(file.fd, uri);
      return file;
    },
    async copyFile(path, fd) {
      if (copyWait) await copyWait.promise;
      if (copyError) throw { code: copyError };
      assert.match(path, /\/dsh-web-download-\d+\/payload$/);
      assert.ok(files.has(path));
      files.set(descriptors.get(fd), Buffer.from(files.get(path)));
    },
    async fsync() { if (syncError) throw { code: syncError }; },
    async close(file) { closes.push(file.fd); descriptors.delete(file.fd); }
  };
  const picker = {
    DocumentSaveOptions: class {},
    DocumentViewPicker: class {
      constructor(context) { assert.equal(context.tempDir, tempDir); }
      async save(options) {
        picks.push(options);
        if (pickerWait) return pickerWait.promise;
        return selected;
      }
    }
  };
  const webview = { WebDownloadDelegate: Delegate, WebDownloadErrorCode: { USER_CANCELED: 40 } };
  const { WebDownloads } = new Function('webview', 'picker', 'fs', 'console', executable + ';return {WebDownloads};')(
    webview, picker, fs, { warn: message => warnings.push(message) });
  const downloads = new WebDownloads(notice => {
    notices.push(notice);
    if (observerThrows) throw new Error('observer failure');
  });
  const context = { tempDir };
  const attach = (address = origin) => downloads.attach(controller, context, address);
  attach();
  function item({ url = origin + '/api/session.export?sessionId=test&includeDescendants=true',
    filename = 'dsh-session-test.zip', bytes = Buffer.from([0x50, 0x4b, 0, 255, 128]), guid } = {}) {
    const delegate = currentDelegate;
    const result = {
      guid: guid ?? 'item-' + ++sequence, started: '', cancelled: false, cancellations: 0, error: 0,
      getGuid() { return this.guid; },
      getUrl() { return url; },
      getSuggestedFileName() { return filename; },
      getLastErrorCode() { return this.error; },
      start(path) {
        if (startError) throw { code: startError };
        this.started = path;
        files.set(path, bytes);
      },
      cancel() {
        this.cancellations += 1;
        if (cancelError) throw { code: cancelError };
        this.cancelled = true;
        this.error = 40;
        if (!cancelWait) delegate.fail(this);
      },
      finish() { delegate.finish(this); },
      fail(code = 20) { this.error = code; delegate.fail(this); }
    };
    delegate.before(result);
    return result;
  }
  return { downloads, attach, item, notices, warnings, picks, opens, closes, removed, files, descriptors,
    get installations() { return installations; } };
}

test('the real session export is an HTTP anchor download after HEAD validation', () => {
  const controller = readFileSync(new URL('../../../packages/session-query/session-log-export/src/client/controller.ts', import.meta.url), 'utf8');
  assert.match(controller, /method: 'HEAD'/);
  assert.match(controller, /anchor\.href = url/);
  assert.match(controller, /anchor\.download = filename/);
  assert.match(controller, /this\.save\(route, sessionLogZipFilename\(sessionId\)\)/);
});

test('native HTTP bytes are saved intact to the system-chosen URI without exposing paths or tokens', async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const h = harness();
  const item = h.item({ bytes });
  assert.match(item.started, /^\/data\/storage\/el2\/base\/haps\/entry\/temp\/dsh-web-download-\d+\/payload$/);
  assert.equal(h.picks.length, 0);
  item.finish();
  await drain();
  assert.deepEqual(h.files.get(output), bytes);
  assert.deepEqual(h.notices.map(n => n.kind), ['started', 'saved']);
  assert.deepEqual(h.picks.map(p => p.newFileNames), [['dsh-session-test.zip']]);
  assert.equal(h.picks[0].autoCreateEmptyFile, false);
  assert.equal(h.picks[0].defaultFilePathUri, undefined);
  assert.equal(h.descriptors.size, 0);
  assert.equal(h.removed.length, 1);
  assert.equal(h.files.size, 1);
  assert.doesNotMatch(JSON.stringify(h.notices), /127\.0\.0\.1|sessionId|\/data\/storage/);
  await h.downloads.close();
});

test('same-origin blob downloads use the native delegate and preserve binary data', async () => {
  const h = harness();
  h.item({ url: 'blob:' + origin + '/opaque-object-id' }).finish();
  await drain();
  assert.deepEqual(h.files.get(output), Buffer.from([0x50, 0x4b, 0, 255, 128]));
  assert.doesNotMatch(source, /base64|FileReader|runJavaScript|registerJavaScriptProxy/);
});

test('URLs cannot select a local destination or download from another connection', async () => {
  for (const url of ['file:///storage/Users/currentUser/secret', 'data:text/plain,secret',
    'http://127.0.0.1:49153/api/session.export', 'blob:http://evil.example/id',
    origin + '.evil.example/file', 'http://127.0.0.1:49152@evil.example/file',
    origin + '\\evil.example/file']) {
    const h = harness();
    assert.equal(h.item({ url }).cancelled, true, url);
    assert.equal(h.files.size, 0);
    assert.equal(h.picks.length, 0);
    assert.equal(h.notices.at(-1).kind, 'unsupported');
  }
  const h = harness();
  h.item({ url: origin + '/../../config/private?filename=/etc/passwd', filename: '../../etc/passwd' }).finish();
  await drain();
  assert.equal(h.picks[0].newFileNames[0], 'passwd');
  assert.equal(h.opens[0].uri, output);
});

test('filenames remain suggestions and system picker owns naming and overwrite decisions', async () => {
  for (const filename of ['../../session.zip', '..\\..\\session.zip', '\u0000\u202e<>:"|?*.zip', '.', ' ', '会'.repeat(300) + '.zip']) {
    const h = harness();
    h.item({ filename }).finish();
    await drain();
    const name = h.picks[0].newFileNames[0];
    assert.ok(name.length > 0);
    assert.ok(Buffer.byteLength(name) <= 255);
    assert.doesNotMatch(name, /[\\/\u0000-\u001f\u202e<>:"|?*]/);
    assert.deepEqual([...h.files.keys()], [output]);
  }
});

test('cancelling the system picker cleans temporary data and writes no destination', async () => {
  const h = harness({ selected: [] });
  h.item().finish();
  await drain();
  assert.deepEqual(h.notices.map(n => n.kind), ['started', 'cancelled']);
  assert.equal(h.opens.length, 0);
  assert.equal(h.files.size, 0);
  assert.equal(h.removed.length, 1);
});

test('only one download per window reaches a picker and other windows keep independent owners', async () => {
  const first = harness();
  const second = harness();
  const a = first.item();
  const duplicate = first.item();
  const b = second.item();
  assert.equal(duplicate.cancelled, true);
  assert.equal(first.notices.at(-1).kind, 'busy');
  assert.equal(b.cancelled, false);
  a.finish();
  b.finish();
  await drain();
  assert.equal(first.picks.length, 1);
  assert.equal(second.picks.length, 1);
});

test('close waits for native cancellation, cleans once and ignores late terminal callbacks', async () => {
  const h = harness({ cancelWait: true });
  const item = h.item();
  let closed = false;
  const work = h.downloads.close();
  assert.equal(h.downloads.close(), work);
  const closing = work.then(() => { closed = true; });
  await drain();
  assert.equal(item.cancellations, 1);
  assert.equal(item.cancelled, true);
  assert.equal(closed, false);
  assert.equal(h.removed.length, 0);
  item.fail(40);
  await closing;
  item.finish();
  item.fail(40);
  assert.equal(h.removed.length, 1);
  assert.equal(h.notices.filter(n => n.kind === 'saved').length, 0);
  assert.equal(h.picks.length, 0);
});

test('close does not wait for an open system picker and its late URI cannot write into a new connection', async () => {
  const pickerWait = deferred();
  const h = harness({ pickerWait });
  const old = h.item();
  old.finish();
  assert.equal(h.picks.length, 1);
  await h.downloads.close();
  assert.equal(h.files.size, 0);
  h.attach();
  const next = h.item();
  pickerWait.resolve([output]);
  await drain();
  assert.equal(h.opens.length, 0);
  old.finish();
  assert.equal(h.picks.length, 1);
  await h.downloads.close();
  assert.equal(next.cancelled, true);
});

test('close joins an already authorized copy before releasing its source or descriptor', async () => {
  const copyWait = deferred();
  const h = harness({ copyWait });
  const item = h.item();
  item.finish();
  await drain();
  let closed = false;
  const closing = h.downloads.close().then(() => { closed = true; });
  await drain();
  assert.equal(closed, false);
  assert.equal(h.files.has(item.started), true);
  assert.equal(h.descriptors.size, 1);
  copyWait.resolve();
  await closing;
  assert.equal(h.descriptors.size, 0);
  assert.equal(h.files.has(item.started), false);
  assert.deepEqual(h.files.get(output), Buffer.from([0x50, 0x4b, 0, 255, 128]));
});

test('download, picker, open, copy and sync failures report their actual effects', async () => {
  const native = harness();
  native.item().fail(20);
  await drain();
  assert.deepEqual(native.notices.at(-1), { kind: 'failed', stage: 'download', filename: 'dsh-session-test.zip', code: 20, partial: false });
  const invalidPicker = harness({ selected: ['/storage/Users/currentUser/Download/injected'] });
  invalidPicker.item().finish();
  await drain();
  assert.equal(invalidPicker.notices.at(-1).stage, 'picker');
  assert.equal(invalidPicker.opens.length, 0);
  const pickerWait = deferred();
  const pickerFailure = harness({ pickerWait });
  pickerFailure.item().finish();
  pickerWait.reject({ code: 16000011 });
  await drain();
  assert.equal(pickerFailure.notices.at(-1).stage, 'picker');
  for (const options of [{ openError: 13900012 }, { copyError: 13900025 }, { syncError: 13900005 }]) {
    const h = harness(options);
    h.item().finish();
    await drain();
    assert.equal(h.notices.at(-1).kind, 'failed');
    assert.equal(h.notices.at(-1).stage, 'save');
    assert.equal(h.notices.at(-1).partial, true);
    assert.equal(h.descriptors.size, 0);
    assert.equal(h.removed.length, 1);
    assert.equal(h.notices.some(n => n.kind === 'saved'), false);
  }
});

test('a failed native start joins cancellation before removing its temporary directory', async () => {
  const h = harness({ startError: 401, cancelWait: true });
  const item = h.item();
  assert.equal(item.cancellations, 1);
  assert.equal(h.notices.at(-1).stage, 'download');
  assert.equal(h.notices.at(-1).code, 401);
  assert.equal(h.removed.length, 0);
  const closing = h.downloads.close();
  item.fail(40);
  await closing;
  assert.equal(h.removed.length, 1);
  assert.equal(item.cancellations, 1);
});

test('a native cancellation failure rejects close without deleting a possibly active download', async () => {
  const h = harness({ cancelError: 17100001 });
  const item = h.item();
  await assert.rejects(h.downloads.close());
  assert.equal(h.removed.length, 0);
  item.finish();
  await h.downloads.close();
  assert.equal(h.removed.length, 1);
  assert.equal(h.picks.length, 0);
});

test('save failure after retirement still reports that the selected destination may be incomplete', async () => {
  const copyWait = deferred();
  const h = harness({ copyWait, copyError: 13900025 });
  h.item().finish();
  await drain();
  const closing = h.downloads.close();
  copyWait.resolve();
  await closing;
  assert.equal(h.notices.at(-1).kind, 'failed');
  assert.equal(h.notices.at(-1).stage, 'save');
  assert.equal(h.notices.at(-1).partial, true);
  assert.equal(h.descriptors.size, 0);
});

test('installation and observer failures stay contained and cleanup failures remain visible', async () => {
  const install = harness({ installError: 17100001 });
  assert.equal(install.notices.at(-1).stage, 'attach');
  assert.equal(install.notices.at(-1).code, 17100001);
  const observer = harness({ observerThrows: true });
  observer.item().finish();
  await drain();
  assert.equal(observer.files.has(output), true);
  assert.ok(observer.warnings.length > 0);
  const cleanup = harness({ cleanupError: 13900005 });
  cleanup.item().finish();
  await drain();
  assert.equal(cleanup.notices.at(-1).stage, 'cleanup');
  assert.ok(cleanup.warnings.length > 0);
  await assert.rejects(cleanup.downloads.close());
  assert.equal(cleanup.removed.length, 2);
});

test('cleanup failure retains the source, blocks another connection and close retries only cleanup', async () => {
  const h = harness({ cleanupError: [13900005, 0] });
  const item = h.item();
  item.finish();
  await drain();
  assert.equal(h.files.has(item.started), true);
  assert.equal(h.notices.at(-1).stage, 'cleanup');
  const installations = h.installations;
  h.attach('http://127.0.0.1:49153');
  assert.equal(h.installations, installations);
  assert.equal(h.notices.at(-1).stage, 'attach');
  await h.downloads.close();
  assert.equal(h.removed.length, 2);
  assert.equal(item.cancellations, 0);
  assert.equal(h.files.has(item.started), false);
  h.attach('http://127.0.0.1:49153');
  assert.equal(h.installations, installations + 1);
});

test('a late picker response cannot silently retry cleanup after close reported a cleanup failure', async () => {
  const pickerWait = deferred();
  const h = harness({ pickerWait, cleanupError: [13900005, 0] });
  h.item().finish();
  await assert.rejects(h.downloads.close());
  assert.equal(h.removed.length, 1);
  pickerWait.resolve([output]);
  await drain();
  assert.equal(h.removed.length, 1);
  assert.equal(h.opens.length, 0);
  await h.downloads.close();
  assert.equal(h.removed.length, 2);
});

test('repeated attachment of the same controller and origin installs the delegate once', async () => {
  const h = harness();
  h.attach();
  const item = h.item();
  h.attach();
  assert.equal(h.installations, 1);
  await h.downloads.close();
  assert.equal(item.cancellations, 1);
  h.attach();
  assert.equal(h.installations, 2);
});
