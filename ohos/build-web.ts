/** Build the upstream Host, Client and Web artifacts without the desktop bundle. */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLIENT_BUILD_RECORD_PATH,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from '../scripts/client-build-environment.ts'
import { pnpmInvocation } from '../scripts/pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')
const client = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, process.env), 'official')
const env = clientBuildProcessEnvironment(process.env, client)
function run(args: string[]): void {
  const invocation = pnpmInvocation(args, env)
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Web build failed: ${args.join(' ')} (${result.status ?? result.signal})`)
}
rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
run(['run', 'build:native-system'])
run(['exec', 'tsc', '-b', 'tsconfig.host.json'])
run(['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'host'])
run(['run', 'build:lib:client'])
run(['run', 'build:web'])
const record = writeClientBuildRecord(root, client)
console.log(`HarmonyOS Web build: ${record.artifacts.fileCount} client artifacts; desktop bundle excluded`)
