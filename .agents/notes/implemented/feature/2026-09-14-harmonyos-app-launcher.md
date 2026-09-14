# Agent Note: HarmonyOS App launcher for the terminal service

Status: implemented

English | [中文](2026-09-14-harmonyos-app-launcher.zh.md)

## Problem

The HarmonyOS distribution serves the CLI and Web profiles from a terminal, and the oheco catalog installs it as an npm package. A user asked for an App instead: tap an icon, see progress, and land in the Web interface. The straightforward wrapper — an App that runs the already-installed Node and DSH out of shared storage — assumes privileges an ordinary signed HAP does not have, and the assumption is only testable on a device.

## Decision

The App in [ohos/app](../../../../ohos/app/README.md) is a thin wrapper around a service the terminal starts. Its home page shows one command to run in a terminal; the service writes its readiness announcement to `~/Documents/dsh-run.log`; the app polls that file once per second, connects once to the announced loopback origin, and only then opens it in a full-window ArkWeb view. Nothing in the App launches the service, and the Web interface is exactly the one the installed `dsh` serves.

In-app launch, the settings page, the diagnostics page, the capability probe and the HAP-external runtime copy that served them are gone. The native supervisor remains in `entry/src/main/cpp` — it still compiles and its tests still run — but no ArkTS code imports it.

## Device capability boundary

An ordinary development signature (DevEco automatic signing) on this device gives the App process `uid=20020187` with supplementary groups `1097,3099`, measured by the App's own probe before those surfaces were withdrawn:

| Capability | Result |
| --- | --- |
| Write its own private directory | works |
| Execute `/system/bin/sh -c …` | works, exit code 0 |
| `open` the shared Node or DSH entry | `EPERM` |
| Execute an ELF copy inside its private directory | `EACCES` |
| `/usr/bin/zsh` | absent from the app sandbox |
| System Node (`/system/bin/node`, `/usr/bin/node`) | absent |

Shared files are owned by `uid 20001006 gid 1006` with mode `-rw-rw----`, and the directories are `drwxrws--x`. The terminal's process joins group 1006; an ordinary app's does not join it, and `ohos.permission.FILE_ACCESS_MANAGER` (the only sandbox rule on this device that grants that group) is `availableType: SYSTEM`. `ohos.permission.READ_WRITE_USER_FILE` is `NORMAL` but has no sandbox rule on this device, and the three directory permissions are `NORMAL` with `user_grant`. This is why the App neither reads the shared runtime nor starts Node, and why `access()` is no longer used anywhere in the tree: it reports success for a mode-0000 file on this platform, so the preflight performs the real `open` instead.

## Log location and access

`~/.dsh` is the terminal application's private directory and a different sandbox cannot read it, so the announcement goes to `~/Documents/dsh-run.log`. Documents files are owner- and group-only as well, so the App requests the normal-level `READ_WRITE_DOCUMENTS_DIRECTORY` and, when the direct path is still refused, reads the file through the system picker's grant, which needs no permission.

The app parses only a newline-terminated line carrying an explicit `http://127.0.0.1:<port>` or `http://[::1]:<port>` authority with a nonzero port and a nonempty token; the upstream LAN suffix is accepted but never opened. The address reaches ArkWeb in memory only.

## Opening gate, theming and first paint

A log left behind by an earlier run still holds a well-formed address, so the App connects to the announced origin once and opens the view only when something answers; a restarted service on a new port is re-checked and reloaded.

Two platform behaviours needed explicit handling. ArkUI does not re-render a page when the system colour mode changes, so `EntryAbility` republishes the colorMode into AppStorage and the page binds it with `@StorageProp`, which re-resolves its `$r()` colours; startup also states the follow-system choice explicitly. ArkWeb paints an empty surface before the page content, so the Web component carries the themed background and a same-theme cover hides it until `onFirstScreenPaint` or `onPageEnd`.

ArkWeb also reports `navigator.onLine` as false while a fresh view resolves system network state, and the Harness client parks in its disconnected state until its own reconnect control is used. A document-start script reports the local connection the page actually uses, and a transient system offline event cannot park it.

## Icons

The App follows the HarmonyOS layered-icon specification: `layered_image.json` names `background.png` and `foreground.png`, both 1024×1024, and the system draws the rounded tile. Baking rounded corners into a bitmap is an explicit review failure, so no layer carries rounding. `app_icon.png` remains as a flat, pre-rounded fallback. The launcher entry and the window decoration read the same ability resource on this device, so the desktop and title-bar icons cannot be set independently; `startWindowIcon` uses a transparent mark with a dark-theme variant.

## Alternatives considered

**Launch the service from the App.** The first build did exactly that, with a native supervisor and a shipped runtime copy. It is impossible here: shared reads fail with `EPERM` and private-directory execution with `EACCES`.

**Ship Node and the runtime inside the HAP.** The device has no system Node, and an ELF extracted into app-private storage cannot be executed, so bundling only the JavaScript runtime leaves nothing to run it.

**Request the privileged file permissions.** `FILE_ACCESS_MANAGER` needs a system-identity-signed profile; `READ_WRITE_USER_FILE` has no sandbox rule here; and reading the shared Node would still not make it executable.

**Display raw child output after keyword masking.** A credential can precede readiness or span records, so the supervisor withholds arbitrary child text entirely. This is retained as a property of that code, not as an App surface.

**Leave the WebView's disconnected state to the user.** The client's reconnect control fixes it in one click, but a page that starts disconnected reads as a broken App; the document-start script removes the cause instead.

**Accept the icon conflict.** Since one ability resource drives both surfaces, the alternative was a transparent mark everywhere, which the user rejected for the desktop.

## Consequences

The user runs one command per session; the App cannot start the service itself, and that is a platform outcome rather than a deferred feature. The Web interface's branding is whatever the installed `dsh` was built with, so the release recipe now selects the `DSH_CLIENT_BUILD_PROFILE=official` client profile — without a rebuilt and reinstalled package the sidebar keeps the local-build label. The App does not monitor the terminal's service and is not resident. The native supervisor and the capability probe remain compiled but unused, kept for devices that do hold the shared-runtime access.

## Testing

`python3 ohos/test-app-project.py` covers project packaging, identity and SDK fields, the layered-icon description and manifest wiring, archive permissions, and refusal of private keys, escaping links and case collisions. `node --test ohos/app/tests/two-step-flow.test.mjs` covers address parsing (terminated lines, LAN suffix, malformed and non-loopback forms), loopback origins, log polling, the replaced address after a restart, and recovery through a picked file. `python3 ohos/app/tests/native/run.py` still builds, signs and tests the supervisor and probe on HarmonyOS. Every check is keyless; the device itself provides the acceptance that no fixture can.
