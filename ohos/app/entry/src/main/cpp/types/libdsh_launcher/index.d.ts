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

/** Asynchronous process supervisor. Methods perform no filesystem or child waits. */
interface DshLauncher {
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
