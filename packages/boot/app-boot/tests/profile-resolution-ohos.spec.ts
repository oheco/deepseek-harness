/** HarmonyOS profile interception uses Node's explicitly exposed internal loaders. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const resolverUrl = new URL('../src/profile-resolution/resolver.ts', import.meta.url).href
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const setup = `
  import { installRuntimeInterception } from ${JSON.stringify(resolverUrl)};
  const resolution = { profilesDir: process.cwd(), localPackageNames: [], linkedRoots: [], entries: [] };
`

function run(exposed: boolean, program: string) {
  return spawnSync(process.execPath, [
    ...exposed ? ['--expose-internals'] : [],
    '--import', 'tsx/esm', '--input-type=module', '-e', setup + program,
  ], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15_000 })
}

describe.skipIf((process.platform as string) !== 'openharmony')('HarmonyOS profile internal loaders', () => {
  it('opens real ESM, CommonJS, helper, condition and resolve internals and restores interception', () => {
    const result = run(true, `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const cjs = require('internal/modules/cjs/loader').Module;
      const original = cjs._resolveFilename;
      const interception = installRuntimeInterception(resolution);
      try {
        assert.notEqual(cjs._resolveFilename, original);
        assert.equal(require.resolve('node:fs'), 'node:fs');
        assert.equal(typeof (await import('node:fs')).readFileSync, 'function');
      } finally {
        interception.dispose();
      }
      assert.equal(cjs._resolveFilename, original);
      console.log('exposed internals ready');
    `)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('exposed internals ready')
  }, 20_000)

  it('rejects a fresh Node process without the flag before loading a native binding', () => {
    const result = run(false, `installRuntimeInterception(resolution);`)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('profile resolution: HarmonyOS requires Node --expose-internals')
    expect(result.stderr).not.toContain('Cannot find module')
  })
})
