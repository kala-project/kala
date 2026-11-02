import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import { KalaApiClient, PRIVATE_CLOUD_DEPLOYMENT, DEDICATED_DEPLOYMENT } from '@agent-kernel/shared'

import { startHostServer, type HostServer } from '../server.js'

describe('versioned product API', () => {
  let server: HostServer | undefined
  let root: string | undefined

  afterEach(async () => {
    await server?.close()
    if (root) await rm(root, { recursive: true, force: true })
    server = undefined
    root = undefined
  })

  it.each([PRIVATE_CLOUD_DEPLOYMENT, DEDICATED_DEPLOYMENT])('creates, pages, reads, admits messages, and deletes tenant Sessions for $tenancy', async (deployment) => {
    root = await mkdtemp(join(tmpdir(), 'kala-public-api-'))
    server = await startHostServer({
      port: 0,
      sessionsDir: root,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      deployment,
      requireIngressIdentity: true,
      llm: {
        name: 'api-test',
        async call() {
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`
    const tenantFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-agent-runlab-principal', 'principal-a')
      headers.set('x-agent-runlab-organization-id', 'org-a')
      headers.set('x-agent-runlab-organization-role', 'member')
      return await fetch(input, { ...init, headers })
    }
    const client = new KalaApiClient({ baseUrl, fetch: tenantFetch })
    expect((await fetch(`${baseUrl}/api/v1/sessions`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/v1/sessions`, { headers: {
      'x-agent-runlab-principal': 'principal-a', 'x-agent-runlab-organization-id': 'org-a',
      'x-agent-runlab-organization-role': 'invalid',
    } })).status).toBe(401)

    const first = await client.createSession({ operationId: 'create-a', sessionId: 'api-a' })
    expect(first.session.summary).toMatchObject({ sessionId: 'api-a', executionMode: 'chat' })
    await expect(client.createSession({ operationId: 'create-a-conflict', sessionId: 'api-a', executionMode: 'dag' }))
      .rejects.toMatchObject({ status: 409, code: 'conflict' })
    await client.createSession({ operationId: 'create-b', sessionId: 'api-b', executionMode: 'dag' })
    const pageOne = await client.listSessions({ limit: 1 })
    expect(pageOne.items).toHaveLength(1)
    expect(pageOne.nextCursor).toEqual(expect.any(String))
    const pageTwo = await client.listSessions({ limit: 1, cursor: pageOne.nextCursor })
    expect(pageTwo.items).toHaveLength(1)
    expect(pageTwo.items[0]?.summary.sessionId).not.toBe(pageOne.items[0]?.summary.sessionId)

    const admission = await client.sendMessage('api-a', { operationId: 'message-a', text: 'hello' })
    expect(admission).toMatchObject({ accepted: true, operationId: 'message-a' })
    const retry = await client.sendMessage('api-a', { operationId: 'message-a', text: 'hello' })
    expect(retry.accepted).toBe(true)
    await expect(client.sendMessage('api-a', { operationId: 'message-a', text: 'different' }))
      .rejects.toMatchObject({ status: 409, code: 'conflict' })
    const structured = { operationId: 'message-content', text: '', content: [{ type: 'text' as const, text: 'alpha' }] }
    await expect(client.sendMessage('api-a', structured)).resolves.toMatchObject({ accepted: true })
    await expect(client.sendMessage('api-a', structured)).resolves.toMatchObject({ accepted: true })
    await expect(client.sendMessage('api-a', { ...structured, content: [{ type: 'text', text: 'beta' }] }))
      .rejects.toMatchObject({ status: 409, code: 'conflict' })
    await expect(client.getDagRun('api-b')).resolves.toEqual({ run: null })

    const forbiddenFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-agent-runlab-principal', 'principal-b')
      headers.set('x-agent-runlab-organization-id', 'org-b')
      headers.set('x-agent-runlab-organization-role', 'member')
      return await fetch(input, { ...init, headers })
    }
    await expect(new KalaApiClient({ baseUrl, fetch: forbiddenFetch }).getSession('api-a')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
    await expect(new KalaApiClient({ baseUrl, fetch: forbiddenFetch }).listSessions()).resolves.toMatchObject({ items: [] })

    const deadline = Date.now() + 2_000
    while (server.loop.hasActiveTurn('api-a') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await client.deleteSession('api-a', 'delete-a')
    await client.deleteSession('api-a', 'delete-a')
    await expect(client.getSession('api-a')).rejects.toMatchObject({ status: 404 })
  })

  it('requires Gateway ingress identity even when a Dedicated Host is given a legacy shared token', async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-legacy-dedicated-api-'))
    server = await startHostServer({
      port: 0, sessionsDir: root, deployment: DEDICATED_DEPLOYMENT,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      auth: { sharedToken: 'legacy-test-token' },
      llm: { name: 'unused', async call() { throw new Error('model must not run') } },
    })
    const url = `http://127.0.0.1:${server.port}/api/v1/sessions`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: {
      'x-agent-runlab-principal': 'forged', 'x-agent-runlab-organization-id': 'org-forged',
      'x-agent-runlab-organization-role': 'owner',
    } })).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: `Bearer legacy-test-token` } })).status).toBe(401)
  })

  it('publishes OpenAPI without authentication and returns versioned error envelopes', async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-public-api-contract-'))
    server = await startHostServer({
      port: 0,
      sessionsDir: root,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      llm: { name: 'api-test', async call() { return { message: { role: 'assistant', content: [] } } } },
      auth: { sharedToken: 'secret-token' },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`
    const document = await fetch(`${baseUrl}/api/v1/openapi.json`)
    expect(document.status).toBe(200)
    expect(document.headers.get('x-kala-api-version')).toBe('v1')
    expect(document.headers.get('x-kala-api-compatibility')).toBe('1')
    await expect(document.json()).resolves.toMatchObject({ openapi: '3.1.0' })

    const denied = await fetch(`${baseUrl}/api/v1/sessions`, {
      headers: {
        'x-agent-runlab-principal': 'forged',
        'x-agent-runlab-organization-id': 'org-forged',
        'x-agent-runlab-organization-role': 'owner',
      },
    })
    expect(denied.status).toBe(401)
    expect(denied.headers.get('x-kala-api-version')).toBe('v1')
    await expect(denied.json()).resolves.toMatchObject({
      error: {
        code: 'authentication_required',
        requestId: expect.any(String),
      },
    })
  })
})
