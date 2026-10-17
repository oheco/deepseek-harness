import webview from '@ohos.web.webview';
import { loopbackOrigin } from './RunLogUrl';
import { connectionDiagnostic, connectionDiagnosticFailure } from './ConnectionDiagnostics';

/**
 * Expire DSH authentication cookies after a real Web controller is bound, before its first authenticated navigation.
 * @param origin Numeric loopback origin for the new connection.
 * @param current Reports whether the bound controller still owns the pending navigation.
 * @returns False when ownership is cancelled; otherwise cookie preparation is complete.
 */
export async function prepareConnectionCookies(origin: string, current: () => boolean, generation: number = -1): Promise<boolean> {
  if (loopbackOrigin(origin) !== origin) {
    throw new Error('Cookie preparation requires a numeric loopback origin');
  }
  if (!current()) {
    return false;
  }
  const hostname = origin.startsWith('http://[::1]:') ? '::1' : '127.0.0.1';
  const started = Date.now();
  connectionDiagnostic('cookies.read_begin', { generation: generation });
  let cookies: webview.WebHttpCookie[];
  try {
    cookies = await webview.WebCookieManager.fetchAllCookies(false);
  } catch (error) {
    connectionDiagnosticFailure('cookies.read_failed', error, { generation: generation, elapsedMs: Date.now() - started });
    throw error as Error;
  }
  connectionDiagnostic('cookies.read_complete', { generation: generation, elapsedMs: Date.now() - started, count: cookies.length });
  if (!current()) {
    connectionDiagnostic('cookies.owner_retired', { generation: generation });
    return false;
  }
  let expired: number = 0;
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (domain !== hostname || cookie.path !== '/' || !/^dsh-auth-[A-Za-z0-9_-]{43}$/.test(cookie.name)) {
      continue;
    }
    if (!current()) {
      return false;
    }
    try {
      webview.WebCookieManager.configCookieSync(origin + '/',
        cookie.name + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly', false, true);
      expired += 1;
    } catch (error) {
      connectionDiagnosticFailure('cookies.expire_failed', error, { generation: generation, expired: expired });
      throw error as Error;
    }
  }
  const owned = current();
  connectionDiagnostic('cookies.prepared', { generation: generation, expired: expired, current: owned,
    elapsedMs: Date.now() - started });
  return owned;
}
