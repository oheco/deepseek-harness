import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishNewFileOhos } from '../src/ohos.ts'
import { publishImmutableAlias, publishImmutableObject } from '../src/store.ts'

const fault = vi.hoisted(() => ({ path: '', code: 'EACCES', phase: 'open' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      if (args[1] !== constants.O_RDONLY || String(args[0]) !== fault.path) return actual.open(...args)
      const error = Object.assign(new Error('directory denied'), { code: fault.code })
      if (fault.phase === 'open') throw error
      const handle = await actual.open(...args)
      vi.spyOn(handle, 'sync').mockRejectedValue(error)
      return handle
    },
  }
})

const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'attachment-ohos-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  fault.path = ''
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const bytes = Buffer.from('immutable attachment')
const digest = createHash('sha256').update(bytes).digest('hex')

describe.skipIf(process.platform === 'win32')('HarmonyOS attachment durability', () => {
  it.each(['EACCES', 'EPERM'])('only HarmonyOS tolerates ancestor open %s', async (code) => {
    for (const platform of ['linux', 'openharmony'] as const) {
      const base = await root()
      const storage = join(base, 'home', 'attachments', 'v1')
      fault.path = base
      fault.code = code
      fault.phase = 'open'
      const target = join(storage, 'objects', digest)
      const result = publishImmutableObject(storage, target, bytes, digest, {
        platform, publishNewFile: rename,
      })
      if (platform === 'openharmony') {
        await result
        expect(await readFile(target)).toEqual(bytes)
      } else {
        await expect(result).rejects.toMatchObject({ code })
        await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  })

  it.each(['EACCES', 'EPERM', 'EIO'])('does not relax ancestor fsync %s on HarmonyOS', async (code) => {
    const base = await root()
    fault.path = base
    fault.code = code
    fault.phase = 'sync'
    await expect(publishImmutableObject(join(base, 'home', 'attachments', 'v1'), join(base, 'target'), bytes, digest, {
      platform: 'openharmony', publishNewFile: rename,
    })).rejects.toMatchObject({ code })
  })

  it('does not relax object-directory open denial on HarmonyOS', async () => {
    const storage = join(await root(), 'attachments', 'v1')
    const target = join(storage, 'objects', digest)
    fault.path = storage
    fault.code = 'EACCES'
    fault.phase = 'open'
    await expect(publishImmutableObject(storage, target, bytes, digest, {
      platform: 'openharmony', publishNewFile: rename,
    })).rejects.toMatchObject({ code: 'EACCES' })
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('HarmonyOS staged attachment aliases', () => {
  it('keeps the alias absent until complete staged bytes reach publication', async () => {
    const storage = join(await root(), 'attachments', 'v1')
    const source = join(storage, 'objects', digest)
    const target = join(storage, 'aliases', 'file.txt')
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, bytes)
    const publish = vi.fn(async (stage: string, destination: string) => {
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(stage)).toEqual(bytes)
      expect(await readFile(source)).toEqual(bytes)
      await rename(stage, destination)
    })
    await publishImmutableAlias(storage, source, target, digest, { platform: 'openharmony', publishNewFile: publish })
    expect(publish).toHaveBeenCalledOnce()
    expect(await readFile(target)).toEqual(bytes)
    expect((await stat(target)).ino).not.toBe((await stat(source)).ino)
    expect(await readdir(join(storage, 'tmp'))).toEqual([])
  })

  it('removes staging and leaves no alias after failed publication or corrupt source', async () => {
    const storage = join(await root(), 'attachments', 'v1')
    const source = join(storage, 'source')
    const target = join(storage, 'aliases', 'file.txt')
    await mkdir(storage, { recursive: true })
    await writeFile(source, bytes)
    const publish = vi.fn(async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }) })
    await expect(publishImmutableAlias(storage, source, target, digest, { platform: 'openharmony', publishNewFile: publish }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause: { code: 'ENOTSUP' } })
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(storage, 'tmp'))).toEqual([])
    await expect(publishImmutableAlias(storage, source, target, '0'.repeat(64), { platform: 'openharmony', publishNewFile: publish }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    expect(publish).toHaveBeenCalledOnce()
    expect(await readdir(join(storage, 'tmp'))).toEqual([])
  })
})

describe.skipIf(!['linux', 'openharmony'].includes(process.platform))('native exclusive attachment publication', () => {
  it('refuses existing files and symlinks without consuming staging', async () => {
    const base = await root()
    const stage = join(base, 'stage'), target = join(base, 'target'), alias = join(base, 'link')
    await writeFile(stage, bytes)
    await publishNewFileOhos(stage, target)
    await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(stage, 'competing')
    await symlink('target', alias)
    for (const destination of [target, alias]) {
      await expect(publishNewFileOhos(stage, destination)).rejects.toMatchObject({ code: 'EEXIST', syscall: 'renameat2' })
    }
    expect(await readFile(target)).toEqual(bytes)
    expect(await readFile(stage, 'utf8')).toBe('competing')
    await expect(publishNewFileOhos(join(base, 'missing'), join(base, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deduplicates complete objects and aliases and rejects corrupt existing aliases', async () => {
    const storage = join(await root(), 'attachments', 'v1')
    const source = join(storage, 'objects', digest), target = join(storage, 'aliases', 'name')
    for (let attempt = 0; attempt < 2; attempt++) {
      await publishImmutableObject(storage, source, bytes, digest, { platform: 'openharmony' })
      await publishImmutableAlias(storage, source, target, digest, { platform: 'openharmony' })
    }
    expect(await readFile(target)).toEqual(bytes)
    const bad = join(storage, 'aliases', 'bad')
    await writeFile(bad, 'corrupt')
    await expect(publishImmutableAlias(storage, source, bad, digest, { platform: 'openharmony' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    expect(await readFile(bad, 'utf8')).toBe('corrupt')
    expect(await readdir(join(storage, 'tmp'))).toEqual([])
  })
})
