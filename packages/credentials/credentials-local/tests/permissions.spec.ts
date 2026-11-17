import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '../src/index.ts'

const boundary = vi.hoisted(() => ({
  filename: '',
  mode: 0o600,
  watcher: undefined as import('node:events').EventEmitter | undefined,
}))

// Emulate modes hmdfs cannot represent, while keeping parsing, locking, and writes real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>) {
      const info = await actual.stat(...args)
      if (String(args[0]) === boundary.filename) {
        const mode = 0o100000 | boundary.mode
        info.mode = typeof info.mode === 'bigint' ? BigInt(mode) : mode
      }
      return info
    },
  }
})

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    watch: () => {
      const watcher = new EventEmitter()
      Object.assign(watcher, { close: async () => { watcher.removeAllListeners() } })
      boundary.watcher = watcher
      return watcher
    },
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const cleanups: Array<() => Promise<void>> = []
const KEY = credentialRef('DSH_MODE_KEY')
const RECORD = credentialKey('mode-test', 'record')
const document = (value: string) => `version: 1\nrefs:\n  ${KEY}: ${value}\nrecords:\n  ${RECORD}:\n    kind: api-key\n    key: record-value\n`

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  Object.defineProperty(process, 'platform', originalPlatform)
  boundary.filename = ''
  boundary.watcher = undefined
  vi.restoreAllMocks()
})

async function setup(platform: string, mode: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-credential-modes-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, '.credentials.yaml')
  await writeFile(path, document('initial'), { mode: 0o600 })
  boundary.filename = path
  boundary.mode = mode
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return path
}

async function boot(path: string, watch = false): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path, watch })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('credential document permissions', () => {
  it.each(['linux', 'darwin', 'freebsd', 'openharmony'])('retains the existing owner-only acceptance range on %s', async (platform) => {
    const path = await setup(platform, 0o400)
    // Owner execute and special bits were already accepted when group/other bits were zero.
    for (const mode of [0o400, 0o600, 0o700, 0o4600]) {
      boundary.mode = mode
      const ctx = await boot(path)
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'initial', source: 'file' })
    }
  })

  it.each(['linux', 'darwin', 'freebsd'])('continues rejecting 0660 on %s', async (platform) => {
    const path = await setup(platform, 0o660)
    await expect(boot(path)).rejects.toThrow(/readable beyond its owner \(mode 660\)/)
    expect(await readFile(path, 'utf8')).toBe(document('initial'))
  })

  it.each(['linux', 'darwin', 'freebsd'])('rejects 0660 after startup on %s during reload and writes', async (platform) => {
    const path = await setup(platform, 0o600)
    const ctx = await boot(path, true)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    boundary.mode = 0o660
    await writeFile(path, document('refused'))
    boundary.watcher!.emit('all', 'change', path)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('reload failed'), path) })
    await expect(ctx.credentials.set(KEY, 'refused-write')).rejects.toThrow(/readable beyond its owner/)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'initial', source: 'file' })
    expect(await readFile(path, 'utf8')).toBe(document('refused'))
  })

  it('retains the Windows mode-check bypass', async () => {
    const path = await setup('win32', 0o666)
    expect(await (await boot(path)).credentials.resolve(KEY)).toEqual({ value: 'initial', source: 'file' })
  })

  it('boots and writes references and records from HarmonyOS 0660, still requesting 0600', async () => {
    const path = await setup('openharmony', 0o660)
    const ctx = await boot(path)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'initial', source: 'file' })
    await ctx.credentials.set(KEY, 'saved')
    await ctx.credentials.modifyRecord(RECORD, async () => ({ kind: 'api-key', key: 'rotated' }))
    expect(await readFile(path, 'utf8')).toContain(`${KEY}: saved`)
    expect(await ctx.credentials.readRecord(RECORD)).toEqual({ kind: 'api-key', key: 'rotated' })
    // Ignore only this spec's stat-mode override when observing the actual created mode.
    boundary.filename = ''
    if (originalPlatform.value !== 'win32') expect((await stat(path)).mode & 0o7777).toBe(0o600)
    boundary.filename = path
    await ctx.credentials.unset(KEY)
    await ctx.credentials.deleteRecord(RECORD)
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    expect(await ctx.credentials.readRecord(RECORD)).toBeUndefined()
    expect(await (await boot(path)).credentials.readRecord(RECORD)).toBeUndefined()
  })

  it('creates a missing HarmonyOS document at 0600 and reads it again', async () => {
    const path = await setup('openharmony', 0o660)
    await rm(path)
    const ctx = await boot(path)
    await ctx.credentials.set(KEY, 'new-document')
    boundary.filename = ''
    if (originalPlatform.value !== 'win32') expect((await stat(path)).mode & 0o7777).toBe(0o600)
    boundary.filename = path
    expect(await (await boot(path)).credentials.resolve(KEY)).toEqual({ value: 'new-document', source: 'file' })
  })

  it('migrates the recognized flat document from HarmonyOS 0660 without losing its value', async () => {
    const path = await setup('openharmony', 0o660)
    await writeFile(path, `# saved note\n${KEY}: legacy-value\n`)
    const ctx = await boot(path)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'legacy-value', source: 'file' })
    expect(await readFile(path, 'utf8')).toBe(`version: 1\nrefs:\n  # saved note\n  ${KEY}: legacy-value\n`)
  })

  it.each([0o640, 0o644, 0o666, 0o670, 0o1660, 0o2660, 0o4660])('rejects HarmonyOS mode %o at boot and before every writer', async (mode) => {
    const path = await setup('openharmony', mode)
    await expect(boot(path)).rejects.toThrow(/readable beyond its owner/)
    boundary.mode = 0o660
    const ctx = await boot(path)
    boundary.mode = mode
    const mutate = vi.fn(async () => ({ kind: 'api-key' as const, key: 'refused' }))
    await expect(ctx.credentials.set(KEY, 'refused')).rejects.toThrow(/readable beyond its owner/)
    await expect(ctx.credentials.unset(KEY)).rejects.toThrow(/readable beyond its owner/)
    await expect(ctx.credentials.modifyRecord(RECORD, mutate)).rejects.toThrow(/readable beyond its owner/)
    await expect(ctx.credentials.deleteRecord(RECORD)).rejects.toThrow(/readable beyond its owner/)
    expect(mutate).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(document('initial'))
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'initial', source: 'file' })
  })

  it.each(['all', 'ready'])('accepts HarmonyOS 0660 on %s reload, keeps the last good value after rejection, and recovers', async (event) => {
    const path = await setup('openharmony', 0o600)
    const ctx = await boot(path, true)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const updates: string[] = []
    ctx.on('credentials/reference-updated', (ref) => { updates.push(ref) })
    boundary.mode = 0o660
    await writeFile(path, document('reloaded'))
    boundary.watcher!.emit(event, 'change', path)
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'reloaded', source: 'file' })
    })
    for (const mode of [0o644, 0o666, 0o2660]) {
      boundary.mode = mode
      await writeFile(path, document('refused'))
      warn.mockClear()
      boundary.watcher!.emit(event, 'change', path)
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('reload failed'), path) })
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'reloaded', source: 'file' })
      expect(updates).toEqual([KEY])
    }
    boundary.mode = 0o660
    await writeFile(path, document('recovered'))
    boundary.watcher!.emit(event, 'change', path)
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'recovered', source: 'file' })
    })
    expect(updates).toEqual([KEY, KEY])
  })
})
