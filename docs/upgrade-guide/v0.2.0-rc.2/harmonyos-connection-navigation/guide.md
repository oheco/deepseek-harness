---
kind: upgrade-guide
description: "HarmonyOS connection settings use native navigation, a fixed mode and a user-supplied broker service address."
---

# HarmonyOS connection settings use native navigation

English | [中文](guide.zh.md)

## Change

Connection pages use native HarmonyOS navigation and Back transitions. They follow the system light/dark theme and stay in portrait. WebView permits portrait and landscape rotation when system rotation lock is off, and its background follows the system theme behind transparent system bars. Transport loss keeps the current WebView and uses [SDK recovery](../harmonyos-broker-sdk-recovery/guide.md). The title bar contains **Save** on the right. **Test connection** and the editing-only **Delete connection** share the bottom action row. Local and remote settings no longer contain mode switches; choose the mode when adding a connection.

New broker service addresses start empty, with no suggested host. Remote settings show the signed-in service and account, then the selected broker, each with **Modify**. Cancelling a service edit restores the previous identity. Choosing a different broker clears its connection password. Existing saved service addresses and credentials remain intact.

## Migration

1. Use **Save** in the title bar instead of **Finish adding**. Create a separate connection to use another mode.
2. For a new remote connection, enter your own HTTPS broker service address and sign in. Its certificate must remain system-trusted.
3. Use **Modify** beside the service to change its login, or beside the broker to select another. Enter the new broker's connection password before saving.

The [App reference](../../../../ohos/app/README.md) owns the current connection flow. The change leaves App preference versions, DSH Session logs and SQLite data unchanged.
