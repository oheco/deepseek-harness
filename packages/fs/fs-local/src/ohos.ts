/** HarmonyOS no-replace publication, where the platform denies hard links. */

import { getSystemErrorName } from 'node:util'

type RenameAt2 = (oldDir: number, source: string, newDir: number, target: string, flags: number) => number

interface Bindings {
  rename: RenameAt2
  errno: () => number
}

const AT_FDCWD = -100
const RENAME_NOREPLACE = 1
let bindings: Bindings | undefined

/* jscpd:ignore-start -- the one-syscall binding is the platform's only no-replace publication primitive; a shared module would make one feature package depend on another's internals. */
/**
 * Move a synced staging file into place without replacing any existing entry.
 * HarmonyOS application filesystems reject `link(2)` with `EPERM`, so guarded
 * creation publishes through `renameat2(RENAME_NOREPLACE)` instead: the
 * complete staged file appears at the target and a concurrent creator is
 * refused with `EEXIST` rather than overwritten. The caller owns staging
 * cleanup and parent-directory fsync after success. A filesystem without
 * `RENAME_NOREPLACE` rejects publication; there is no overwrite or
 * partial-copy fallback.
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
/* jscpd:ignore-end */
