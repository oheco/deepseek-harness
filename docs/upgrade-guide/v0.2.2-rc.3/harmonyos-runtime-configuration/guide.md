---
kind: upgrade-guide
description: "HarmonyOS startup uses zsh and plugins replace the earlier fork's fixed-token flag and private UI hooks."
---

# HarmonyOS runtime configuration

English | [中文](guide.zh.md)

## Change

The HarmonyOS CLI/Web distribution follows upstream `0.2.2-rc.3` and adds system compatibility. Commands use `/usr/bin/zsh -f -c`; persistent terminals also use zsh. The earlier HarmonyOS fork's `--token` flag, private conversation-header factory, settings-path dialog and custom WebSocket fragmentation are not included. Existing upstream profile names remain available.

HarmonyOS accepts credential files with exact mode `0660`, in addition to the existing owner-only modes. Other platforms retain upstream permission checks. File creation still requests `0600`. Shared HOME cannot enforce private chmod modes; use application-private storage when owner-only access is required.

## Migration

1. Stop the previous Web service before starting the replacement. Back up the existing `DSH_HOME` into application-private storage. Keep existing Session generations; their presence does not establish downgrade support.
2. Use Node.js `>=24.9.0`, system zsh and Python 3 with termios. Install the published CLI with `oo install deepseek-harness`, or follow the [HarmonyOS installation reference](https://github.com/oheco/deepseek-harness/blob/v0.2.2-rc.3-ohos.1/ohos/README.md). Keep a separate `DSH_HOME` for a trial installation.
3. Remove `--token` from saved launch commands. To retain a fixed login URL, install [oheco/dsh-fixed-token](https://github.com/oheco/dsh-fixed-token) from its repository directory with `dsh plugin --profile web add link:/absolute/path/dsh-fixed-token`. Move the existing `connection.config.token` value in the profile patch to the plugin row below, then remove only the legacy token field. The plugin accepts 16–256 URL-safe characters; generate a new token if the previous value is outside that range. Never publish the token or the profile patch.

```yaml
- id: oheco-fixed-token
  name: '@oheco/dsh-fixed-token'
  config:
    token: <existing-private-token>
```

4. Update external plugins to upstream APIs. The optional [open-session list](https://github.com/oheco/dsh-open-sessions) replaces the older private-header approach. Keep image-guard after retry plugins when using [oheco/dsh-image-guard](https://github.com/oheco/dsh-image-guard). These plugins are installed separately; the runtime does not bundle them.
5. Restart Web and refresh the browser. Confirm `dsh --version` prints `0.2.2-rc.3`, verify the enabled plugin rows, and test the login URL. The outer package metadata identifies adaptation revision `0.2.2-rc.3-ohos.1`.

Run persistent commands directly: on this HarmonyOS system, interactive `exec` ends the shell and resets its state. Explicit process confinement remains unsupported; the deployment defaults and other limits are described in the installation reference.
