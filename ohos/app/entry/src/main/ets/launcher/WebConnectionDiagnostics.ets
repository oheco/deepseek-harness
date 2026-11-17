import { connectionDiagnostic, ConnectionDiagnosticFields } from './ConnectionDiagnostics';

const CONSOLE_PREFIX: string = '__DSH_CONNECTION_DIAGNOSTIC_V1__';

interface WebDiagnosticRecord extends ConnectionDiagnosticFields {
  kind: number;
}

/** Observe only DSH's mux before page scripts run; never inspect URLs, payloads or free-form reasons. */
export const WEB_CONNECTION_DIAGNOSTIC_SCRIPT: string = `(() => {
  if (window.top !== window || window.__dshConnectionDiagnosticInstalled) return;
  window.__dshConnectionDiagnosticInstalled = true;
  const prefix = '__DSH_CONNECTION_DIAGNOSTIC_V1__';
  const output = console.info.bind(console);
  const emit = (kind, fields = {}) => {
    try { output(prefix + JSON.stringify({ kind, ...fields })); } catch (error) { /* observation only */ }
  };
  const clock = () => Math.round(performance.now());
  let readOnline = () => navigator.onLine;
  for (let owner = navigator; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'onLine');
    if (descriptor && typeof descriptor.get === 'function') {
      readOnline = () => Reflect.apply(descriptor.get, navigator, []);
      break;
    }
  }
  const reasonCode = reason => {
    if (!reason) return 0;
    if (reason === 'reconnect requested') return 1;
    if (reason === 'invalid Remote stream frame') return 2;
    if (reason === 'Remote stream failure could not be delivered') return 3;
    if (reason === 'peer disposed') return 4;
    return 5;
  };
  const environment = kind => emit(kind, { online: readOnline(), hidden: document.hidden });
  environment(1);
  window.addEventListener('online', () => environment(9), true);
  window.addEventListener('offline', () => environment(10), true);
  window.addEventListener('pageshow', () => environment(12), true);
  window.addEventListener('pagehide', () => environment(11), true);
  document.addEventListener('visibilitychange', () => environment(8), true);
  let sequence = 0;
  const Original = window.WebSocket;
  try {
    window.WebSocket = new Proxy(Original, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        let mux = false;
        try {
          const address = new URL(socket.url);
          const protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
          mux = protocol + '//' + address.host === location.origin && address.pathname === '/api/remote.mux';
        } catch (error) { /* an unclassified socket is left alone */ }
        if (!mux) return socket;
        const id = ++sequence;
        const openedAt = clock();
        let lastMessageAt = openedAt;
        let sampledAt = openedAt;
        let received = 0, sent = 0, totalChars = 0, maxChars = 0;
        const snapshot = () => ({ socket: id, readyState: socket.readyState, ageMs: clock() - openedAt,
          lastMessageMs: clock() - lastMessageAt, received, sent, totalChars, maxChars,
          online: readOnline(), hidden: document.hidden });
        emit(14, snapshot());
        socket.addEventListener('open', () => emit(2, snapshot()));
        socket.addEventListener('error', () => emit(3, snapshot()));
        socket.addEventListener('close', event => emit(4, { ...snapshot(), code: event.code,
          clean: event.wasClean, reason: reasonCode(event.reason) }));
        socket.addEventListener('message', event => {
          received++;
          lastMessageAt = clock();
          const chars = typeof event.data === 'string' ? event.data.length : 0;
          const bytes = event.data instanceof ArrayBuffer ? event.data.byteLength :
            (event.data instanceof Blob ? event.data.size : 0);
          totalChars += chars;
          maxChars = Math.max(maxChars, chars);
          if (chars >= 262144 || bytes >= 262144) emit(7, { ...snapshot(), chars, bytes });
          else if (clock() - sampledAt >= 5000) { sampledAt = clock(); emit(6, snapshot()); }
        });
        const send = socket.send;
        socket.send = function () {
          const result = Reflect.apply(send, this, arguments);
          if (this === socket) sent++;
          return result;
        };
        const close = socket.close;
        socket.close = function () {
          if (this === socket) emit(5, { ...snapshot(), code: typeof arguments[0] === 'number' ? arguments[0] : 0,
            reason: reasonCode(arguments[1]) });
          return Reflect.apply(close, this, arguments);
        };
        return socket;
      }
    });
  } catch (error) { emit(13); }
})();`;

function webEvent(kind: number): string {
  switch (kind) {
    case 1: return 'web.observer_ready';
    case 2: return 'web.ws_open';
    case 3: return 'web.ws_error';
    case 4: return 'web.ws_closed';
    case 5: return 'web.ws_close_requested';
    case 6: return 'web.ws_summary';
    case 7: return 'web.ws_large_message';
    case 8: return 'web.visibility';
    case 9: return 'web.online';
    case 10: return 'web.offline';
    case 11: return 'web.page_hidden';
    case 12: return 'web.page_shown';
    case 13: return 'web.observer_failed';
    case 14: return 'web.ws_created';
    default: return '';
  }
}

/** Decode only bounded numeric observer records; ordinary page console output is never persisted. */
export function recordWebConnectionDiagnostic(message: string, generation: number, current: boolean): void {
  if (!message.startsWith(CONSOLE_PREFIX) || message.length > 2048) { return; }
  let record: WebDiagnosticRecord;
  try {
    record = JSON.parse(message.slice(CONSOLE_PREFIX.length)) as WebDiagnosticRecord;
  } catch (error) {
    return;
  }
  if (!record || !Number.isSafeInteger(record.kind)) { return; }
  const event = webEvent(record.kind);
  if (event === '') { return; }
  connectionDiagnostic(event, { generation: generation, current: current, code: record.code, clean: record.clean,
    reason: record.reason, socket: record.socket, readyState: record.readyState, ageMs: record.ageMs,
    lastMessageMs: record.lastMessageMs, online: record.online, hidden: record.hidden,
    received: record.received, sent: record.sent, chars: record.chars, bytes: record.bytes,
    totalChars: record.totalChars, maxChars: record.maxChars });
}
