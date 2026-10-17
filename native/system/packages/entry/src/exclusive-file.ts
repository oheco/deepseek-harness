/** Lazy HarmonyOS exclusive regular-file creation; importing does not load an addon. */
import { getSystemErrorName } from 'node:util'
import { loadSystemBinding } from './system-binding.js'

/** A failed thread signal-mask operation; restore failure leaves the mask unknown. */
export class ExclusiveFileSignalMaskError extends Error {
  readonly syscall = 'pthread_sigmask'
  readonly code: string

  /**
   * @param errno - positive errno from pthread_sigmask.
   * @param path - requested file path, which is never removed after failure.
   * @param phase - failed mask operation; block failure performs no open.
   * @param openErrno - original open errno, or zero if open succeeded or was not attempted.
   */
  constructor(
    readonly errno: number,
    readonly path: string,
    readonly phase: 'block' | 'restore',
    readonly openErrno: number,
  ) {
    const code = getSystemErrorName(-errno)
    super(phase === 'restore'
      ? `${code}: exclusive-file signal mask restore failed; thread mask is unknown. Stop dependent work and restart the host.`
      : `${code}: exclusive-file signal mask block failed; no file was opened.`)
    this.name = 'ExclusiveFileSignalMaskError'
    this.code = code
  }
}

/**
 * Create a new regular file with O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC.
 * Only SIGCHLD is blocked on the calling thread around one libc open; the
 * original signal mask is restored before returning. The operation never retries,
 * opens an existing path, truncates, or removes a path, including after failure.
 * @param path - UTF-8 filesystem path without NUL characters; parent must exist.
 * @param mode - Integer permission bits from 0 to 0o777, reduced by the process umask.
 * @returns A writable fd owned by the caller, who must close it.
 * @throws On unsupported platforms, missing bindings, invalid arguments, or native
 *   errors. Open errors carry code, positive errno, syscall='open', and path.
 *   Signal-mask errors are ExclusiveFileSignalMaskError with phase='block'|'restore',
 *   and openErrno. A restore error leaves the thread mask uncertain; creation may
 *   have occurred, but the fd is closed and no path is removed. Stop dependent work.
 */
export function openExclusive(path: string, mode: number): number {
  const platform: string = process.platform
  if (platform !== 'openharmony') {
    throw Object.assign(new Error(`exclusive-file is not supported on ${platform}-${process.arch}`), {
      code: 'ERR_EXCLUSIVE_FILE_UNSUPPORTED_PLATFORM',
      syscall: 'open',
      path,
    })
  }
  const binding = loadSystemBinding()
  if (typeof binding.openExclusive !== 'function') {
    throw Object.assign(new Error('The system addon has no exclusive-file capability'), {
      code: 'ERR_EXCLUSIVE_FILE_UNAVAILABLE',
      syscall: 'open',
      path,
    })
  }
  const result = binding.openExclusive(path, mode)
  if (result.maskErrno !== 0) {
    throw new ExclusiveFileSignalMaskError(result.maskErrno, path, result.maskPhase === 1 ? 'block' : 'restore', result.errno)
  }
  if (result.errno !== 0) {
    const code = getSystemErrorName(-result.errno)
    throw Object.assign(new Error(`${code}: exclusive file creation failed`), {
      code,
      errno: result.errno,
      syscall: 'open',
      path,
    })
  }
  return result.fd
}
