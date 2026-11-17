/** Shared lazy selection of the installation-owned system addon. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Native exclusive-create outcome, captured before returning to JavaScript. */
export interface ExclusiveOpenResult {
  fd: number
  errno: number
  maskErrno: number
  maskPhase: 0 | 1 | 2
}

/** Independent capabilities supplied by the selected platform binary. */
export interface SystemBinding {
  tryLock(fd: number, callback: (errno: number) => void): void
  openExclusive?(path: string, mode: number): ExclusiveOpenResult
}

let binding: SystemBinding | undefined

/**
 * Load the current platform's declared addon on the first capability call.
 * @returns The cached binding; resolution or loading failures propagate.
 */
export function loadSystemBinding(): SystemBinding {
  if (binding) return binding
  const platform: string = process.platform
  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${process.arch}/package.json`)
  binding = require(join(dirname(manifest), 'bin', filename)) as SystemBinding
  return binding
}
