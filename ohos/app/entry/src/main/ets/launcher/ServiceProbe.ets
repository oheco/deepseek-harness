import http from '@ohos.net.http';

/** Loopback connect attempts stay short: the service either answers at once or is not up. */
const CONNECT_TIMEOUT_MS = 1500;
const READ_TIMEOUT_MS = 1500;

/**
 * Reports whether a service is actually answering on the address found in the
 * log. A log left behind by an earlier run still holds a valid-looking URL, so
 * the WebView is opened only after a real response arrives; any HTTP status
 * proves a listener answered, while a refused connection or timeout does not.
 */
export async function serviceAnswers(origin: string): Promise<boolean> {
  const request = http.createHttp();
  try {
    const response = await request.request(origin + '/', {
      method: http.RequestMethod.GET,
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS,
      expectDataType: http.HttpDataType.STRING
    });
    return response.responseCode > 0;
  } catch (_) {
    return false;
  } finally {
    request.destroy();
  }
}
