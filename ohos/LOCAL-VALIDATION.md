# 0.2.0-rc.2 HarmonyOS local validation

This historical record covers the initial rc.2 local trial, before the connection manager, fixed Web token and SDK 0.4.0 integration. Its build and test results apply to the source snapshots named below. Current App build, signature and install evidence belongs to [App validation](app/VALIDATION.md); the formal distribution retains the rc.2 upstream baseline recorded in [release.json](release.json). No publishing or installed-package replacement occurred during this initial trial.

## Inputs and build

- Upstream: `dsh-v0.2.0-rc.2`; the exact source is recorded in [release.json](release.json).
- Independent source branch: `ohos/0.2.0-rc.2` in `deepseek-harness-0.2.0`.
- Read-only porting reference: `v0.1.7-rc.2-ohos.1`, including the completed HarmonyOS App.
- Local runtime version: `0.2.0-rc.2-ohos.1`, not published.
- Host: HarmonyOS ARM64; Node.js `v24.21.0`; Python `3.14.7`; pinned pnpm `11.7.0`; SDK Clang and PATH `binary-sign-tool`.
- Fresh build snapshot: the initial local implementation; its source identifier is retained in the archived build metadata and validation receipt. Later changes are documentation, local installation/export helpers, metadata, and one source configuration asset: the Web `office-to-pdf` row is disabled on OpenHarmony. The final packaging copies that exact committed YAML into the private deployment, records its source commit and digest as `post_build_config_updates`, and verifies all other runtime payload bytes against the five-scenario tested candidate. Compiled JS/native product sources and reviewed dependency versions are unchanged; no unchanged TypeScript build is repeated merely for a documentation/config asset. A future fresh build of the final source includes the same gate directly. The comparison is recorded outside the archive in `harness-ohos-0.2.0-local/VERIFIED.json`.
- All upstream registry package entries/snapshots remain byte-identical. Only OHOS workspace importers and the fixed existing Koffi link were added. Tool archive digests and the reviewed lock digest were checked.
- Proxy-only prefetch resolved 1373 packages, reused 1317, downloaded 51. Both source installation and the fresh build used frozen offline installation with copy semantics.
- `ohos/build.py` ran from a fresh private clone without node_modules, built signed flock plus Host/Client/Web, retained the official brand, excluded Electron packaging, and deployed the 290-workspace CLI/Web closure. Build and clone temporary directories were cleaned. Cache outputs remain separate from the current installation.

Commands used for the fresh build and initial candidate:

```sh
python3 <fresh-private-clone>/ohos/build.py --store "$XDG_CACHE_HOME/dsh-0.1.7-store" --output "$XDG_CACHE_HOME/dsh-0.2.0-build"
python3 ohos/package.py --deployment "$XDG_CACHE_HOME/dsh-0.2.0-build/deployment" --system-addon "$XDG_CACHE_HOME/dsh-0.2.0-build/deployment/node_modules/@deepseek-ai/node-addon-system-openharmony-arm64/bin/system.node" --output "$XDG_CACHE_HOME/dsh-0.2.0-candidate"
```

The tested candidate archive was 45,467,638 bytes, SHA-256 `ea41cdce5dbba8d5dfd343953d4ab93319cf9597b97ec7b02ec938b3bcde22b8`. Final documentation and build metadata are packaged separately after validation; final checksums are in the local artifact checksum file and `VERIFIED.json`, not embedded recursively in this record.

## Focused checks

| Check | Result | Evidence |
|---|---|---|
| Native build / package / flock behavior | 62/62, no skips | `logs/native-build.log`, `logs/native-oracle-build.log`, `logs/native-tests.log` |
| Runtime compatibility | 18 focused files, 158 distinct successful assertions | `logs/runtime-focused*.log` |
| New Office platform gate / existing preview diagnostics | 2 focused files, 30/30 | `logs/runtime-office-gate-focused.log` |
| Host and Client TypeScript compilation | Passed in fresh full Web build | `logs/build.log` |
| App logic and project checks | 23 + 16 passed | `ohos/app/validation`, App `VALIDATION.md` |
| App ArkTS independent semantic check | 0 errors, 10 warnings | App `VALIDATION.md` |
| Icons and bilingual documentation pairs | Passed | App logs and runtime scoped pairing checks |
| Python helpers / zsh launcher syntax / patch whitespace | Passed | `py_compile`, `zsh -n`, `git diff --check` |

Native tests include real descriptor contention, cross-process exclusion, SIGKILL ownership release, worker termination, callback errno behavior and an independent compiled/signed C oracle, not only metadata fixtures. The oracle executes from private cache because shared HOME ignores executable chmod. The initial native test run exposed an obsolete unsupported-platform expectation in the upstream fixture; adding the HarmonyOS branch and enabling the native tests produced 62/62 without skipping.

Runtime tests cover no-hardlink publication/conflicts, ArkWeb resource grammar/sidebar, settings-document path fallback, resolver/loader flags, configured shell selection, real zsh PTY state/cleanup, persistent tool behavior, JSONL generation, and real source startup/profile resolution. The first batch had one 15-second cold loader subprocess timeout; the identical standalone operation and the failing file rerun passed without changing the timeout, flags, assertions or implementation. The original failing log is retained rather than claiming the first run was green. No full repository suite was run.

## Installed runtime acceptance

The actual candidate archive was checksum-verified and extracted under a private **installation path containing spaces**. Pinned OHOS node-pty/Koffi/sharp/ripgrep copies were added via `install-local.py` and `local-dependencies.py`; existing installed dependencies were never modified. Every test used independent temporary state, local deterministic Messages streaming and random loopback ports, with cleanup of its own process groups.

```sh
python3 ohos/install-local.py --archive "$XDG_CACHE_HOME/dsh-0.2.0-candidate/deepseek-harness-0.2.0-rc.2-ohos.1.tgz" --dependencies-source "$XDG_CACHE_HOME/dsh-0.2.0-source-deps/node_modules" --output "<private-temp>/install with spaces"
python3 ohos/acceptance.py --dsh "<private-temp>/install with spaces/package/bin/dsh" --tmp-parent "$TMPDIR" --logs ../harness-ohos-0.2.0-local/logs/acceptance
```

**5/5 passed:** headless tool/provider round trip and zsh/file effects; ripgrep/glob search; PTC dispatch; persistent zsh variables/working directory/reset/exit codes; Web readiness/authentication Cookie/official title/fetched JS assets/settings path fallback/shipped resource-bundle address resolution. Durable session writing was exercised. Evidence: `logs/acceptance-run.log`, `logs/acceptance/acceptance.json` and scenario logs.

## App and local delivery

The migrated App retains Documents permission, searches, context actions, external links, path actions, theme overlays/first-frame mask and robust large-log parsing. No UserFile, broker buttons or configuration-editor bridge were added. The independent user-facing launcher defaults to `$XDG_CONFIG_HOME/dsh-0.2.0-local`, loopback and port 0; explicit overrides are `DSH_020_HOME` / `DSH_020_PORT`. It ignores an inherited generic `DSH_HOME` so the current service cannot supply old session state accidentally. App logs use `~/Documents/dsh-0.2.0-run.log`.

`export/DSHApp-0.2.0` is a new project, created with 71 staged files individually matched, no personal signing/configuration/build residue and unchanged bundle name `org.oheco.deepseekharness`. Later check records are synchronized only to this new project. The App-specific `VALIDATION.md` records the actual homepage-command and log-parser Web integration result. The identical bundle name means manual installation upgrades the same App, not a parallel installation. No HAP build, signing or installation was performed.

## Explicit unsupported and unverified capabilities

The new Office gate was also checked through real Loader/Include composition of the shipped YAML: the OHOS provider is disabled, its package is not imported or initialized, and the general preview configuration stays mounted. Existing client tests verify the missing-provider/endpoint `unavailable` diagnostic. The final gated archive receives a separate Web-only smoke; its result is recorded in `logs/acceptance-final`, and payload comparison ensures no other runtime bytes changed after the five-scenario candidate.

- **New upstream LibreOffice Kit 0.1.1 does not select an engine on OpenHarmony.** The shipped CLI `capabilities --json` was checked and failed with `Unsupported LibreOfficeKit host: openharmony-arm64` (recorded in `logs/office-capabilities.log`). Office-to-PDF/engine-backed conversion, recalculation and rendering are unavailable in this local port, not counted as passed. No Linux engine or global `process.platform` spoofing was used. Office editing through other JS/Python tools was not validated.
- HarmonyOS has no supported process sandbox backend. Default full access / disabled approvals is preserved; explicit sandbox requests must fail. Linux precise syscall-wait terminal detection is unavailable.
- Shared HOME chmod cannot protect credentials/session data. Test state used private storage; no old sessions or credentials were copied. Fresh temporary runtime checks do not establish live HOME/hmdfs permissions on all devices.
- New upstream OTel infrastructure was preserved, with session telemetry still disabled on OHOS as before. Telemetry egress was not validated.
- Live remote model APIs, manual browser/ArkWeb interactions, ordinary-HAP Documents permission, DevEco HAP build/sign/install, old-session upgrade/downgrade, exhaustive local lint and full repository/platform-matrix tests were not verified.
- The old source tree, old App exports, software catalog and current installed DSH/service were left untouched. No publishing or formal-index installation was attempted.
