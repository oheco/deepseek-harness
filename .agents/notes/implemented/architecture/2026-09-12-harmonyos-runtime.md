# Agent Note: HarmonyOS runtime and exclusive persistence

Status: implemented

English | [中文](2026-09-12-harmonyos-runtime.zh.md)

## Problem

HarmonyOS PC ARM64 exposes Node.js as `openharmony` and Python as `ohos`. The available shell is zsh, application filesystems reject hard links, and Linux sandbox and syscall-wait assumptions do not hold. Unmodified npm native packages do not select usable binaries on this platform.

## Decision

The existing CLI profiles remain the application entrypoints. HarmonyOS selects `/usr/bin/zsh` for both fresh commands and persistent PTYs. The tool name remains `bash`, while model-facing descriptions specify zsh syntax. Persistent zsh uses a zero-width OSC prompt marker; Python `termios` disables echo inside its automation PTY. Process cleanup uses `/proc` identities and foreground groups without claiming Linux stdin-wait evidence.

The base bundle defaults to `danger-full-access` and approval `never` on HarmonyOS, matching the explicitly selected port scope. Explicit permission configuration remains authoritative. Unsupported confined modes reject execution. Session telemetry is disabled on HarmonyOS.

JSONL first publication and generation publication use `renameat2(RENAME_NOREPLACE)` through Koffi, followed by directory sync. Existing targets are never overwritten. Filesystems lacking the required atomic operation fail without a partial-copy fallback. The signed Node-API system addon supplies the existing flock ownership protocol. The released-session migration rules remain in their [owning note](2026-08-31-released-session-format-migrations.md); this platform extension preserves that decision and adds its filesystem exception.

The private HarmonyOS deployment manifest includes required workspace peers explicitly. Its production closure comes from the repository lockfile, while adapted node-pty, Koffi, sharp and ripgrep remain separately versioned npm dependencies. The launcher supplies the Node internal-module flag required by the existing HMR implementation. Package installation and process execution use the platform's actual file modes.

## Alternatives considered

**Treat HarmonyOS as Linux.** The native module names, missing sandbox substrate, missing syscall records and hard-link failures make Linux detection insufficient. Platform-specific dispatch preserves other hosts' implementations.

**Rename with replacement or copy a staged log.** Replacement destroys a competing committed generation, and copying exposes incomplete bytes. The no-replacement rename preserves the existing publication invariant.

**Require Bash and native libvips before accepting CLI use.** The user selected zsh and accepted the no-sandbox port. The official sharp WASM engine already provides the image operations required by Harness; a native libvips port is a separate performance and codec decision.

## Consequences

Shell syntax is zsh on HarmonyOS, and Python 3 is required for persistent-terminal initialization. Exact stdin-wait detection remains unavailable there. The port has no sandbox enforcement; unsupported restricted modes fail explicitly. WASM memory, performance and format limits apply to images.

Native headless validation uses a local deterministic DeepSeek-compatible stream, executes actual zsh tools, verifies filesystem effects and returned tool results, reads the durable session, and joins process shutdown. Persistent-tool validation verifies state, nonzero status and shell exit. Library acceptance independently covers signed PTYs, FFI callbacks, ripgrep PCRE2 and image conversion. These results do not establish real remote API behavior without a credential, Electron support, or acceptance on every HarmonyOS version.
