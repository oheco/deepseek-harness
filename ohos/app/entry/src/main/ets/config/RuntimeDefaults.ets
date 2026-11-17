// Generated connection defaults; only --web-launcher selects a local runtime override.
export class RuntimeDefaults {
  static homeDir: string = "/storage/Users/currentUser";
  static runLogName: string = "dsh-0.2.1-run.log";
  static runCommand: string = "DSH_HOME=\"${XDG_CONFIG_HOME:?}/deepseek-harness\" dsh web --host 127.0.0.1 --port 0 --no-open > /storage/Users/currentUser/Documents/dsh-0.2.1-run.log 2>&1 &";
}
