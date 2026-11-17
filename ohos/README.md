# HarmonyOS CLI/Web — 0.2.2-rc.3-ohos.1

English | [中文](README.zh.md)

## Scope

This local port starts at upstream `dsh-v0.2.2-rc.3`. [release.json](release.json) pins the source, adapted runtime dependencies and reviewed lockfile. Source changes cover HarmonyOS file publication, native file locking and output creation, PTY inspection, zsh and Node internal-module access. HarmonyOS additionally accepts credentials files with mode `0660`; other platforms retain the upstream permission check. File creation still requests `0600`.

Fixed Web tokens, custom WebSocket fragmentation, settings-path dialogs and conversation-header factories are not added. Upstream workspace versions remain `0.2.2-rc.3`; the outer runtime archive records the adaptation revision. The HarmonyOS release is published in [oheco/deepseek-harness](https://github.com/oheco/deepseek-harness/releases/tag/v0.2.2-rc.3-ohos.1) and installed through the [oheco package catalog](https://oheco.org/).

## Local use

Node.js `>=24.9.0`, Python 3 with termios, and the fixed dependencies in `release.json` are required. Prepare a separate installation from the built archive:

```sh
python3 ohos/install-local.py --archive <runtime.tgz> --dependencies-source <adapted-node_modules> --output <new-private-directory>
<new-private-directory>/package/bin/dsh --version
<new-private-directory>/package/bin/dsh web --host 127.0.0.1 --port 0 --no-open
```

The launcher adds [compat.patch.yml](compat.patch.yml) before explicit caller overlays. That deployment configuration disables HMR and telemetry and sets the existing Gateway heartbeat interval to 60 seconds. The launcher defaults `DSH_PERMISSION_MODE` to `danger-full-access`; an explicit value is preserved. HarmonyOS has no supported process-confinement backend, so explicit confinement fails. Official bundle sources are unchanged.

The default harness home remains `~/.dsh`. Shared HOME presents credentials as `0660`, which this port accepts. Applications can instead select an application-private directory with `DSH_HOME`. Shared HOME cannot enforce private chmod modes. Temporary files use `$TMPDIR`; caches and executable build tools use `$XDG_CACHE_HOME`.

The App sources are copied from the previous latest App revision recorded in [app-release.json](app-release.json). Its local launcher and broker SDK remain unchanged, including the existing document-start ArkWeb URL compatibility script. The [App reference](app/README.md) describes those features. App source copying does not imply a new device installation or acceptance result.

## Build

Pinned archives, source inputs, hashes and licenses are retained under `tpr/ohos-build-tools`. The build uses the upstream Host/Client library steps and Web build, excluding Electron Desktop. Native addons and the type-aware lint backend are built or prepared and signed on HarmonyOS. Prefetch registry inputs through the configured proxy, then install frozen dependencies offline with copy semantics.

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store <prepared-pnpm-store> --output <fresh-build>
python3 ohos/package.py --deployment <fresh-build>/deployment --output <fresh-package>
```

Review the updated lockfile and its digest in `release.json` before building. Run `build:check` after generating artifacts. [LOCAL-VALIDATION.md](LOCAL-VALIDATION.md) records checks actually performed for this revision; previous release evidence is not a result for this port.

## Limits

Persistent terminals cannot precisely detect Linux-style syscall input waits. The native implementation retains foreground-process-group checks and PID identity protection. The system zsh ends an interactive shell when `exec` replaces it; the terminal reports the exit and the next call starts a fresh shell. Run commands directly to preserve persistent state. Session and attachment publication use atomic no-replace operations without requiring hard links on shared HOME.

Upstream LibreOffice Kit `0.2.3` discovers its WASM backend on HarmonyOS; native preview is unavailable. Actual document conversion has not been qualified in this local port. This port does not implement an Office engine or introduce an Office UI workaround. Independent browser ArkWeb behavior is outside the App's injected URL repair. Existing out-of-tree plugins must support the upstream host APIs; the old private header factory is not restored.
