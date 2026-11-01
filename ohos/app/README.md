# DSH HarmonyOS App · Connection Manager

English | [中文](README.zh.md)

Manage saved local and remote DSH connections, then open the selected workspace in a full-window WebView. This community App project is for local validation. Build and device acceptance evidence is recorded in [VALIDATION.md](VALIDATION.md).

## Open in DevEco

This source project builds App `0.2.1-rc.2-ohos.2` with versionCode `1000011` for CLI/Web runtime `0.2.1-rc.2-ohos.1`. [VALIDATION.md](VALIDATION.md) records its build and device acceptance. To create a local source export, run `python3 -B ohos/package-app-project.py --output <new-archive-directory> --export-project <new-project-directory>` from the checkout root.

1. Open the project root containing [build-profile.json5](build-profile.json5).
2. Use an ARM64 HarmonyOS SDK supporting the declared `6.1.0(23)` compile, target and compatible API. The module supports phone, tablet and 2in1 devices; its forms scroll and adapt to the available window width.
3. Configure your own App signing and Build/Run `entry`. The export contains no personal signing identity or profile.

The display name is `Deepseek Harness` and the bundle name is `org.oheco.deepseekharness`. Installing the same bundle upgrades the existing App. The module needs Internet permission. It contains the broker C SDK, complete pinned dependency sources and ARM64 static libraries. Its [native documentation](entry/src/main/cpp/README.md) owns the dependency and rebuild details.

## Add and edit connections

The home page lists saved connection names and modes. Tap the central bottom `+`, then choose **Local mode** or **Remote mode**. The chosen mode stays fixed on its settings page. Use **Edit** to change the name or settings, or delete the connection. **Save** sits on the right of the navigation title bar; **Test connection** and, when editing, **Delete connection** sit together at the bottom.

The App saves at most 100 connection records in private preferences. Each record contains the DSH token and, for remote connections, the peer password, a native login-session reference and the last successful local port. Native private storage holds access and refresh credentials; account passwords are discarded after login. Legacy records retain their static bearer until a fresh login replaces it. A successful save immediately updates the displayed list and the settings used by Edit and Open. A failed save retains the previous list. Unreadable or unsupported preferences require retry before editing; the App does not replace them with an empty list.

### Local mode

Start the `0.2.1-rc.2-ohos.1` DSH runtime on the same device with a fixed port and token:

```sh
DSH_HOME="${XDG_CONFIG_HOME:?}/deepseek-harness" dsh web --host 127.0.0.1 --port 3080 --token '<your token>' --no-open
```

The generated launch command uses an OS-selected port and writes `Documents/dsh-0.2.1-run.log` under the exported home directory. For a saved App connection, use a fixed port as above.

In the App, enter a name, the local port (default `3080`) and that token (initially empty). **Test connection** uses a fresh token exchange, then reads the authenticated DSH homepage. Its label stays centered; an independently positioned icon to its left spins while testing and becomes a green check on success or a red cross on failure. Test and Delete labels both use size 14. Draft inputs are retained. Changing connection settings clears the previous result. Failure details distinguish a rejected token, refused request, unreachable service and a different service on the port. **Save** in the title bar saves the settings; a successful test is not required to save them.

The App connects to `127.0.0.1`. It does not start Node or DSH; a terminal or another permitted environment must already run the service.

### Remote mode

1. Enter your broker service HTTPS address, account and account password. New service addresses start empty. All management and signaling connections require HTTPS/WSS with a system-trusted certificate and a matching hostname.
2. Sign in and select an online broker from that account's list. Offline brokers remain visible and cannot be selected.
3. Enter a connection name, that broker's **connection password**, the remote DSH port (default `3080`) and the DSH token. These are independent of the management account password.
4. Test the connection or use **Save** in the title bar. The remote broker must be running and authorize TCP access to its `127.0.0.1:<DSH port>` target.

Below the connection name, the settings page shows the signed-in service address and account, then the selected broker. Each has a **Modify** button. Service edits return to the existing settings page after login and, when needed, broker selection. Cancelling restores the previous identity; selecting a different broker clears its connection password.

The App has no custom CA import or trust override. It reads version-one connection settings and writes version two; older Apps cannot read version two. New refresh-enabled login requires a broker 0.5.0 control service. Existing static-bearer records need one fresh login to gain automatic refresh. Subsequent access-token renewal is persisted without another password entry; revoked accounts or expired refresh authority require sign-in again.

The native SDK handles WSS signaling, peer authentication, traversal and relay. Its local TCP mapping remains the WebView's loopback address throughout recovery. The first mapping requests an OS-selected port; subsequent opens prefer the saved successful port. A local listener bind failure alone falls back to a new random port, which replaces the saved preference. Reconnect retains the live listener. Reusing the port preserves the browser origin and its cache; cache headers remain the service's responsibility. A new authenticated WebView first binds a blank page on the UI thread, then expires only the DSH authentication cookie of that loopback host and port with the root path before navigation. Restoring an authenticated renderer preserves its cookies and last in-app address.

A test closes its temporary mapping. A successful open transfers ownership to the window's WebView. Returning to the connection list hides the most recent page and retains its controller, document, route, history and mapping. Opening the same settings resumes that page without another token probe when healthy. Switching settings or using Disconnect waits for actual teardown before creating another owner. Transport loss retains the page and listener; the top-center indicator shows SDK recovery. Paused or failed recovery shows Reconnect and Back; terminal account expiry requests sign-in. Ordinary recovery does not reload the page. Only an exited renderer is recreated after endpoint recovery. A wrong DSH token leaves broker login intact.

The [native integration](entry/src/main/cpp/broker/README.md) uses the unmodified broker 0.5.0 SDK. Older peers can still recover mapping service, but continuation of existing TCP/WebSocket sockets requires the newer recovery protocol at both peers and the control service. The App does not change broker token lifetimes or DSH service behavior.

## Multiple windows

Each window keeps one open connection, so several connections can stay open at the same time. When the window is at least 600 vp wide, **New window** on a saved connection opens that connection in a new window. Launching the App again from its icon brings the most recently active window forward. A connection that is open or opening in another window shows **Switch to window**; that button, or tapping the connection itself, brings the holding window forward instead of opening the connection twice. **Edit** stays unavailable for that connection until its window closes it. The window title shows the name of its open connection.

Every window owns an independent native broker channel with its own client, peer and loopback listener, so windows never share a mapping. Closing a window releases only its own channel, and Disconnect or another selection in one window does not affect the others. At most 64 channels exist at once. Saved-list changes in one window appear in the others, and each save applies to the latest saved list, so concurrent edits keep each other's entries. Cookie preparation affects only the new connection's own loopback origin, so the other windows stay signed in.

## WebView and appearance

The WebView occupies the whole content area and permits automatic portrait and landscape rotation when system rotation lock is off. The connection list and all settings pages stay in portrait; returning from WebView restores portrait. System Back first closes a native menu or search, then follows Web history within the connection origin. It skips the bootstrap blank page and retains the current workspace page when returning to the connection list. Desktop users can return directly with **Ctrl+Shift+L**. Ctrl+F, match navigation, context actions, external links and local path actions remain available. A path displayed by a remote DSH page is not fetched from the remote computer by the native file-manager action.

The connection list and forms use native HarmonyOS Navigation and NavDestination pages with default transitions and the system back button. They follow the system light/dark theme. System bars remain transparent: the App's background (`#FFFFFF` light, `#151517` dark) extends behind the status bar and bottom gesture area, with readable system-bar text and icons. Controls remain in safe areas. Settings Scroll fills the page width so its scrollbar stays at the screen edge; horizontal padding and maximum widths apply to its content, with bottom actions aligned to the form. The loading cover stays through the initial blank page until the connection page finishes loading. Cookie preparation or navigation failure keeps a visible error and the return action. A main-page HTTP or network failure stays visible with its status or error code and a **Return to connections** action; paint and page completion cannot dismiss it. Errors from subresources do not replace the page. Native overlays read the active page's theme colors.

## Diagnostic logs

**Diagnostic logs** in the connection-list title bar lets you view, refresh and copy the App-private connection journal. Records survive App restarts, with at most 2 MiB retained; copying includes every retained record. The connection diagnostics reference ([English](CONNECTION_DIAGNOSTICS.md), [中文](CONNECTION_DIAGNOSTICS.zh.md)) describes collection, redaction and stage fields.

## Local verification and export

Run these from the source checkout:

```sh
node --test ohos/app/tests/*.test.mjs
python3 -B ohos/test-app-project.py
node ohos/check-app-arkts.cjs --sdk <installed-ets-sdk> --output <new-private-directory>
python3 -B ohos/package-app-project.py --output <new-archive-directory> --export-project <new-project-directory>
```

The packager includes the offline native dependency payload and refuses existing export directories. The ArkTS checker is a semantic check, not a complete DevEco HAP build. Native signed transport fixtures and runtime checks are separate from manual ArkWeb interaction; [VALIDATION.md](VALIDATION.md) distinguishes them. Existing exports, personal signing configuration and installed services are preserved.
