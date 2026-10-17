---
description: "Prebuilt system primitives for Linux confinement and POSIX Session write locks."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

## Summary

Use the Linux `landlock-run` executable to confine subprocesses, or the `./flock` entry to acquire a POSIX write lock. Platform packages contain the precompiled binaries; consumer installation never builds native code. Landlock policy and Session lifecycle remain with callers.

## Table of Contents

- [Use](#use)
- [Support](#support)
- [Development](#development)

## Use

`@deepseek-ai/node-addon-system/landlock-run` exports `launcherPath`, `probe`, and `grantArgs` for Landlock. Its executable name, flags, and failure semantics are defined by the [CLI contract](docs/cli-contract.md).

The [flock behavior contract](docs/flock-contract.md) maps descriptor, process, and advisory-lock semantics to independent native tests.

`@deepseek-ai/node-addon-system/flock` exports `tryLockExclusive(fd): Promise<void>`. Keep the descriptor open until completion. Acquisition uses nonblocking exclusive flock; contention rejects with `EAGAIN` or `EWOULDBLOCK`, and closing the final descriptor for the open file description releases the lock. See the [entry README](packages/entry/README.md).

Importing either entry does not load an addon. A missing Landlock executable probes unusable; a missing flock binding rejects acquisition. Neither path compiles or silently grants unsupported behavior.

## Support

Linux x64/arm64 packages contain the static Landlock executable and separate glibc/musl `system.node` files. macOS x64/arm64 and HarmonyOS ARM64 packages contain `system.node` only. HarmonyOS selects its signed Node-API v8 addon with `process.platform === "openharmony"`; it provides no Landlock launcher. Landlock additionally needs an enforcing Linux kernel; Windows uses the Harness's existing locking implementation. The [support matrix](docs/support-matrix.md) names builders and verification owners.

## Development

From this directory, `pnpm build:ts` builds the entry, `pnpm build:native` builds the host's declared native payload, and `pnpm build:test-oracle` builds an independent flock syscall fixture. Then `pnpm test` exercises entry, lock, packaging, and available kernel behavior. Linux requires musl-gcc for a complete build; macOS uses cc. The root `pnpm run build:native-system` builds only the current host addon for source tests.

On HarmonyOS with Node 24 and its development headers, run `node native/system/scripts/build.ts --host-addon-only` from the repository root. Put `clang`, `llvm-objcopy` and `binary-sign-tool` in PATH (check the LLVM tools PATH if missing) and point `TMPDIR` at application-private temporary storage. Preparation removes the SDK linker's initial codesign section from a temporary copy before final signing. Compilation and signing directories are cleaned after success or failure; publication copies to a unique pending file beside the destination before renaming, including when TMPDIR and the source tree are on different filesystems.

HarmonyOS lock tests include native callbacks, workers, processes, and an independent C oracle. Build the oracle with SDK Clang and `binary-sign-tool`; it executes from `$XDG_CACHE_HOME` because shared HOME ignores executable chmod. Test temporary directories use `$TMPDIR`.

The [architecture](docs/architecture.md), [packaging](docs/packaging.md), and [release procedure](docs/release.md) own implementation and publication details.

### Dev Note

None.
