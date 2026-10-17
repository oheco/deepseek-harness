import { createRequire } from 'node:module'

/**
 * Reaches a Node internal module from a test process.
 *
 * Linux and macOS use the platform's `node-addon-require-builtin` binding, matching
 * production resolution. OpenHarmony has no binding for that addon, so the tests
 * use the same `--expose-internals` route the HarmonyOS launcher gives the product;
 * the flag is injected into Vitest workers by `vitest.shared.ts`.
 * @param id - Internal module id, such as `internal/modules/esm/loader`.
 * @returns the internal module's exports.
 */
export function requireNodeInternal(id: string): unknown {
  const require = createRequire(import.meta.url)
  if ((process.platform as string) === 'openharmony') {
    if (!process.execArgv.includes('--expose-internals')) {
      throw new Error('HarmonyOS tests need Node --expose-internals; no native require-builtin binding exists')
    }
    return require(id)
  }
  const addon = require('node-addon-require-builtin') as { requireBuiltin(moduleId: string): unknown }
  return addon.requireBuiltin(id)
}
