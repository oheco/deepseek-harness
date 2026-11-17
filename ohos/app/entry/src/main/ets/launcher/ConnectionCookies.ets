import webview from '@ohos.web.webview';
import cryptoFramework from '@ohos.security.cryptoFramework';
import { loopbackOrigin } from './RunLogUrl';
import { connectionDiagnostic, connectionDiagnosticFailure } from './ConnectionDiagnostics';

const BASE64URL: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Url(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | ((index + 1 < bytes.length ? bytes[index + 1] : 0) << 8) |
      (index + 2 < bytes.length ? bytes[index + 2] : 0);
    text += BASE64URL[(value >> 18) & 63] + BASE64URL[(value >> 12) & 63];
    if (index + 1 < bytes.length) { text += BASE64URL[(value >> 6) & 63]; }
    if (index + 2 < bytes.length) { text += BASE64URL[value & 63]; }
  }
  return text;
}

/**
 * Name of the DSH browser-session cookie for one HTTP authority. DSH Web names each cookie `dsh-auth-` plus the
 * unpadded base64url SHA-256 of the request Host authority, so services on other loopback ports keep their cookies.
 * @param origin Numeric loopback origin.
 * @returns Cookie name.
 */
export function authenticationCookieName(origin: string): string {
  let authority = origin.slice('http://'.length);
  if (authority.endsWith(':80')) {
    authority = authority.slice(0, -3);
  }
  const bytes = new Uint8Array(authority.length);
  for (let index = 0; index < authority.length; index++) {
    bytes[index] = authority.charCodeAt(index);
  }
  const digest = cryptoFramework.createMd('SHA256');
  digest.updateSync({ data: bytes });
  return 'dsh-auth-' + base64Url(digest.digestSync().data);
}

/**
 * Expire this origin's DSH authentication cookie after a real Web controller is bound, before its first
 * authenticated navigation. Cookies of other loopback ports, including connections open in other windows, stay valid.
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
  const name = authenticationCookieName(origin);
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
    if (domain !== hostname || cookie.path !== '/' || cookie.name !== name) {
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
