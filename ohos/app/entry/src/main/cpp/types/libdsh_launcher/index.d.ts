/** Explicit launch inputs; no terminal environment or API credentials are inherited. */
export interface LaunchConfig {
  nodePath: string;
  dshEntry: string;
  homeDir: string;
  workDir: string;
  /** Dedicated application-private directory: created/verified owner-only 0700. */
  filesDir: string;
  /** Dedicated application-private directory, not the system-created cache root. */
  cacheDir: string;
  /** Dedicated application-private directory, not the system-created temp root. */
  tempDir: string;
  /** Integer 0..65535; zero accepts the actual ephemeral port announced by DSH. */
  port: number;
  /** Required integer 1..86400000 milliseconds; includes preparation time. */
  startupTimeoutMs: number;
}

/** A bounded in-memory copy. Never persist, print, or report url: it contains a token. */
export interface LaunchSnapshot {
  /** idle | starting | ready | stopping | stopped | error */
  state: string;
  /** Only a fully validated loopback URL while ready; cleared on stop or exit. */
  url: string;
  message: string;
  /** At most 16 KiB; arbitrary child text is withheld, not keyword-filtered. */
  logs: string;
  /** Owned child PID while active; zero before fork and after reap. */
  pid: number;
  /** -1 before exit or when no child was created; signals use 128 + signal. */
  exitCode: number;
}

/** The device capability report produced by probe(). */
export interface ProbeSnapshot {
  /** True while the native worker is still running its checks. */
  running: boolean;
  /**
   * At most 8 KiB of printable-ASCII lines, each starting with `OK `, `FAIL `, or
   * `INFO `, and every `http(s)://…` run replaced by `[URL redacted]`. Command
   * output contributes only its first line, cleaned and cut to 120 characters.
   */
  report: string;
}

/** HTTPS broker control service verified with HarmonyOS system roots and hostname. */
export interface BrokerServiceOptions {
  /** HTTPS origin without credentials, path or query; supplied by the user. */
  serviceUrl: string;
  /** context.tempDir + '/dsh-broker'; verified private 0700, fixed for all requests in this process. */
  tempDir: string;
  /** App filesDir + '/dsh-broker-auth'; native verifies a real private 0700 directory. */
  credentialDir: string;
}
export interface BrokerLoginOptions extends BrokerServiceOptions {
  account: string;
  password: string;
}
/** Refresh authority is persisted natively; launcher preferences retain only its session reference. */
export interface BrokerLoginResult {
  /** Empty for managed login; retained only for version-one launcher migration. */
  accessToken: string;
  authSessionId: string;
  tokenType: 'Bearer';
}
export interface BrokerListOptions extends BrokerServiceOptions {
  /** Version-one static bearer; empty when authSessionId references managed credentials. */
  accessToken: string;
  authSessionId: string;
}
/** Approved/connectable status is determined during peer setup, not listing. */
export interface BrokerInfo {
  id: string;
  name: string;
  online: boolean;
}
export interface BrokerConnectOptions extends BrokerListOptions {
  brokerId: string;
  /** Required broker peer password, independent of account password and DSH token. */
  peerPassword: string;
  /** Integer 1..65535; the target is fixed to remote 127.0.0.1. */
  remotePort: number;
  /** Prefer the saved listener; zero allocates its first port. Local bind failure falls back to zero. */
  localPort: number;
}
/** URL is unauthenticated; callers append the separate DSH token for WebView login. */
export interface BrokerStatus {
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'retry_wait' | 'paused' | 'failed' | 'closed';
  /** SDK-owned http://127.0.0.1:<local-port>/ retained through outages and paused retries until explicit close. */
  localUrl: string;
  localPort: number;
  brokerId: string;
  remotePort: number;
  /** Fixed redacted diagnostic; never includes credentials or wire responses. */
  error: string;
  /** DSH_BROKER_AUTH for account authorization failures (HTTP 401/403); otherwise empty. */
  errorCode: string;
}
export interface DshProbeOptions {
  /** Exact numeric http://127.0.0.1:<port> origin; no path or query. */
  origin: string;
  /** Independent DSH authentication token. Never persisted by native code. */
  token: string;
}
export interface DshProbeResult {
  state: 'ok' | 'unauthorized' | 'forbidden' | 'unreachable' | 'not-dsh';
  httpStatus: number;
}

/** Asynchronous process supervisor. Methods perform no filesystem or child waits. */
interface DshLauncher {
  /** Initialize a 0700 App-private directory containing at most two 1 MiB diagnostic files. */
  configureConnectionDiagnostics(directory: string): void;
  /** Append fixed event names and space-separated integer fields; reject free-form text or secrets. */
  writeConnectionDiagnostic(event: string, fields: string): void;
  /** Read older then current journal, bounded to 2 MiB; errors contain no private path or payload. */
  readConnectionDiagnostics(): string;
  /** Persist refresh credentials in credentialDir before returning a managed session reference; never log credentials. */
  brokerLogin(options: BrokerLoginOptions): Promise<BrokerLoginResult>;
  /** List brokers using native refresh authority or an unexpired legacy bearer; terminal account expiry rejects with DSH_BROKER_AUTH. */
  brokerList(options: BrokerListOptions): Promise<BrokerInfo[]>;
  /** Create a persistent peer and preferred-or-random listener; wait for initial authentication and return its actual local port. */
  brokerConnect(options: BrokerConnectOptions): Promise<BrokerStatus>;
  /** Wake a paused SDK peer without replacing its map; acceptance returns current state, completion is observed through brokerStatus. */
  brokerReconnect(): Promise<BrokerStatus>;
  /** Cancel initial connection waiting and queued work; settle after map/peer/API quiescence. Management REST waits on its deadline. */
  brokerClose(): Promise<void>;
  /** Read the SDK's recovery state on the owner worker; outages retain handles and the numeric loopback URL. */
  brokerStatus(): Promise<BrokerStatus>;
  /** Fresh cookie jar; token303 exchange and same-origin homepage __DSH_BOOT__ check. */
  dshProbe(options: DshProbeOptions): Promise<DshProbeResult>;
  /** Enqueue startup; throws on invalid fields or an active/terminating run. */
  start(config: LaunchConfig): void;
  /**
   * Start the read-only capability checks for the same paths on a separate probe
   * worker; returns without waiting. The probe never starts DSH, never touches the
   * supervised child, and may run while a launch is active. Throws on invalid
   * fields or while a probe is already running; a new call replaces the previous
   * report and may wait for that probe's in-flight check.
   */
  probe(config: LaunchConfig): void;
  /** Copy the probe report without waiting; throws before the first probe() call. */
  probeSnapshot(): ProbeSnapshot;
  /** Copy current state without waiting for child I/O or reaping. */
  snapshot(): LaunchSnapshot;
  /** Request TERM, then bounded KILL. Idempotent; stopping lasts until reap. */
  stop(): void;
}

declare const launcher: DshLauncher;
export default launcher;
