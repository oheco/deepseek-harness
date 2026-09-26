import webview from '@ohos.web.webview';
import picker from '@ohos.file.picker';
import pasteboard from '@ohos.pasteboard';
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import common from '@ohos.app.ability.common';
import { RuntimeDefaults } from '../config/RuntimeDefaults';
import { leavesWebView, openOutside } from '../launcher/ExternalLink';
import { loopbackOrigin } from '../launcher/RunLogUrl';
import { RunLogState, RunLogView, RunLogWatcher } from '../launcher/RunLogWatcher';
import { serviceAnswers } from '../launcher/ServiceProbe';
import { KeyCode } from '@ohos.multimodalInput.keyCode';
import { CONTEXT_CAPTURE_SCRIPT, ContextSnapshot, contextSnapshotScript, contextTarget } from '../launcher/ContextActions';
import { viewInFileManager, PathActionResult } from '../launcher/PathActions';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { OverlayPalette, overlayPaletteScript, parseOverlayPalette } from '../launcher/OverlayAppearance';

/** The command the page asks the user to run; the log path is outside the app sandbox. */
const RUN_COMMAND = RuntimeDefaults.runCommand;
const RUN_LOG_NAME = RuntimeDefaults.runLogName;
const DOCUMENTS_PERMISSION: Permissions = 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY';
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
  @State private commandCopied: number = 0;
  @State private logState: RunLogState = RunLogState.Idle;
  @State private picked: boolean = false;
  // Bound only so a system theme change re-renders this page: the colours below
  // are $r() resources, and ArkUI re-resolves them on that re-render.
  @StorageProp(COLOR_MODE_KEY) private colorMode: number = -1;
  @State private webUrl: string = '';
  @State private webOrigin: string = '';
  @State private webGeneration: number = 0;
  @State private pageLoaded: boolean = false;
  // ArkWeb paints an empty surface before the page content, so a themed cover
  // stays until the first paint instead of letting the default white show.
  @State private webPainted: boolean = false;
  private logPath: string = RuntimeDefaults.homeDir + '/Documents/' + RUN_LOG_NAME;
  private watcher: RunLogWatcher = new RunLogWatcher();
  private controller: webview.WebviewController = new webview.WebviewController();
  private checking: string = '';
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

  aboutToAppear(): void {
    this.attached = true;
    this.watcher.subscribe((view: RunLogView) => this.onLog(view));
    this.watcher.setPath(this.logPath);
    this.requestDocumentsAccess();
  }

  aboutToDisappear(): void {
    this.watcher.unsubscribe();
    clearTimeout(this.searchTimer);
    clearTimeout(this.paletteTimer);
    this.attached = false;
    this.dismissMenu();
  }

  /** Best effort: the picker route works without this grant, so a denial is not fatal. */
  private requestDocumentsAccess(): void {
    try {
      const manager = abilityAccessCtrl.createAtManager();
      const ability = getContext(this) as common.UIAbilityContext;
      manager.requestPermissionsFromUser(ability, [DOCUMENTS_PERMISSION])
        .then(() => this.watcher.setPath(this.logPath))
        .catch(() => {});
    } catch (_) {
      // Without an ability context the picker remains the only route.
    }
  }

  /** Opens the Web view only after the announced address actually answers. */
  private onLog(view: RunLogView): void {
    this.logState = view.state;
    if (view.url === '' || view.url === this.webUrl || this.checking === view.url) {
      return;
    }
    const origin = loopbackOrigin(view.url);
    if (origin === '') {
      return;
    }
    this.checking = view.url;
    serviceAnswers(origin).then((answers: boolean) => {
      if (this.checking !== view.url) {
        return;
      }
      this.checking = '';
      if (answers) {
        this.dismissMenu();
        if (this.searchVisible) {
          this.hideSearch();
        }
        this.webUrl = view.url;
        this.webOrigin = origin;
        this.webGeneration = this.webGeneration + 1;
        this.overlayPalette = undefined;
        this.pageLoaded = false;
        this.webPainted = false;
        this.controller = new webview.WebviewController();
      }
    });
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
    const find = ctrl && event.keyCode === KeyCode.KEYCODE_F;
    const escape = event.keyCode === KeyCode.KEYCODE_ESCAPE && (this.menuVisible || this.searchVisible);
    const enter = fromFind && this.searchVisible && event.keyCode === KeyCode.KEYCODE_ENTER;
    if (!find && !escape && !enter) {
      return false;
    }
    if (event.type === KeyType.Down) {
      if (find) {
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
    this.menuPath = target.path;
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
      this.menuPath = parsed.path;
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

  private async pickRunLog(): Promise<void> {
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.selectMode = picker.DocumentSelectMode.FILE;
      const uris = await new picker.DocumentViewPicker().select(options);
      if (uris.length === 0) {
        return;
      }
      this.picked = true;
      this.watcher.setUri(uris[0]);
    } catch (_) {
      this.picked = false;
    }
  }

  private async copyCommand(): Promise<void> {
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, RUN_COMMAND);
      await pasteboard.getSystemPasteboard().setData(data);
      this.commandCopied = 1;
    } catch (_) {
      this.commandCopied = 2;
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
    if (this.webUrl === '' || !this.pageLoaded) {
      return false;
    }
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (_) {
      // A detached renderer has no history; the platform handles Back normally.
    }
    return false;
  }

  private statusText(): Resource {
    if (this.logState === RunLogState.Unreadable) {
      return $r('app.string.log_unreadable');
    }
    if (this.picked) {
      return $r('app.string.log_waiting_picked');
    }
    if (this.logState === RunLogState.Missing) {
      return $r('app.string.log_missing');
    }
    return $r('app.string.log_waiting');
  }

  @Builder
  private waitingPage() {
    Column({ space: 24 }) {
      Column({ space: 12 }) {
        Text($r('app.string.command_title')).fontSize(20).fontWeight(FontWeight.Bold)
        Text(RUN_COMMAND).fontFamily('monospace').fontSize(13).copyOption(CopyOptions.LocalDevice)
          .width('100%').padding(16).backgroundColor($r('app.color.canvas')).borderRadius(12)
        Button(this.commandCopied === 1 ? $r('app.string.command_copied') : $r('app.string.copy_command'))
          .onClick(() => this.copyCommand())
      }.width('100%').alignItems(HorizontalAlign.Start)

      Column({ space: 12 }) {
        Row({ space: 12 }) {
          LoadingProgress().width(24).height(24).color($r('app.color.accent'))
          Text($r('app.string.waiting_title')).fontSize(20).fontWeight(FontWeight.Bold)
        }
        Text(this.statusText()).fontSize(15).fontColor($r('app.color.ink'))
        Text(this.logPath).fontFamily('monospace').fontSize(12).fontColor($r('app.color.muted'))
        if (this.logState === RunLogState.Unreadable) {
          Button($r('app.string.pick_log')).onClick(() => this.pickRunLog())
        }
      }.width('100%').alignItems(HorizontalAlign.Start)
    }.constraintSize({ maxWidth: 860 }).width('100%').padding(32).justifyContent(FlexAlign.Center)
    .backgroundColor($r('app.color.panel'))
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
              if (generation === this.webGeneration) {
                this.webPainted = true;
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
              if (event && generation === this.webGeneration &&
                loopbackOrigin(event.url) === this.webOrigin) {
                this.pageLoaded = true;
                this.webPainted = true;
                this.refreshOverlayPalette();
              }
            })
            .onRenderExited(() => {
              if (generation === this.webGeneration) {
                this.dismissMenu();
                clearTimeout(this.searchTimer);
                clearTimeout(this.paletteTimer);
                this.overlayPalette = undefined;
                this.searchVisible = false;
                this.webUrl = '';
                this.webOrigin = '';
                this.checking = '';
              }
            })
            .width('100%').height('100%')
        }, (generation: number) => generation.toString())
      } else {
        this.waitingPage()
      }
      if (this.webUrl !== '' && !this.webPainted && !this.pageLoaded) {
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
