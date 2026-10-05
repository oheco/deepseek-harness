import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import resourceManager from '@ohos.resourceManager';
import native from 'libdsh_launcher.so';
import { applySystemBars, resolveSystemColorMode } from '../launcher/SystemBars';
import { WEB_VIEW_ACTIVE_EVENT, WebOrientation } from '../launcher/WebOrientation';
import { APP_BACKGROUND_EVENT, APP_FOREGROUND_EVENT } from '../launcher/AppActivity';

/**
 * AppStorage key carrying the resolved system colour mode. ArkUI resolves `$r()`
 * colour resources against the application colour mode; a page bound to this key
 * through `@StorageProp` re-evaluates its colours when the system mode changes.
 */
export const COLOR_MODE_KEY: string = 'dshColorMode';

/** The ability owns the window frame; the page owns connection and interaction state. */
export default class EntryAbility extends UIAbility {
  private activeWindowStage: window.WindowStage | undefined = undefined;
  private mainWindow: window.Window | undefined = undefined;
  private colorMode: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  private orientation: WebOrientation = new WebOrientation();
  private webViewActivityChanged: (active: boolean) => void = (active: boolean): void => {
    this.orientation.setWebActive(active);
  };

  onCreate(): void {
    this.refreshColorMode(this.context.config);
    try {
      this.context.eventHub.on(WEB_VIEW_ACTIVE_EVENT, this.webViewActivityChanged);
    } catch (error) {
      // A context that cannot subscribe retains the default portrait policy.
    }
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    this.refreshColorMode(newConfig);
    this.refreshSystemBars();
  }

  onForeground(): void {
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
    try {
      this.context.eventHub.emit(APP_BACKGROUND_EVENT);
    } catch (error) {
      // An unavailable context or a failed page callback cannot interrupt backgrounding.
    }
  }

  onWindowStageDestroy(): void {
    this.closeBroker();
    this.activeWindowStage = undefined;
    this.mainWindow = undefined;
    this.orientation.detach();
    this.orientation.setWebActive(false);
  }

  onDestroy(): void {
    this.closeBroker();
    this.activeWindowStage = undefined;
    this.mainWindow = undefined;
    this.orientation.dispose();
    try {
      this.context.eventHub.off(WEB_VIEW_ACTIVE_EVENT, this.webViewActivityChanged);
    } catch (error) {
      // A destroyed context may no longer accept listener removal.
    }
  }

  /** End native ownership when its window or ability is destroyed; the NAPI cleanup hook joins remaining work. */
  private closeBroker(): void {
    try {
      native.brokerClose().catch((error: Error) => {
        // Native module cleanup still owns the final worker join after context teardown.
      });
    } catch (error) {
      // Native environment cleanup owns remaining handles if close cannot be submitted.
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

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.activeWindowStage = windowStage;
    this.mainWindow = undefined;
    this.orientation.detach();
    try {
      this.orientation.attach(windowStage.getMainWindowSync());
    } catch (error) {
      // A window not available yet receives the latest policy after content loads.
    }
    windowStage.loadContent('pages/Index', (error) => {
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
    });
  }
}
