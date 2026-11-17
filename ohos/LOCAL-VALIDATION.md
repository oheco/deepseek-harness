# 0.2.2-rc.3 HarmonyOS local validation

This record covers the local `0.2.2-rc.3-ohos.1` port at upstream `dsh-v0.2.2-rc.3`. [release.json](release.json) fixes the source, runtime dependencies and reviewed lock digest. [app-release.json](app-release.json) retains the previous latest App identity. After the local checks and installation, the user confirmed normal operation of the upgraded runtime and installed plugins on 2026-11-17 and authorized publication. The release retains the tested runtime code; source identity, documentation and release records are finalized before publication.

## Inputs and build

- Host: HarmonyOS ARM64, HongMeng Kernel 1.13.0, Node.js 24.21.0, Python 3.14.7 and system zsh 5.9. The retained SDK Clang and `binary-sign-tool` build and sign the system addon on this host.
- pnpm 11.28.5 and all fixed tools in `tpr/ohos-build-tools/SOURCES.json` were prepared independently. This includes compiling and signing the Go type-aware lint backend. The source archives, hashes and licenses remain in the checkout.
- The proxy-only registry prefetch resolved 1,417 packages. Fresh dependency installation used the frozen lockfile, offline copy imports and zero downloads. Registry package records and snapshots remain byte-identical to the upstream lock; only workspace importers were added.
- The final build ran from a fresh private-filesystem checkout, with 337 workspace packages in the CLI/Web closure. Native, Host, Client and Web artifacts passed; Web records 371 client artifacts. Electron Desktop is excluded.
- `build:check` passed after the final artifact build. Production deployment passed offline using the explicit prepared store. An earlier manual attempt used the default store and failed on missing cached tarballs; the final attempt used the reviewed store without downloading or changing dependencies.
- The final build log, source-snapshot digest and native build receipt are under the local cache directory `dsh-0.2.2-rc.3-local`. The archive records its source identity and signed-addon digest in `build-info.json`.

## Source and native checks

| Surface | Actual result |
|---|---|
| Native exclusive creation and flock | 63 passed; real child/worker contention, whole SIGCHLD mask restoration, ownership, native error propagation and fault-injected build/sign/publication paths |
| Subprocess regression | 67 passed in three selected specs; 100 unrelated cases excluded by the name filter |
| Real HarmonyOS subprocess integration | Two passed: 172,032 bytes of complete UTF-8 spill with `0600` permissions; PTY foreground group, resize, input and exit cleanup |
| FS, attachments, credentials and JSONL | 31 specs, 834 unique cases: 828 passed and six platform skips; no unresolved failures |
| Credential permission policy | Exact HarmonyOS `0660` accepted during startup, reload and writes; other modes/platforms and requested creation mode retain upstream behavior |
| Shell, terminal and profile resolution | Initial scope: 6,112 cases; seven failures were traced to fixtures, contention or the independently reproduced system exec behavior. All seven were closed by targeted checks at the original deadlines. Final persistent/terminal run: 53 passed; failed-case retry: seven passed |
| App logic | 230 passed, zero failures/skips across 14 files, one CPU and serial execution |
| App project | 22 passed, including isolated exports and the updated CLI baseline expectation |
| App copying | All 324 files match `app-v0.2.1-rc.2-ohos.3`; hashes remain unchanged after this validation |
| Metadata and documentation | Workspace constraints, generated config/tool catalog freshness, relevant bilingual pairing records and `git diff --check` passed |

Storage retries retained the original five-second test deadline. Observed source-worker initialization varies with build contention; successful isolated runs measured the real worker lifecycle and natural exit. No worker-pool feature, production migration timeout or Session-format change was added. The source worker receives the necessary HarmonyOS Node flag; bundled workers retain their existing arguments.

The text-image fixture initially generated a completely white PNG before normalization because this Sharp/resvg build has no font-text engine. A deterministic outline-glyph fixture now supplies real antialiased text on every platform, preserving the JPEG ladder, dimensions and contrast assertions. Independent image dimensions were split into separate cases without changing production normalization or test deadlines.

## Installed runtime acceptance

The checksum-verified archive passed isolated extraction and execution from a path containing spaces. The installed `--version` reports the upstream `0.2.2-rc.3`; the outer package and release metadata identify `0.2.2-rc.3-ohos.1`. Plugin help, the standalone SDK configuration dump and the profile-qualified default configuration dump passed.

All five installed scenarios passed across two batches: headless, file search, PTC, persistent shell and Web. Each used a deterministic localhost DeepSeek Messages provider where needed, temporary private state and a workspace containing spaces. Checks exercised actual tool calls, durable sessions, zsh state and reset, native ripgrep, Web authentication cookies, HTML and JavaScript assets. Web started with a real `0660` credential fixture. Relocated Sharp PNG processing and a Koffi libc call also passed. Existing credentials and sessions were never copied; private test state and temporary installations were cleaned. The independent local-runtime directory remains as the runnable deliverable.

The old PTC environment switch is no longer the upstream activation path; the acceptance fixture now selects the existing PTC executor through an explicit patch. Product bundles and executor implementations remain unchanged. Real remote-model requests, interactive browser automation and manual ArkWeb operation were not tested.

Archive identities and the comparison of code/resource bytes and modes are recorded beside the local candidate. A report-only archive refresh excludes the three top-level human-readable README/validation documents from that comparison. Initial and corrected lint evidence is retained: all diagnostics were confined to two new tests; their corrected lint and native cleanup regressions passed, followed by another Host aggregate check.

## Release preparation

The outgoing runtime inputs were compared with the validated build snapshot: all 32 recorded runtime inputs are unchanged. The Git index also retains all 324 original App files and their modes, including the 34 historical validation records hidden by the copied App ignore rule. The imported broker SDK README is excluded from bilingual pairing without modifying the copied SDK. Machine-readable source-pin fields retain their full commit identifiers; the reference checker still rejects abbreviated pins, unrelated fields and files, and prohibited organization links.

The full `doc-sync` run passed 39 leaves initially. Its four remaining leaves were closed with focused checks: the CLI-help source child now receives the HarmonyOS Node flag; all 1,262 documentation pairs match; explicit machine-pin and negative-reference cases pass; the two documentation-site specs pass independently at their original 5-second test and 60-second hook deadlines. The concurrent run recorded a missing Node flag, narrow pairing/source-pin policy mismatches and timing failures; its unsuccessful logs remain retained. Isolated CLI-help and website checks passed after the fixes without increasing a deadline. ACP, website and official-bundle behavior remain unchanged. The HarmonyOS upgrade guide is staged with the installed documentation and generated index.

## Platform limits

Shared HOME cannot enforce private chmod or hard links. This port accepts its `0660` credentials by explicit policy and uses no-replace publication without hard links. Creation still requests `0600`; application-private storage remains available through `DSH_HOME`.

HarmonyOS has no supported process-confinement backend and cannot precisely detect Linux syscall-level terminal input waits. Explicit confinement fails. The deployment configuration sets the full-access default, disables HMR and telemetry, and uses the upstream configurable heartbeat interval.

System zsh ends an interactive shell when `exec` replaces it. A Python PTY probe independent of DSH reproduces the behavior; noninteractive exec works. Persistent tools report the exit, clear the terminal and rebuild it for the next call; descriptions warn that persistent state resets. No exec emulation was added.

LibreOffice Kit 0.2.3 discovers its WASM backend on this host, with native preview unavailable. Actual document conversion has not been tested. App checks do not establish a new HAP build, signature, device installation, manual ArkWeb interaction or behavior on other devices. Existing native GitHub automation has no HarmonyOS runner; this release does not extend that CI platform matrix. The user's later application acceptance is reported separately from the automated checks above.
