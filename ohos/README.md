# HarmonyOS CLI/Web and App — 0.2.1-rc.2-ohos.1

English | [中文](README.zh.md)

## Scope

The oheco distribution is `0.2.1-rc.2-ohos.1`, based on upstream `dsh-v0.2.1-rc.2`; upstream workspace packages retain their rc.2 versions. [release.json](release.json) records the exact upstream source and adapted dependencies. [app-release.json](app-release.json) independently records the App revision. The adaptation branch is `ohos/0.2.1-rc.2` in the upstream fork. CLI/Web excludes Electron; the separate HarmonyOS App manages local and broker connections without embedding Node or the npm runtime.

## Install and run

Install Node.js 24 and the runtime through the official software catalog:

```sh
oo install nodejs
oo install deepseek-harness
dsh --version
DSH_HOME="${XDG_CONFIG_HOME:?}/deepseek-harness" dsh web --host 127.0.0.1 --port 0 --no-open
```

The catalog installs the four exact HarmonyOS dependencies in `release.json` through npm. The archive contains the production CLI/Web closure, Web assets and signed system addon. oo invokes npm with global installation by default; explicit npm options after `--` select another scope or prefix. Open the authentication URL printed by `dsh web`. Use an application-private `DSH_HOME`; shared HOME cannot enforce private permissions. Do not copy existing credentials or sessions into validation roots. Upstream owns Session upgrade compatibility; this adaptation does not promise downgrade support.

Export App `0.2.1-rc.2-ohos.1` with `oo export deepseek-harness@0.2.1-rc.2-ohos.1 app --output <new-directory>`; the package version selects the matching CLI/Web release and the named project selects its App revision. Its bundle is `org.oheco.deepseekharness`; installation upgrades the same App. Personally sign the project for the intended devices in DevEco. New connection defaults launch installed `dsh`, choose a loopback port automatically and write `~/Documents/dsh-0.2.1-run.log`; saved user commands remain unchanged. See the [App reference](app/README.md) for connection behavior and the [broker integration](app/entry/src/main/cpp/broker/README.md) for the unchanged official 0.5.0 SDK, trust and recovery requirements. Engineering exports contain the offline SDK and native dependencies, but no personal signing configuration.

## Reproduce the build

Requirements: HarmonyOS PC ARM64, Node.js 24 with development headers, Python 3, SDK Clang and llvm-objcopy, oheco Go `1.27.1-ohos.1` and `binary-sign-tool` on PATH. Pinned tools, archives, digests and licenses live under `tpr/ohos-build-tools`, including pnpm. VitePress uses unchanged esbuild-wasm 0.21.5 for its locked 0.21.5 compiler through the local dependency copy; other build tools retain their pinned HarmonyOS/WASM packages. Tool preparation builds the locked oxlint-tsgolint 7.0.2001 backend natively from the complete pinned Go source and dependency archives. Preparation removes any existing signing section from a private output copy before signing it through binary-sign-tool. The input manifest records its filesystem-case adaptation. Preparation leaves TypeScript-Go compiler golden outputs in the verified full archive without unpacking them; source, bundled declarations, diagnostics and vendored dependencies remain in the build workspace. Prefetch the lockfile dependencies through the configured proxy, then build offline; do not reuse another version's node_modules.

Host and Client compilation and bundling use upstream library build steps, with the desktop bundle excluded. Run `build:check` after these artifacts exist to check the aggregate test and script programs.

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store <private-prepared-store> --output <fresh-build>
python3 ohos/package.py --deployment <fresh-build>/deployment --output <fresh-package>
python3 ohos/package-app-project.py --output <fresh-app-output>
```

`prepare-runtime.py` computes the current CLI/Web deploy closure. `update-workspace-lock.py` adds HarmonyOS workspace links and reuses fixed upstream Koffi without resolving registry versions; review the lock and its digest in `release.json`. `build.py` requires a fresh checkout without node_modules, installs frozen offline inputs with copy semantics, compiles Host/Client/Web and the signed flock addon, retains the official brand, and deploys production packages. The App exporter verifies every SDK/native input and defaults to the installed runtime; `--web-launcher` explicitly selects a local trial launcher.

Temporary files and directories use `$TMPDIR` and are cleaned. Keep paths short for tsx Unix sockets. Build caches use `$XDG_CACHE_HOME`; long-lived configuration, credentials and sessions use `$XDG_CONFIG_HOME`. `install-local.py` prepares an isolated archive installation with fixed HarmonyOS dependencies and refuses existing output directories. `acceptance.py` exercises the installed artifact with private state. Runtime validation is in [LOCAL-VALIDATION.md](LOCAL-VALIDATION.md); [App validation](app/VALIDATION.md) distinguishes source checks, build/signature checks and install-only device results.

## Platform limitations

LibreOffice Kit 0.1.5 has no OpenHarmony engine. Its capability query returns `Unsupported LibreOfficeKit host: openharmony-arm64`. The Web composition disables its Office-to-PDF provider, while retaining general document previews and the independent Excel/CSV byte viewer. Engine-backed Office conversion, recalculation and rendering remain unsupported; other JS/Python Office editing tools are not validated. The adaptation uses neither Linux binaries nor global platform spoofing.

Shell tools use `/usr/bin/zsh`. Persistent terminals require Python 3 with termios and cannot reliably detect a child waiting for input. HarmonyOS has no supported process sandbox backend: default full access with approvals disabled remains, while explicit sandbox requests fail. File publication handles shared HOME's missing hardlinks/private chmod. Settings-document opening falls back to a path. App Documents permission and the two-step terminal launch flow remain. Source fixtures and native artifact checks do not establish manual ArkWeb behavior or transparent old TCP continuation under every network outage; device checks obey the user's install-only scope.
