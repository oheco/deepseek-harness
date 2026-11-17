/** UIAbilityContext event sent after the window enters the foreground; carries no payload. */
export const APP_FOREGROUND_EVENT: string = 'dshAppForeground';

/** UIAbilityContext event sent when the window enters the background; carries no payload. */
export const APP_BACKGROUND_EVENT: string = 'dshAppBackground';

/** UIAbilityContext event carrying the open connection name for the window title, or '' for the App name. */
export const WINDOW_TITLE_EVENT: string = 'dshWindowTitle';
