# HarmonyOS Web port — 0.1.7-rc.2

English | [中文](README.zh.md)

## Scope

This local-only port targets HarmonyOS PC ARM64 and upstream tag `dsh-v0.1.7-rc.2`, commit `477b4f420553e8a52c2fbccc464d7561b239c443`, on branch `ohos/0.1.7-rc.2`. The runtime package adapts CLI/Web, not the upstream desktop application. The separate [HarmonyOS App project](app/README.md) now carries the completed 0.1.5 wrapper features and connects to the isolated local 0.1.7 runtime; it is exported separately, not embedded in the npm package. No release, registry update, or installed-version replacement is part of this work.

The previous port is used only as a reference. Use a separate application-private `DSH_HOME`: newer session formats must not be tested against the existing 0.1.5 data. The normal Web service on port 9000 is not used for acceptance.

## Build

Build natively on HarmonyOS with Node.js 24, Python 3, Node development headers, SDK Clang, and `binary-sign-tool` in `PATH`. Fixed build-tool archives and their checksums/licenses are in `tpr/ohos-build-tools`. The pnpm CLI is provided there; a global pnpm installation is unnecessary. Dependency acquisition must use the configured proxy before the offline build.

`prepare-runtime.py` generates the current Web/CLI workspace closure from upstream preset dependencies and workspace dependencies/required peers. It does not copy the old 0.1.5 closure. Regenerate it and the pnpm lockfile when manifests change. `update-workspace-lock.py` adds only OHOS workspace links and reuses the existing Koffi version without re-resolving registry versions. Review and record the lockfile SHA-256 in `release.json`.

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store /absolute/private/prepared-store --output /absolute/private/fresh-build
python3 ohos/package.py --deployment /absolute/private/fresh-build/deployment --output /absolute/private/local-package
```

The build requires a fresh dependency installation, uses offline/frozen/copy mode, selects the original `official` client branding, and excludes the desktop bundling step. Temporary work goes under `$TMPDIR`. Local package creation is not publication.

## Runtime and validation

The package needs the adapted node-pty, Koffi, sharp, and ripgrep versions recorded in `release.json`. They are external runtime dependencies, not upstream Linux binaries. Sharp uses WASM. The system flock addon is built and signed natively from this checkout. Use the generated `bin/dsh` launcher, which passes `--expose-internals` to the HarmonyOS Node runtime.

```sh
python3 ohos/acceptance.py --dsh /absolute/local-package/package/bin/dsh --tmp-parent "$TMPDIR" --logs /absolute/local-validation-logs
```

Acceptance uses disposable application-private data, a local deterministic model provider, and an ephemeral Web port. It does not establish real-provider behavior or real browser/WebView rendering. Current results and exact commands belong in `LOCAL-VALIDATION.md` once executed; the old version's results are not evidence for this version.

## Platform limits

Shell tools use `/usr/bin/zsh`, not bash. Persistent terminals require Python 3 with `termios`, and cannot determine whether a child is waiting specifically for stdin. HarmonyOS has no supported process sandbox backend: the platform default remains full access with approvals disabled; explicitly requested containment must fail rather than silently run unconfined. The shared user filesystem does not support hard links or private chmod modes, so credentials and session state belong in application-private storage. Native application opening is not provided; settings-document actions return the file path when no opener is available.
