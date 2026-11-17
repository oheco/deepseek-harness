---
description: "JavaScript entry for the prebuilt Landlock launcher and asynchronous POSIX flock."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

The `./landlock-run` entry exports the Landlock launcher path, enforcement probe, grant arguments, and protocol constants. The independent `./flock` entry exports `tryLockExclusive(fd): Promise<void>`; importing either entry does not load `system.node`. The package has no root export.

The lock operation attempts `LOCK_EX | LOCK_NB` asynchronously. Keep the caller-owned descriptor open until completion; contention rejects with `EAGAIN`/`EWOULDBLOCK`, other syscall failures also reject, and errors carry their code, positive errno, and `syscall: 'flock'`. Native setup errors reject the same promise. Closing the last descriptor for the open file description releases the lock. The binding does not open, duplicate, close, or explicitly unlock descriptors.

Optional OS/CPU platform packages carry the binaries. Their `~x.y.z` dependency ranges allow later patches within the same minor version. Linux has `bin/landlock-run` and separate `bin/glibc/system.node` / `bin/musl/system.node`; macOS has `bin/system.node`. Missing or unloadable flock bindings reject acquisition, without installation-time compilation. Landlock remains a separate executable with its existing fail-closed protocol; unsupported kernels/platforms probe unusable.

HarmonyOS arm64 has a signed `bin/system.node` with flock and the independent `./exclusive-file` capability. `openExclusive(path, mode)` synchronously uses `O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC`, blocking only SIGCHLD on the calling thread around one libc open and restoring the entire prior mask. It never retries, opens an existing path, truncates, or removes a path. The caller owns the returned descriptor and must close it. Open failures retain their code, positive errno, `syscall: 'open'`, and path. `ExclusiveFileSignalMaskError` identifies a failed block or restore and retains the original open errno; block failure performs no open. Restore failure closes any returned fd and leaves any created path untouched, but the thread mask is unknown: stop dependent work and restart the host. Importing the entry does not load the addon; unsupported platforms, missing binaries, and missing capabilities fail when called. Private files require a permission-preserving filesystem such as HarmonyOS `$TMPDIR`; shared HOME does not enforce the requested mode.

The C sources ship for auditability. See the workspace [architecture](../../docs/architecture.md), [support matrix](../../docs/support-matrix.md), and [CLI contract](../../docs/cli-contract.md).
