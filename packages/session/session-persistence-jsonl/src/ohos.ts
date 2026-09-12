/** Atomic publication without hard links on HarmonyOS application filesystems. */

import { getSystemErrorName } from 'node:util'

type RenameAt2 = (oldDir: number, source: string, newDir: number, target: string, flags: number) => number

interface Bindings {
  rename: RenameAt2
  errno: () => number
}

const AT_FDCWD = -100
const RENAME_NOREPLACE = 1
let bindings: Bindings | undefined

/**
 * Move a synced staging file into place without replacing any existing entry.
 * The caller owns parent-directory fsync after success. Unsupported filesystems
 * reject publication; there is no overwrite or partial-copy fallback.
 * @param source - complete staging file on the target filesystem.
 * @param target - destination that must not already exist.
 * @returns Completion after the atomic rename; rejects with a Node-style filesystem error.
 */
export async function publishNewFileOhos(source: string, target: string): Promise<void> {
  if (bindings === undefined) {
    const koffi = (await import('koffi')).default
    const libc = koffi.load(null)
    bindings = {
      rename: libc.func('int renameat2(int oldfd, const char *source, int newfd, const char *target, unsigned int flags)') as RenameAt2,
      errno: koffi.errno,
    }
  }
  if (bindings.rename(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE) === 0) return
  const errno = bindings.errno()
  const code = getSystemErrorName(-errno)
  const error = new Error(`renameat2 ${code}: ${source} -> ${target}`) as NodeJS.ErrnoException & { dest: string }
  error.code = code
  error.errno = -errno
  error.syscall = 'renameat2'
  error.path = source
  error.dest = target
  throw error
}
