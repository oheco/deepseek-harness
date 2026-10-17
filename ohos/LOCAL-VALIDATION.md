# 0.2.1-rc.2 HarmonyOS validation

This record covers the `0.2.1-rc.2-ohos.1` port. [release.json](release.json) owns the upstream baseline, runtime dependency revisions and reviewed lock digest; [app-release.json](app-release.json) owns the independent App identity. Historical 0.2.0 test totals are not evidence for this version. Validation is in progress; unfinished checks below must be replaced with their actual results before publication.

## Inputs

- Upstream tag: `dsh-v0.2.1-rc.2`; adaptation branch: `ohos/0.2.1-rc.2`.
- Host: HarmonyOS ARM64, Node.js 24.21.0, Python 3.14.7, SDK Clang, Go 1.27.1 and `binary-sign-tool`.
- Build inputs: pnpm 11.28.5, oxlint 1.81.0, oxlint-tsgolint 7.0.2001, Lightning CSS WASM 1.33.0, and the exact esbuild/Rolldown/Rollup/resolver versions in `tpr/ohos-build-tools/SOURCES.json`. Every retained archive and license digest was checked. The complete lint source archive is retained; build preparation omits only TypeScript-Go compiler golden outputs (`testdata/baselines`, 49,440 entries), which are neither compiled nor embedded. All compiler source, bundled declarations, diagnostics and vendored Go dependencies remain. The first preparation was stopped during golden-output extraction and restarted in a new output directory with this filter. The native lint build completed and its original explicit signing step passed. The preparation recipe now removes any existing signing section from a private output copy before final signing, accommodating the observed difference between go run and this go build output. Native catalog generation passed with CGO_ENABLED=0, avoiding the current SDK external linker's existing codesign section.
- All upstream registry package records and snapshots remain byte-identical; only HarmonyOS workspace importers and the existing Koffi snapshot link are added. Proxy-only frozen prefetch passed. pnpm uses the existing proxy's verified HTTP CONNECT endpoint because its SOCKS transport failed; no direct network fallback was used.
- The CLI/Web closure contains 307 workspace packages. Electron is excluded. The source checkout began without node_modules and the build uses frozen offline installation with copy semantics.
- All 19 modified and 11 untracked old App files were snapshotted with SHA-256 before migration. The old checkout and installed service remain unchanged. Current App tests and metadata extend those migrated inputs; the released broker SDK remains 0.5.0 without local SDK changes.

## Source checks

| Check | Result |
|---|---|
| App logic | 185/185 passed under Node 24, using the existing read-only TypeScript tool installation for test transpilation |
| App back-history negative controls | Two in-memory origin-filter mutations failed the new regressions as expected; production source was unchanged |
| Web authentication merge | Syntax and static comparison passed; dependency-backed tests pending |
| Runtime/platform tests | Pending |
| Native flock and independent oracle | Pending |
| App native diagnostics | Two independent C++ logger tests compiled with warnings enabled, stripped of the linker's initial codesign section, signed with binary-sign-tool and executed successfully; temporary inputs cleaned |
| Native broker localhost suite | Final build/sign/run passed, including expired access, persistent reply loss, durable pending journal, exact restart replay, TLS roots/rejection, cancellation and cookie probe; two overlapping isolated runs passed and altered-journal negative control failed as expected |
| App project export and standalone ArkTS | 22/22 project tests passed; current installed SDK checker reported 0 errors with product API 23 (existing SDK/NAPI/deprecation/permission warnings retained) |
| Host/Client/Web build and build:check | Pending |
| Native lint tool build/signing | Go source build passed; revised private-copy signature normalization passed; final AArch64 ELF has one codesign section, 20,997,184 bytes, SHA-256 `f156a3129d524d76b9804a67b571c2c137be273c5561744a2cc38c2943620456`; behavioral lint checks pending |
| Documentation, lint and manifest checks | Pending |

The App additions cover blank-page back/reentry, pending initial blank navigation, same-origin history, rejection of foreign/blank history, throwing history APIs, empty history, menu/search precedence and binary WebSocket diagnostic thresholds. The Web changes retain public URL, TLS audience and API Peer behavior while adding the optional fixed launch token.

## Built artifacts

The fresh offline runtime build is in progress. The App HAP completed a fresh offline Hvigor 7.26.8 / SDK 26.0.0.105 Release build, signing and independent signature verification, retaining compatible API23. The 5,402,074-byte local HAP has SHA-256 `277e801e05d547f2da97a1c2fcb21dce27c30845883a14f4de6f9d379d5c32b2`; 252 source inputs matched its build cache at build time. The signing public key matches the original family and temporary signing material/configuration was cleaned. The signed personal HAP is local; the public App deliverable is an unsigned portable source project. [App build checks](app/validation/port-0.2.1-rc.2/app-build-checks.json) retains the results. Runtime hashes, source identity and actual acceptance results will be recorded after they pass.

## Installed package acceptance and publication

The runtime's five shipped-profile scenarios, path relocation, old-format compatibility, real-provider smoke, immutable Release verification, catalog deployment and isolated official-index installation are pending. Existing credentials and sessions are not copied into test roots.

The sharp 0.35.5-ohos.1 dependency is published as an immutable Release. Catalog commit `340a94b7b271f68d2642ddaeaad756568a98b3e7` passed native generation and site checks, then Pages run `39042647250` deployed it successfully. The default official v6 index contains the released archive with SHA-256 `ebe84217f42c1c6761559d6371ca7188a6957da1ca7cb5283366ecd69d5c2ce8`, 3,937,861 bytes. oo 0.13.0 update, exact-version install into a fresh prefix with spaces, byte-exact RGBA PNG roundtrip and non-symmetric rotation, lossless WebP resize, and uninstall passed. The private test root was cleaned; the existing installation was not modified.

## Platform limits

HarmonyOS uses zsh and has no supported process sandbox backend; explicit confinement requests fail. Shared HOME cannot enforce private chmod and forbids hard links; configuration/session state belongs on the application-private filesystem. Linux syscall-level terminal wait detection is unavailable. Session telemetry remains disabled by the HarmonyOS composition.

Office-to-PDF remains disabled on HarmonyOS. The locked LibreOffice Kit 0.1.5 CLI capability query ran on the actual host and explicitly rejected `openharmony-arm64` with exit 1; the package limits its WASM fallback to Linux. Other document previews remain mounted. App source/native checks and HAP build/signature checks do not establish manual ArkWeb interactions, device permission prompts or seamless continuation of old TCP connections through every network outage. Manual device behavior is reported separately from automated checks.
