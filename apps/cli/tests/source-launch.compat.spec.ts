import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { testProfileResolution } from './profiles/headless/tests/profile-resolution.ts'

/**
 * Keyless source-launch and profile-resolution checks through the production
 * tsx ESM-only entry. The Node compatibility matrix runs this file without a
 * build; source tool execution with native/generated dependencies belongs to
 * the build-backed source-tool suite.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  testProfileResolution('src')

  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.dsh).toBe('node --import tsx/esm apps/cli/src/bin.ts')
  })

  it('reports its own package release when the runtime compatibility version differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cli-version-'))
    const modules = join(root, 'node_modules')
    let modulesLinked = false
    try {
      const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string
      }
      const compatibilityVersion = getDshRuntimeVersion()
      const releaseVersion = `${manifest.version}-display-fixture`
      expect(releaseVersion).not.toBe(compatibilityVersion)
      await mkdir(join(root, 'src'))
      for (const filename of ['bin.ts', 'args.ts', 'startup-diagnostics.ts']) {
        await copyFile(new URL(`../src/${filename}`, import.meta.url), join(root, 'src', filename))
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: releaseVersion }))
      await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), modules, 'junction')
      modulesLinked = true
      const loaderFlags = (process.platform as string) === 'openharmony' ? ['--expose-internals'] : []
      const result = await execa(process.execPath, [
        ...loaderFlags, '--import', import.meta.resolve('tsx/esm'), join(root, 'src/bin.ts'), '--version',
      ], {
        cwd: root,
        env: {
          TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'), NODE_OPTIONS: undefined, NODE_PATH: undefined,
          DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
        },
        input: '', timeout: 25_000, killSignal: 'SIGKILL', reject: false,
      })
      expect(result.timedOut).toBe(false)
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toBe(releaseVersion)
      expect(result.stderr).toBe('')
      expect(getDshRuntimeVersion()).toBe(compatibilityVersion)
    } finally {
      if (modulesLinked) await unlink(modules)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('boots the source entry and requires a profile', async () => {
    // HarmonyOS resolves Node internals through this flag because no native
    // require-builtin addon exists for it; the launcher passes it in production.
    const loaderFlags = (process.platform as string) === 'openharmony' ? ['--expose-internals'] : []
    const result = await execa(process.execPath, [...loaderFlags, '--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--profile <name> is required')
    expect(result.stdout).toBe('')
  }, 30_000)
})
