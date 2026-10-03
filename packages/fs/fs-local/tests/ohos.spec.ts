import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishNewFileOhos } from '../src/ohos.ts'
import { writeFileAtomic } from '../src/fsio.ts'

const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'fs-ohos-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe.skipIf(!['linux', 'openharmony'].includes(process.platform))('HarmonyOS native exclusive creation', () => {
  it('publishes a complete file and rejects competing files and symlinks', async () => {
    const base = await root()
    const stage = join(base, 'stage'), target = join(base, 'target'), alias = join(base, 'alias')
    await writeFile(stage, 'complete')
    await publishNewFileOhos(stage, target)
    await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(stage, 'competitor')
    await symlink('target', alias)
    for (const destination of [target, alias]) {
      await expect(publishNewFileOhos(stage, destination)).rejects.toMatchObject({ code: 'EEXIST', syscall: 'renameat2' })
    }
    expect(await readFile(target, 'utf8')).toBe('complete')
    expect(await readFile(stage, 'utf8')).toBe('competitor')
    await expect(publishNewFileOhos(join(base, 'missing'), join(base, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('maps a real guarded-create race without replacing the competing file', async () => {
    const base = await root(), target = join(base, 'target')
    await writeFileAtomic(target, 'ours', undefined, undefined, { platform: 'openharmony' }, { displayPath: target })
    expect(await readFile(target, 'utf8')).toBe('ours')
    await expect(writeFileAtomic(target, 'theirs', undefined, undefined, { platform: 'openharmony' }, { displayPath: target }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await readFile(target, 'utf8')).toBe('ours')
    expect(await readdir(base)).toEqual(['target'])
  })
})

it.each(['EACCES', 'ENOTSUP'])('cleans staging without falling back after HarmonyOS publication %s', async (code) => {
  const base = await root(), target = join(base, 'target')
  const failure = Object.assign(new Error('publication failed'), { code })
  await expect(writeFileAtomic(target, 'ours', undefined, undefined, {
    platform: 'openharmony',
    publishNewFile: async () => { throw failure },
  }, { displayPath: target })).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: failure })
  expect(await readdir(base)).toEqual([])
})
