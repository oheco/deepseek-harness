import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishNewFileOhos } from '../src/ohos.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!['linux', 'openharmony'].includes(process.platform))('exclusive rename publication', () => {
  it('publishes one complete file and refuses a competing writer without consuming its stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-exclusive-'))
    roots.push(root)
    const first = join(root, 'first'), second = join(root, 'second'), target = join(root, 'target')
    await writeFile(first, 'first log')
    await writeFile(second, 'second log')
    await publishNewFileOhos(first, target)
    await expect(readFile(first)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(publishNewFileOhos(second, target)).rejects.toMatchObject({ code: 'EEXIST', syscall: 'renameat2' })
    expect(await readFile(target, 'utf8')).toBe('first log')
    expect(await readFile(second, 'utf8')).toBe('second log')
  })

  it('refuses to replace a destination symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-exclusive-link-'))
    roots.push(root)
    const source = join(root, 'stage'), referent = join(root, 'referent'), target = join(root, 'target')
    await writeFile(source, 'staged')
    await writeFile(referent, 'existing')
    await symlink('referent', target)
    await expect(publishNewFileOhos(source, target)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(referent, 'utf8')).toBe('existing')
  })

  it('reports a missing staging path without creating a target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-exclusive-missing-'))
    roots.push(root)
    await expect(publishNewFileOhos(join(root, 'missing'), join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
