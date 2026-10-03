/** Build publication uses a complete signed payload and a same-directory rename. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

for (const failure of ['none', 'compile', 'sign', 'copy']) {
  test(`HarmonyOS build publishes atomically and cleans up (${failure})`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-build-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const scripts = path.join(dir, 'scripts');
    const pkg = path.join(dir, 'packages/openharmony-arm64');
    const temp = path.join(dir, 'tmp');
    for (const name of [scripts, path.join(pkg, 'bin'), temp]) fs.mkdirSync(name, { recursive: true });
    fs.copyFileSync(new URL('../packages/openharmony-arm64/prebuilds.json', import.meta.url), path.join(pkg, 'prebuilds.json'));
    const output = path.join(pkg, 'bin/system.node');
    fs.writeFileSync(output, 'previous');
    const source = fs.readFileSync(new URL('../scripts/build.ts', import.meta.url), 'utf8');
    const script = path.join(scripts, 'build.mjs');
    fs.writeFileSync(script, ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'openharmony' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      const output = ${JSON.stringify(output)};
      const failure = ${JSON.stringify(failure)};
      const exists = fs.existsSync;
      fs.existsSync = (name) => String(name).endsWith('/node_api.h') || exists(name);
      cp.spawnSync = (command, args) => {
        const signing = command === 'binary-sign-tool';
        assert.equal(command, signing ? 'binary-sign-tool' : 'clang');
        const dest = args[args.indexOf(signing ? '-outFile' : '-o') + 1];
        assert.equal(path.dirname(path.dirname(dest)), process.env.TMPDIR);
        if (signing) assert.equal(fs.readFileSync(args[args.indexOf('-inFile') + 1], 'utf8'), 'compiled');
        fs.writeFileSync(dest, signing ? 'signed' : 'compiled');
        return { status: failure === (signing ? 'sign' : 'compile') ? 1 : 0 };
      };
      const copy = fs.copyFileSync;
      fs.copyFileSync = (from, to, flags) => {
        assert.equal(fs.readFileSync(output, 'utf8'), 'previous');
        assert.equal(path.dirname(to), path.dirname(output));
        assert.equal(flags, fs.constants.COPYFILE_EXCL);
        assert.equal(fs.readFileSync(from, 'utf8'), 'signed');
        if (failure === 'copy') {
          fs.writeFileSync(to, 'partial');
          throw new Error('injected copy failure');
        }
        copy(from, to, flags);
      };
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        assert.equal(path.dirname(from), path.dirname(to), 'cross-filesystem rename would fail with EXDEV');
        assert.equal(fs.readFileSync(from, 'utf8'), 'signed');
        assert.equal(fs.readFileSync(to, 'utf8'), 'previous');
        rename(from, to);
      };
      syncBuiltinESMExports();
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key))), TMPDIR: temp },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, failure === 'none' ? 0 : 1, result.stderr);
    if (failure !== 'none') assert.match(result.stderr, /clang failed|signing failed|injected copy failure/);
    assert.equal(fs.readFileSync(output, 'utf8'), failure === 'none' ? 'signed' : 'previous');
    assert.deepEqual(fs.readdirSync(temp), []);
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ['system.node']);
  });
}
