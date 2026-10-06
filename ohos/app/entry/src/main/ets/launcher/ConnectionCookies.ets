import webview from '@ohos.web.webview';
import { loopbackOrigin } from './RunLogUrl';

/** Expire the DSH authentication family before a newly authenticated connection owns a WebView. */
export async function prepareConnectionCookies(origin: string, current: () => boolean): Promise<boolean> {
  if (loopbackOrigin(origin) !== origin) {
    throw new Error('Cookie preparation requires a numeric loopback origin');
  }
  if (!current()) {
    return false;
  }
  const hostname = origin.startsWith('http://[::1]:') ? '::1' : '127.0.0.1';
  const cookies: webview.WebHttpCookie[] = await webview.WebCookieManager.fetchAllCookies(false);
  if (!current()) {
    return false;
  }
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (domain !== hostname || cookie.path !== '/' || !/^dsh-auth-[A-Za-z0-9_-]{43}$/.test(cookie.name)) {
      continue;
    }
    if (!current()) {
      return false;
    }
    webview.WebCookieManager.configCookieSync(origin + '/',
      cookie.name + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly', false, true);
  }
  return current();
}
