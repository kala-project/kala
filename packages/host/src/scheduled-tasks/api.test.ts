import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ServerMessageQueueEvent,
} from '@agent-kernel/shared'
import { PRIVATE_CLOUD_DEPLOYMENT, PROTOCOL_VERSION } from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import { startHostServer, type HostServer } from '../server.js'

type ScheduledRun = {
  occurrenceId: string
  sessionId?: string
  status: string
}

const headers = (organizationId: string, role = 'member', principal = `${organizationId}-user`) => ({
  'content-type': 'application/json',
  'x-agent-runlab-principal': principal,
  'x-agent-runlab-organization-id': organizationId,
  'x-agent-runlab-organization-role': role,
})

async function waitFor<T>(
  description: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 6_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function connectSocket<ServerEvents, ClientEvents>(
  socket: ClientSocket<ServerEvents, ClientEvents>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 2_000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
  })
}

describe('scheduled task product API', () => {
  let server: HostServer | undefined
  let root: string | undefined
  const sockets: Array<ClientSocket> = []
  let releaseLlm: (() => void) | undefined

  afterEach(async () => {
    releaseLlm?.()
    releaseLlm = undefined
    for (const socket of sockets.splice(0)) socket.close()
    await server?.close()
    if (root) await rm(root, { recursive: true, force: true })
    server = undefined
    root = undefined
  })

  it('enforces Unit owner visibility, write scope, lifecycle, and history contracts', async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-scheduled-api-'))
    server = await startHostServer({
      port: 0,
      sessionsDir: root,
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      llm: { name: 'test', async call() { return { message: { role: 'assistant', content: [] } } } },
    })
    const base = `http://127.0.0.1:${server.port}/api/v1`
    await fetch(`${base}/sessions`, {
      method: 'POST', headers: headers('org-a'), body: JSON.stringify({ operationId: 'create-s', sessionId: 's1' }),
    })
    const created = await fetch(`${base}/scheduled-tasks`, {
      method: 'POST', headers: headers('org-a'), body: JSON.stringify({
        prompt: 'scheduled prompt', target: { kind: 'session', sessionId: 's1' },
        schedule: { kind: 'once', at: '2099-01-01T00:00:00.000Z' },
      }),
    })
    expect(created.status).toBe(201)
    const task = (await created.json() as { task: { id: string; status: string; nextRunAt: string } }).task

    await fetch(`${base}/sessions`, {
      method: 'POST', headers: headers('org-b'), body: JSON.stringify({ operationId: 'create-b-workspace', sessionId: 'b-workspace-session', workspaceId: 'workspace-b' }),
    })
    const crossUnitWorkspace = await fetch(`${base}/scheduled-tasks`, {
      method: 'POST', headers: headers('org-a'), body: JSON.stringify({
        prompt: 'must not run', target: { kind: 'workspace', workspaceId: 'workspace-b' },
        schedule: { kind: 'once', at: '2099-01-01T00:00:00.000Z' },
      }),
    })
    expect(crossUnitWorkspace.status).toBe(404)
    await expect(crossUnitWorkspace.json()).resolves.toMatchObject({ error: { code: 'not_found', message: 'workspace not found' } })
    expect(task).toMatchObject({ status: 'active', nextRunAt: '2099-01-01T00:00:00.000Z' })

    const isolated = await fetch(`${base}/scheduled-tasks`, { headers: headers('org-b') })
    expect(await isolated.json()).toEqual({ items: [] })
    expect((await fetch(`${base}/scheduled-tasks/${task.id}`, { headers: headers('org-b') })).status).toBe(404)
    expect((await fetch(`${base}/scheduled-tasks`, {
      method: 'POST', headers: headers('org-a', 'viewer'), body: JSON.stringify({}),
    })).status).toBe(403)

    const paused = await fetch(`${base}/scheduled-tasks/${task.id}/pause`, { method: 'POST', headers: headers('org-a') })
    expect(await paused.json()).toMatchObject({ task: { status: 'paused' } })
    const resumed = await fetch(`${base}/scheduled-tasks/${task.id}/resume`, { method: 'POST', headers: headers('org-a') })
    expect(await resumed.json()).toMatchObject({ task: { status: 'active' } })
    expect((await fetch(`${base}/sessions/s1`, { method: 'DELETE', headers: { ...headers('org-a'), 'idempotency-key': 'delete-s1' } })).status).toBe(204)
    expect(await (await fetch(`${base}/scheduled-tasks/${task.id}`, { headers: headers('org-a') })).json()).toMatchObject({ task: { status: 'paused' } })
    const history = await fetch(`${base}/scheduled-tasks/${task.id}/history`, { headers: headers('org-a') })
    expect(await history.json()).toEqual({ items: [] })
    expect((await fetch(`${base}/scheduled-tasks/${task.id}`, { method: 'DELETE', headers: headers('org-a') })).status).toBe(204)
  })

  it('serves old deleted-task runs through a durable principal-isolated inbox and only marks displayed IDs seen', async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-scheduled-inbox-'))
    const scheduledDirectory = join(root, '.scheduled-tasks')
    await mkdir(scheduledDirectory, { recursive: true })
    const run = (input: { occurrenceId: string; ownerKey: string; principal: string; status: string; updatedAt: string }) => ({
      occurrenceId: input.occurrenceId,
      taskId: `deleted-${input.occurrenceId}`,
      operationId: `schedule-${input.occurrenceId}`,
      scheduledFor: '2026-09-30T12:00:00.000Z',
      status: input.status,
      claimedAt: '2026-09-30T12:00:00.000Z',
      updatedAt: input.updatedAt,
      task: {
        id: `deleted-${input.occurrenceId}`,
        generation: 1,
        ownerKey: input.ownerKey,
        createdBy: input.principal,
        prompt: `Task for ${input.principal}\nprivate prompt for ${input.principal}`,
        target: { kind: 'session', sessionId: `session-${input.occurrenceId}` },
      },
      sessionId: `session-${input.occurrenceId}`,
      ...(input.status === 'failed' ? { error: 'Executor is offline.' } : {}),
    })
    await writeFile(join(scheduledDirectory, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      tasks: [],
      runs: [
        run({ occurrenceId: 'occ_alice_enqueued', ownerKey: 'organization:org-a', principal: 'alice', status: 'enqueued', updatedAt: '2026-10-01T12:01:00.000Z' }),
        run({ occurrenceId: 'occ_alice_failed', ownerKey: 'organization:org-a', principal: 'alice', status: 'failed', updatedAt: '2026-10-01T12:02:00.000Z' }),
        run({ occurrenceId: 'occ_alice_review', ownerKey: 'organization:org-a', principal: 'alice', status: 'needs_review', updatedAt: '2026-10-01T12:03:00.000Z' }),
        run({ occurrenceId: 'occ_alice_skipped', ownerKey: 'organization:org-a', principal: 'alice', status: 'skipped', updatedAt: '2026-10-01T12:04:00.000Z' }),
        run({ occurrenceId: 'occ_bob_failed', ownerKey: 'organization:org-a', principal: 'bob', status: 'failed', updatedAt: '2026-10-01T12:05:00.000Z' }),
        run({ occurrenceId: 'occ_other_tenant', ownerKey: 'organization:org-b', principal: 'alice', status: 'enqueued', updatedAt: '2026-10-01T12:06:00.000Z' }),
      ],
    }))
    const start = async () => await startHostServer({
      port: 0,
      sessionsDir: root!,
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      llm: { name: 'test', async call() { return { message: { role: 'assistant', content: [] } } } },
    })
    server = await start()
    let base = `http://127.0.0.1:${server.port}/api/v1`
    expect((await fetch(`${base}/sessions`, {
      method: 'POST', headers: headers('org-a', 'member', 'alice'),
      body: JSON.stringify({ operationId: 'create-origin-a', sessionId: 'session-occ_alice_enqueued' }),
    })).status).toBe(201)
    expect((await fetch(`${base}/sessions`, {
      method: 'POST', headers: headers('org-b', 'member', 'alice'),
      body: JSON.stringify({ operationId: 'create-origin-b', sessionId: 'session-occ_other_tenant' }),
    })).status).toBe(201)

    const origins = await fetch(`${base}/scheduled-tasks/origins?sessionId=session-occ_alice_enqueued`, { headers: headers('org-a', 'member', 'alice') })
    expect(origins.status).toBe(200)
    const originBody = await origins.json()
    expect(originBody).toEqual({ origins: { 'schedule-occ_alice_enqueued': 'deleted-occ_alice_enqueued' } })
    expect(JSON.stringify(originBody)).not.toContain('private prompt')
    expect((await fetch(`${base}/scheduled-tasks/origins?sessionId=session-occ_alice_enqueued`, { headers: headers('org-b', 'member', 'alice') })).status).toBe(404)
    expect((await fetch(`${base}/scheduled-tasks/origins?sessionId=session-occ_other_tenant`, { headers: headers('org-a', 'member', 'alice') })).status).toBe(404)

    const first = await (await fetch(`${base}/scheduled-tasks/inbox`, { headers: headers('org-a', 'member', 'alice') })).json()
    expect(first).toEqual({
      items: [
        { occurrenceId: 'occ_alice_review', taskId: 'deleted-occ_alice_review', status: 'needs_review', scheduledFor: '2026-09-30T12:00:00.000Z', updatedAt: '2026-10-01T12:03:00.000Z', seen: false, sessionId: 'session-occ_alice_review', taskLabel: 'Task for alice', target: { kind: 'session', sessionId: 'session-occ_alice_review' }, claimedAt: '2026-09-30T12:00:00.000Z' },
        { occurrenceId: 'occ_alice_failed', taskId: 'deleted-occ_alice_failed', status: 'failed', scheduledFor: '2026-09-30T12:00:00.000Z', updatedAt: '2026-10-01T12:02:00.000Z', seen: false, sessionId: 'session-occ_alice_failed', taskLabel: 'Task for alice', target: { kind: 'session', sessionId: 'session-occ_alice_failed' }, claimedAt: '2026-09-30T12:00:00.000Z', error: 'Executor is offline.' },
        { occurrenceId: 'occ_alice_enqueued', taskId: 'deleted-occ_alice_enqueued', status: 'enqueued', scheduledFor: '2026-09-30T12:00:00.000Z', updatedAt: '2026-10-01T12:01:00.000Z', seen: false, sessionId: 'session-occ_alice_enqueued', taskLabel: 'Task for alice', target: { kind: 'session', sessionId: 'session-occ_alice_enqueued' }, claimedAt: '2026-09-30T12:00:00.000Z' },
      ],
      unreadCount: 3,
    })
    expect(JSON.stringify(first)).not.toContain('private prompt')
    await expect((await fetch(`${base}/scheduled-tasks/inbox`, { headers: headers('org-a', 'member', 'alice') })).json()).resolves.toEqual(first)
    await expect((await fetch(`${base}/scheduled-tasks/inbox`, { headers: headers('org-a', 'member', 'bob') })).json()).resolves.toMatchObject({
      items: [{ occurrenceId: 'occ_bob_failed', seen: false }], unreadCount: 1,
    })
    await expect((await fetch(`${base}/scheduled-tasks/inbox`, { headers: headers('org-b', 'member', 'alice') })).json()).resolves.toMatchObject({
      items: [{ occurrenceId: 'occ_other_tenant', seen: false }], unreadCount: 1,
    })

    const seen = await fetch(`${base}/scheduled-tasks/inbox/seen`, {
      method: 'POST',
      headers: headers('org-a', 'viewer', 'alice'),
      body: JSON.stringify({ occurrenceIds: ['occ_alice_review', 'occ_alice_enqueued', 'occ_bob_failed', 'occ_other_tenant'] }),
    })
    expect(seen.status).toBe(200)
    await expect(seen.json()).resolves.toEqual({ acknowledged: ['occ_alice_enqueued', 'occ_alice_review'], unreadCount: 1 })

    await server.close()
    server = await start()
    base = `http://127.0.0.1:${server.port}/api/v1`
    await expect((await fetch(`${base}/scheduled-tasks/inbox`, { headers: headers('org-a', 'member', 'alice') })).json()).resolves.toMatchObject({
      items: [
        { occurrenceId: 'occ_alice_review', seen: true },
        { occurrenceId: 'occ_alice_failed', seen: false },
        { occurrenceId: 'occ_alice_enqueued', seen: true },
      ],
      unreadCount: 1,
    })
    await expect((await fetch(`${base}/scheduled-tasks/inbox`, { headers: headers('org-a', 'member', 'bob') })).json()).resolves.toMatchObject({
      items: [{ occurrenceId: 'occ_bob_failed', seen: false }], unreadCount: 1,
    })
  })

  it('accepts interval and monthly JSON schedules and rejects invalid calendar fields', async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-scheduled-api-shapes-'))
    server = await startHostServer({
      port: 0,
      sessionsDir: root,
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      llm: { name: 'test', async call() { return { message: { role: 'assistant', content: [] } } } },
    })
    const base = `http://127.0.0.1:${server.port}/api/v1`
    await fetch(`${base}/sessions`, {
      method: 'POST', headers: headers('org-a'), body: JSON.stringify({ operationId: 'create-s', sessionId: 's1' }),
    })
    const create = async (schedule: Record<string, unknown>) => await fetch(`${base}/scheduled-tasks`, {
      method: 'POST', headers: headers('org-a'), body: JSON.stringify({ prompt: 'calendar task', target: { kind: 'session', sessionId: 's1' }, schedule }),
    })

    const interval = await create({ kind: 'interval', timezone: 'America/New_York', hour: 9, minute: 15, everyDays: 3, startDate: '2098-12-31' })
    expect(interval.status).toBe(201)
    await expect(interval.json()).resolves.toMatchObject({ task: { schedule: { kind: 'interval', everyDays: 3, startDate: '2098-12-31' } } })
    const monthly = await create({ kind: 'monthly', timezone: 'UTC', hour: 8, minute: 0, daysOfMonth: [1, 15, 31] })
    expect(monthly.status).toBe(201)
    await expect(monthly.json()).resolves.toMatchObject({ task: { schedule: { kind: 'monthly', daysOfMonth: [1, 15, 31] } } })

    const badDate = await create({ kind: 'interval', timezone: 'UTC', hour: 8, minute: 0, everyDays: 2, startDate: '2099-02-29' })
    expect(badDate.status).toBe(400)
    await expect(badDate.json()).resolves.toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('YYYY-MM-DD') } })
    const duplicateDay = await create({ kind: 'monthly', timezone: 'UTC', hour: 8, minute: 0, daysOfMonth: [15, 15] })
    expect(duplicateDay.status).toBe(400)
    await expect(duplicateDay.json()).resolves.toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('unique integers') } })
  })

  it('triggers a once task through the Host and leaves its prompt queued behind an active Session turn', async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-scheduled-session-trigger-'))
    let markLlmStarted: (() => void) | undefined
    const llmStarted = new Promise<void>((resolve) => { markLlmStarted = resolve })
    const llmBlocked = new Promise<void>((resolve) => { releaseLlm = resolve })
    server = await startHostServer({
      port: 0,
      sessionsDir: root,
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      llm: {
        name: 'blocked-test',
        async call() {
          markLlmStarted?.()
          await llmBlocked
          return { message: { role: 'assistant', content: [] } }
        },
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    const base = `${origin}/api/v1`
    const sessionId = 'scheduled-existing-session'
    expect((await fetch(`${base}/sessions`, {
      method: 'POST', headers: headers('org-queue'), body: JSON.stringify({ operationId: 'create-existing', sessionId }),
    })).status).toBe(201)

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${origin}/dashboard`, {
      transports: ['websocket'],
      auth: { role: 'dashboard', sessionId, clientVersion: PROTOCOL_VERSION },
      extraHeaders: headers('org-queue'),
      reconnection: false,
    })
    sockets.push(dashboard)
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session ready timed out')), 2_000)
      dashboard.once('session:ready', () => { clearTimeout(timer); resolve() })
    })
    await connectSocket(dashboard)
    await ready

    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (event) => {
      if (event.sessionId === sessionId) latestQueue = event
    })
    expect((await fetch(`${base}/sessions/${sessionId}/messages`, {
      method: 'POST', headers: headers('org-queue'), body: JSON.stringify({ operationId: 'hold-active-turn', text: 'hold this turn' }),
    })).status).toBe(202)
    await Promise.race([
      llmStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LLM did not start')), 2_000)),
    ])

    const prompt = 'queued scheduled prompt'
    const created = await fetch(`${base}/scheduled-tasks`, {
      method: 'POST',
      headers: headers('org-queue'),
      body: JSON.stringify({
        prompt,
        target: { kind: 'session', sessionId },
        schedule: { kind: 'once', at: new Date(Date.now() + 1_200).toISOString() },
      }),
    })
    expect(created.status).toBe(201)
    const taskId = (await created.json() as { task: { id: string } }).task.id

    const run = await waitFor('scheduled Session run and QUEUE delivery', async () => {
      const response = await fetch(`${base}/scheduled-tasks/${taskId}/history`, { headers: headers('org-queue') })
      const items = (await response.json() as { items: ScheduledRun[] }).items
      const enqueued = items.find((item) => item.status === 'enqueued')
      const queued = latestQueue?.items.some((item) => item.text === prompt && item.mode === 'queue')
      return enqueued && queued ? enqueued : undefined
    })
    expect(run).toMatchObject({ status: 'enqueued', sessionId })
    expect((await fetch(`${base}/scheduled-tasks/${taskId}/history`, { headers: headers('org-other') })).status).toBe(404)
  }, 10_000)

  it('triggers a workspace once task into a fresh bound Session linked from run history', async () => {
    root = await mkdtemp(join(tmpdir(), 'kala-scheduled-workspace-trigger-'))
    const workspaceId = 'scheduled-workspace'
    const executorToken = 'scheduled-workspace-test-token'
    server = await startHostServer({
      port: 0,
      sessionsDir: root,
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      auth: { executorTokens: [{ token: executorToken, workspaceId }] },
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      llm: { name: 'test', async call() { return { message: { role: 'assistant', content: [] } } } },
    })
    const origin = `http://127.0.0.1:${server.port}`
    const base = `${origin}/api/v1`
    const seedSessionId = 'workspace-owner-session'
    expect((await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: headers('org-workspace'),
      body: JSON.stringify({ operationId: 'create-workspace-owner', sessionId: seedSessionId, workspaceId }),
    })).status).toBe(201)

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${origin}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: executorToken },
      reconnection: false,
    })
    sockets.push(executor)
    await connectSocket(executor)
    executor.emit('executor:announce', {
      executorId: 'scheduled-workspace-executor',
      workspaceId,
      workspaceName: 'scheduled workspace',
      tools: [],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    await waitFor('executor announcement', () =>
      server?.executorsSnapshot().some((item) => item.executorId === 'scheduled-workspace-executor') ? true : undefined,
    )

    const prompt = 'fresh workspace scheduled prompt'
    const created = await fetch(`${base}/scheduled-tasks`, {
      method: 'POST',
      headers: headers('org-workspace'),
      body: JSON.stringify({
        prompt,
        target: { kind: 'workspace', workspaceId, workspaceName: 'scheduled workspace' },
        schedule: { kind: 'once', at: new Date(Date.now() + 1_200).toISOString() },
      }),
    })
    expect(created.status).toBe(201)
    const taskId = (await created.json() as { task: { id: string } }).task.id

    const run = await waitFor('workspace scheduled run', async () => {
      const response = await fetch(`${base}/scheduled-tasks/${taskId}/history`, { headers: headers('org-workspace') })
      const items = (await response.json() as { items: ScheduledRun[] }).items
      return items.find((item) => item.status === 'enqueued' && item.sessionId)
    })
    expect(run.sessionId).toEqual(expect.any(String))
    expect(run.sessionId).not.toBe(seedSessionId)

    const linkedSession = await waitFor('history-linked workspace Session', async () => {
      const response = await fetch(`${base}/sessions/${run.sessionId}`, { headers: headers('org-workspace') })
      if (!response.ok) return undefined
      const body = await response.json() as {
        session: { summary: { sessionId: string; workspaceId?: string }; state: { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> } }
      }
      const delivered = body.session.state.messages.some((message) =>
        message.role === 'user' && message.content.some((content) => content.type === 'text' && content.text === prompt),
      )
      return delivered ? body.session : undefined
    })
    expect(linkedSession.summary).toMatchObject({ sessionId: run.sessionId, workspaceId })
    expect((await fetch(`${base}/sessions/${run.sessionId}`, { headers: headers('org-other') })).status).toBe(404)
    expect((await fetch(`${base}/scheduled-tasks/${taskId}/history`, { headers: headers('org-other') })).status).toBe(404)
  }, 10_000)
})
