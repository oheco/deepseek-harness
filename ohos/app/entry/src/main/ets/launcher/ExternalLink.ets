import Want from '@ohos.app.ability.Want';
import common from '@ohos.app.ability.common';
import { loopbackOrigin } from './RunLogUrl';

/**
 * Addresses the page itself owns. ArkWeb reports them before it resolves them,
 * so handing one to the system would break the page's own scripting instead of
 * opening a site.
 */
const PAGE_OWNED_SCHEMES: string[] = ['about:', 'blob:', 'data:', 'javascript:', 'filesystem:', 'file:'];

/**
 * Reports whether an address has to leave this app.
 *
 * Only the origin the WebView was opened with stays inside. Everything else is
 * a destination the wrapped service chose for the system — a documentation
 * link, an authorization page, a mail address — and this single-purpose window
 * cannot render it as well as the application that owns it.
 *
 * @param url - Address reported by ArkWeb.
 * @param origin - Origin of the service currently shown in the WebView.
 * @returns true when another application has to open the address.
 */
export function leavesWebView(url: string, origin: string): boolean {
  const address = url.trim();
  if (address === '') {
    return false;
  }
  const lowered = address.toLowerCase();
  for (const owned of PAGE_OWNED_SCHEMES) {
    if (lowered.startsWith(owned)) {
      return false;
    }
  }
  return loopbackOrigin(address) !== origin;
}

/**
 * Hands one address to the application the system associates with it.
 *
 * `openLink` covers App Linking and falls back to the default browser for a
 * plain address; a browsable VIEW request covers everything else the system can
 * resolve, including schemes such as `mailto:`.
 *
 * @param context - Ability context that starts the target application.
 * @param url - Address to open outside this app.
 * @returns true when the system accepted the request.
 */
export async function openOutside(context: common.UIAbilityContext, url: string): Promise<boolean> {
  try {
    await context.openLink(url, { appLinkingOnly: false });
    return true;
  } catch (_) {
    // No verified App Linking domain matched; the VIEW request below is the route
    // for a browser or any other handler.
  }
  const want: Want = {
    action: 'ohos.want.action.viewData',
    entities: ['entity.system.browsable'],
    uri: url
  };
  try {
    await context.startAbility(want);
    return true;
  } catch (_) {
    // Nothing on the device declares this address, including its scheme.
    return false;
  }
}
