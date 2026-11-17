import window from '@ohos.window';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import resourceManager from '@ohos.resourceManager';

/**
 * Resolve an actual mode for native frame colors. An unspecified configuration
 * uses the resource manager's resolved mode, then the last actual mode; a new
 * ability with neither uses the SDK's default light mode.
 * @param configured - current ability configuration, including follow-system or omission.
 * @param resourceMode - application resource configuration when the ability mode is unspecified.
 * @param previous - most recent actual mode retained by the ability.
 * @returns The actual light or dark mode; never the follow-system sentinel.
 */
export function resolveSystemColorMode(configured: ConfigurationConstant.ColorMode | undefined,
  resourceMode: resourceManager.ColorMode | undefined,
  previous: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT):
  ConfigurationConstant.ColorMode {
  if (configured === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ||
    configured === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT) {
    return configured;
  }
  if (resourceMode === resourceManager.ColorMode.DARK) {
    return ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  if (resourceMode === resourceManager.ColorMode.LIGHT) {
    return ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  }
  return previous === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ?
    ConfigurationConstant.ColorMode.COLOR_MODE_DARK : ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
}

/**
 * Match the base/dark app.color.background resource and DSH's base web palette.
 * @param mode - actual system color mode resolved by the ability.
 * @returns An opaque RGB window background.
 */
export function appWindowBackground(mode: ConfigurationConstant.ColorMode): string {
  return mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ? '#151517' : '#FFFFFF';
}

/**
 * Keep system bars transparent so the page background shows through, with readable foregrounds.
 * @param mode - actual system color mode resolved by the ability.
 * @returns Properties for the status and navigation bars.
 */
export function systemBarProperties(mode: ConfigurationConstant.ColorMode): window.SystemBarProperties {
  const foreground: string = mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ? '#FFFFFFFF' : '#FF0F1115';
  return {
    statusBarColor: '#00000000',
    navigationBarColor: '#00000000',
    statusBarContentColor: foreground,
    navigationBarContentColor: foreground
  };
}

/**
 * Apply the system theme after successful loadContent. Normal window layout keeps
 * interactive content in safe areas; the page expands only its background drawing.
 * Unsupported bar styling or a destroyed window does not interrupt page loading.
 * @param mainWindow - the live main window whose content has finished loading.
 * @param mode - actual system color mode resolved by the ability.
 * @returns No value; asynchronous styling failures are contained.
 */
export function applySystemBars(mainWindow: window.Window, mode: ConfigurationConstant.ColorMode): void {
  try {
    mainWindow.setWindowBackgroundColor(appWindowBackground(mode));
  } catch (error) {
    // A destroyed window cannot accept a background update.
  }
  try {
    mainWindow.setWindowLayoutFullScreen(false).catch((error: Error) => {
      // A rejected layout update leaves the platform's safe-area policy in place.
    });
  } catch (error) {
    // A window that is no longer live can reject before returning a Promise.
  }
  try {
    mainWindow.setWindowSystemBarProperties(systemBarProperties(mode)).catch((error: Error) => {
      // Unsupported bar styling retains the platform colors and visible bars.
    });
  } catch (error) {
    // A destroyed or unsupported window can reject before returning a Promise.
  }
}
