---
description: "JavaScript entry for the prebuilt Landlock launcher and asynchronous POSIX flock."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

The `./landlock-run` entry exports the Landlock launcher path, enforcement probe, grant arguments, and protocol constants. The independent `./flock` entry exports `tryLockExclusive(fd): Promise<void>`, and `./exclusive-file` exports HarmonyOS-only `openExclusive(path, mode): number`. Importing any entry does not load `system.node`. The package has no root export.

The lock operation attempts `LOCK_EX | LOCK_NB` asynchronously. Keep the caller-owned descriptor open until completion; contention rejects with `EAGAIN`/`EWOULDBLOCK`, other syscall failures also reject, and errors carry their code, positive errno, and `syscall: 'flock'`. Native setup errors reject the same promise. Closing the last descriptor for the open file description releases the lock. The binding does not open, duplicate, close, or explicitly unlock descriptors.

Optional OS/CPU platform packages carry the binaries. Their `~x.y.z` dependency ranges allow later patches within the same minor version. Linux has `bin/landlock-run` and separate `bin/glibc/system.node` / `bin/musl/system.node`; macOS and HarmonyOS ARM64 have `bin/system.node`. Missing or unloadable flock bindings reject acquisition, without installation-time compilation. Landlock remains a separate executable with its existing fail-closed protocol; unsupported kernels/platforms probe unusable.

`openExclusive(path, mode)` synchronously creates a regular file with `O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC` and returns a caller-owned writable descriptor. The path is a UTF-8 string without NUL characters; its parent must exist. Mode is an integer from `0` to `0o777`, reduced by umask. The caller writes and closes the descriptor. Existing files, symlinks and special files are rejected without opening or changing them. The operation never retries, reopens, truncates or unlinks a path. Open errors carry `code`, positive `errno`, `syscall: 'open'`, and `path`; unsupported platforms and missing bindings fail when called.

On HarmonyOS, only SIGCHLD is blocked on the calling thread around the single libc open, then the complete original mask is restored before JavaScript resumes. Mask failures are `ExclusiveFileSignalMaskError` and carry `syscall: 'pthread_sigmask'`, `phase: 'block' | 'restore'`, and `openErrno` preserving any open failure. Setup failure performs no open. Restore failure leaves the thread mask uncertain: any returned native descriptor is closed, creation may have occurred, and the caller must stop dependent work. Result construction failure also closes a newly created descriptor; no failure removes its path. The capability does not change Node's filesystem methods or the process-wide signal disposition.

The C sources and exclusive-file header ship for auditability. See the workspace [architecture](../../docs/architecture.md), [support matrix](../../docs/support-matrix.md), and [CLI contract](../../docs/cli-contract.md).
