import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import { PRIVATE_CLOUD_DEPLOYMENT, PROTOCOL_VERSION, type DashboardClientToServerEvents, type DashboardServerToClientEvents, type EventAppendedEvent, type ServerHistoryPayload, type SessionReadyEvent } from '@agent-kernel/shared'
import { io, type Socket } from 'socket.io-client'
import { startHostServer, type HostServer } from '../server.js'
import { ScheduledTaskStore } from './store.js'

it.concurrent.each(['organization', 'portable-token'])('hydrates historical and live scheduled badges over existing WebSocket envelopes (%s)', async (scope) => {
  const root = await mkdtemp(join(tmpdir(), 'kala-dashboard-origins-'))
  const ledger = new ScheduledTaskStore(join(root, 'scheduled-ledger'))
  let server: HostServer | undefined
  let socket: Socket<DashboardServerToClientEvents, DashboardClientToServerEvents> | undefined
  const sessionId = 'origins-session'
  const organizationId = 'origins-org'
  const ownerKey = scope === 'organization' ? `organization:${organizationId}` : 'principal:token'
  const principal = scope === 'organization' ? 'origins-user' : 'token'
  const headers = scope === 'organization' ? {
    'content-type': 'application/json',
    'x-agent-runlab-principal': 'origins-user',
    'x-agent-runlab-organization-id': organizationId,
    'x-agent-runlab-organization-role': 'member',
  } : { 'content-type': 'application/json', authorization: 'Bearer fixture-token' }
  try {
    server = await startHostServer({
      port: 0, sessionsDir: join(root, 'sessions'),
      ...(scope === 'organization' ? { deployment: PRIVATE_CLOUD_DEPLOYMENT } : { auth: { sharedToken: 'fixture-token' } }),
      scheduledTaskStore: ledger, authorizeScheduledPrincipal: async () => 'member',
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      llm: { name: 'local-fixture', async call() { return { message: { role: 'assistant', content: [] } } } },
    })
    const origin = `http://127.0.0.1:${server.port}`
    expect((await fetch(`${origin}/api/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ sessionId, operationId: 'create-origins-session' }) })).status).toBe(201)
    const historical = await ledger.create({
      ownerKey, createdBy: principal, prompt: 'Historical schedule',
      target: { kind: 'session', sessionId }, schedule: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    })
    const oldRun = await ledger.claim(historical.id, historical.nextRunAt!)
    expect(oldRun?.operationId).toMatch(/^schedule_[a-f0-9]{40}$/)
    await ledger.finish(oldRun!.occurrenceId, 'enqueued', { sessionId })
    await server.loop.dispatch(sessionId, { kind: 'user_message', operationId: oldRun!.operationId, text: historical.prompt })
    await server.loop.waitForQuiescence()

    socket = io(`${origin}/dashboard`, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: headers, auth: { role: 'dashboard', sessionId, clientVersion: PROTOCOL_VERSION, ...(scope === 'portable-token' ? { token: 'fixture-token' } : {}) } })
    const ready = new Promise<SessionReadyEvent>((resolve) => socket!.once('session:ready', resolve))
    const connected = new Promise<void>((resolve, reject) => {
      socket!.once('connect', resolve)
      socket!.once('connect_error', reject)
    })
    socket.connect()
    await connected
    expect(socket.io.engine.transport.name).toBe('websocket')
    expect((await ready).scheduledMessageTasks).toMatchObject({ [oldRun!.operationId]: historical.id })
    const history = new Promise<ServerHistoryPayload>((resolve) => socket!.once('server:history', resolve))
    socket.emit('client:load_history', { sessionId })
    expect((await history).entries.some((entry) => entry.event.kind === 'user_message' && entry.event.operationId === oldRun!.operationId)).toBe(true)

    const appended: EventAppendedEvent[] = []
    socket.on('event:appended', (event) => appended.push(event))
    const liveTask = await ledger.create({
      ownerKey, createdBy: principal, prompt: 'Live schedule',
      target: { kind: 'session', sessionId }, schedule: { kind: 'once', at: new Date(Date.now() + 100).toISOString() },
    })
    const live = await new Promise<EventAppendedEvent>((resolve) => {
      socket!.on('event:appended', (event) => {
        if (event.event.kind === 'user_message' && event.event.text === liveTask.prompt) resolve(event)
      })
    })
    expect(live.scheduledTaskId).toBe(liveTask.id)
    expect(live.event.kind === 'user_message' && live.event.operationId).toMatch(/^schedule_[a-f0-9]{40}$/)
    await server.loop.waitForQuiescence()
    const refreshed = new Promise<SessionReadyEvent>((resolve) => socket!.once('session:ready', resolve))
    socket.emit('subscribe', { sessionId })
    expect((await refreshed).scheduledMessageTasks).toMatchObject({ [oldRun!.operationId]: historical.id, [live.event.kind === 'user_message' ? live.event.operationId! : '']: liveTask.id })
    expect(appended.filter((event) => event.seq === live.seq)).toHaveLength(1)
    expect(appended.map((event) => event.seq)).toEqual([...new Set(appended.map((event) => event.seq))].sort((a, b) => a - b))
    expect(appended.some((event) => event.event.kind === 'llm_response')).toBe(true)
    expect(appended.filter((event) => event.event.kind !== 'user_message').every((event) => !event.scheduledTaskId)).toBe(true)
  } finally {
    socket?.close()
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)
