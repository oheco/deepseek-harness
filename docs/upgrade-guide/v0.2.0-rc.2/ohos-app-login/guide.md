---
kind: upgrade-guide
description: "HarmonyOS App refresh login requires broker 0.5.0, and saved version-two connections cannot be read by an older App."
---

# HarmonyOS App login and saved connections

English | [中文](guide.zh.md)

## Change

The App reads old version-one connection preferences and writes version two with a native login-session reference and a preferred local port. An older App cannot read version two. New account login uses the broker 0.5.0 refresh API; existing static bearers remain usable until expiry but cannot acquire refresh authority without another login. DSH Session logs and SQLite stores retain their formats.

## Migration

1. Upgrade the existing `org.oheco.deepseekharness` App by installing the new HAP over it. Keep its application data; the existing connections are read automatically.
2. For a remote connection, use **Edit → Modify** beside the service, sign in to a broker 0.5.0 service once, then **Save**. Account passwords are cleared; native private storage persists the refresh credentials. Keep the current App after saving version-two settings.
3. Confirm that the connection still opens with its separate peer password and DSH token. Return to the connection list and reopen unchanged settings to resume the retained page. See the [App reference](../../../../ohos/app/README.md) for recovery and token-expiry behavior.
