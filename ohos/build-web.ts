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
import { libraryBuildSteps } from '../scripts/compile-referenced-projects.ts'

const root = resolve(import.meta.dirname, '..')
const client = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, process.env), 'official')
const env = clientBuildProcessEnvironment(process.env, client)
function execute(command: string, args: readonly string[], label: string): void {
  console.log(`HarmonyOS build: ${label}`)
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`HarmonyOS build failed: ${label} (${result.status ?? result.signal})`)
}
function run(args: string[]): void {
  const invocation = pnpmInvocation(args, env)
  execute(invocation.command, invocation.args, args.join(' '))
}
rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
run(['run', 'build:native-system'])
for (const step of libraryBuildSteps(root, 'all')) {
  if (step.id === 'desktop-bundle') continue
  execute(step.command, step.args, step.label)
}
run(['run', 'build:web'])
const record = writeClientBuildRecord(root, client)
console.log(`HarmonyOS Web build: ${record.artifacts.fileCount} client artifacts; desktop bundle excluded`)
