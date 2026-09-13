import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { duplicateFileOhos, publishNewFileOhos } from '../src/ohos.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!['linux', 'openharmony'].includes(process.platform))('exclusive rename publication', () => {
  it('publishes one complete object and refuses a competing writer without consuming its stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-exclusive-'))
    roots.push(root)
    const first = join(root, 'first'), second = join(root, 'second'), target = join(root, 'target')
    await writeFile(first, 'first object')
    await writeFile(second, 'second object')
    await publishNewFileOhos(first, target)
    await expect(readFile(first)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(publishNewFileOhos(second, target)).rejects.toMatchObject({ code: 'EEXIST', syscall: 'renameat2' })
    expect(await readFile(target, 'utf8')).toBe('first object')
    expect(await readFile(second, 'utf8')).toBe('second object')
  })

  it('refuses to replace a destination symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-exclusive-link-'))
    roots.push(root)
    const source = join(root, 'stage'), referent = join(root, 'referent'), target = join(root, 'target')
    await writeFile(source, 'staged')
    await writeFile(referent, 'existing')
    await symlink('referent', target)
    await expect(publishNewFileOhos(source, target)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(referent, 'utf8')).toBe('existing')
  })

  it('reports a missing staging path without creating a target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-exclusive-missing-'))
    roots.push(root)
    await expect(publishNewFileOhos(join(root, 'missing'), join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('immutable name duplication', () => {
  it('copies an immutable object into a second durable name without consuming the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-alias-'))
    roots.push(root)
    const source = join(root, 'object'), alias = join(root, 'alias')
    await writeFile(source, 'immutable bytes')
    await duplicateFileOhos(source, alias)
    expect(await readFile(source, 'utf8')).toBe('immutable bytes')
    expect(await readFile(alias, 'utf8')).toBe('immutable bytes')
  })

  it('refuses an existing alias without changing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-alias-existing-'))
    roots.push(root)
    const source = join(root, 'object'), alias = join(root, 'alias')
    await writeFile(source, 'next')
    await writeFile(alias, 'keep')
    await expect(duplicateFileOhos(source, alias)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(alias, 'utf8')).toBe('keep')
  })

  it('reports a missing source without creating an alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-alias-missing-'))
    roots.push(root)
    const alias = join(root, 'alias')
    await expect(duplicateFileOhos(join(root, 'missing'), alias)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(alias)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
