import url from '@ohos.url';

/** Connection modes persisted by the launcher, independent of Web page state. */
export enum ConnectionMode {
  Local = 'local',
  Remote = 'remote'
}

/** Broker network path for a remote connection; values match the SDK relay modes. */
export enum RelayMode {
  /** Try a direct peer path first and relay when traversal fails. */
  Auto = 'auto',
  /** Never relay; traversal failure fails the connection. */
  Never = 'never',
  /** Relay every packet through the service's TURN server; no direct fallback. */
  Force = 'force'
}

/** A saved connection contains only the settings needed to reopen that service. */
export class ConnectionProfile {
  id: string = '';
  name: string = '';
  mode: ConnectionMode = ConnectionMode.Local;
  port: number = 3080;
  token: string = '';
  serviceUrl: string = '';
  account: string = '';
  accessToken: string = '';
  /** Native private credential journal reference; new logins keep token material outside preferences. */
  authSessionId: string = '';
  /** Last successful loopback listener; zero asks the OS to allocate its first port. */
  localPort: number = 0;
  brokerId: string = '';
  brokerName: string = '';
  peerPassword: string = '';
  /** Remote network path; local connections keep Auto. Records saved before this field read as Auto. */
  relayMode: RelayMode = RelayMode.Auto;
}

/** Versioned launcher preferences; these records do not modify DSH Session data. */
export class ConnectionDocument {
  version: number = 2;
  connections: ConnectionProfile[] = [];
}

/** Returns a concrete TCP port, or zero for invalid input. */
export function connectionPort(value: string): number {
  if (!/^[0-9]{1,5}$/.test(value)) {
    return 0;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : 0;
}

/** Accepts the HTTPS service origin consumed by the native broker bridge. */
export function serviceOrigin(value: string): string {
  const raw = value.trim();
  if (raw === '' || /[\x00-\x20\x7f\\]/.test(raw)) {
    return '';
  }
  try {
    const parsed = new url.URL(raw.includes('://') ? raw : 'https://' + raw);
    if (parsed.protocol !== 'https:' ||
      parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' ||
      (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.port === '0') {
      return '';
    }
    return parsed.origin;
  } catch (error) {
    // Invalid service addresses cannot become a broker credential destination.
    return '';
  }
}

/** Builds a token exchange URL without treating user token characters as URL syntax. */
export function connectionUrl(origin: string, token: string): string {
  return origin + '/?token=' + encodeURIComponent(token);
}

function relayMode(value: RelayMode): boolean {
  return value === RelayMode.Auto || value === RelayMode.Never || value === RelayMode.Force;
}

function shortString(value: string, limit: number): boolean {
  return typeof value === 'string' && value.length <= limit && !/[\x00\r\n]/.test(value);
}

/** Rejects incomplete records before saving or loading credentials. */
export function validConnection(value: ConnectionProfile): boolean {
  if (!value || !shortString(value.id, 128) || value.id === '' || !shortString(value.name, 120) ||
    value.name.trim() === '' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    !shortString(value.token, 4096) || value.token.trim() === '') {
    return false;
  }
  if (!Number.isInteger(value.localPort) || value.localPort < 0 || value.localPort > 65535 ||
    !shortString(value.authSessionId, 36) || (value.authSessionId !== '' &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.authSessionId))) {
    return false;
  }
  if (!relayMode(value.relayMode)) {
    return false;
  }
  if (value.mode === ConnectionMode.Local) {
    return value.relayMode === RelayMode.Auto && value.serviceUrl === '' && value.account === '' && value.accessToken === '' &&
      value.authSessionId === '' && value.localPort === 0 &&
      value.brokerId === '' && value.brokerName === '' && value.peerPassword === '';
  }
  return value.mode === ConnectionMode.Remote && shortString(value.serviceUrl, 2048) &&
    serviceOrigin(value.serviceUrl) === value.serviceUrl && shortString(value.account, 256) &&
    value.account.trim() !== '' && shortString(value.accessToken, 4096) &&
    (value.authSessionId !== '' ? value.accessToken === '' : value.accessToken !== '') &&
    shortString(value.brokerId, 128) && value.brokerId !== '' &&
    shortString(value.brokerName, 256) && shortString(value.peerPassword, 4096) && value.peerPassword !== '';
}

/** Migrates bounded version-one preferences; credential journals remain native and App-private. */
export function parseConnections(raw: string): ConnectionProfile[] {
  if (raw === '') {
    return [];
  }
  if (raw.length > 1024 * 1024) {
    throw new Error('connection preferences exceed the supported size');
  }
  const document = JSON.parse(raw) as ConnectionDocument;
  if (!document || (document.version !== 1 && document.version !== 2) || !Array.isArray(document.connections) ||
    document.connections.length > 100) {
    throw new Error('unsupported connection preferences');
  }
  const ids: string[] = [];
  const connections: ConnectionProfile[] = [];
  for (const connection of document.connections) {
    if (!connection) {
      throw new Error('invalid connection preferences');
    }
    const current = new ConnectionProfile();
    current.id = connection.id;
    current.name = connection.name;
    current.mode = connection.mode;
    current.port = connection.port;
    current.token = connection.token;
    current.serviceUrl = connection.serviceUrl;
    current.account = connection.account;
    current.accessToken = connection.accessToken;
    current.brokerId = connection.brokerId;
    current.brokerName = connection.brokerName;
    current.peerPassword = connection.peerPassword;
    // Records written before relay selection omit the field and keep the earlier Auto behavior; null stays invalid.
    current.relayMode = (connection.relayMode as RelayMode | undefined) === undefined ? RelayMode.Auto : connection.relayMode;
    current.authSessionId = document.version === 1 ? '' : connection.authSessionId;
    current.localPort = document.version === 1 ? 0 : connection.localPort;
    if (!validConnection(current) || ids.includes(current.id)) {
      throw new Error('invalid connection preferences');
    }
    ids.push(current.id);
    connections.push(current);
  }
  return connections;
}

/** Encodes the same validated document used at the persistence read boundary. */
export function encodeConnections(connections: ConnectionProfile[]): string {
  const document = new ConnectionDocument();
  document.connections = connections;
  const raw = JSON.stringify(document);
  document.connections = parseConnections(raw);
  return JSON.stringify(document);
}
