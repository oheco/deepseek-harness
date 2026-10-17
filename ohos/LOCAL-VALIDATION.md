# 0.2.1-rc.2 HarmonyOS validation

This record covers the `0.2.1-rc.2-ohos.1` port. [release.json](release.json) owns the upstream baseline, runtime dependency revisions and reviewed lock digest; [app-release.json](https://github.com/oheco/deepseek-harness/blob/v0.2.1-rc.2-ohos.1/ohos/app-release.json) owns the independent App identity. Results distinguish source checks, built artifacts and installed-package acceptance. Acceptance covers the checksum-verified candidate installation and the explicitly recorded related Gateway rebuild; final archive identity and payload-equivalence checks accompany the release.

## Inputs and build

- Upstream tag: `dsh-v0.2.1-rc.2`; adaptation branch: `ohos/0.2.1-rc.2`.
- Host: HarmonyOS ARM64, Node.js 24.21.0, Python 3.14.7, SDK Clang, Go 1.27.1 and `binary-sign-tool`. Node is the application runtime; Go builds the development lint analyzer.
- Build inputs: pnpm 11.28.5, oxlint 1.81.0, oxlint-tsgolint 7.0.2001, Lightning CSS WASM 1.33.0, and the exact esbuild/Rolldown/Rollup/resolver versions in `tpr/ohos-build-tools/SOURCES.json`. Retained archives and licenses were checked. Lint preparation excludes only compiler golden outputs, which are neither compiled nor embedded; compiler source, bundled declarations, diagnostics and vendored Go dependencies remain.
- Proxy-only frozen prefetch and a fresh offline installation passed: 1,383 packages, zero downloads during installation. pnpm uses the existing proxy's verified HTTP CONNECT endpoint because its SOCKS transport failed; no direct network fallback was used.
- The initial CLI/Host/Client/Web artifact build passed from that offline installation. Its production deployment contains the 307-workspace CLI/Web closure. The official Electron application bundle is excluded.
- Finalization adds the subprocess consumer's native-entry workspace reference and pins the reviewed Sharp repair. All upstream registry package records and snapshots remain byte-identical. The affected native entry, subprocess and Gateway artifacts were rebuilt; Gateway Client runtime bytes remain unchanged. The final package retains the initial cold-build receipt and records the incremental changes separately.
- Native signing uses a private output copy, removes an existing signing section before signing, and preserves the input. The signed Go analyzer is 20,997,184 bytes; the final system addon is 27,008 bytes. Runtime metadata records their applicable digests and source identity.
- The original checkout's 19 modified and 11 untracked App files were snapshotted before migration. App inputs extend that migration; the broker SDK remains 0.5.0 without local SDK changes. Existing credentials and sessions are not copied into test roots.

## Source checks

| Check | Result |
|---|---|
| App logic | 185/185 passed under Node 24 using the existing read-only TypeScript tool installation |
| App back-history negative controls | Two in-memory origin-filter mutations failed the regressions as expected; production source was unchanged |
| App syntax, resources and native diagnostics | Syntax/resource/pairing/whitespace checks passed; two independent C++ logger tests compiled, signed and ran |
| App project and ArkTS | 22/22 project tests passed; the SDK checker reported zero errors with compatible API23; existing SDK/NAPI/deprecation/permission warnings remain |
| Native broker | Two independent signed localhost runs and two overlapping runs passed; altered-journal negative control rejected the fixture |
| Native exclusive creation | Three focused tests, live stdout workloads, ownership/error cases, whole-mask comparisons and a signed fault oracle passed; the existing flock contention, build/initialization and export checks also passed |
| Output collection and terminal cleanup | The selected collector/logger, stdout/stderr spill and foreground/disowned-terminal cases passed together: 20/20; an independent real collector probe preserved exact bytes in 40/40 streams |
| Foreground inspection | 13 process-inspector tests passed, including redacted proc fields and native foreground-group lookup; the real ISIG-disabled foreground SIGINT case also passed |
| Session generations and documentation fixtures | 75 generation cases passed with one genuine hard-link capability skip; POSIX publication behavior is simulated explicitly in the other HarmonyOS fixtures; 22 documentation and 19 repository-reference cases passed |
| Shell execution and sandbox capability | Focused executor and sandbox tests passed with explicit Bash fixtures and awaited disposal |
| Source CLI/profile launch | Five source-launch cases passed with unchanged deadlines, assertions and zero retries; short cases used a private read-only copy of existing TSX transforms rather than an uncached claim |
| Sharp standard streams | The immutable `0.35.5-ohos.2` repair passed 36 stdio cases, exact desktop-launch stdio layouts, isolated installations and relocation; two independent offline archives were byte-identical |
| Aggregate types and changed-file lint | Host and Client checks passed after the current artifacts; the affected Host program passed again after the type-only lint corrections; changed-file lint passed |
| Gateway streaming and transport configuration | 77/77 cases across the two related suites passed: fragment/message preservation, Unicode, interleaved Ping probes, zero/fractional fragment-size rejection, stalled-peer termination, iterator cleanup, multiplexing and cancellation |
| Final documentation consistency | Four named bilingual pairs and the exported-API JSDoc check passed; the earlier seven-document link/anchor check covers the changed links, and the Gateway additions introduce no links; the unrelated full documentation-site build was canceled |

The exclusive-file primitive blocks SIGCHLD only on the calling thread around one exclusive open. A failed mask setup opens nothing; a failed restoration closes any returned descriptor and causes the collector to stop dependent work rather than claim safe recovery. The [native entry](https://github.com/oheco/deepseek-harness/blob/v0.2.1-rc.2-ohos.1/native/system/packages/entry/README.md) and [collector](https://github.com/oheco/deepseek-harness/blob/v0.2.1-rc.2-ohos.1/packages/subprocess/subprocess-local/README.md) own these failure guarantees. The two terminal cases passed with the original readiness deadlines and added failure diagnostics; those results do not establish a cause for the earlier empty-PID observation.

## App artifacts

The HarmonyOS App completed a fresh offline Hvigor 7.26.8 / SDK 26.0.0.105 Release build, signing and independent signature checks, retaining compatible API23. Its local signed HAP is 5,402,074 bytes with SHA-256 `277e801e05d547f2da97a1c2fcb21dce27c30845883a14f4de6f9d379d5c32b2`; all 252 recorded source inputs matched the build cache. The signing public key matches the original family, and temporary signing material/configuration was removed. The signed personal HAP stays local; the public App deliverable is an unsigned portable source project. [App build checks](https://github.com/oheco/deepseek-harness/blob/v0.2.1-rc.2-ohos.1/ohos/app/validation/port-0.2.1-rc.2/app-build-checks.json) retains the results.

## Installed-package acceptance

| Check | Result |
|---|---|
| Archive extraction, private dependencies and relocation into a path with spaces | Passed with checksum-verified extraction, five pinned dependency copies and the complete adaptation version |
| Shipped headless, search, PTC, persistent-terminal and Web scenarios | All five passed through the shipped profiles; Web also checked the settings-document RPC and the shipped empty-authority resource-address handling |
| Synthetic old-version V4 Session read and authenticated ZIP export | Passed from the preserved 0.2.0 CLI writer; the new reader exported the V4 log and left the original synthetic committed bytes unchanged |
| Own App command and actual ArkTS readiness parser | Passed with a quoted private log path, independent launcher, isolated state and random port; actual RunLogUrl.ets parsed the readiness address |
| Native SDK broker mapping to this Web runtime | Passed against the installed runtime: token exchange303, fresh cookie, wrong-token401, homepage200, isolated settings RPC200, $events ready after WebSocket101 and normal close1000; owned listeners, process groups and state were removed |
| Current-runtime bounded weak-network regression | Six related cases passed: four browser-style autoPong-only cases (small at256KiB/s; large unlimited/256/512KiB/s) and the two previously failing large active-Ping cases at256/512KiB/s. Each completed its snapshot, stayed connected20seconds afterward and intentionally closed1000; all owned state/processes were removed |
| Browser interaction with the assembled Web build | Passed in the live ArkWeb 7 / Chrome144 browser on an isolated localhost origin: authentication, browse-picker selection of a private spaced path, workspace persistence after reload, settings and the local-path fallback; no HTTP error resources or console errors; one intentional reload canceled a request |

Large accepted snapshots contained 9,467,994–9,468,089 bytes. Browser-style clients initiate no Ping and answer server control frames through the WebSocket protocol. The Gateway queues Ping probes between bounded data fragments so that later kernel-buffered data cannot put every probe behind the complete snapshot. Message contents remain unchanged. The related rebuild changes only the recorded Gateway members; the other 28,265 members match the installed candidate byte-for-byte. Clean-source finalization changes only the root build metadata and this validation record, without another full pre-publication reinstallation.

The upstream writer remains V4 in both versions. The compatibility check uses synthetic data from an isolated old CLI invocation and checks that the new reader/export leaves its committed log bytes unchanged. Local deterministic provider streams exercise the shipped application composition and transport; no real model API key was supplied, so live remote-provider behavior is not tested.

## Publication and catalog verification

Runtime and portable-project archives must pass the applicable installed-package checks before tagging and immutable publication. Their source identity, package versions, sizes and SHA-256 values are recorded with the release. Catalog deployment and official-index install/export/run/uninstall are post-publication verification and are reported separately with the actual published URLs and deployment result. Historical Sharp and DSH artifacts remain unchanged.

## Platform limits

HarmonyOS uses zsh and has no supported process sandbox backend; explicit confinement requests fail. Shared HOME cannot enforce private chmod and forbids hard links; configuration/session state belongs on the application-private filesystem. Native PTY foreground-group lookup is available, while Linux syscall-level terminal wait detection is unavailable. Session telemetry remains disabled by the HarmonyOS composition.

Office-to-PDF remains disabled on HarmonyOS: the locked LibreOffice Kit 0.1.5 capability query rejected `openharmony-arm64`, and its WASM fallback is Linux-only. Other document previews remain mounted. App source/native checks and HAP signature checks do not establish manual ArkWeb back/reentry, device permission prompts, post-unlock behavior or recovery over every cellular outage. Automated bounded network results describe only the tested local conditions.
