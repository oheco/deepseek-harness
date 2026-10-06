import webview from '@ohos.web.webview';
import pasteboard from '@ohos.pasteboard';
import { ConnectionHome, ConnectionHomeController } from './ConnectionHome';
import common from '@ohos.app.ability.common';
import { RuntimeDefaults } from '../config/RuntimeDefaults';
import { APP_FOREGROUND_EVENT, APP_BACKGROUND_EVENT } from '../launcher/AppActivity';
import { WebConnection, WebConnectionState } from '../launcher/WebConnection';
import { ConnectionProfile } from '../launcher/ConnectionProfile';
import { WEB_VIEW_ACTIVE_EVENT } from '../launcher/WebOrientation';
import { leavesWebView, openOutside } from '../launcher/ExternalLink';
import { loopbackOrigin } from '../launcher/RunLogUrl';

import { KeyCode } from '@ohos.multimodalInput.keyCode';
import { CONTEXT_CAPTURE_SCRIPT, ContextSnapshot, contextSnapshotScript, contextTarget } from '../launcher/ContextActions';
import { viewInFileManager, PathActionResult } from '../launcher/PathActions';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { OverlayPalette, overlayPaletteScript, parseOverlayPalette } from '../launcher/OverlayAppearance';

/** AppStorage key written by EntryAbility when the system colour mode changes. */
const COLOR_MODE_KEY = 'dshColorMode';
/**
 * The page only ever talks to 127.0.0.1, but ArkWeb reports `navigator.onLine`
 * as false while it is still resolving system network state. The Harness client
 * reads that flag at boot and parks in its disconnected state — recoverable only
 * through its own reconnect control — so the local page would sit "disconnected"
 * until the user clicks it. This script runs before any page script and reports
 * the connection the page actually uses, and it keeps a transient system offline
 * event from parking a loopback connection.
 */
const LOCAL_CONNECTION_SCRIPT: string =
  'try {' +
  '  Object.defineProperty(navigator, "onLine", { configurable: true, get: function () { return true; } });' +
  '  window.addEventListener("offline", function (event) { event.stopImmediatePropagation(); }, true);' +
  '} catch (error) { /* an engine that refuses the override keeps its own state */ }';

@Entry
@Component
struct Index {
  private homeController: ConnectionHomeController = new ConnectionHomeController();
  private remote: boolean = false;
  private remoteTimer: number = -1;
  private closingWeb: boolean = false;
  private activityContext: common.UIAbilityContext | undefined = undefined;
  private activeConnection: ConnectionProfile | undefined = undefined;
  private rendererAlive: boolean = true;
  private currentWebAddress: string = '';
  private detachedWork: Promise<void> = Promise.resolve();
  private closeWork: Promise<void> | undefined = undefined;
  @State private connectionState: WebConnectionState = WebConnectionState.Connected;
  private webConnection: WebConnection = new WebConnection((state: WebConnectionState, recovered: boolean) =>
    this.connectionChanged(state, recovered));
  private appForeground: () => void = () => {
    this.resumeWeb().catch((error: Error) => {
      // Recovery retains the page and its disconnected state if a renderer cannot be resumed.
    });
  };
  private appBackground: () => void = () => {
    clearInterval(this.remoteTimer);
    this.webConnection.background();
  };
  // Bound only so a system theme change re-renders this page: the colours below
  // are $r() resources, and ArkUI re-resolves them on that re-render.
  @StorageProp(COLOR_MODE_KEY) private colorMode: number = -1;
  @State private webUrl: string = '';
  @State private webOrigin: string = '';
  @State private webGeneration: number = 0;
  @State private pageLoaded: boolean = false;
  @State private webError: Resource | undefined = undefined;
  // ArkWeb paints an empty surface before the page content, so a themed cover
  // stays until the first paint instead of letting the default white show.
  @State private webPainted: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  // ArkWeb may report one navigation through more than one callback; the second
  // report of the same address must not open a second browser window.
  private handedOff: string = '';
  private handedOffAt: number = 0;
  @State private searchVisible: boolean = false;
  @State private searchText: string = '';
  @State private searchCount: number = 0;
  @State private searchIndex: number = 0;
  @State private menuVisible: boolean = false;
  @State private menuText: string = '';
  @State private menuLink: string = '';
  @State private menuPath: string = '';
  @State private menuX: number = 0;
  @State private menuY: number = 0;
  @State private viewportWidth: number = 800;
  @State private viewportHeight: number = 600;
  private menuResult: WebContextMenuResult | undefined = undefined;
  private menuRequest: number = 0;
  private nativeSelection: boolean = false;
  private searchTimer: number = -1;
  @State private overlayPalette: OverlayPalette | undefined = undefined;
  @State private hoveredAction: string = '';
  @State private searchX: number = 0;
  @State private searchY: number = 12;
  private searchMoved: boolean = false;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private paletteTimer: number = -1;
  private paletteReading: boolean = false;
  private attached: boolean = false;

  private updateWebOrientation(active: boolean): void {
    try {
      (this.getUIContext().getHostContext() as common.UIAbilityContext).eventHub.emit(WEB_VIEW_ACTIVE_EVENT, active);
    } catch (error) {
      // A detached ability owns its remaining window cleanup.
    }
  }

  aboutToAppear(): void {
    this.attached = true;
    this.updateWebOrientation(this.webUrl !== '');
    try {
      this.activityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.activityContext.eventHub.on(APP_FOREGROUND_EVENT, this.appForeground);
      this.activityContext.eventHub.on(APP_BACKGROUND_EVENT, this.appBackground);
    } catch (error) {
      // A detached context cannot deliver App activity; the page remains reachable through Back.
    }
    if (this.activeConnection && this.webUrl !== '') {
      this.reattachWeb().catch((error: Error) => {
        // A reattached renderer can retry on its next foreground event.
      });
    }
  }

  aboutToDisappear(): void {
    clearTimeout(this.searchTimer);
    clearTimeout(this.paletteTimer);
    clearInterval(this.remoteTimer);
    this.updateWebOrientation(false);
    this.attached = false;
    this.dismissMenu();
    const context = this.activityContext;
    this.activityContext = undefined;
    if (context) {
      try {
        context.eventHub.off(APP_FOREGROUND_EVENT, this.appForeground);
      } catch (error) {
        // A destroyed ability may already have removed its activity listeners.
      }
      try {
        context.eventHub.off(APP_BACKGROUND_EVENT, this.appBackground);
      } catch (error) {
        // Native cleanup must continue even when the context no longer accepts listener removal.
      }
    }
    this.webConnection.background();
    this.detachedWork = this.closeWork ?? Promise.resolve();
  }

  private async reattachWeb(): Promise<void> {
    const generation = this.webGeneration;
    await this.detachedWork;
    if (!this.attached || this.closingWeb || generation !== this.webGeneration || !this.activeConnection) {
      return;
    }
    await this.resumeWeb();
  }

  private startRemotePolling(): void {
    clearInterval(this.remoteTimer);
    if (this.attached && this.remote && this.webUrl !== '' && !this.closingWeb) {
      this.remoteTimer = setInterval(() => this.checkRemote(), 2000);
    }
  }

  private async resumeWeb(): Promise<void> {
    if (!this.attached || this.closingWeb || this.webUrl === '') {
      return;
    }
    this.startRemotePolling();
    await this.webConnection.foregrounded();
  }

  private connectionChanged(state: WebConnectionState, recovered: boolean): void {
    if (!this.attached || this.closingWeb || this.webUrl === '') {
      return;
    }
    const previous = this.connectionState;
    this.connectionState = state;
    if (state === WebConnectionState.Disconnected && previous !== state) {
      this.notify($r('app.string.web_connection_disconnected'));
    }
    if (!recovered) {
      return;
    }
    if (!this.rendererAlive) {
      this.controller = new webview.WebviewController();
      this.webUrl = this.currentWebAddress;
      this.webGeneration += 1;
      this.pageLoaded = false;
      this.webPainted = false;
      this.webError = undefined;
      this.rendererAlive = true;
      return;
    }
    this.controller.runJavaScript('window.dispatchEvent(new Event("online"));').catch((error: Error) => {
      // A renderer not ready for online notification keeps its own WebSocket reconnect behavior.
    });
  }

  /** The connection flow has authenticated this address before transferring its mapping. */
  private openWeb(address: string, remote: boolean, connection: ConnectionProfile): boolean {
    const origin = loopbackOrigin(address);
    if (origin === '' || this.closingWeb || this.webUrl !== '') {
      return false;
    }
    const controller = new webview.WebviewController();
    this.dismissMenu();
    this.searchVisible = false;
    this.remote = remote;
    this.webUrl = address;
    this.webOrigin = origin;
    this.webGeneration += 1;
    this.overlayPalette = undefined;
    this.pageLoaded = false;
    this.webPainted = false;
    this.webError = undefined;
    this.controller = controller;
    this.rendererAlive = true;
    this.currentWebAddress = address;
    this.activeConnection = connection;
    this.connectionState = WebConnectionState.Connected;
    this.webConnection.activate(connection, origin);
    this.startRemotePolling();
    this.updateWebOrientation(true);
    return true;
  }

  /** Keep a main-page failure visible even when ArkWeb later reports paint or load completion. */
  private showWebError(generation: number, request: WebResourceRequest, message: Resource, http: boolean): void {
    if (!this.attached || this.closingWeb || generation !== this.webGeneration ||
      !request.isMainFrame() || loopbackOrigin(request.getRequestUrl()) !== this.webOrigin) {
      return;
    }
    if (this.webError === undefined || http) {
      this.webError = message;
    }
    this.pageLoaded = false;
    this.webPainted = false;
    this.dismissMenu();
    this.searchVisible = false;
  }

  private async checkRemote(): Promise<void> {
    if (this.attached && this.remote && !this.closingWeb) {
      await this.webConnection.check();
    }
  }

  private closeWeb(): Promise<void> {
    if (this.closeWork) {
      return this.closeWork;
    }
    this.closingWeb = true;
    this.dismissMenu();
    clearInterval(this.remoteTimer);
    clearTimeout(this.searchTimer);
    clearTimeout(this.paletteTimer);
    this.searchVisible = false;
    const work = this.finishWebClose();
    this.closeWork = work;
    work.then(() => {
      if (this.closeWork === work) {
        this.closeWork = undefined;
      }
    });
    return work;
  }

  private async finishWebClose(): Promise<void> {
    const cleanup: Promise<void> = this.webConnection.close();
    this.remote = false;
    this.activeConnection = undefined;
    this.currentWebAddress = '';
    this.webGeneration += 1;
    this.webUrl = '';
    this.updateWebOrientation(false);
    this.webOrigin = '';
    this.pageLoaded = false;
    this.webPainted = false;
    this.webError = undefined;
    this.overlayPalette = undefined;
    try {
      await cleanup;
    } finally {
      this.closingWeb = false;
    }
  }

  /**
   * Sends one address out of the app. ArkWeb decides synchronously whether a
   * navigation continues, so the request is issued here and a refusal is
   * reported through the notice instead of the return value.
   */
  private handOff(url: string): void {
    const now = Date.now();
    if (url === this.handedOff && now - this.handedOffAt < 1000) {
      return;
    }
    this.handedOff = url;
    this.handedOffAt = now;
    const ability = getContext(this) as common.UIAbilityContext;
    openOutside(ability, url).then((opened: boolean) => {
      if (!opened) {
        this.notify($r('app.string.external_failed'));
      }
    });
  }

  /** Transient feedback uses a platform toast, never a persistent WebView overlay. */
  private notify(message: Resource): void {
    if (!this.attached) {
      return;
    }
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 3000, bottom: 24 });
    } catch (_) {
      // An ability going into the background cannot show a toast.
    }
  }

  private palette(): OverlayPalette {
    return this.overlayPalette || new OverlayPalette(this.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
  }

  /** Poll only while native overlays are open, so an in-page theme switch is reflected too. */
  private async refreshOverlayPalette(): Promise<void> {
    clearTimeout(this.paletteTimer);
    if (!this.attached || this.webUrl === '' || this.paletteReading) {
      return;
    }
    this.paletteReading = true;
    const generation = this.webGeneration;
    try {
      const raw = await this.controller.runJavaScript(overlayPaletteScript(this.webOrigin));
      const palette = parseOverlayPalette(raw);
      if (palette && this.attached && generation === this.webGeneration) {
        this.overlayPalette = palette;
      }
    } catch (_) {
      // Unavailable page colors fall back to the system theme.
    } finally {
      this.paletteReading = false;
      if (this.attached && (this.searchVisible || this.menuVisible)) {
        this.paletteTimer = setTimeout(() => this.refreshOverlayPalette(), 400);
      }
    }
  }

  private findWidth(): number {
    return Math.max(0, Math.min(440, this.viewportWidth - 24));
  }

  private placeSearch(): void {
    const maxX = Math.max(0, this.viewportWidth - this.findWidth() - 12);
    this.searchX = this.searchMoved ? Math.max(0, Math.min(this.searchX, maxX)) : maxX;
    this.searchY = Math.max(0, Math.min(this.searchY, this.viewportHeight - 60));
  }

  private allowSearchDrag(event: BaseGestureEvent): GestureJudgeResult {
    if (event.fingerList.length === 0) {
      return GestureJudgeResult.REJECT;
    }
    const pan = event as GestureEvent;
    const x = event.fingerList[0].localX - pan.offsetX;
    const y = event.fingerList[0].localY - pan.offsetY;
    const width = this.findWidth();
    // The 48vp row has 8vp padding, a 16vp grip, a flexible input, a 60vp
    // counter, and three 28vp buttons separated by 6vp gaps. Controls never drag.
    const input = x >= 30 && x < width - 176;
    const buttons = (x >= width - 104 && x < width - 76) ||
      (x >= width - 70 && x < width - 42) || (x >= width - 36 && x < width - 8);
    return y >= 8 && y < 40 && (input || buttons) ? GestureJudgeResult.REJECT : GestureJudgeResult.CONTINUE;
  }

  private focusElement(id: string): void {
    try {
      this.getUIContext().getFocusController().requestFocus(id);
    } catch (_) {
      // A component removed during navigation cannot take focus.
    }
  }

  private showSearch(): void {
    this.dismissMenu();
    if (this.searchVisible) {
      this.focusElement('dsh-find');
    }
    this.placeSearch();
    this.searchVisible = true;
    this.refreshOverlayPalette();
  }

  private hideSearch(): void {
    this.searchVisible = false;
    clearTimeout(this.searchTimer);
    this.searchCount = 0;
    this.searchIndex = 0;
    try {
      this.controller.clearMatches();
    } catch (_) {
      // A renderer that has exited no longer owns any highlights.
    }
    this.focusElement('dsh-web');
  }

  private searchChanged(value: string): void {
    this.searchText = value;
    clearTimeout(this.searchTimer);
    this.searchCount = 0;
    this.searchIndex = 0;
    this.searchTimer = setTimeout(() => {
      try {
        if (this.searchText === '') {
          this.controller.clearMatches();
        } else {
          this.controller.searchAllAsync(this.searchText);
        }
      } catch (_) {
        this.notify($r('app.string.web_action_failed'));
      }
    }, 120);
  }

  private nextMatch(forward: boolean): void {
    if (this.searchText === '') {
      return;
    }
    try {
      this.controller.searchNext(forward);
    } catch (_) {
      this.notify($r('app.string.web_action_failed'));
    }
  }

  private webKey(event: KeyEvent, fromFind: boolean = false): boolean {
    const ctrl = event.getModifierKeyState ? event.getModifierKeyState(['Ctrl']) : false;
    const shift = event.getModifierKeyState ? event.getModifierKeyState(['Shift']) : false;
    const leave = ctrl && shift && event.keyCode === KeyCode.KEYCODE_L && this.webUrl !== '';
    const find = ctrl && event.keyCode === KeyCode.KEYCODE_F && this.webUrl !== '';
    const escape = event.keyCode === KeyCode.KEYCODE_ESCAPE && (this.menuVisible || this.searchVisible);
    const enter = fromFind && this.searchVisible && event.keyCode === KeyCode.KEYCODE_ENTER;
    if (!leave && !find && !escape && !enter) {
      return false;
    }
    if (event.type === KeyType.Down) {
      if (leave) {
        this.closeWeb();
      } else if (find) {
        this.showSearch();
      } else if (escape) {
        if (this.menuVisible) {
          this.dismissMenu();
        } else {
          this.hideSearch();
        }
      } else {
        const shift = event.getModifierKeyState ? event.getModifierKeyState(['Shift']) : false;
        this.nextMatch(!shift);
      }
    }
    return true;
  }

  private dismissMenu(): void {
    this.menuRequest += 1;
    this.menuVisible = false;
    this.hoveredAction = '';
    if (this.menuResult) {
      try {
        this.menuResult.closeContextMenu();
      } catch (_) {
        // The renderer may already have dismissed this menu during navigation.
      }
      this.menuResult = undefined;
    }
  }

  private showContext(event: OnContextMenuShowEvent): boolean {
    this.dismissMenu();
    this.menuResult = event.result;
    if (event.param.getInputFieldType() === ContextMenuInputFieldType.Password) {
      this.dismissMenu();
      return true;
    }
    const selection = event.param.getSelectionText() || '';
    this.nativeSelection = selection.trim() !== '';
    this.menuText = this.nativeSelection ? selection : '';
    const target = contextTarget(this.menuText || event.param.getLinkUrl() || '', RuntimeDefaults.homeDir);
    this.menuLink = target.link;
    this.menuPath = this.remote ? '' : target.path;
    if (!this.menuText) {
      this.menuText = this.menuLink;
    }
    this.menuX = this.getUIContext().px2vp(event.param.x());
    this.menuY = this.getUIContext().px2vp(event.param.y());
    // Do not create an empty overlay while the DOM lookup is pending.
    this.resolveContext(this.menuRequest);
    return true;
  }

  private async resolveContext(request: number): Promise<void> {
    try {
      const raw = await this.controller.runJavaScript(contextSnapshotScript(this.webOrigin));
      if (request !== this.menuRequest || !raw || this.nativeSelection || this.menuLink !== '') {
        return;
      }
      const decoded: string = raw.startsWith('"') ? JSON.parse(raw) as string : raw;
      const snapshot = JSON.parse(decoded) as ContextSnapshot;
      if (typeof snapshot.selection !== 'string' || typeof snapshot.candidate !== 'string' ||
        typeof snapshot.link !== 'string' || typeof snapshot.time !== 'number' ||
        Date.now() - snapshot.time > 2000 || snapshot.time > Date.now() + 1000) {
        return;
      }
      const selected = snapshot.selection.trim() !== '' ? snapshot.selection : '';
      const value = selected || snapshot.link || snapshot.candidate;
      if (value.length > 8192) {
        return;
      }
      const parsed = contextTarget(value, RuntimeDefaults.homeDir);
      this.menuText = selected || parsed.link || parsed.path;
      this.menuLink = parsed.link;
      this.menuPath = this.remote ? '' : parsed.path;
    } catch (_) {
      // Unsupported document surfaces keep only the native selection/link data.
    } finally {
      if (request === this.menuRequest) {
        if (this.menuText.trim() === '') {
          this.dismissMenu();
        } else {
          const rows = 1 + (this.menuLink !== '' ? 1 : 0) + (this.menuPath !== '' ? 1 : 0);
          this.menuX = Math.max(0, Math.min(this.menuX, this.viewportWidth - 244));
          this.menuY = Math.max(0, Math.min(this.menuY, this.viewportHeight - rows * 40 - 12));
          await this.refreshOverlayPalette();
          if (request === this.menuRequest) {
            this.menuVisible = true;
            this.refreshOverlayPalette();
          }
        }
      }
    }
  }

  private async copyContext(): Promise<void> {
    const text = this.menuText;
    const native = this.nativeSelection;
    const result = this.menuResult;
    if (native && result) {
      this.menuResult = undefined;
      this.menuVisible = false;
      this.menuRequest += 1;
      try {
        result.copy();
      } catch (_) {
        this.notify($r('app.string.web_action_failed'));
      }
      return;
    }
    this.dismissMenu();
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text));
    } catch (_) {
      this.notify($r('app.string.web_action_failed'));
    }
  }

  private async viewContextPath(): Promise<void> {
    const path = this.menuPath;
    this.dismissMenu();
    const result = await viewInFileManager(getContext(this) as common.UIAbilityContext, path);
    if (!result.opened) {
      this.notify(this.pathError(result));
    }
  }

  private pathError(result: PathActionResult): Resource {
    switch (result.reason) {
      case 'access-denied': return $r('app.string.path_access_denied');
      case 'no-handler': return $r('app.string.path_no_handler');
      case 'not-found': return $r('app.string.path_not_found');
      case 'invalid-path': return $r('app.string.path_invalid');
      case 'unsupported-path': return $r('app.string.path_unsupported');
      default: return $r('app.string.path_open_failed');
    }
  }

  onBackPress(): boolean {
    if (this.menuVisible) {
      this.dismissMenu();
      return true;
    }
    if (this.searchVisible) {
      this.hideSearch();
      return true;
    }
    if (this.webUrl === '') {
      return this.homeController.back();
    }
    try {
      if (this.pageLoaded && this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (error) {
      // A detached renderer has no history; Back still returns to saved connections.
    }
    this.closeWeb();
    return true;
  }

  private overlayAction(action: string): void {
    switch (action) {
      case 'previous': this.nextMatch(false); break;
      case 'next': this.nextMatch(true); break;
      case 'close': this.hideSearch(); break;
      case 'copy': this.copyContext(); break;
      case 'files': this.viewContextPath(); break;
      case 'browser': {
        const link = this.menuLink;
        this.dismissMenu();
        this.handOff(link);
        break;
      }
    }
  }

  @Builder
  private findButton(symbol: string, label: Resource, action: string) {
    Button({ type: ButtonType.Normal }) {
      Text(symbol).fontSize(18).fontColor(this.palette().text)
    }.width(28).height(28).borderRadius(8).padding(0)
    .backgroundColor(this.hoveredAction === action ? this.palette().hover : Color.Transparent)
    .stateEffect(false).hoverEffect(HoverEffect.None).accessibilityText(label)
    .onHover((hovered: boolean) => this.hoveredAction = hovered ? action : '')
    .onClick(() => this.overlayAction(action))
  }

  @Builder
  private findBar() {
    Row({ space: 6 }) {
      Text('⠿').width(16).fontSize(18).fontColor(this.palette().muted)
        .accessibilityText($r('app.string.find_drag'))
      TextInput({ text: this.searchText, placeholder: $r('app.string.find_placeholder') })
        .id('dsh-find').layoutWeight(1).height(32).fontSize(14)
        .padding({ left: 10, right: 10 }).borderRadius(8)
        .fontColor(this.palette().text).placeholderColor(this.palette().muted)
        .caretColor(this.palette().accent).backgroundColor(this.palette().input)
        .border({ width: 0.5, color: this.palette().border })
        .onChange((value: string) => this.searchChanged(value))
        .onKeyPreIme((event: KeyEvent) => this.webKey(event, true))
        .onAppear(() => {
          this.focusElement('dsh-find');
          this.searchChanged(this.searchText);
        })
      Text(this.searchIndex.toString() + ' / ' + this.searchCount.toString())
        .width(60).textAlign(TextAlign.Center).fontSize(12).fontColor(this.palette().muted)
      this.findButton('↑', $r('app.string.find_previous'), 'previous')
      this.findButton('↓', $r('app.string.find_next'), 'next')
      this.findButton('×', $r('app.string.find_close'), 'close')
    }.width(this.findWidth()).height(48).padding(8)
    .backgroundColor(this.palette().surface).borderRadius(12)
    .border({ width: 0.5, color: this.palette().border })
    .shadow({ radius: 20, color: this.palette().shadow, offsetY: 6 })
    .position({ x: this.searchX, y: this.searchY })
    .gesture(PanGesture({ direction: PanDirection.All, distance: 4 }).tag('dsh-find-drag')
      .onActionStart(() => {
        this.dragStartX = this.searchX;
        this.dragStartY = this.searchY;
        this.searchMoved = true;
      })
      .onActionUpdate((event: GestureEvent) => {
        this.searchX = this.dragStartX + event.offsetX;
        this.searchY = this.dragStartY + event.offsetY;
        this.placeSearch();
      }))
    .onGestureJudgeBegin((info: GestureInfo, event: BaseGestureEvent) =>
      info.tag === 'dsh-find-drag' ? this.allowSearchDrag(event) : GestureJudgeResult.CONTINUE)
  }

  @Builder
  private menuItem(label: Resource, action: string) {
    Button({ type: ButtonType.Normal }) {
      Row() {
        Text(label).fontSize(14).fontColor(this.palette().text).textAlign(TextAlign.Start).layoutWeight(1)
      }.width('100%').justifyContent(FlexAlign.Start)
    }.width('100%').height(40).padding({ left: 10, right: 10 }).borderRadius(10)
    .backgroundColor(this.hoveredAction === action ? this.palette().hover : Color.Transparent)
    .stateEffect(false).hoverEffect(HoverEffect.None)
    .onHover((hovered: boolean) => this.hoveredAction = hovered ? action : '')
    .onClick(() => this.overlayAction(action))
  }

  @Builder
  private contextMenu() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {}.width('100%').height('100%').onClick(() => this.dismissMenu())
      Column() {
        this.menuItem($r('app.string.context_copy'), 'copy')
        if (this.menuLink !== '') {
          this.menuItem($r('app.string.context_browser'), 'browser')
        }
        if (this.menuPath !== '') {
          this.menuItem($r('app.string.context_files'), 'files')
        }
      }.width(Math.min(240, this.viewportWidth)).padding(4).borderRadius(20)
      .backgroundColor(this.palette().surface).border({ width: 0.5, color: this.palette().border })
      .shadow({ radius: 24, color: this.palette().shadow, offsetY: 8 })
      .position({ x: this.menuX, y: this.menuY })
    }.width('100%').height('100%')
    .onKeyPreIme((event: KeyEvent) => this.webKey(event))
  }

  build() {
    Stack() {
      Column() {}.width('100%').height('100%').backgroundColor($r('app.color.background'))
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
        .hitTestBehavior(HitTestMode.None)
      if (this.webUrl !== '') {
        ForEach([this.webGeneration], (generation: number) => {
          Web({ src: this.webUrl, controller: this.controller })
            .javaScriptAccess(true)
            .domStorageAccess(true)
            .fileAccess(false)
            .mixedMode(MixedMode.None)
            // Gesture zoom is off: the page is an application surface, and a
            // pinch would only desynchronise it from its own layout.
            .zoomAccess(false)
            // Windows are never created here, so every popup request is answered
            // with a controller that refuses one; the address is then routed below.
            .multiWindowAccess(true)
            .allowWindowOpenMethod(true)
            // ArkWeb disables page dark mode unless asked; without this the page
            // keeps its light `prefers-color-scheme` while the window goes dark.
            .darkMode(WebDarkMode.Auto)
            // The component's own background also covers the not-yet-painted surface.
            .backgroundColor($r('app.color.panel'))
            .id('dsh-web')
            .onInterceptKeyEvent((event: KeyEvent) => this.webKey(event))
            .onContextMenuShow((event) => this.showContext(event))
            .onSearchResultReceive((event) => {
              if (generation === this.webGeneration && this.searchVisible && this.searchText !== '') {
                this.searchCount = event.numberOfMatches;
                this.searchIndex = event.numberOfMatches > 0 ? event.activeMatchOrdinal + 1 : 0;
              }
            })
            .javaScriptOnDocumentStart([
              { script: LOCAL_CONNECTION_SCRIPT, scriptRules: ['*'] },
              { script: CONTEXT_CAPTURE_SCRIPT, scriptRules: ['*'] }
            ])
            .onFirstScreenPaint(() => {
              if (generation === this.webGeneration && this.webError === undefined) {
                this.webPainted = true;
              }
            })
            .onHttpErrorReceive((event) => {
              if (event) {
                this.showWebError(generation, event.request,
                  $r('app.string.web_http_error', event.response.getResponseCode()), true);
              }
            })
            .onErrorReceive((event) => {
              if (event) {
                this.showWebError(generation, event.request,
                  $r('app.string.web_network_error', event.error.getErrorCode()), false);
              }
            })
            .onConsole(() => true)
            // The renderer waits for this answer, so the refusal is sent before
            // anything else: a page must never block on a window that cannot exist.
            .onWindowNew((event) => {
              event.handler.setWebController(null);
              if (generation === this.webGeneration && leavesWebView(event.targetUrl, this.webOrigin)) {
                this.handOff(event.targetUrl);
              }
            })
            .onLoadIntercept((event) => {
              if (!event || generation !== this.webGeneration) {
                return false;
              }
              const url = event.data.getRequestUrl();
              if (!event.data.isMainFrame() || !leavesWebView(url, this.webOrigin)) {
                return false;
              }
              this.handOff(url);
              return true;
            })
            .onOverrideUrlLoading((request) => {
              if (generation !== this.webGeneration || !request.isMainFrame()) {
                return false;
              }
              const url = request.getRequestUrl();
              if (!leavesWebView(url, this.webOrigin)) {
                return false;
              }
              this.handOff(url);
              return true;
            })
            .onPageBegin(() => this.dismissMenu())
            .onPageEnd((event) => {
              if (event && generation === this.webGeneration && this.webError === undefined &&
                loopbackOrigin(event.url) === this.webOrigin) {
                this.currentWebAddress = event.url;
                this.pageLoaded = true;
                this.webPainted = true;
                this.refreshOverlayPalette();
              }
            })
            .onRenderExited(() => {
              if (generation === this.webGeneration) {
                this.rendererAlive = false;
                this.webConnection.disconnected();
              }
            })
            .width('100%').height('100%')
        }, (generation: number) => generation.toString())
      } else {
        ConnectionHome({ controller: this.homeController,
          onOpen: (address: string, remote: boolean, connection: ConnectionProfile) =>
            this.openWeb(address, remote, connection) })
      }
      if (this.webUrl !== '' && this.webError !== undefined) {
        Column({ space: 16 }) {
          Text($r('app.string.web_load_error_title')).fontSize(20).fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.ink')).textAlign(TextAlign.Center)
          Text(this.webError).fontSize(15).fontColor($r('app.color.ink')).textAlign(TextAlign.Center)
          Button($r('app.string.web_return_connections')).height(48)
            .onClick(() => { this.closeWeb(); })
        }.width('100%').height('100%').padding(24).justifyContent(FlexAlign.Center)
        .backgroundColor($r('app.color.panel'))
      } else if (this.webUrl !== '' && !this.webPainted && !this.pageLoaded) {
        Column({ space: 16 }) {
          LoadingProgress().width(28).height(28).color($r('app.color.accent'))
          Text($r('app.string.opening')).fontSize(15).fontColor($r('app.color.ink'))
        }.width('100%').height('100%').justifyContent(FlexAlign.Center)
        .backgroundColor($r('app.color.panel'))
      }
      if (this.searchVisible && this.webUrl !== '') {
        this.findBar()
      }
      if (this.menuVisible && this.webUrl !== '') {
        this.contextMenu()
      }
    }.width('100%').height('100%').backgroundColor($r('app.color.panel'))
    .onKeyPreIme((event: KeyEvent) => this.webKey(event))
    .onAreaChange((_, area: Area) => {
      this.viewportWidth = Number(area.width);
      this.viewportHeight = Number(area.height);
      this.placeSearch();
      if (this.menuVisible) {
        this.dismissMenu();
      }
    })
  }
}
