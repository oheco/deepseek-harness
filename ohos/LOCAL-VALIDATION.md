# 0.2.0-rc.2 HarmonyOS local validation

This record belongs to the new local port, not the 0.1.7 release. No push, release tag, upload, catalog update, installation replacement, or existing-service change is authorized.

## Inputs

- Upstream: `dsh-v0.2.0-rc.2`, `639ed015397290b3745d163aafe02ffee4aa3f84`.
- Branch: `ohos/0.2.0-rc.2` in `deepseek-harness-0.2.0`.
- Porting reference: read-only 0.1.7 adaptation at `6ad7995665` and its completed HarmonyOS App.
- Local runtime version: `0.2.0-rc.2-ohos.1` (not published).
- Host: HarmonyOS ARM64, Node.js 24.21.0, Python 3.14.7; native signatures use PATH `binary-sign-tool`.
- Dependency prefetch: proxy-only; 1373 packages resolved, 1317 reused, 51 downloaded. Upstream registry versions are retained.
- Frozen offline installation: passed. Native build tools and same-version CSS WASM are copied into a new private cache. Pinned HarmonyOS runtime dependency copies are separate from old installations.

## Checks in progress

Native addon build, focused compatibility tests, full Host/Client/Web build, isolated final archive runtime acceptance, App checks, and new App export are being executed. Their final commands and results will replace this section after completion. No old pass counts are evidence for this port.

## Isolation and remaining boundaries

All runtime test state is temporary and application-private, using random loopback ports. The user-facing local launcher uses `$XDG_CONFIG_HOME/dsh-0.2.0-local` and never inherits the old `DSH_HOME`. No credentials or sessions are copied. App output is a new project, with unchanged bundle identity and Documents permission; HAP signing/installation is not part of this task.

Full repository tests, local exhaustive lint, live model APIs, and manual browser/ArkWeb interactions are not yet verified and will not be described as passing. The platform has no supported process sandbox backend. No broker startup buttons, UserFile permission, or configuration-editor bridge are added.
