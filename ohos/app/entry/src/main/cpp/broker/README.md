# Native broker client reference

English | [中文](README.zh.md)

The `libdsh_launcher.so` module exposes Promise methods `brokerLogin`, `brokerList`, `brokerConnect`, `brokerReconnect`, `brokerClose`, `brokerStatus` and `dshProbe`. [The TypeScript declarations](../types/libdsh_launcher/index.d.ts) own their inputs and results. [broker_client.cpp](../broker_client.cpp) owns SDK handles; [broker_napi.cpp](../broker_napi.cpp) converts results and installs the independent async cleanup hook.

## Authentication and mapping

Broker methods require the supplied service's HTTPS origin and verify the certificate chain and hostname for HTTPS and WSS. The App creates a private PEM trust bundle from root-owned, non-writable certificates in HarmonyOS `/etc/security/certificates`, then supplies it through the SDK's public `ca_file` option. Missing, unreadable, malformed or empty system roots fail the operation. The App exposes no custom CA import; NAPI rejects `caPath`, including an empty or undefined value. Only the separately compiled fixture library accepts a private test CA. QUIC peer certificates retain the SDK's independent PAKE/pinning verification.

Login returns the account bearer token to ArkTS for application-private persistence. Native code writes no account credentials to disk and never logs passwords, tokens, URLs or response bodies. Account password, peer password and DSH token are separate credentials. Management HTTP 401 rejects with `Error.code = 'DSH_BROKER_AUTH'`; terminal SDK account-authorization failures are also classified for the caller. DSH probe authentication results do not invalidate the account bearer.

Connect uses `ob_remote_connect_async`, creates one SDK TCP mapping on numeric `127.0.0.1` with an OS-selected port, and waits for authenticated connection before returning success. The target is remote `127.0.0.1` at the supplied DSH port. The SDK listener is the WebView endpoint; the App adds no forwarding listener and does not request a fixed replacement port. HTTP Host, Origin, redirects, cookies and WebSocket bytes remain unchanged. The local listener has no broker-layer caller authentication, so DSH authentication must remain enabled.

Login, list and connect receive `context.tempDir + '/dsh-broker'`. The worker creates missing components at 0700, rejects symlinks/dot components, and verifies final ownership and mode. Before SDK workers start, it sets process `TMPDIR` once to that validated App-private directory; a different directory is rejected for the native client's lifetime. The public system-root bundle and ephemeral SDK peer certificates use private files. The SDK removes peer keys and certificates on final close. No shell or TLS environment override is used.

## Recovery and ownership

One persistent App worker serializes SDK operations. `brokerStatus` reports `idle`, `connecting`, `connected`, `reconnecting`, `retry_wait`, `paused`, `failed` or `closed`; the same local URL and port remain recorded while the peer and mapping are owned. Recoverable transport loss preserves the API client, peer and map. The SDK runs its default automatic policy: up to eight attempts within a 60-second budget, followed by `paused`. The App does not implement another retry loop or reset that budget during status polling.

`brokerReconnect` wakes a paused peer through `ob_remote_peer_reconnect`. Its Promise returns a state snapshot: acceptance does not mean connection has completed. Healthy and already recovering peers remain intact. Terminal authorization failures cannot be revived by manual retry. The App observes subsequent states and verifies the DSH endpoint before reporting recovery. Explicit Back, window/ability destruction and native environment disposal are the final resource-release paths; backgrounding and temporary component detachment preserve the SDK listener.

SDK v2 can retain existing TCP/WebSocket sockets when both peer contexts and the remote target socket survive within the default 120-second grace period. Control service and both mapping peers must support the new recovery protocol for transparent old-flow continuation. With a 0.3.0 control service or peer, compatibility mode can recover mapping service and retain the App's listener, but old TCP flows may close. Business clients reconnect those flows. See the [SDK recovery guide](https://github.com/oheco/oheco-broker/blob/main/docs/RECONNECT.md).

Close invalidates App generations immediately, discards unstarted ordinary work, and settles after the owner closes the map, joins peer/control/I/O workers, and destroys the borrowed API client. Asynchronous initial peer setup can be stopped through its live handle. Management requests remain bounded by their HTTP timeout. Disposal settles queued futures and joins the App worker before native code unloads; the async cleanup hook falls back to a synchronous join if it cannot create its cleanup thread.

The DSH probe accepts only a numeric loopback HTTP origin. Each probe starts without a cookie, exchanges the supplied token through a same-origin 303 redirect, and requests the homepage with only that response's bounded in-memory cookies. Success requires HTTP 200 containing `__DSH_BOOT__`. Cookies do not persist between probes, and an incorrect token cannot reuse an earlier successful session.

## Offline build inputs

The App consumes the released broker 0.4.0 C SDK without source changes. [broker-sources.json](../tpr/broker-sources.json) records package identity, the complete source archive and original file digests. [The SDK copy](../broker_sdk/ob_remote.h) and its original CMake file match the installed release. App-specific build settings live in [broker_dependencies.cmake](../broker_dependencies.cmake). [Dependency metadata](../tpr/native-dependencies.json), [original licenses](../tpr/licenses/) and the MIT SDK license are retained.

[PAYLOAD.json](../tpr/broker-native-arm64/PAYLOAD.json) records the prepared arm64 static libraries and headers. CMake checks [SHA256SUMS](../tpr/broker-native-arm64/SHA256SUMS) before compiling the SDK. DevEco uses relative prepared inputs without downloads or sibling checkout/cache paths. Rebuild offline on HarmonyOS with `python3 entry/src/main/cpp/prepare_native.py --build-dir "$XDG_CACHE_HOME/<new-directory>"` in the exported project, or `python3 ohos/prepare-broker-native.py --build-dir "$XDG_CACHE_HOME/<new-directory>"` in the repository. The original SDK builder requires Clang/Clang++, CMake, Ninja, Python, Go for BoringSSL generators and `binary-sign-tool` for its mandatory target probes. Temporary files use private TMPDIR; the archive contains public upstream test vectors and excludes generated peer keys and personal signing material.

## Verification limits

[The App validation record](../../../../../VALIDATION.md) distinguishes SDK build probes, App integration checks, signed-HAP builds and device installation. A terminal-native check does not establish ordinary-HAP sandbox access, suspension behavior or physical WebView continuity. Those remain device-application checks.
