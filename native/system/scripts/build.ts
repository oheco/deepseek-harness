/**
 * Build this host's declared system binaries. Landlock is a static musl
 * executable; flock uses stable Node-API with separate Linux libc builds.
 * Node headers come from the Node installation running this script.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { 'host-addon-only': { type: 'boolean' } }, allowPositionals: false })
const hostAddonOnly = values['host-addon-only'] === true
const sources: Record<string, string> = {
  'landlock-run': 'packages/entry/src/main.c',
  flock: 'packages/entry/src/flock.c',
}

interface Binary {
  tool: string
  kind: string
  path: string
  napi?: number
  libc?: string
}

const platform: string = process.platform
if (platform !== 'linux' && platform !== 'darwin' && platform !== 'openharmony') {
  if (hostAddonOnly) process.exit(0)
  throw new Error('build: system binaries are built on Linux, macOS or HarmonyOS; no native target for this host')
}
const host = `${platform}-${process.arch}`
const libc = platform === 'linux'
  ? ((process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? 'glibc' : 'musl')
  : undefined
const headers = resolve(dirname(process.execPath), '../include/node')
let built = 0

for (const name of readdirSync(join(root, 'packages')).sort()) {
  const dir = join(root, 'packages', name)
  const metadata = join(dir, 'prebuilds.json')
  if (!existsSync(metadata)) continue
  const spec = JSON.parse(readFileSync(metadata, 'utf8')) as { platform: string; binaries: Binary[] }
  if (spec.platform !== host) continue

  for (const binary of spec.binaries) {
    if (hostAddonOnly && (binary.kind !== 'node-api' || (binary.libc !== undefined && binary.libc !== libc))) continue
    const source = sources[binary.tool]
    if (source === undefined) throw new Error(`build: unknown tool ${binary.tool}`)
    const output = join(dir, binary.path)
    mkdirSync(dirname(output), { recursive: true })
    let compiler: string
    let flags: string[]

    if (binary.kind === 'static-musl' && platform === 'linux' && binary.tool === 'landlock-run') {
      compiler = 'musl-gcc'
      flags = ['-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-static', '-s']
    } else if (binary.kind === 'node-api' && binary.tool === 'flock' && binary.napi === 8) {
      if (!existsSync(join(headers, 'node_api.h'))) {
        throw new Error(`build: Node-API headers missing at ${headers}; use a Node installation with development headers`)
      }
      compiler = platform === 'linux' && binary.libc === 'musl' ? 'musl-gcc' : platform === 'openharmony' ? 'clang' : 'cc'
      flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', headers]
      if (platform !== 'linux' && binary.libc !== undefined) {
        throw new Error('build: non-Linux flock must not select a Linux libc')
      }
      if (platform === 'darwin') {
        flags.push('-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=11.0')
      } else {
        if (platform === 'linux' && binary.libc !== 'glibc' && binary.libc !== 'musl') {
          throw new Error('build: Linux flock must select glibc or musl')
        }
        flags.push('-shared')
      }
    } else {
      throw new Error(`build: unsupported ${binary.tool}/${binary.kind} target on ${host}`)
    }

    const temporary = mkdtempSync(join(tmpdir(), 'native-build-'))
    const pending = join(dirname(output), `.${basename(output)}.${randomUUID()}.pending`)
    try {
      const compiled = join(temporary, basename(output))
      const extraSources = platform === 'openharmony' && binary.kind === 'node-api'
        ? ['-pthread', join(root, 'packages/entry/src/exclusive-file.c')]
        : []
      const result = spawnSync(compiler, [...flags, '-o', compiled, join(root, source), ...extraSources], { stdio: 'inherit' })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`build: ${compiler} failed for ${binary.path}`)
      let payload = compiled
      if (platform === 'openharmony') {
        const unsigned = compiled + '.unsigned'
        const stripped = spawnSync('llvm-objcopy', ['--remove-section=.codesign', compiled, unsigned], { stdio: 'inherit' })
        if (stripped.error) throw new Error('build: llvm-objcopy could not run; check the LLVM tools PATH', { cause: stripped.error })
        if (stripped.status !== 0) throw new Error('build: HarmonyOS addon signature normalization failed')
        payload = compiled + '.signed'
        const signature = spawnSync('binary-sign-tool', ['sign', '-inFile', unsigned, '-outFile', payload, '-selfSign', '1'], { stdio: 'inherit' })
        if (signature.error) throw new Error('build: binary-sign-tool could not run; check the LLVM tools PATH', { cause: signature.error })
        if (signature.status !== 0) throw new Error('build: HarmonyOS addon signing failed')
      }
      // TMPDIR may be on another filesystem. Copy fully before the same-directory
      // rename, so concurrent readers never see a truncated or unsigned addon.
      copyFileSync(payload, pending, constants.COPYFILE_EXCL)
      renameSync(pending, output)
    } finally {
      try {
        rmSync(pending, { force: true })
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    }
    console.log(`build: built ${basename(dir)}/${binary.path}`)
    built++
  }
}
if (built === 0) throw new Error(`build: no declared binaries for ${host}`)
