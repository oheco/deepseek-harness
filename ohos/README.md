# HarmonyOS Web and App local port — 0.2.0-rc.2

English | [中文](README.zh.md)

## Scope

Upstream tag `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`, independent branch `ohos/0.2.0-rc.2`. The completed 0.1.7 HarmonyOS patches and App are porting inputs, not replacements for the new upstream code. The CLI/Web package excludes upstream Electron; `ohos/app` migrates the existing ArkWeb shell without embedding the npm runtime.

This work is local only: no push, release tag, GitHub Release, catalog update, installed-package replacement, or existing-service changes. Use an independent application-private `DSH_HOME`; do not copy credentials or existing sessions. Upstream owns session upgrade compatibility. This local trial does not verify old-session migration or downgrade.

## Build

Requirements: HarmonyOS PC ARM64, Node.js 24 and development headers, Python 3, SDK Clang, and `binary-sign-tool` on PATH. Pinned tool archives, sources, digests, and licenses are under `tpr/ohos-build-tools`, including pnpm; no global pnpm is required. Prefetch the upstream lockfile dependencies through the configured proxy, then build offline. Do not substitute the old node_modules tree.

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store /absolute/private/prepared-store --output /absolute/private/fresh-build
python3 ohos/package.py --deployment /absolute/private/fresh-build/deployment --output /absolute/private/local-package
```

`prepare-runtime.py` computes the current CLI/Web deploy closure. `update-workspace-lock.py` only adds HarmonyOS workspace links and reuses upstream Koffi 3.1.1 without resolving new registry versions. Review the resulting lockfile and record its SHA-256 in `release.json`. `build.py` requires a source tree without node_modules, then performs offline frozen installation with copy semantics, Host/Client/Web compilation, and production deployment. It keeps the `official` brand and excludes the Electron build. Save logs in the independent local delivery directory.

All temporary files and directories use `$TMPDIR` and are cleaned. Keep its path short because tsx Unix sockets are subject to the HarmonyOS `sun_path` length limit. Use `$XDG_CACHE_HOME` for caches/build outputs and application-private storage such as `$XDG_CONFIG_HOME` for configuration, credentials, and sessions, not shared HOME.

## Local operation and validation

`install-local.py --archive <archive> --dependencies-source <pinned OHOS dependencies> --output <fresh directory>` verifies the archive digest and prepares an isolated local runtime. It refuses an existing output directory and never performs a global npm installation.

The runtime requires the HarmonyOS node-pty, Koffi, sharp, and ripgrep versions pinned in `release.json`, not upstream Linux binaries. `local-dependencies.py` copies and verifies already-installed pinned HarmonyOS dependencies for isolated local validation without modifying the installation. sharp uses WASM. The system flock addon is compiled natively from current source and signed. The launcher passes `--expose-internals` for the Host's Node internal loader.

```sh
zsh /storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-local/run-web.zsh
python3 ohos/acceptance.py --dsh /absolute/local-package/package/bin/dsh --tmp-parent "$TMPDIR" --logs /absolute/local-validation-logs
```

The local launcher defaults to `$XDG_CONFIG_HOME/dsh-0.2.0-local`, loopback, a random port, no browser auto-open, and no old configuration. Open the authentication URL it prints. The App homepage command writes `~/Documents/dsh-0.2.0-run.log` and connects to that logged service. The exported project is `export/DSHApp-0.2.0`; its unchanged bundle name means installation upgrades the same App rather than co-installing it. The exported project excludes personal signing settings.

Actual focused tests and five isolated runtime scenarios are recorded in `LOCAL-VALIDATION.md`. The deterministic local model server does not establish live model API or browser/ArkWeb interaction validation. Do not default to the full repository suite or validate other software packages. Old test results are not evidence for this version.

## Platform limitations

Shell tools use `/usr/bin/zsh`. Persistent terminals require Python 3 with termios and cannot reliably detect a child waiting for input. HarmonyOS has no supported process sandbox backend: the default uses full access with approvals disabled, while an explicit sandbox request must fail rather than silently run unconfined. Shared HOME lacks hardlinks/private chmod; file publication uses the HarmonyOS implementation. Settings-document opening falls back to a path. The App retains Documents permission and the two-step launch flow; UserFile, broker buttons, and editor bridging are not added. Users build, personally sign, install, and verify HAP interactions through DevEco.
