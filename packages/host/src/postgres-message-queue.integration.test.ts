import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createConfig } from '@agent-kernel/kernel'
import { PROTOCOL_VERSION, type ExecutorClientToServerEvents, type ExecutorServerToClientEvents, type ToolResultAck } from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHostServer, type HostServer } from './server.js'
import { SessionArtifactRegistry } from './session-artifact-registry.js'
import { MessageAttachmentStore } from './message-attachment-store.js'
import { PostgresDagStore } from './dag/postgres-store.js'
import { PushSubscriptionStore } from './push/store.js'
import { bangShellResultOperationId } from './bang-shell.js'
import { QueueClaimFencedError } from './postgres-message-queue.js'
import { PostgresSessionAuthority } from './store/postgres-session-authority.js'
import { createPostgresHotStateStore, type PostgresHotStateStore } from './tenant-runtime/postgres-hot-state.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const config = createConfig({ tools: [], systemPrompt: 'persistent queue test' })

integrationDescribe('Private Cloud PostgreSQL message queue integration', () => {
  const testProject = `kala-pg-queue-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  const roots: string[] = []
  const hotStores: PostgresHotStateStore[] = []
  const servers: HostServer[] = []
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_queue_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${port}/kala_queue_test`
    await eventually(async () => await makeAuthority('probe').initialize(), 30_000)
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(servers.splice(0).map(async (server) => await server.close()))
    await Promise.allSettled(hotStores.map(async (store) => await store.close()))
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function makeAuthority(owner: string): PostgresSessionAuthority {
    const hot = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-${owner}` })
    hotStores.push(hot)
    return new PostgresSessionAuthority(hot, 'tenant-queue', { ownerId: owner, leaseTtlMs: 2_000, leaseWaitMs: 5_000 })
  }

  // These tests exercise PG Queue semantics only. All other required Host
  // dependencies use isolated temporary fixtures, never a live Runtime root.
  function auxiliaryStorage(root: string, authority: PostgresSessionAuthority) {
    return {
      objectStorage: {
        sessionArtifacts: new SessionArtifactRegistry(join(root, 'artifacts')),
        messageAttachments: new MessageAttachmentStore(join(root, 'attachments')),
      },
      dagStore: new PostgresDagStore(authority.hotState.database, 'tenant-queue', `test-unit-${randomUUID()}`),
      pushStore: new PushSubscriptionStore(join(root, 'push.jsonl')),
      vapidKeys: null,
    }
  }

  function item(operationId: string, text = operationId) {
    return { id: operationId, operationId, text, mode: 'queue' as const, createdAt: new Date().toISOString() }
  }

  it('serializes concurrent enqueue and preserves priority, edits, reorder, delete, and stop tombstones', async () => {
    const first = makeAuthority('queue-a').messageQueue
    const second = makeAuthority('queue-b').messageQueue
    const sessionId = `queue-semantics-${randomUUID()}`

    await Promise.all([
      first.enqueue(sessionId, item('one'), 'back'),
      second.enqueue(sessionId, item('two'), 'back'),
      first.enqueue(sessionId, item('front', 'priority'), 'front'),
      second.enqueue(sessionId, item('one'), 'back'),
    ])
    let state = await first.load(sessionId)
    expect(state.items.map(({ operationId }) => operationId).sort()).toEqual(['front', 'one', 'two'])
    expect(state.items[0]?.operationId).toBe('front')

    await second.update(sessionId, 'two', { ...state.items.find(({ id }) => id === 'two')!, text: 'edited' })
    await first.reorder(sessionId, 'two', 'one')
    await second.delete(sessionId, 'one')
    state = await first.load(sessionId)
    expect(state.items.map(({ operationId, text }) => [operationId, text])).toEqual([['front', 'priority'], ['two', 'edited']])
    expect(state.cancelledOperationIds).toContain('one')

    await first.stop(sessionId)
    await second.enqueue(sessionId, item('two', 'edited'), 'back')
    state = await second.load(sessionId)
    expect(state.items).toEqual([])
    expect(state.cancelledOperationIds).toEqual(expect.arrayContaining(['one', 'front', 'two']))
  })

  it('atomically imports a legacy authority snapshot without overwriting a concurrent PG writer', async () => {
    const first = makeAuthority('migration-a').messageQueue
    const second = makeAuthority('migration-b').messageQueue
    const sessionId = `queue-migration-${randomUUID()}`
    const migrated = await Promise.all([
      first.loadOrInitialize(sessionId, async () => ({ items: [item('legacy')], cancelledOperationIds: ['cancelled-legacy'] })),
      second.loadOrInitialize(sessionId, async () => ({ items: [item('legacy')], cancelledOperationIds: ['cancelled-legacy'] })),
    ])
    expect(migrated[0]).toEqual(migrated[1])
    expect((await first.load(sessionId)).items.map(({ operationId }) => operationId)).toEqual(['legacy'])
    await second.enqueue(sessionId, item('new'), 'back')
    await expect(first.loadOrInitialize(sessionId, async () => ({ items: [], cancelledOperationIds: [] }))).resolves.toMatchObject({
      items: [expect.objectContaining({ operationId: 'legacy' }), expect.objectContaining({ operationId: 'new' })],
      cancelledOperationIds: ['cancelled-legacy'],
    })
  })

  it('fences completion, release, and shell result writes after claim transfer', async () => {
    const first = makeAuthority('claim-a').messageQueue
    const second = makeAuthority('claim-b').messageQueue
    const sessionId = `queue-claim-${randomUUID()}`
    await first.enqueue(sessionId, { ...item('shell'), text: '!echo once', shell: { command: 'echo once', state: 'queued' } }, 'back')

    const oldClaim = (await first.claimHead(sessionId, 'host-a', 80)).claim!
    await new Promise((resolve) => setTimeout(resolve, 120))
    const newClaim = (await second.claimHead(sessionId, 'host-b', 1_000)).claim!
    expect(newClaim.generation).toBeGreaterThan(oldClaim.generation)
    await expect(first.persistShellResult(oldClaim, { command: 'echo once', state: 'completed', result: 'uncertain' }))
      .rejects.toBeInstanceOf(QueueClaimFencedError)
    await expect(first.completeClaim(oldClaim)).rejects.toBeInstanceOf(QueueClaimFencedError)
    await expect(first.releaseClaim(oldClaim)).resolves.toBe(false)
    expect((await second.load(sessionId)).items[0]?.shell?.result).toBeUndefined()

    await second.persistShellResult(newClaim, { command: 'echo once', state: 'completed', result: 'known' })
    await second.completeClaim(newClaim)
    expect((await first.load(sessionId)).items).toEqual([])
  })

  it('fails closed after a running shell claim expires without a result receipt', async () => {
    const previousSecret = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = `shell-takeover-secret-${randomUUID()}`
    const firstAuthority = makeAuthority('shell-owner-a')
    const secondAuthority = makeAuthority('shell-owner-b')
    const first = firstAuthority.messageQueue
    const second = secondAuthority.messageQueue
    const sessionId = `shell-unknown-${randomUUID()}`
    const operationId = `shell-operation-${randomUUID()}`
    const workspaceId = `workspace-${randomUUID()}`
    const executorToken = `executor-${randomUUID()}`
    const root = mkdtempSync(join(tmpdir(), 'kala-pg-shell-takeover-'))
    roots.push(root)
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const replacement = await startHostServer({
      port: 0,
      sessionsDir: join(root, 'sessions-not-created'),
      httpServer: http,
      sessionAuthority: secondAuthority,
      ...auxiliaryStorage(root, secondAuthority),
      defaultConfig: config,
      queueClaimTtlMs: 100,
      auth: { executorTokens: [{ token: executorToken, workspaceId }] },
      llm: {
        name: 'shell-takeover-replacement',
        async call() {
          throw new Error('unknown shell result must not reach the model')
        },
      },
    })
    servers.push(replacement)
    await replacement.store.create({ sessionId, workspaceId, config })

    await first.enqueue(sessionId, {
      ...item(operationId, '!printf once'),
      shell: { command: 'printf once', state: 'queued' },
    }, 'back')
    const oldClaim = (await first.claimHead(sessionId, 'old-shell-host', 80)).claim!
    await first.persistShellResult(oldClaim, { command: 'printf once', state: 'running' })

    let replacementToolCalls = 0
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`http://127.0.0.1:${replacement.port}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: executorToken },
      reconnection: false,
    })
    try {
      await new Promise<void>((resolve) => executor.on('connect', resolve))
      executor.on('tool:call', (payload, ack: (result: ToolResultAck) => void) => {
        replacementToolCalls += 1
        ack({ callId: payload.callId, ok: true, content: 'would be a duplicate' })
      })
      executor.emit('executor:announce', {
        executorId: 'replacement-shell-executor',
        workspaceId,
        workspaceName: 'replacement shell workspace',
        tools: ['bash'],
        runtime: 'node',
        runtimeVersion: 'test',
      })
      await eventually(async () => {
        const announced = [...replacement.io.of('/executor').sockets.values()].some((socket) =>
          (socket.data.connectionMeta as { executorId?: string } | undefined)?.executorId === 'replacement-shell-executor')
        if (!announced) throw new Error('replacement executor not announced yet')
      }, 2_000)
      await new Promise((resolve) => setTimeout(resolve, 120))

      const admission = await fetch(`http://127.0.0.1:${replacement.port}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': process.env.KALA_INGRESS_HANDOFF_SECRET! },
        body: JSON.stringify({ sessionId, operationId, text: '!printf once', intent: 'shell', mode: 'queue' }),
      })
      expect(admission.ok).toBe(true)
      await eventually(async () => {
        if ((await second.load(sessionId)).items[0]?.shell?.state !== 'unknown') throw new Error('shell result is not marked unknown yet')
      }, 2_000)

      const state = await second.load(sessionId)
      expect(replacementToolCalls).toBe(0)
      expect(state.items).toHaveLength(1)
      expect(state.items[0]?.shell).toMatchObject({
        command: 'printf once',
        state: 'unknown',
        error: expect.stringContaining('delete/cancel this item'),
      })
      expect(state.items[0]?.shell?.result).toBeUndefined()
      expect(await replacement.store.findOperation(sessionId, bangShellResultOperationId(operationId))).toBeUndefined()
      await expect(first.persistShellResult(oldClaim, { command: 'printf once', state: 'completed', result: 'late receipt' }))
        .rejects.toBeInstanceOf(QueueClaimFencedError)
      await expect(first.completeClaim(oldClaim)).rejects.toBeInstanceOf(QueueClaimFencedError)
      await expect(first.releaseClaim(oldClaim)).resolves.toBe(false)
    } finally {
      executor.close()
      if (previousSecret === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previousSecret
    }
  }, 30_000)

  it('dispatches one idempotent operation once when two Host servers share a Session', async () => {
    const previousSecret = process.env.KALA_INGRESS_HANDOFF_SECRET
    process.env.KALA_INGRESS_HANDOFF_SECRET = `queue-secret-${randomUUID()}`
    const sessionId = `two-hosts-${randomUUID()}`
    const operationId = `operation-${randomUUID()}`
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let claims = 0
    let llmCalls = 0
    const makeServer = async (name: string): Promise<HostServer> => {
      const root = mkdtempSync(join(tmpdir(), 'kala-pg-queue-host-'))
      roots.push(root)
      const http = createServer()
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
      const authority = makeAuthority(name)
      const server = await startHostServer({
        port: 0,
        sessionsDir: join(root, 'sessions-not-created'),
        httpServer: http,
        sessionAuthority: authority,
        ...auxiliaryStorage(root, authority),
        defaultConfig: config,
        queueClaimTtlMs: 300,
        queueDispatchBarrier: async ({ operationId: claimedOperation }) => {
          if (claimedOperation !== operationId) return
          claims += 1
          await barrier
        },
        llm: {
          name: `two-host-${name}`,
          async call() {
            llmCalls += 1
            return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
          },
        },
      })
      servers.push(server)
      return server
    }

    try {
      const [first, second] = await Promise.all([makeServer('host-a'), makeServer('host-b')])
      await first.store.create({ sessionId, config })
      const secret = process.env.KALA_INGRESS_HANDOFF_SECRET!
      const body = JSON.stringify({ sessionId, operationId, text: 'exactly once', intent: 'text', mode: 'queue' })
      const admit = async (server: HostServer) => await fetch(`http://127.0.0.1:${server.port}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': secret },
        body,
      })
      const admissions = await Promise.all([admit(first), admit(second)])
      expect(admissions.every((response) => response.ok)).toBe(true)
      await eventually(async () => {
        if (claims !== 1) throw new Error(`expected one durable claim, saw ${claims}`)
      }, 5_000)
      release()
      await eventually(async () => {
        const operation = await first.store.findOperation(sessionId, operationId)
        if (operation?.kind !== 'event') throw new Error('operation not committed yet')
      }, 5_000)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(claims).toBe(1)
      expect(llmCalls).toBe(1)
      expect((await first.store.readEventEntries(sessionId)).filter(({ event }) => event.kind === 'user_message' && event.operationId === operationId)).toHaveLength(1)
      expect((await second.store.readEventEntries(sessionId)).filter(({ event }) =>
        event.kind === 'user_message' && event.operationId === operationId && event.text === 'exactly once')).toHaveLength(1)
    } finally {
      release?.()
      if (previousSecret === undefined) delete process.env.KALA_INGRESS_HANDOFF_SECRET
      else process.env.KALA_INGRESS_HANDOFF_SECRET = previousSecret
    }
  }, 30_000)
})

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}
