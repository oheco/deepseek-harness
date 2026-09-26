/**
 * Extracts the authenticated loopback URL that a terminal-started service
 * announced. The rules mirror the native readiness parser: a complete line,
 * an explicit loopback authority, a nonzero port, and a nonempty token.
 */

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/\?token=([A-Za-z0-9_-]+)$/;
const ANNOUNCEMENT_PREFIX = 'dsh web: ';
const LAN_SUFFIX = ' (LAN: ';

/**
 * Returns the first terminated line that announces a loopback URL, or ''.
 * A line is only considered once its newline has arrived, so a half-written
 * announcement can never be adopted as a truncated address.
 */
export function readinessUrl(text: string): string {
  let cursor = 0;
  for (;;) {
    const lineBreak = text.indexOf('\n', cursor);
    if (lineBreak < 0) {
      return '';
    }
    const raw = text.slice(cursor, lineBreak);
    const candidate = announcedUrl(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (candidate !== '') {
      return candidate;
    }
    cursor = lineBreak + 1;
  }
}

/** Accepts either the full announcement line or a bare loopback URL line. */
function announcedUrl(line: string): string {
  let rest = line;
  if (line.startsWith(ANNOUNCEMENT_PREFIX)) {
    rest = line.slice(ANNOUNCEMENT_PREFIX.length);
    const lan = rest.indexOf(LAN_SUFFIX);
    if (lan >= 0) {
      // The LAN address never becomes the WebView target, but a truncated or
      // malformed suffix must not be accepted as a local announcement either.
      if (!rest.endsWith(')')) {
        return '';
      }
      rest = rest.slice(0, lan);
    }
  }
  const match = LOOPBACK_URL.exec(rest);
  if (match === null || Number(match[1]) > 65535) {
    return '';
  }
  return rest;
}

/** Accepts explicit IP loopback HTTP authorities only; no DNS, credentials or scheme ambiguity. */
export function loopbackOrigin(address: string): string {
  if (/[\x00-\x20\x7f\\]/.test(address)) {
    return '';
  }
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(?=\/|[?#]|$)/.exec(address);
  if (match === null || Number(match[2]) > 65535) {
    return '';
  }
  return match[0];
}
