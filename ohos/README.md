---
description: "Install, build, and validate DeepSeek Harness on HarmonyOS PC ARM64."
---

# DeepSeek Harness on HarmonyOS

English | [中文](README.zh.md)

## Summary

This distribution runs the CLI/headless and browser Web profiles on HarmonyOS PC ARM64 with Node.js 24 or later and `/usr/bin/zsh`. The npm package contains the application and its JavaScript runtime dependencies; oheco supplies the adapted node-pty, Koffi, sharp, and ripgrep packages through npm.

## Installation and use

Use oo 0.5.0 or later. Install into a writable npm prefix and add its `bin` directory to `PATH`:

```sh
oo update
oo npm install --global --prefix "$HOME/.local" @deepseek-ai/dsh@0.1.5-rc.2-ohos.1
export PATH="$HOME/.local/bin:$PATH"
dsh --help
```

Set `DSH_HOME` to a writable application-private directory. Configure `DEEPSEEK_API_KEY` before calling a remote provider. `dsh --profile headless "your task"` runs a command-line task; `dsh web --host 127.0.0.1 --port 0 --no-open` starts the browser interface. Follow the address and authentication instructions printed by the Web profile.

The HarmonyOS default is full filesystem/process access with approvals disabled. Explicit permission configuration remains authoritative; a requested sandbox fails when no supported backend exists. Shell tools use zsh syntax. Python 3 with `termios` is required for the optional persistent-terminal tool. Sharp uses the upstream WASM implementation; its supported image formats differ from native libvips builds.

## Reproducible build

The source branch is `ohos/0.1.5-rc.2` in [oheco/deepseek-harness](https://github.com/oheco/deepseek-harness). The upstream commit and exact adapted dependency versions are recorded in `ohos/release.json`. The source lockfile fixes the JavaScript dependencies, including pnpm integrity hashes and repository patches. Prepare the lockfile's pnpm store with the configured proxy before building; the release build uses offline mode and refuses missing inputs. Use the repository's pinned pnpm with Node.js 24, Python 3, and Git on the build machine.

```sh
python3 ohos/build.py --output /absolute/path/to/fresh-build
```

Build the system addon on HarmonyOS with Node development headers, Clang, and `binary-sign-tool` available in `PATH`:

```sh
node --experimental-strip-types native/system/scripts/build.ts --host-addon-only
```

Package the production deployment with the signed HarmonyOS addon. When packaging from another machine, pass `--system-addon` with the corresponding shared-file path.

```sh
python3 ohos/package.py --deployment /absolute/path/to/fresh-build/deployment --output /absolute/path/to/fresh-release
```

The archive keeps the signed addon unchanged and records the source commit, lockfile hash, addon hash, and bundled package versions in `build-info.json`. Publish only archives built from the accepted clean commit. npm runs no dependency build scripts during oo installation.

## Validation and limits

Native acceptance uses HarmonyOS PC ARM64, Node.js 24.21.0, Python 3.14.7, and SDK 26.0.0.35-Beta. A local deterministic DeepSeek-compatible provider exercises real profile startup, zsh arrays and file effects, persistent terminal state and reset, search, JavaScript PTC, session persistence, and Web authentication/static resources. The installed launcher and an installation path containing spaces are part of acceptance.

Live remote-model behavior needs a provider credential and is not established by the local provider tests. Electron is outside this distribution. The Python SDK is not included: the tested host lacks its pydantic/pydantic-core dependencies. JavaScript PTC runs through the Node runtime and does not require the Python SDK. Persistent terminals cannot detect a process waiting specifically on stdin on this platform.
