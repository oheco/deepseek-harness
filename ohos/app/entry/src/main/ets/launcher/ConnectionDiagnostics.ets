import native from 'libdsh_launcher.so';

/** Only numeric measurements and flags cross into the persistent diagnostic journal. */
export interface ConnectionDiagnosticFields {
  operation?: number;
  channel?: number;
  /** Channel of another window that a switch brings forward. */
  targetChannel?: number;
  generation?: number;
  remote?: boolean;
  attached?: boolean;
  visible?: boolean;
  current?: boolean;
  initialAuthentication?: boolean;
  elapsedMs?: number;
  code?: number;
  errorType?: number;
  status?: number;
  chars?: number;
  bytes?: number;
  count?: number;
  expired?: number;
  phase?: number;
  state?: number;
  recovered?: boolean;
  online?: boolean;
  hidden?: boolean;
  clean?: boolean;
  socket?: number;
  readyState?: number;
  ageMs?: number;
  lastMessageMs?: number;
  totalChars?: number;
  maxChars?: number;
  received?: number;
  sent?: number;
  reason?: number;
}

interface DiagnosticFailure extends Error {
  code?: number | string;
}

let operationCounter: number = 0;

/** Correlate one selection or explicit disconnect without logging its saved identity. */
export function nextDiagnosticOperation(): number {
  operationCounter += 1;
  return operationCounter;
}

/** Configure the App-private journal before its first page or broker operation. */
export function initializeConnectionDiagnostics(filesDir: string): void {
  native.configureConnectionDiagnostics(filesDir + '/connection-diagnostics');
  connectionDiagnostic('app.diagnostics_ready', { phase: 1 });
}

function numericField(name: string, value: number | boolean | undefined): string {
  if (value === undefined) { return ''; }
  const numberValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  if (!Number.isSafeInteger(numberValue)) { return ''; }
  return ' ' + name + '=' + numberValue.toString();
}

/** Append fixed event names and numeric fields; a failed logger cannot change connection behavior. */
export function connectionDiagnostic(event: string, fields: ConnectionDiagnosticFields = {}): void {
  const values = numericField('operation', fields.operation) + numericField('channel', fields.channel) +
    numericField('targetChannel', fields.targetChannel) + numericField('generation', fields.generation) +
    numericField('remote', fields.remote) + numericField('attached', fields.attached) +
    numericField('visible', fields.visible) + numericField('current', fields.current) +
    numericField('initialAuthentication', fields.initialAuthentication) + numericField('elapsedMs', fields.elapsedMs) +
    numericField('code', fields.code) + numericField('errorType', fields.errorType) + numericField('status', fields.status) +
    numericField('chars', fields.chars) + numericField('bytes', fields.bytes) + numericField('count', fields.count) +
    numericField('expired', fields.expired) + numericField('phase', fields.phase) + numericField('state', fields.state) +
    numericField('recovered', fields.recovered) + numericField('online', fields.online) + numericField('hidden', fields.hidden) +
    numericField('clean', fields.clean) + numericField('socket', fields.socket) + numericField('readyState', fields.readyState) +
    numericField('ageMs', fields.ageMs) + numericField('lastMessageMs', fields.lastMessageMs) +
    numericField('totalChars', fields.totalChars) + numericField('maxChars', fields.maxChars) +
    numericField('received', fields.received) + numericField('sent', fields.sent) + numericField('reason', fields.reason);
  try {
    native.writeConnectionDiagnostic(event, values.trim());
  } catch (error) {
    // Logging is observational; the viewer reports a journal that cannot be read.
  }
}

/** Preserve platform error numbers and fixed native categories, never an error message or stack. */
export function diagnosticFailureCode(error: Error): number {
  const code = (error as DiagnosticFailure)?.code;
  if (typeof code === 'number' && Number.isSafeInteger(code)) { return code; }
  switch (code) {
    case 'DSH_BROKER': return -1;
    case 'DSH_BROKER_AUTH': return -2;
    default: return 0;
  }
}

/** Log an exception without copying messages that may contain URLs or credentials. */
export function connectionDiagnosticFailure(event: string, error: Error, fields: ConnectionDiagnosticFields = {}): void {
  fields.code = diagnosticFailureCode(error);
  switch (error?.name) {
    case 'TypeError': fields.errorType = 1; break;
    case 'RangeError': fields.errorType = 2; break;
    case 'ReferenceError': fields.errorType = 3; break;
    case 'BusinessError': fields.errorType = 4; break;
    default: fields.errorType = 0; break;
  }
  connectionDiagnostic(event, fields);
}

/** Stable broker-state numbers used by the file viewer and the native journal. */
export function diagnosticBrokerState(state: string): number {
  switch (state) {
    case 'idle': return 0;
    case 'connecting': return 1;
    case 'connected': return 2;
    case 'reconnecting': return 3;
    case 'retry_wait': return 4;
    case 'paused': return 5;
    case 'failed': return 6;
    case 'closed': return 7;
    default: return -1;
  }
}
