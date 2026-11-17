# Support matrix

| Platform package suffix | Builder | Payload |
|---|---|---|
| linux-x64 | ubuntu-24.04 | static Landlock executable; glibc and musl system.node |
| linux-arm64 | ubuntu-24.04-arm | static Landlock executable; glibc and musl system.node |
| darwin-x64 | macos-15-intel | system.node |
| darwin-arm64 | macos-latest | system.node |
| openharmony-arm64 | native HarmonyOS arm64 | signed system.node with flock and exclusive-file |

The stable Node-API v8 addon is built once per platform/libc and exercised by CI under Node 20, 22, 24, and 26. macOS builds target 11.0 or later. Linux binding selection uses the running Node process's libc; the static launcher serves both libc variants.

HarmonyOS arm64 is built and validated locally with its native toolchain and signed binaries; GitHub-hosted runners do not cover this package. Its `./exclusive-file` capability is HarmonyOS-only, and the available Node installation determines the local runtime coverage.

Landlock additionally requires an enforcing Linux kernel. The functional probe determines full, partial, or unusable enforcement; kernel version alone is not an availability guarantee.

Windows has neither a Landlock launcher nor this POSIX addon. The Harness retains its existing Windows semaphore implementation. Other CPU/OS combinations have no published platform package: Landlock probes unusable, and flock acquisition rejects. New platform support requires a native builder and installed-artifact verification.
