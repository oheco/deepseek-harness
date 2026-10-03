/** Independent local Web connection; regenerate with package-app-project.py when paths move. */
export class RuntimeDefaults {
  static homeDir: string = '/storage/Users/currentUser';
  static runLogName: string = 'dsh-0.2.0-run.log';
  static runCommand: string = 'zsh /storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-local/run-web.zsh > /storage/Users/currentUser/Documents/dsh-0.2.0-run.log 2>&1 &';
}
