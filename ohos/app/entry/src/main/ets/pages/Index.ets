import webview from '@ohos.web.webview';
import picker from '@ohos.file.picker';
import pasteboard from '@ohos.pasteboard';
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import common from '@ohos.app.ability.common';
import { RuntimeDefaults } from '../config/RuntimeDefaults';
import { loopbackOrigin } from '../launcher/RunLogUrl';
import { RunLogState, RunLogView, RunLogWatcher } from '../launcher/RunLogWatcher';
import { serviceAnswers } from '../launcher/ServiceProbe';

/** The command the page asks the user to run; the log path is outside the app sandbox. */
const RUN_COMMAND = 'dsh web --host 127.0.0.1 --port 9000 --no-open > ~/Documents/dsh-run.log 2>&1 &';
const RUN_LOG_NAME = 'dsh-run.log';
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
  @State private blocked: boolean = false;
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

  aboutToAppear(): void {
    this.watcher.subscribe((view: RunLogView) => this.onLog(view));
    this.watcher.setPath(this.logPath);
    this.requestDocumentsAccess();
  }

  aboutToDisappear(): void {
    this.watcher.unsubscribe();
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
        this.webUrl = view.url;
        this.webOrigin = origin;
        this.webGeneration = this.webGeneration + 1;
        this.pageLoaded = false;
        this.webPainted = false;
        this.controller = new webview.WebviewController();
      }
    });
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
    if (this.blocked) {
      this.blocked = false;
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

  build() {
    Stack() {
      if (this.webUrl !== '') {
        ForEach([this.webGeneration], (generation: number) => {
          Web({ src: this.webUrl, controller: this.controller })
            .javaScriptAccess(true)
            .domStorageAccess(true)
            .fileAccess(false)
            .mixedMode(MixedMode.None)
            .multiWindowAccess(false)
            .allowWindowOpenMethod(false)
            // ArkWeb disables page dark mode unless asked; without this the page
            // keeps its light `prefers-color-scheme` while the window goes dark.
            .darkMode(WebDarkMode.Auto)
            // The component's own background also covers the not-yet-painted surface.
            .backgroundColor($r('app.color.panel'))
            .javaScriptOnDocumentStart([{ script: LOCAL_CONNECTION_SCRIPT, scriptRules: ['*'] }])
            .onFirstScreenPaint(() => {
              if (generation === this.webGeneration) {
                this.webPainted = true;
              }
            })
            .onConsole(() => true)
            .onLoadIntercept((event) => {
              if (event && event.data.isMainFrame() && generation === this.webGeneration) {
                return loopbackOrigin(event.data.getRequestUrl()) !== this.webOrigin;
              }
              return false;
            })
            .onOverrideUrlLoading((request) => {
              return request.isMainFrame() && generation === this.webGeneration &&
                loopbackOrigin(request.getRequestUrl()) !== this.webOrigin;
            })
            .onPageEnd((event) => {
              if (event && generation === this.webGeneration &&
                loopbackOrigin(event.url) === this.webOrigin) {
                this.pageLoaded = true;
                this.webPainted = true;
              }
            })
            .onRenderExited(() => {
              if (generation === this.webGeneration) {
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
      if (this.blocked) {
        Row({ space: 12 }) {
          Text($r('app.string.external_blocked')).fontSize(13).layoutWeight(1)
          Button($r('app.string.dismiss')).onClick(() => this.blocked = false)
        }.padding(12).width('100%').backgroundColor($r('app.color.canvas'))
      }
    }.width('100%').height('100%').backgroundColor($r('app.color.panel'))
  }
}
