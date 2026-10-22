import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createConfig, type ReferencedFileContent } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageAttachmentStore } from '../message-attachment-store.js'
import { SessionStore } from '../store/session.js'
import { attachJsonRoutes } from './routes.js'

let root = ''
let server: ReturnType<typeof createServer> | undefined

beforeEach(async () => {
  root = join(process.cwd(), '.test-data', `attachment-routes-${randomUUID()}`)
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
  await rm(root, { recursive: true, force: true })
})

describe('message attachment upload route', () => {
  it('requires dashboard authentication and returns only reference metadata', async () => {
    const sessions = new SessionStore(join(root, 'sessions'))
    await sessions.create({
      sessionId: 'session-1',
      config: createConfig({ tools: [], systemPrompt: 'test' }),
    })
    const messageAttachments = new MessageAttachmentStore(join(root, 'message-attachments'))
    const acceptedOperations = new Set<string>()
    server = createServer()
    attachJsonRoutes(server, {
      models: [],
      defaultModel: '',
      sessions,
      messageAttachments,
      auth: { sharedToken: 'attachment-token' },
      enqueueUserMessage: async ({ operationId, sessionId, content }) => {
        if (operationId === 'operation-fail') throw new Error('queue unavailable')
        await messageAttachments.commitReferences(sessionId, content)
        acceptedOperations.add(operationId)
        return { committed: true }
      },
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const url = `http://127.0.0.1:${address.port}/runtime/attachments?sessionId=session-1`
    const authenticatedHeaders = { authorization: 'Bearer attachment-token' }

    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-agent-runlab-attachment-name': encodeURIComponent('../notes.txt'),
      },
      body: 'secret bytes',
    })
    expect(unauthorized.status).toBe(401)

    const viewer = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-agent-runlab-attachment-name': 'notes.txt',
        'x-agent-runlab-principal': 'viewer@example.com',
        'x-agent-runlab-organization-id': 'org-1',
        'x-agent-runlab-organization-role': 'viewer',
      },
      body: 'secret bytes',
    })
    expect(viewer.status).toBe(403)
    const viewerAdmission = await fetch(`http://127.0.0.1:${address.port}/runtime/admission/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-runlab-principal': 'viewer@example.com',
        'x-agent-runlab-organization-id': 'org-1',
        'x-agent-runlab-organization-role': 'viewer',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        operationId: 'operation-viewer',
        text: 'not allowed',
        intent: 'text',
        mode: 'queue',
      }),
    })
    expect(viewerAdmission.status).toBe(403)

    const failedUpload = await fetch(url, {
      method: 'POST',
      headers: {
        ...authenticatedHeaders,
        'content-type': 'text/plain',
        'x-agent-runlab-attachment-name': 'failed.txt',
      },
      body: 'release me',
    })
    const failedFile = (await failedUpload.json() as { file: ReferencedFileContent }).file
    const failedAdmission = await fetch(`http://127.0.0.1:${address.port}/runtime/admission/messages`, {
      method: 'POST',
      headers: {
        ...authenticatedHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        operationId: 'operation-fail',
        text: '',
        intent: 'text',
        mode: 'queue',
        content: [failedFile],
      }),
    })
    expect(failedAdmission.status).toBe(400)
    const failedRelease = await fetch(`http://127.0.0.1:${address.port}/runtime/attachments/release`, {
      method: 'POST',
      headers: {
        ...authenticatedHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        attachmentIds: [failedFile.source.attachmentId],
      }),
    })
    expect(failedRelease.status).toBe(200)
    expect(() => messageAttachments.resolve('session-1', failedFile)).toThrow('unavailable')

    const uploaded = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer attachment-token',
        'content-type': 'text/plain',
        'x-agent-runlab-attachment-name': encodeURIComponent('../notes.txt'),
      },
      body: 'secret bytes',
    })
    const responseText = await uploaded.text()
    const responseBody = JSON.parse(responseText) as {
      file: {
        type: 'file'
        name: string
        mediaType: string
        source: { kind: 'host_ref'; attachmentId: string; sha256: string; bytes: number }
      }
    }
    expect(uploaded.status).toBe(201)
    expect(responseText).not.toContain(Buffer.from('secret bytes').toString('base64'))
    expect(responseBody).toMatchObject({
      file: {
        type: 'file',
        name: 'notes.txt',
        mediaType: 'text/plain',
        source: {
          kind: 'host_ref',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          bytes: 12,
        },
      },
    })

    const admissionRequest = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authenticatedHeaders,
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        operationId: 'operation-attachment',
        text: '',
        intent: 'text',
        mode: 'queue',
        content: [responseBody.file],
      }),
    } as const
    const commitSpy = vi.spyOn(messageAttachments, 'commitReferences').mockRejectedValueOnce(new Error('registry unavailable'))
    const pendingAdmission = await fetch(`http://127.0.0.1:${address.port}/runtime/admission/messages`, admissionRequest)
    expect(pendingAdmission.status).toBe(400)
    expect(await pendingAdmission.json()).not.toHaveProperty('durablyAccepted')
    expect(acceptedOperations.has('operation-attachment')).toBe(false)
    const admitted = await fetch(`http://127.0.0.1:${address.port}/runtime/admission/messages`, admissionRequest)
    commitSpy.mockRestore()
    expect(admitted.status).toBe(202)
    expect(acceptedOperations.has('operation-attachment')).toBe(true)

    const released = await fetch(`http://127.0.0.1:${address.port}/runtime/attachments/release`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authenticatedHeaders,
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        attachmentIds: [responseBody.file.source.attachmentId],
      }),
    })
    expect(released.status).toBe(200)
    expect(messageAttachments.resolve('session-1', responseBody.file).bytes).toBe(12)
  })

  it('persists and serves image attachments through a session-scoped immutable URL', async () => {
    const sessions = new SessionStore(join(root, 'sessions'))
    await sessions.create({ sessionId: 'image-session', config: createConfig({ tools: [], systemPrompt: 'test' }) })
    await sessions.create({ sessionId: 'other-session', config: createConfig({ tools: [], systemPrompt: 'test' }) })
    const messageAttachments = new MessageAttachmentStore(join(root, 'message-attachments'))
    server = createServer()
    attachJsonRoutes(server, { models: [], defaultModel: '', sessions, messageAttachments, auth: { sharedToken: 'image-token' } })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const origin = `http://127.0.0.1:${address.port}`
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const uploaded = await fetch(`${origin}/runtime/attachments?sessionId=image-session`, {
      method: 'POST',
      headers: { authorization: 'Bearer image-token', 'content-type': 'image/png', 'x-agent-runlab-attachment-name': 'pasted-image.png' },
      body: png,
    })
    expect(uploaded.status).toBe(201)
    const file = (await uploaded.json() as { file: ReferencedFileContent }).file
    const imageUrl = `${origin}/runtime/attachments/${file.source.attachmentId}?sessionId=image-session`
    expect((await fetch(imageUrl)).status).toBe(401)
    expect((await fetch(`${origin}/runtime/attachments/%?sessionId=image-session`, { headers: { authorization: 'Bearer image-token' } })).status).toBe(400)
    const image = await fetch(imageUrl, { headers: { authorization: 'Bearer image-token' } })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('cache-control')).toContain('immutable')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
    expect((await fetch(`${origin}/runtime/attachments/${file.source.attachmentId}?sessionId=other-session`, { headers: { authorization: 'Bearer image-token' } })).status).toBe(404)
    await writeFile(messageAttachments.resolve('image-session', file).path, Buffer.from('corrupted'))
    const corrupted = await fetch(imageUrl, { headers: { authorization: 'Bearer image-token' } })
    expect(corrupted.status).toBe(404)
    expect(await corrupted.text()).toContain('integrity validation')

    const invalidImage = await fetch(`${origin}/runtime/attachments?sessionId=image-session`, {
      method: 'POST',
      headers: { authorization: 'Bearer image-token', 'content-type': 'image/png', 'x-agent-runlab-attachment-name': 'fake.png' },
      body: Buffer.from('not a png'),
    })
    expect(invalidImage.status).toBe(400)
    expect(await invalidImage.text()).toContain('do not match declared image type')
  })

  it('rejects non-image binary files for Kernel sessions before storing them', async () => {
    const sessions = new SessionStore(join(root, 'sessions'))
    await sessions.create({
      sessionId: 'kernel-session',
      config: createConfig({ tools: [], systemPrompt: 'test' }),
    })
    const messageAttachments = new MessageAttachmentStore(join(root, 'message-attachments'))
    server = createServer()
    attachJsonRoutes(server, {
      models: [],
      defaultModel: '',
      sessions,
      messageAttachments,
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')

    const response = await fetch(`http://127.0.0.1:${address.port}/runtime/attachments?sessionId=kernel-session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-agent-runlab-attachment-name': 'report.pdf',
      },
      body: Buffer.from([0, 1, 2, 3]),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('cannot send binary attachment')
  })
})
