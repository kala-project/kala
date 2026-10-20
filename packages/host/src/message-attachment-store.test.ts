import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isContainedAttachmentPath, MessageAttachmentStore } from './message-attachment-store.js'
import {
  resolveKernelMessageAttachments,
  resolveMessageAttachmentSdkFilePath,
  validateMessageAttachmentReferences,
} from './message-attachment-resolver.js'

let root = ''

beforeEach(async () => {
  root = join(process.cwd(), '.test-data', `message-attachments-${randomUUID()}`)
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('MessageAttachmentStore', () => {
  it('stores path-safe content-addressed bytes and session-scoped references without base64', async () => {
    const store = new MessageAttachmentStore(root)
    const data = Buffer.from('hello attachment', 'utf8')
    const first = await store.register({
      sessionId: 'session-a',
      name: '../../notes.txt',
      mediaType: 'text/plain; charset=utf-8',
      data,
    })
    const second = await store.register({
      sessionId: 'session-b',
      name: 'notes.txt',
      mediaType: 'text/plain',
      data,
    })

    expect(first.name).toBe('notes.txt')
    expect(first).not.toHaveProperty('data')
    expect(first.source.sha256).toBe(second.source.sha256)
    expect(store.resolve('session-a', first).path).toBe(store.resolve('session-b', second).path)
    await expect(readFile(store.resolve('session-a', first).path)).resolves.toEqual(data)
    expect(await readFile(join(root, 'registry.json'), 'utf8')).not.toContain(data.toString('base64'))
    expect(() => store.resolve('session-b', first)).toThrow('does not belong to this Session')

    const sharedPath = store.resolve('session-a', first).path
    await store.deleteSession('session-a')
    await expect(readFile(sharedPath)).resolves.toEqual(data)
    await store.deleteSession('session-b')
    await expect(readFile(sharedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resolves UTF-8 text only at Kernel dispatch and rejects binary bytes clearly', async () => {
    const store = new MessageAttachmentStore(root)
    const text = await store.register({
      sessionId: 'session-a',
      name: 'settings.json',
      mediaType: 'application/json',
      data: Buffer.from('{"enabled":true}', 'utf8'),
    })
    const resolved = await resolveKernelMessageAttachments(store, 'session-a', [{
      role: 'user',
      content: [{ type: 'text', text: 'review' }, text],
    }])
    expect(resolved[0]?.content).toEqual([
      { type: 'text', text: 'review' },
      { type: 'text', text: expect.stringContaining('{"enabled":true}') },
    ])

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const image = await store.register({ sessionId: 'session-a', name: 'screenshot.png', mediaType: 'image/png', data: png })
    const resolvedImage = await resolveKernelMessageAttachments(store, 'session-a', [{ role: 'user', content: [image] }])
    expect(resolvedImage[0]?.content).toEqual([{
      type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: png.toString('base64') },
    }])

    const binary = await store.register({
      sessionId: 'session-a',
      name: 'fake.txt',
      mediaType: 'text/plain',
      data: Buffer.from([0, 1, 2, 3]),
    })
    await expect(resolveKernelMessageAttachments(store, 'session-a', [{
      role: 'user',
      content: [binary],
    }])).rejects.toThrow('cannot send binary attachment')
  })

  it('awaits asynchronous attachment resolution and rejects unavailable SDK paths explicitly', async () => {
    const store = new MessageAttachmentStore(root)
    const file = await store.register({
      sessionId: 'session-a',
      name: 'notes.txt',
      mediaType: 'text/plain',
      data: Buffer.from('async attachment', 'utf8'),
    })
    const asyncResolver = {
      resolve: async (sessionId: string, referenced: typeof file) => store.resolve(sessionId, referenced),
    }

    await expect(validateMessageAttachmentReferences(asyncResolver, 'session-a', [file])).resolves.toBeUndefined()
    const resolved = await resolveKernelMessageAttachments(asyncResolver, 'session-a', [{ role: 'user', content: [file] }])
    expect(resolved[0]?.content[0]).toEqual({ type: 'text', text: expect.stringContaining('async attachment') })
    await expect(resolveMessageAttachmentSdkFilePath(
      { sdkFilePath: async () => undefined },
      'session-a',
      file,
    )).rejects.toThrow('cannot be exposed as a local SDK file')
  })

  it('reloads committed image references and bytes after a Runtime replacement', async () => {
    const store = new MessageAttachmentStore(root)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const image = await store.register({ sessionId: 'session-a', name: 'screenshot.png', mediaType: 'image/png', data: png })
    await store.commitReferences('session-a', [image])

    const replacementRuntimeStore = new MessageAttachmentStore(root)
    await replacementRuntimeStore.load()
    const restored = replacementRuntimeStore.resolveById('session-a', image.source.attachmentId)
    expect(restored.mediaType).toBe('image/png')
    await expect(restored.read()).resolves.toEqual(png)
  })

  it('releases failed pending uploads but retains committed references', async () => {
    const store = new MessageAttachmentStore(root)
    const pending = await store.register({
      sessionId: 'session-a',
      name: 'pending.md',
      mediaType: 'text/markdown',
      data: Buffer.from('pending', 'utf8'),
    })
    await store.releasePending('session-a', [pending.source.attachmentId])
    expect(() => store.resolve('session-a', pending)).toThrow('unavailable')

    const committed = await store.register({
      sessionId: 'session-a',
      name: 'committed.md',
      mediaType: 'text/markdown',
      data: Buffer.from('committed', 'utf8'),
    })
    await store.commitReferences('session-a', [committed])
    await store.releasePending('session-a', [committed.source.attachmentId])
    expect(store.resolve('session-a', committed).bytes).toBe(9)
  })

  it('cleans expired pending uploads when the store reloads', async () => {
    const store = new MessageAttachmentStore(root)
    const pending = await store.register({
      sessionId: 'session-a',
      name: 'abandoned.md',
      mediaType: 'text/markdown',
      data: Buffer.from('abandoned', 'utf8'),
    })
    const pendingPath = store.resolve('session-a', pending).path
    const registryPath = join(root, 'registry.json')
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { records: Array<{ createdAt: string }> }
    registry.records[0]!.createdAt = '2000-01-01T00:00:00.000Z'
    await writeFile(registryPath, JSON.stringify(registry))

    const reloaded = new MessageAttachmentStore(root)
    await reloaded.load()
    expect(() => reloaded.resolve('session-a', pending)).toThrow('unavailable')
    await expect(readFile(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recognizes contained Windows paths without hard-coded POSIX separators', () => {
    expect(isContainedAttachmentPath(
      'C:\\runlab\\attachments',
      'C:\\runlab\\attachments\\aa\\hash',
      win32,
    )).toBe(true)
    expect(isContainedAttachmentPath(
      'C:\\runlab\\attachments',
      'C:\\runlab\\outside\\hash',
      win32,
    )).toBe(false)
  })

  it('serializes registry mutations across Runtime processes and refreshes stale readers', async () => {
    const predecessor = new MessageAttachmentStore(root)
    const candidate = new MessageAttachmentStore(root)
    await Promise.all([predecessor.load(), candidate.load()])

    const [first, second] = await Promise.all([
      predecessor.register({
        sessionId: 'session-a',
        name: 'first.md',
        mediaType: 'text/markdown',
        data: Buffer.from('first', 'utf8'),
      }),
      candidate.register({
        sessionId: 'session-b',
        name: 'second.md',
        mediaType: 'text/markdown',
        data: Buffer.from('second', 'utf8'),
      }),
    ])

    expect(candidate.resolve('session-a', first).bytes).toBe(5)
    expect(predecessor.resolve('session-b', second).bytes).toBe(6)
    const registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')) as { records: unknown[] }
    expect(registry.records).toHaveLength(2)
  })
})
