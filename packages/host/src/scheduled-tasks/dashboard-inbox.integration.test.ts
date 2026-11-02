import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import { PRIVATE_CLOUD_DEPLOYMENT, PROTOCOL_VERSION, type DashboardClientToServerEvents, type DashboardServerToClientEvents } from '@agent-kernel/shared'
import { io, type Socket } from 'socket.io-client'
import { startHostServer, type HostServer } from '../server.js'
import { ScheduledTaskStore } from './store.js'

it('pushes committed Inbox and seen changes only to the same org/creator over existing control WebSockets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kala-dashboard-inbox-'))
  const ledger = new ScheduledTaskStore(join(root, 'ledger'))
  const sockets: Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>[] = []
  let host: HostServer | undefined
  const headers = (org: string, principal: string) => ({
    'content-type': 'application/json', 'x-agent-runlab-organization-id': org,
    'x-agent-runlab-principal': principal, 'x-agent-runlab-organization-role': 'member',
  })
  try {
    host = await startHostServer({
      port: 0, sessionsDir: join(root, 'sessions'), deployment: PRIVATE_CLOUD_DEPLOYMENT,
      scheduledTaskStore: ledger, authorizeScheduledPrincipal: async () => 'member',
      defaultConfig: createConfig({ tools: [] }),
      llm: { name: 'fixture', async call() { return { message: { role: 'assistant', content: [] } } } },
    })
    const origin = `http://127.0.0.1:${host.port}`
    const connect = async (org: string, principal: string) => {
      const socket = io(`${origin}/dashboard`, { transports: ['websocket'], autoConnect: false, reconnection: false,
        extraHeaders: headers(org, principal), auth: { role: 'dashboard', clientId: `${org}-${principal}`, clientVersion: PROTOCOL_VERSION } })
      sockets.push(socket)
      const ready = new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('connect_error', reject)
      })
      socket.connect()
      await ready
      expect(socket.io.engine.transport.name).toBe('websocket')
      return socket
    }
    const alice = await connect('org-a', 'alice')
    const bob = await connect('org-a', 'bob')
    const otherOrg = await connect('org-b', 'alice')
    const excluded = vi.fn()
    bob.on('server:scheduled_inbox_changed', excluded)
    otherOrg.on('server:scheduled_inbox_changed', excluded)
    const task = await ledger.create({
      ownerKey: 'organization:org-a', createdBy: 'alice', prompt: 'Run',
      target: { kind: 'session', sessionId: 'target' }, schedule: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    })
    const run = await ledger.claim(task.id, task.nextRunAt!)
    const changed = new Promise((resolve) => alice.once('server:scheduled_inbox_changed', resolve))
    await ledger.finish(run!.occurrenceId, 'failed', { error: 'Executor unavailable' })
    expect(await changed).toEqual({ reason: 'changed' })
    const inbox = await (await fetch(`${origin}/api/v1/scheduled-tasks/inbox`, { headers: headers('org-a', 'alice') })).json()
    expect(inbox).toMatchObject({ unreadCount: 1, items: [{ occurrenceId: run!.occurrenceId, status: 'failed' }] })
    const seen = new Promise((resolve) => alice.once('server:scheduled_inbox_changed', resolve))
    const result = await fetch(`${origin}/api/v1/scheduled-tasks/inbox/seen`, {
      method: 'POST', headers: headers('org-a', 'alice'), body: JSON.stringify({ occurrenceIds: [run!.occurrenceId] }),
    })
    expect(result.status).toBe(200)
    expect(await seen).toEqual({ reason: 'changed' })
    expect(excluded).not.toHaveBeenCalled()
  } finally {
    for (const socket of sockets) socket.close()
    await host?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
