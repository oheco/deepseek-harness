---
kind: upgrade-guide
description: "The HarmonyOS connection manager removes log import and custom broker CA trust."
---

# HarmonyOS broker connections require system trust

English | [中文](guide.zh.md)

## Change

The HarmonyOS App removes **Import a local connection from log** and **Import CA certificate**. Management HTTPS and signaling WSS require a certificate trusted by the system, with a valid chain and matching hostname. New service addresses are empty and must be supplied by the user.

Saved version-one connections retain their names, ports and credentials. The reader drops the retired `caPath` field, and subsequent saves omit it. A service previously trusted through an imported private CA fails certificate verification. Public native broker methods reject a supplied `caPath` property; all App callers use the updated [native declarations](../../../../ohos/app/entry/src/main/cpp/types/libdsh_launcher/index.d.ts).

## Migration

1. For a local connection, start DSH with `dsh web --port 3080 --token '<your token>'`, choose **Local mode**, and enter the port and token directly. Use **Save** in the title bar to save it.
2. For a remote connection, enter your management service address; its HTTPS certificate must be system-trusted and match its hostname. Replace a private-CA-only server certificate before connecting.
3. Test the connection. Its button keeps the **Test connection** label; a spinner indicates progress, a green check success and a red cross failure. Confirm the entered token remains present. Existing saved names and credentials need no manual rewrite.

The [App reference](../../../../ohos/app/README.md) describes the current flow. This App preferences change does not modify DSH Session logs or SQLite data.
