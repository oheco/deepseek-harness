# App connection diagnostics

English | [中文](CONNECTION_DIAGNOSTICS.zh.md)

This reference describes the App's connection journal and how to collect it. It distinguishes stages of a stalled local open, browser WebSocket closure, and native broker recovery.

## View and copy

After reproducing the issue, return to the connection list and tap **Diagnostic logs** in the title bar. Desktop users can return with **Ctrl+Shift+L**. **Refresh** reads the latest records; **Copy logs** copies every retained record, while the page displays only the latest 96 KiB. Opening the viewer and returning from it preserves pending connection work. Records remain available after an App restart.

The journal is stored at `context.filesDir/connection-diagnostics/connection.log`, with `connection.previous.log` as its rotation file. The directory uses mode 0700 and files use 0600. Each file is limited to 1 MiB, with at most 2 MiB retained; rotation replaces older records. Read errors show fixed feedback, and write failures do not change connection results.

Records contain timestamps, a process number, fixed event names, integers and boolean flags. This journal excludes accounts, passwords, tokens, Cookie names and values, connection names, broker/session identifiers, addresses, session contents, raw exceptions, and raw WebSocket reasons. Copying occurs only when the user taps the button.

## Interpret records

`source=app` and `source=native` share one file. `wallMs` is a timestamp, `monoMs` is native monotonic time, and `pid` distinguishes restarts. `generation` counts the corresponding App owner's lifetime, `app_gen` counts native cancellation, and `sdk_gen` counts SDK recovery. Interpret these counters separately; they cannot be compared directly. `current=0` identifies a callback from a retired page.

| Record | Relevant fields |
| --- | --- |
| `home.phase` / `home.phase_pending` | `operation` distinguishes selections and disconnects; `phase`: 1 page preparation, 2 broker mapping, 3 DSH probe, 4 WebView handoff, 5 disconnect; `elapsedMs` measures the wait |
| `index.phase` / `index.phase_pending` | `phase`: 0 ready or finished, 1 controller attachment or initial blank completion, 2 Cookie preparation, 3 navigation completion, 4 page error, 5 renderer exit; `attached` reports controller attachment |
| `cookies.read_begin` / `cookies.read_complete` / `cookies.prepared` | Cookie metadata read, completion and number expired; a missing completion can be compared with the pending stage |
| `index.back_history` / `index.back_to_connections` | History size `count`, current position `status`, and previous-entry category `phase`: 0 bootstrap blank, 1 connection origin, 2 other; addresses are excluded |
| `index.http_error` / `index.network_error` / `index.renderer_exited` | HTTP status, ArkWeb error number or renderer-exit enum; request errors use `phase=1` for the main document |
| `web.ws_created` / `web.ws_open` / `web.ws_error` / `web.ws_closed` | Only the current origin's `/api/remote.mux` is observed; socket number, close code, clean flag, age, time since the last complete message, and receive/send counts |
| `web.ws_close_requested` | The page's requested close code, separately from the resulting close event |
| `web.ws_large_message` / `web.ws_summary` | Text `chars`, `totalChars` and `maxChars` count UTF-16 code units; binary messages use `bytes`; ordinary messages are summarized at most once every five seconds |
| `web.visibility` / `web.online` / `web.offline` | Browser-reported visibility and online state; the original online getter is retained, but this remains an ArkWeb report rather than cellular-network diagnostics |
| `native_sdk_state` / `native_sdk_recovery_stopped` | SDK numeric `code`, `http`, attempts, generation and retry delay; flags bit0 means a mapping exists, bit1 means cancellation generation changed, bit2 means state query failed |
| `native_probe_stage_begin` / `native_probe_stage_end` | Stage 1 token exchange, 2 homepage; numeric curl result, HTTP, duration and retained body bytes; body contents are excluded |
| `native_operation_begin` / `native_operation_end` | Method 0 login, 1 list, 2 map, 3 manual reconnect, 4 status, 5 close, 6 DSH probe; queue and execution durations are separate |
| `native_napi_forced_close` / `native_release_begin` / `native_release_end` | Whether submission failure triggered cancellation and close, plus mapping/peer/API release durations |

`native_sdk_state.state` uses SDK numbers: 0 connecting, 1 connected, 2 reconnecting, 3 retry_wait, 4 paused, 5 failed, 6 closed. `connection.state.state` uses App numbers: 0 connected, 1 disconnected, 2 recovering, 3 authentication-required. The close `reason` is a fixed category: 0 empty, 1 reconnect requested, 2 invalid Remote stream frame, 3 Remote stream failure could not be delivered, 4 peer disposed, 5 another nonempty value. Unmatched text is discarded.

Pending-stage observations run every five seconds; stable SDK polling records only changes. Observers write logs while existing logic owns connection actions. WebSocket code 1006 means the browser did not receive a normal close frame; identifying a server heartbeat timeout or termination still requires corresponding server logs. The SDK public state does not expose its internal online-probe curl stages, so the App HTTP Probe and SDK state remain separate records.

## Verification

Run App behavior checks with `node --test ohos/app/tests/*.test.mjs`. [connection_log_test.cpp](entry/src/main/cpp/connection_log_test.cpp) covers concurrency, rotation, permissions, symlink/FIFO refusal and write failures; [native_diagnostics_test.cpp](entry/src/main/cpp/native_diagnostics_test.cpp) covers silent fallback and state deduplication. Native CMake registers both with `DSH_BUILD_BROKER_TESTS`. HarmonyOS test executables require signing before execution. Diagnostic build and device evidence is recorded separately from the existing revision in [VALIDATION.md](VALIDATION.md).
