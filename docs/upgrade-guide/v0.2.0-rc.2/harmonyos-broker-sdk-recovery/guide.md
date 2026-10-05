---
kind: upgrade-guide
description: "HarmonyOS App uses the released broker SDK recovery lifecycle and updated native bridge inputs."
---

# HarmonyOS App uses broker SDK recovery

English | [中文](guide.zh.md)

## Change

The App embeds the unmodified broker 0.4.0 C SDK. Network loss retains its peer, TCP mapping, listening port and WebView. The SDK retries automatically; returning to the foreground wakes a paused peer on the same handle. Normal recovery does not recreate the WebView. Existing TCP/WebSocket continuation requires the new recovery protocol at both peers and the control service; 0.3.0 remains compatible for mapping service recovery.

The native bridge adds `brokerReconnect`. `brokerStatus.state` includes `reconnecting`, `retry_wait`, `paused` and `closed`, with an `errorCode` field for terminal account-authorization failures. `brokerConnect.localPort` is removed and rejected: the SDK selects a port once, and recovery retains its original listener. `brokerLogin` and `brokerList` now require the same private `tempDir` as connect.

## Migration

1. Pass `context.tempDir + '/dsh-broker'` to login, list and connect. Keep that directory fixed for the native client's lifetime.
2. Keep the SDK mapping while its state is recovering or paused. Request `brokerReconnect` on a paused connection and observe subsequent status; request acceptance does not mean connected.
3. Remove fixed replacement-port inputs and close/connect recovery sequences. Await final `brokerClose` when releasing ownership; the App can leave the page immediately while that cleanup completes.

The [native client reference](../../../../ohos/app/entry/src/main/cpp/broker/README.md) owns the full recovery and cleanup behavior. App preference versions, DSH Session logs and SQLite data are unchanged.
