import { createRequire } from 'node:module'

/**
 * Load a Node internal module through the product's platform-specific mechanism.
 * @param id - internal module id.
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
