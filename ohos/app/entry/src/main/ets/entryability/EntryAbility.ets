import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { Configuration } from '@ohos.app.ability.Configuration';

/**
 * AppStorage key carrying the live system colour mode. ArkUI resolves `$r()`
 * colour resources against the application colour mode, but a page does not
 * re-render when that mode changes, so a page bound to this key through
 * `@StorageProp` re-evaluates its colours instead of keeping the old ones.
 */
export const COLOR_MODE_KEY: string = 'dshColorMode';

/** The page owns all other state; the ability loads it and tracks the theme. */
export default class EntryAbility extends UIAbility {
  onCreate(): void {
    // Following the system is the platform default, so the mode is read rather
    // than forced: an explicit setColorMode would freeze the app to one theme.
    AppStorage.setOrCreate<ConfigurationConstant.ColorMode>(COLOR_MODE_KEY, this.context.config.colorMode);
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    const mode: ConfigurationConstant.ColorMode | undefined = newConfig.colorMode;
    if (mode !== undefined) {
      AppStorage.setOrCreate<ConfigurationConstant.ColorMode>(COLOR_MODE_KEY, mode);
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        return;
      }
      try {
        // State the documented follow-system choice once the page is loaded:
        // `$r()` colours resolve against this application colour mode.
        this.context.getApplicationContext()
          .setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
      } catch (_) {
        // A context that cannot set the mode keeps the platform default.
      }
    });
  }
}
