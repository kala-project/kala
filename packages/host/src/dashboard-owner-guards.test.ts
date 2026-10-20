import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import { createConfig } from '@agent-kernel/kernel'
import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  ServerSubAgentStartedEvent,
  SessionReadyEvent,
} from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

import type { LLMAdapter } from './llm/adapter.js'
import { startHostServer, type HostServer } from './server.js'

const AGENT = {
  name: 'agent',
  description: 'spawn an agent',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  },
  requiresApproval: false,
  executionKind: 'host',
  executionHandler: 'agent',
} as const

type Dashboard = ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>

type SessionError = { scope: string; message: string }

async function connectDashboard(server: HostServer, sessionId: string): Promise<Dashboard> {
  const dashboard: Dashboard = clientIO(`http://localhost:${server.port}/dashboard`, {
    transports: ['websocket'],
    reconnection: false,
    auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
  })
  await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
  return dashboard
}

describe('dashboard indirect effect owner guards', () => {
  let server: HostServer | undefined
  let dashboard: Dashboard | undefined
  let dir: string | undefined

  afterEach(async () => {
    dashboard?.close()
    await server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('does not clear or abort a stream after the Session owner moves', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kala-dashboard-owner-cancel-'))
    const sessionId = 'owner-moved-cancel-effects'
    const checked: string[] = []
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      defaultConfig: createConfig({ tools: [] }),
      llm: {
        name: 'unused',
        async call() {
          throw new Error('model must not be called')
        },
      },
      assertSessionEffectOwner: async (checkedSessionId) => {
        checked.push(checkedSessionId)
        throw new Error('Session owner moved to another replica')
      },
    })
    await server.store.ensure({ sessionId, defaultConfig: createConfig({ tools: [] }) })
    const cancelStream = vi.spyOn(server.loop, 'cancelStream')
    const cursorBefore = server.store.get(sessionId)!.state.cursor
    dashboard = await connectDashboard(server, sessionId)

    const clearError = new Promise<SessionError>((resolve) => dashboard!.once('session:error', resolve))
    dashboard.emit('client:clear', { sessionId })
    await expect(clearError).resolves.toMatchObject({
      scope: 'host',
      message: 'Session owner moved to another replica',
    })
    expect(cancelStream).not.toHaveBeenCalled()
    expect(server.store.get(sessionId)!.state.cursor).toBe(cursorBefore)

    const streamError = new Promise<SessionError>((resolve) => dashboard!.once('session:error', resolve))
    dashboard.emit('client:cancel_stream', { sessionId })
    await expect(streamError).resolves.toMatchObject({
      scope: 'host',
      message: 'Session owner moved to another replica',
    })
    expect(cancelStream).not.toHaveBeenCalled()
    expect(checked).toEqual([sessionId, sessionId])
  })

  it('rechecks ownership inside compaction after the dashboard guard and before the model call', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kala-dashboard-owner-compact-'))
    const sessionId = 'owner-transfer-during-compact'
    let compacting = false
    let compactChecks = 0
    let llmCalls = 0
    const llm: LLMAdapter = {
      name: 'owner-transfer-compact',
      async call() {
        llmCalls += 1
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'completed seed turn' }],
          },
        }
      },
    }
    const config = createConfig({ tools: [], systemPrompt: 'test' })
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      defaultConfig: config,
      llm,
      assertSessionEffectOwner: async (checkedSessionId) => {
        expect(checkedSessionId).toBe(sessionId)
        if (compacting && ++compactChecks > 1) {
          throw new Error('Session owner transferred during compaction')
        }
      },
    })
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.loop.dispatch(sessionId, { kind: 'user_message', text: 'seed compactable history' })
    expect(llmCalls).toBe(1)
    dashboard = await connectDashboard(server, sessionId)

    compacting = true
    const compactError = new Promise<SessionError>((resolve) => dashboard!.once('session:error', resolve))
    dashboard.emit('client:compact', { sessionId })
    await expect(compactError).resolves.toMatchObject({
      scope: 'kernel',
      message: 'Session owner transferred during compaction',
    })

    expect(compactChecks).toBe(2)
    expect(llmCalls).toBe(1)
  })

  it('checks the child Session owner before interrupting a sub-agent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kala-dashboard-owner-child-'))
    const parentSessionId = 'owner-guard-parent'
    let deniedChildSessionId: string | undefined
    let childAborted = false
    let calls = 0
    const llm: LLMAdapter = {
      name: 'owner-guard-child',
      async call(input) {
        calls += 1
        if (calls === 1) {
          return {
            message: {
              role: 'assistant',
              content: [{
                type: 'tool_call',
                callId: 'owner-guard-agent-call',
                name: 'agent',
                input: { prompt: 'keep running' },
              }],
            },
          }
        }
        return await new Promise((_resolve, reject) => {
          const abort = () => {
            childAborted = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }
          if (input.signal?.aborted) abort()
          else input.signal?.addEventListener('abort', abort, { once: true })
        })
      },
    }
    const config = createConfig({ tools: [AGENT], systemPrompt: 'test' })
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      defaultConfig: config,
      llm,
      assertSessionEffectOwner: async (sessionId) => {
        if (sessionId === deniedChildSessionId) throw new Error('child Session owner moved')
      },
    })
    await server.store.ensure({ sessionId: parentSessionId, defaultConfig: config })
    dashboard = await connectDashboard(server, parentSessionId)
    const started = new Promise<ServerSubAgentStartedEvent>((resolve) => {
      dashboard!.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve(payload)
      })
    })
    dashboard.emit('client:user_message', {
      intent: 'text',
      sessionId: parentSessionId,
      text: 'start child',
    })
    const child = await started
    deniedChildSessionId = child.childSessionId

    const interruptError = new Promise<SessionError>((resolve) => dashboard!.once('session:error', resolve))
    dashboard.emit('client:interrupt_sub_agent', {
      parentSessionId,
      parentCallId: child.parentCallId,
      childSessionId: child.childSessionId,
    })
    await expect(interruptError).resolves.toMatchObject({
      scope: 'host',
      message: 'child Session owner moved',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(childAborted).toBe(false)
  })
})
