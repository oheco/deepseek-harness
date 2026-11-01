import UIAbility from '@ohos.app.ability.UIAbility';
import Want from '@ohos.app.ability.Want';
import window from '@ohos.window';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import resourceManager from '@ohos.resourceManager';
import native from 'libdsh_launcher.so';
import { applySystemBars, resolveSystemColorMode } from '../launcher/SystemBars';
import { WEB_VIEW_ACTIVE_EVENT, WebOrientation } from '../launcher/WebOrientation';
import { APP_BACKGROUND_EVENT, APP_FOREGROUND_EVENT, WINDOW_TITLE_EVENT } from '../launcher/AppActivity';
import { initializeConnectionDiagnostics, connectionDiagnostic, connectionDiagnosticFailure } from '../launcher/ConnectionDiagnostics';
import { OPEN_CONNECTION_KEY, WINDOW_CHANNEL_KEY, WindowSession, openRequest, windowRegistry } from '../launcher/WindowRegistry';

/**
 * AppStorage key carrying the resolved system colour mode. ArkUI resolves `$r()`
 * colour resources against the application colour mode; a page bound to this key
 * through `@StorageProp` re-evaluates its colours when the system mode changes.
 */
export const COLOR_MODE_KEY: string = 'dshColorMode';

/**
 * Each `specified` instance owns one window frame and one native broker channel, so windows keep independent live
 * connections; the page owns connection and interaction state.
 */
export default class EntryAbility extends UIAbility {
  private activeWindowStage: window.WindowStage | undefined = undefined;
  private mainWindow: window.Window | undefined = undefined;
  private colorMode: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  private orientation: WebOrientation = new WebOrientation();
  private session: WindowSession | undefined = undefined;
  private storage: LocalStorage = new LocalStorage();
  private windowTitle: string = '';
  private brokerReleased: boolean = false;
  private webViewActivityChanged: (active: boolean) => void = (active: boolean): void => {
    this.orientation.setWebActive(active);
  };
  private windowTitleChanged: (title: string) => void = (title: string): void => {
    this.windowTitle = title;
    this.applyWindowTitle();
  };

  onCreate(want: Want): void {
    try {
      initializeConnectionDiagnostics(this.context.filesDir);
    } catch (error) {
      connectionDiagnosticFailure('app.diagnostics_initialize_failed', error);
    }
    const session = windowRegistry().attach(want);
    this.session = session;
    this.storage.setOrCreate<number>(WINDOW_CHANNEL_KEY, session.channel);
    this.storage.setOrCreate<string>(OPEN_CONNECTION_KEY, openRequest(want));
    connectionDiagnostic('ability.created', { channel: session.channel });
    this.refreshColorMode(this.context.config);
    try {
      this.context.eventHub.on(WEB_VIEW_ACTIVE_EVENT, this.webViewActivityChanged);
    } catch (error) {
      // A context that cannot subscribe retains the default portrait policy.
    }
    try {
      this.context.eventHub.on(WINDOW_TITLE_EVENT, this.windowTitleChanged);
    } catch (error) {
      // A context that cannot subscribe keeps the App name as its window title.
    }
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    this.refreshColorMode(newConfig);
    this.refreshSystemBars();
  }

  onForeground(): void {
    connectionDiagnostic('ability.foreground', { channel: this.channel() });
    if (this.session) {
      windowRegistry().activated(this.session);
    }
    this.refreshColorMode(this.context.config);
    this.refreshSystemBars();
    this.orientation.reapply();
    try {
      this.context.eventHub.emit(APP_FOREGROUND_EVENT);
    } catch (error) {
      // An unavailable context or a failed page callback cannot interrupt foregrounding.
    }
  }

  onBackground(): void {
    connectionDiagnostic('ability.background', { channel: this.channel() });
    try {
      this.context.eventHub.emit(APP_BACKGROUND_EVENT);
    } catch (error) {
      // An unavailable context or a failed page callback cannot interrupt backgrounding.
    }
  }

  onWindowStageDestroy(): void {
    connectionDiagnostic('ability.window_destroyed', { channel: this.channel() });
    this.releaseBroker();
    this.activeWindowStage = undefined;
    this.mainWindow = undefined;
    this.orientation.detach();
    this.orientation.setWebActive(false);
  }

  onDestroy(): void {
    connectionDiagnostic('ability.destroyed', { channel: this.channel() });
    this.releaseBroker();
    if (this.session) {
      windowRegistry().detach(this.session);
    }
    this.activeWindowStage = undefined;
    this.mainWindow = undefined;
    this.orientation.dispose();
    try {
      this.context.eventHub.off(WEB_VIEW_ACTIVE_EVENT, this.webViewActivityChanged);
    } catch (error) {
      // A destroyed context may no longer accept listener removal.
    }
    try {
      this.context.eventHub.off(WINDOW_TITLE_EVENT, this.windowTitleChanged);
    } catch (error) {
      // A destroyed context may no longer accept listener removal.
    }
  }

  private channel(): number {
    return this.session ? this.session.channel : 0;
  }

  /** End this window's native ownership; other windows keep their channels and the NAPI cleanup hook joins leftovers. */
  private releaseBroker(): void {
    if (!this.session || this.brokerReleased) {
      return;
    }
    this.brokerReleased = true;
    try {
      native.brokerRelease(this.session.channel).catch((error: Error) => {
        // Native module cleanup still owns the final worker join after context teardown.
      });
    } catch (error) {
      // Native environment cleanup owns remaining handles if release cannot be submitted.
    }
  }

  private refreshColorMode(configuration: Configuration): void {
    let resourceMode: resourceManager.ColorMode | undefined = undefined;
    if (configuration.colorMode !== ConfigurationConstant.ColorMode.COLOR_MODE_DARK &&
      configuration.colorMode !== ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT) {
      try {
        resourceMode = this.context.getApplicationContext().resourceManager.getConfigurationSync().colorMode;
      } catch (error) {
        // An unavailable resource configuration retains the last resolved system mode.
      }
    }
    this.colorMode = resolveSystemColorMode(configuration.colorMode, resourceMode, this.colorMode);
    AppStorage.setOrCreate<ConfigurationConstant.ColorMode>(COLOR_MODE_KEY, this.colorMode);
  }

  private refreshSystemBars(): void {
    if (this.mainWindow) {
      applySystemBars(this.mainWindow, this.colorMode);
    }
  }

  /** Name the window after its open connection so windows stay distinguishable; '' restores the App name. */
  private applyWindowTitle(): void {
    const target = this.mainWindow;
    if (!target) {
      return;
    }
    let appName = '';
    try {
      appName = this.context.resourceManager.getStringByNameSync('app_name');
    } catch (error) {
      // An unavailable resource leaves the connection name alone.
    }
    const title = this.windowTitle === '' ? appName : appName === '' ? this.windowTitle : this.windowTitle + ' - ' + appName;
    if (title === '') {
      return;
    }
    try {
      target.setWindowTitle(title).catch((error: Error) => {
        // Devices without window titles keep their system label.
      });
    } catch (error) {
      // A window that does not support titles keeps its system label.
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.activeWindowStage = windowStage;
    this.brokerReleased = false;
    this.mainWindow = undefined;
    this.orientation.detach();
    try {
      this.orientation.attach(windowStage.getMainWindowSync());
    } catch (error) {
      // A window not available yet receives the latest policy after content loads.
    }
    windowStage.loadContent('pages/Index', this.storage, (error) => {
      if (error.code || this.activeWindowStage !== windowStage) {
        return;
      }
      try {
        this.context.getApplicationContext()
          .setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
      } catch (error) {
        // A context that cannot set the mode keeps the platform's follow-system default.
      }
      this.refreshColorMode(this.context.config);
      try {
        this.mainWindow = windowStage.getMainWindowSync();
      } catch (error) {
        // A missing main window keeps the page's background and default bar style.
      }
      if (this.mainWindow) {
        this.orientation.attach(this.mainWindow);
      }
      this.refreshSystemBars();
      if (this.windowTitle !== '') {
        this.applyWindowTitle();
      }
    });
  }
}
