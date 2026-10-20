import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadPostgresStateMasterKey } from './postgres-state.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('PostgreSQL tenant state master key', () => {
  it('loads an externally supplied raw 32-byte key without modifying it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-pg-state-key-'))
    roots.push(root)
    const keyPath = join(root, 'master-key')
    const expected = Buffer.alloc(32, 0x5a)
    await writeFile(keyPath, expected)

    expect(await loadPostgresStateMasterKey(keyPath)).toEqual(expected)
    expect(await readFile(keyPath)).toEqual(expected)
  })

  it('fails closed when the key is missing or not exactly 32 bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-pg-state-key-'))
    roots.push(root)
    const missingPath = join(root, 'missing-key')
    await expect(loadPostgresStateMasterKey(missingPath)).rejects.toThrow()
    await expect(readFile(missingPath)).rejects.toThrow()

    const shortPath = join(root, 'short-key')
    await writeFile(shortPath, Buffer.alloc(31))
    await expect(loadPostgresStateMasterKey(shortPath)).rejects.toThrow('exactly 32 bytes')
    expect((await readFile(shortPath)).length).toBe(31)
  })
})
