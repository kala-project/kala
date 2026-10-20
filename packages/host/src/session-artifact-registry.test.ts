import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionArtifactRegistry } from './session-artifact-registry.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

describe('SessionArtifactRegistry', () => {
  it('copies and reloads a session-bound image snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ak-session-artifact-'))
    const registry = new SessionArtifactRegistry(root)
    await registry.load()
    const record = await registry.registerImage({ sessionId: 's1', fileName: 'image.png', title: 'Image', data: png })
    expect(record.mediaType).toBe('image/png')
    expect(await readFile(registry.contentPath(record))).toEqual(png)
    const restarted = new SessionArtifactRegistry(root)
    await restarted.load()
    expect(restarted.get(record.artifactId)?.sessionId).toBe('s1')
    const resolved = restarted.get('s1', record.artifactId)
    expect(resolved?.sessionId).toBe('s1')
    await expect(resolved?.read()).resolves.toEqual(png)
    expect(restarted.get('another-session', record.artifactId)).toBeUndefined()
  })

  it('rejects non-image payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ak-session-artifact-'))
    const registry = new SessionArtifactRegistry(root)
    await expect(registry.registerImage({ sessionId: 's1', fileName: 'secret.png', data: Buffer.from('not an image') })).rejects.toThrow('unsupported image type')
  })

  it('stores SVG images with their explicit media type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ak-session-artifact-'))
    const registry = new SessionArtifactRegistry(root)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>')
    const record = await registry.registerImage({ sessionId: 's1', fileName: 'image.svg', data: svg })
    expect(record.mediaType).toBe('image/svg+xml')
    expect(record.fileName).toMatch(/\.svg$/)
    expect(await readFile(registry.contentPath(record))).toEqual(svg)
  })

  it('deletes only the registered images for the requested Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ak-session-artifact-'))
    const registry = new SessionArtifactRegistry(root)
    const removed = await registry.registerImage({ sessionId: 's1', fileName: 'one.png', data: png })
    const retained = await registry.registerImage({ sessionId: 's2', fileName: 'two.png', data: png })

    await registry.deleteSession('s1')

    await expect(readFile(registry.contentPath(removed))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(registry.contentPath(retained))).toEqual(png)
    const restarted = new SessionArtifactRegistry(root)
    await restarted.load()
    expect(restarted.get(removed.artifactId)).toBeUndefined()
    expect(restarted.get(retained.artifactId)?.sessionId).toBe('s2')
  })
})
