# DSH HarmonyOS App · Connection Manager

English | [中文](README.zh.md)

Manage saved local and remote DSH connections, then open the selected workspace in a full-window WebView. This community App project is for local validation. Build and device acceptance evidence is recorded in [VALIDATION.md](VALIDATION.md).

## Open in DevEco

1. Open the project root containing [build-profile.json5](build-profile.json5).
2. Use an ARM64 HarmonyOS SDK supporting the declared `6.1.0(23)` compile, target and compatible API. The module supports phone, tablet and 2in1 devices; its forms scroll and adapt to the available window width.
3. Configure your own App signing and Build/Run `entry`. The export contains no personal signing identity or profile.

The display name is `Deepseek Harness` and the bundle name is `org.oheco.deepseekharness`. Installing the same bundle upgrades the existing App. The module needs Internet permission. It contains the broker C SDK, complete pinned dependency sources and ARM64 static libraries. Its [native documentation](entry/src/main/cpp/README.md) owns the dependency and rebuild details.

## Add and edit connections

The home page lists saved connection names and modes. Tap the central bottom `+`, then choose **Local mode** or **Remote mode**. The chosen mode stays fixed on its settings page. Use **Edit** to change the name or settings, or delete the connection. **Save** sits on the right of the navigation title bar; **Test connection** and, when editing, **Delete connection** sit together at the bottom.

The App saves at most 100 connection records in its own private preferences. These contain the DSH token and, for remote connections, the service bearer and peer password. Account passwords are discarded after login and are not saved. A successful save immediately updates the displayed list and the settings used by Edit and Open, including token-only changes. A failed save retains the previous list. Unreadable or unsupported preferences require retry before editing; the App does not replace them with an empty list.

### Local mode

Start DSH on the same device with a fixed port and token. The isolated local launcher accepts the Web arguments:

```sh
zsh /storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-connections-local/run-web.zsh --port 3080 --token '<your token>'
```

In the App, enter a name, the local port (default `3080`) and that token (initially empty). **Test connection** uses a fresh token exchange, then reads the authenticated DSH homepage. Its label stays centered; an independently positioned icon to its left spins while testing and becomes a green check on success or a red cross on failure. Test and Delete labels both use size 14. Draft inputs are retained. Changing connection settings clears the previous result. Failure details distinguish a rejected token, refused request, unreachable service and a different service on the port. **Save** in the title bar saves the settings; a successful test is not required to save them.

The App connects to `127.0.0.1`. It does not start Node or DSH; a terminal or another permitted environment must already run the service.

### Remote mode

1. Enter your broker service HTTPS address, account and account password. New service addresses start empty. All management and signaling connections require HTTPS/WSS with a system-trusted certificate and a matching hostname.
2. Sign in and select an online broker from that account's list. Offline brokers remain visible and cannot be selected.
3. Enter a connection name, that broker's **connection password**, the remote DSH port (default `3080`) and the DSH token. These are independent of the management account password.
4. Test the connection or use **Save** in the title bar. The remote broker must be running and authorize TCP access to its `127.0.0.1:<DSH port>` target.

Below the connection name, the settings page shows the signed-in service address and account, then the selected broker. Each has a **Modify** button. Service edits return to the existing settings page after login and, when needed, broker selection. Cancelling restores the previous identity; selecting a different broker clears its connection password.

The App has no custom CA import or trust override. Previously saved connection records retain their settings while retired CA references are discarded.

The native SDK handles WSS signaling, peer authentication, traversal and relay. Its local TCP mapping remains the WebView's loopback address throughout recovery; HTTP, API and WebSocket traffic keep the browser-facing Host, Origin and cookies. After explicitly closing and reopening a connection, the App creates a new mapping and performs the token exchange again. A newly authenticated connection first binds its WebView to a blank page so the Web engine initializes on the UI thread. Before loading the authenticated address, the App expires only DSH authentication cookies on that loopback host with the root path. Cookies from previous mapping ports cannot accumulate into an oversized request header; unrelated cookies, page storage and history are retained. A cancelled open cannot expire cookies or load a page after its asynchronous read finishes. Restoring an already authenticated renderer preserves its cookies and last in-app address.

A test closes its temporary mapping. A successful open transfers ownership to the WebView; returning to the list or App teardown closes it. Transport loss keeps the current page and SDK listener while the SDK attempts automatic recovery. The App observes recovery without changing the controller, page state or origin. Returning to the foreground verifies the endpoint and wakes a paused connection; repeated events share pending work. Recovery failure keeps the page. A retired renderer is recreated at its last in-app address after recovery. Back leaves the page immediately and cancels pending work; a new WebView cannot take ownership until cleanup completes. Native connection and authentication failures stay in the connection flow; an expired management bearer opens sign-in for that saved connection, and an incorrect DSH token leaves its broker login intact.

The [native integration](entry/src/main/cpp/broker/README.md) uses the unmodified broker 0.4.0 SDK. A 0.3.0 server remains compatible and the App keeps its local listener, but continuation of existing TCP/WebSocket sockets requires the newer recovery protocol at both peers and the control service.

## WebView and appearance

The WebView occupies the whole content area and permits automatic portrait and landscape rotation when system rotation lock is off. The connection list and all settings pages stay in portrait; returning from WebView restores portrait. System Back first closes a native menu or search, then handles Web history, then returns to the connection list. Desktop users can return directly with **Ctrl+Shift+L**. Ctrl+F, match navigation, context actions, external links and local path actions remain available. A path displayed by a remote DSH page is not fetched from the remote computer by the native file-manager action.

The connection list and forms use native HarmonyOS Navigation and NavDestination pages with default transitions and the system back button. They follow the system light/dark theme. System bars remain transparent: the App's background (`#FFFFFF` light, `#151517` dark) extends behind the status bar and bottom gesture area, with readable system-bar text and icons. Controls remain in safe areas. Settings Scroll fills the page width so its scrollbar stays at the screen edge; horizontal padding and maximum widths apply to its content, with bottom actions aligned to the form. The loading cover stays through the initial blank page until the connection page finishes loading. Cookie preparation or navigation failure keeps a visible error and the return action. A main-page HTTP or network failure stays visible with its status or error code and a **Return to connections** action; paint and page completion cannot dismiss it. Errors from subresources do not replace the page. Native overlays read the active page's theme colors.

## Local verification and export

Run these from the source checkout:

```sh
node --test ohos/app/tests/*.test.mjs
python3 -B ohos/test-app-project.py
node ohos/check-app-arkts.cjs --sdk <installed-ets-sdk> --output <new-private-directory>
python3 -B ohos/package-app-project.py --output <new-archive-directory> --export-project <new-project-directory>
```

The packager includes the offline native dependency payload and refuses existing export directories. The ArkTS checker is a semantic check, not a complete DevEco HAP build. Native signed transport fixtures and runtime checks are separate from manual ArkWeb interaction; [VALIDATION.md](VALIDATION.md) distinguishes them. Existing exports, personal signing configuration and installed services are preserved.
