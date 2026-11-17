import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishNewFileOhos } from '../src/ohos.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!['linux', 'openharmony'].includes(process.platform))('HarmonyOS exclusive log publication', () => {
  it('consumes successful staging but preserves competing staging and committed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-ohos-'))
    roots.push(root)
    const stage = join(root, 'stage'), target = join(root, 'target'), alias = join(root, 'alias')
    await writeFile(stage, 'complete log')
    await publishNewFileOhos(stage, target)
    await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(stage, 'competing log')
    await symlink('target', alias)
    for (const destination of [target, alias]) {
      await expect(publishNewFileOhos(stage, destination)).rejects.toMatchObject({ code: 'EEXIST', syscall: 'renameat2' })
    }
    expect(await readFile(target, 'utf8')).toBe('complete log')
    expect(await readFile(stage, 'utf8')).toBe('competing log')
    await expect(publishNewFileOhos(join(root, 'missing'), join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
