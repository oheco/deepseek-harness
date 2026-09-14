# Native supervisor verification

English | [中文](README.zh.md)

These isolated native process fixtures exercise [the portable core](../../entry/src/main/cpp/README.md); they never execute a real DSH entry or listen on port 9000. The fake signed Node executable validates the exact argument vector, six-entry explicit environment, cwd, private directory modes, inherited descriptor closure, and dedicated process group before emitting any readiness text. Two test executables cover the supervisor and the capability probe, and neither starts a real service.

## Build and sign on HarmonyOS

Requirements are Python 3, CMake, Ninja, SDK `clang++`, and `binary-sign-tool` on `PATH`, with a writable application-private `XDG_CACHE_HOME`. Run from the repository root:

```sh
python3 ohos/app/tests/native/run.py
```

The recipe creates a fresh 0700 `dsh-launcher-native-*` build directory under `XDG_CACHE_HOME`, configures native C++17 builds, signs all four executables, runs CTest, and separately links `libdsh_launcher.so` against the installed SDK's NAPI library. Compiler probes build static archives and are never executed. Build paths and retained CTest logs appear in the command output. The SDK's libc lacks `pthread_cancel`, so the core uses the compiler's `-pthread` option instead of CMake's incompatible FindThreads libc probe.

Equivalent signing and fixture commands after CMake compilation are:

```sh
binary-sign-tool sign -inFile "$BUILD/fixture with spaces" -outFile "$BUILD/fixture with spaces.signed" -selfSign 1
binary-sign-tool sign -inFile "$BUILD/dsh_supervisor_test" -outFile "$BUILD/dsh_supervisor_test.signed" -selfSign 1
binary-sign-tool sign -inFile "$BUILD/dsh_probe_test" -outFile "$BUILD/dsh_probe_test.signed" -selfSign 1
binary-sign-tool sign -inFile "$BUILD/dsh_launcher_smoke" -outFile "$BUILD/dsh_launcher_smoke.signed" -selfSign 1
```

Replace each original executable with its signed sibling and set mode 0700 before running it. `run.py` performs those replacements atomically. Re-sign after every binary rebuild or strip operation. Run the signed fixture suite again with `ctest --test-dir "$BUILD" --output-on-failure`; each invocation creates a fresh private test state subdirectory. Never use a shared HOME build directory when the test depends on owner-only permissions.

## Covered behavior

The suite covers chunked ANSI/readiness lines, complete-line-only readiness, CRLF, exact fixed and real ephemeral port validation, strict IPv4 LAN suffix validation, no-newline EOF, oversized stdout/stderr lines, malformed URLs and tokens, stdout/stderr separation, missing paths and exec errno reporting, startup timeout, TERM-resistant children, post-ready and pre-ready exit, repeated start rejection, immediate asynchronous stop, stop-before-retry from idle/error, and retry after reap. It checks every observed snapshot for credential leakage and the 16 KiB log bound, including a flooding child. Environment fixtures inject fake terminal/API credentials into the test parent and prove the child does not receive them.

Directory fixtures use private storage where chmod is effective. They prove 0100 HOME and cwd allow actual child `chdir` while `open(O_RDONLY | O_DIRECTORY)` is denied, then require the supervisor to reach readiness and restart. They also cover HOME as environment-only metadata, final HOME/work directory aliases without lexical environment rewriting, real child `chdir` denial through a 0600 directory alias with stage/path/errno and exit 127, ancestor search denial, missing paths, ordinary files, dangling links and symlink cycles. Separate short-lived child probes test actual `chdir`, never changing the test parent's cwd or relying on `access(X_OK)`, which can incorrectly return success for an unsearchable directory on OHOS. Permission changes apply only to newly created fixture directories and are restored after assertions.

The probe executable covers the real-operation file checks and the capability report. It first records that `access(R_OK)` returns success for a mode 0000 entry while `open(O_RDONLY)` fails with `EACCES`, then requires the supervisor to refuse that entry before any fork with `open file [path]: errno=13`, and proves the diagnostic never comes from `access()`. A separate case copies the signed fixture, removes its execute bits at mode 0400, and requires the distinct `execute bit [path]: errno=13` refusal with no fork, followed by a successful retry at mode 0700. Report checks require every line to carry an `OK`/`FAIL`/`INFO` prefix, printable-ASCII content, a bound of 8 KiB and 500 bytes per line, `INFO identity`/`INFO mode`/`INFO summary` lines, real opens of both files, the private-directory write, the fixture's recorded exit status, the system shell check, and the app-private copy result; no line may contain an unredacted `http://` or `https://` run. A TERM-resistant check must still terminate inside the probe's bound: the fixture runs a script that traps TERM and the report must record the terminating signal, with the whole check finished well inside the twelve-second assertion. The remaining cases prove a probe started by `start` leaves the supervised child and an unrelated process alive and reaped only by their owners, that a second `probe` call while one runs is rejected, that a completed report is stable while `running` returns to false, that a later call replaces the instance with an empty report, and that an invalid config is rejected before any probe exists. Where an existing private directory is absent, the write check reports that failure independently and the remaining checks still run.

The process-group fixture leaves an independently owned unrelated process alive, observes an owned descendant heartbeat stop, and verifies the direct child has been reaped. Where unprivileged Linux/OHOS `PR_SET_CHILD_SUBREAPER` succeeds in the isolated test executable, tests additionally reap their own adopted grandchildren and verify that killing the owner triggers the Node child's parent-death SIGKILL. The production library does not request subreaper status or require a HarmonyOS system permission API.

## Opt-in real-service driver

`dsh_launcher_smoke` is built and signed but deliberately not run by the fixture recipe. A parent agent or user may invoke it as a managed background job after independently authorizing a real DSH service:

```sh
"$BUILD/dsh_launcher_smoke" "$SIGNED_NODE" "$BUILT_DSH_ENTRY" "$HOME_DIR" "$EMPTY_WORK_DIR" "$XDG_CACHE_HOME/dsh-app-real-smoke-UNIQUE" 0
```

The private root must not already exist; its parent, HOME, and cwd must exist. The driver uses the production supervisor, waits at most 90 seconds for readiness, requests the authenticated loopback page, follows DSH's same-origin HTTP 303/cookie handoff when required, requires HTTP 200 from the resulting index request, requests stop, and verifies reap. It prints stage/PASS/failure diagnostics without URL, token, cookie, body, or arbitrary child text. It refuses explicitly configured port 9000; zero selects a free port. The caller owns the background job, collects its output, and retains or removes only its dedicated test state. A successful driver run remains terminal-context verification, not ordinary-HAP authorization evidence.

## Recorded native result

On 2026-09-14, the complete recipe passed directly on HarmonyOS aarch64 with SDK `26.0.0.35-Beta` and Clang `15.0.4`, and the same date's probe run re-ran the whole recipe: `dsh_supervisor_native` passed in 24.97 seconds and the new `dsh_probe_native` passed in 9.23 seconds, including the real-open regression, the style and bound checks on the capability report, and the coexistence/replacement cases; the NAPI shared library linked successfully. All fixture, test, and opt-in smoke executables were signed with `binary-sign-tool sign ... -selfSign 1`. The retained evidence is under `$XDG_CACHE_HOME/dsh-launcher-native-*/Testing/Temporary/LastTest.log`; the signed smoke driver is in the same build root. These recorded runs did not invoke the smoke driver. CMake printed an unknown `HarmonyOS` platform notice, but used the installed native compiler target; no Linux platform identity or cross-platform result was substituted.

The directory regression fails against the old `O_RDONLY` HOME/work preflight with errno 13 on the real 0100 HOME fixture, and passes with metadata-only preflight. On this device, `access(X_OK)` returns success for 0600 and 000 directories whose actual `chdir` returns errno 13, so fixture search probes use the operation itself. The same unreliability holds for reads: `access(R_OK)` returns success for a mode 0000 file whose actual `open(O_RDONLY)` returns errno 13, and a fixture records both results before requiring the real-open diagnostic. The probe report on this device additionally shows `execve` of an unsigned app-private copy of `/system/bin/sh` failing with errno 13 while the signed fixture and the system shells execute normally. The core also uses `O_PATH` to traverse searchable 0711 `/data` ancestors and individual `close` calls because OHOS `close_range` raises SIGSYS rather than returning ENOSYS. Signing-tool program-header alignment warnings did not prevent the signed binaries from executing.

## Not established by these tests

SDK compilation/linking does not exercise ArkTS NAPI import, async environment cleanup at VM teardown, HAP code signing and bundling, WebView navigation, ordinary HAP access to shared Node/runtime paths, SELinux fork/exec policies, background suspension, or application removal. The probe report reads the terminal process's own uid, gid, and supplementary groups, and the terminal domain holds group 1006, which is why it can read shared runtime files an ordinary app is denied; the report therefore demonstrates the checks, not the app's answers. Privilege drops are refused in this domain, so a non-owner unreadable file cannot be constructed here: the mode-0000 fixture reproduces the same `EACCES` through the real open, and the ordinary-HAP shared-path denial remains unverified. Native library and executable signing requirements can differ between terminal execution and HAP packaging. Parent-death cleanup protects the direct child on the tested kernel, not detached descendants or all device versions. A kernel-uninterruptible child can remain stopping beyond the KILL deadline; restart stays disabled until actual reap.
