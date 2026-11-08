import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { startExecutor } from './client.js'
import { McpClientManager, type McpToolDescriptor } from './mcp-client.js'
import type { McpServerConfig } from './mcp-config.js'
import { ToolError, type Tool, type ToolContext } from './tools/registry.js'

const fixture = fileURLToPath(new URL('./__fixtures__/mcp-server.mjs', import.meta.url))
const managers: McpClientManager[] = []
const temporaryRoots: string[] = []

function server(name: string, mode = 'normal', toolName = 'echo', env?: Record<string, string>): McpServerConfig {
  return { name, command: process.execPath, args: [fixture, mode, toolName], ...(env ? { env } : {}) }
}

function context(signal = new AbortController().signal): ToolContext {
  return { sessionId: 'session', callId: 'call', signal } as ToolContext
}

async function manager(
  servers: McpServerConfig[],
  options: { reserved?: string[]; callTimeoutMs?: number; initializeTimeoutMs?: number } = {},
): Promise<{ manager: McpClientManager; catalogs: Array<{ tools: readonly Tool[]; descriptors: readonly McpToolDescriptor[] }> }> {
  const catalogs: Array<{ tools: readonly Tool[]; descriptors: readonly McpToolDescriptor[] }> = []
  const instance = new McpClientManager({
    servers,
    reservedToolNames: new Set(options.reserved ?? []),
    initializeTimeoutMs: options.initializeTimeoutMs ?? 1_000,
    callTimeoutMs: options.callTimeoutMs ?? 1_000,
    onCatalogChanged(tools, descriptors) { catalogs.push({ tools, descriptors }) },
  })
  managers.push(instance)
  await instance.initialize()
  return { manager: instance, catalogs }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function testSocket(): {
  inbound: EventEmitter
  emitted: Array<{ event: string; args: unknown[] }>
  socket: Record<string, unknown>
} {
  const inbound = new EventEmitter()
  const managerEvents = new EventEmitter()
  const emitted: Array<{ event: string; args: unknown[] }> = []
  const socket = {
    connected: true,
    id: 'socket-id',
    auth: undefined,
    io: managerEvents,
    on(event: string, handler: (...args: never[]) => void) { inbound.on(event, handler) },
    emit(event: string, ...args: unknown[]) { emitted.push({ event, args }); return true },
    disconnect() { this.connected = false },
  }
  return { inbound, emitted, socket }
}

function request<T>(inbound: EventEmitter, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => inbound.emit(event, payload, resolve))
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((item) => item.close()))
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('MCP stdio client manager', () => {
  it('discovers descriptors with stable schema hashes and calls text tools', async () => {
    const { catalogs } = await manager([server('fixture')])
    const catalog = catalogs.at(-1)!
    expect(catalog.descriptors).toEqual([expect.objectContaining({
      name: 'fixture__echo',
      description: 'Fixture echo tool',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      schemaHash: 'f0ed10c74df9a127bf15130f04ff3984782993db64f9c1fa459ae3909c98d2da',
    })])
    await expect(catalog.tools[0]!.run({ value: 'hello' }, context())).resolves.toBe('hello')
  })

  it('maps MCP isError and unsupported content to explicit failures', async () => {
    const errored = await manager([server('erroring', 'error')])
    await expect(errored.catalogs.at(-1)!.tools[0]!.run({}, context())).rejects.toMatchObject({ code: 'EMCP' })

    const image = await manager([server('imaging', 'image')])
    await expect(image.catalogs.at(-1)!.tools[0]!.run({}, context())).rejects.toMatchObject({ code: 'ENOTSUP' })
  })

  it('bounds calls and honors caller cancellation', async () => {
    const timed = await manager([server('slow', 'hang')], { callTimeoutMs: 30 })
    await expect(timed.catalogs.at(-1)!.tools[0]!.run({}, context())).rejects.toMatchObject({ code: 'ETIMEDOUT' })

    const cancelled = await manager([server('cancelled', 'hang')], { callTimeoutMs: 2_000 })
    const controller = new AbortController()
    const pending = cancelled.catalogs.at(-1)!.tools[0]!.run({}, context(controller.signal))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ECANCELED' })
  })

  it('removes tools after a server crash and fails the in-flight call', async () => {
    const { catalogs } = await manager([server('crashy', 'crash')])
    const tool = catalogs.at(-1)!.tools[0]!
    await expect(tool.run({}, context())).rejects.toBeInstanceOf(ToolError)
    await waitFor(() => catalogs.at(-1)?.tools.length === 0)
    expect(catalogs.at(-1)?.descriptors).toEqual([])
  })

  it('closes the stdio child when the manager shuts down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-mcp-close-'))
    temporaryRoots.push(root)
    const marker = join(root, 'closed')
    const { manager: instance } = await manager([server('closer', 'normal', 'echo', { CLOSE_MARKER: marker })])
    await instance.close()
    await waitFor(() => existsSync(marker))
    expect(readFileSync(marker, 'utf8')).toBe('closed\n')
  })

  it('isolates invalid and initialization-timed-out servers and refuses prefixed name collisions', async () => {
    const isolated = await manager(
      [server('bad', 'invalid-schema'), server('stuck', 'init-hang'), server('good')],
      { initializeTimeoutMs: 500 },
    )
    expect(isolated.catalogs.at(-1)!.tools.map((tool) => tool.name)).toEqual(['good__echo'])

    const collided = await manager([server('fixture')], { reserved: ['fixture__echo'] })
    expect(collided.catalogs.at(-1)!.tools).toEqual([])
    expect(collided.catalogs.at(-1)!.descriptors).toEqual([])
  })

  it('announces descriptors and reannounces without them after a crash', async () => {
    const inbound = new EventEmitter()
    const managerEvents = new EventEmitter()
    const emitted: Array<{ event: string; args: unknown[] }> = []
    const socket = {
      connected: true,
      id: 'socket-id',
      auth: undefined,
      io: managerEvents,
      on(event: string, handler: (...args: never[]) => void) { inbound.on(event, handler) },
      emit(event: string, ...args: unknown[]) { emitted.push({ event, args }); return true },
      disconnect() { this.connected = false },
    }
    const executor = startExecutor({
      host: 'http://localhost', workspaceId: 'workspace', workspaceName: 'workspace',
      executorId: 'executor', tools: [], receiptStorePath: false,
      mcpServers: [server('dynamic', 'crash')], ioFactory: (() => socket) as never,
      mcpInitializeTimeoutMs: 1_000, mcpCallTimeoutMs: 1_000,
    })
    inbound.emit('connect')
    await executor.ready
    const announcements = (): Array<{ tools: string[]; mcpTools?: McpToolDescriptor[] }> => emitted
      .filter((event) => event.event === 'executor:announce')
      .map((event) => event.args[0] as { tools: string[]; mcpTools?: McpToolDescriptor[] })
    expect(announcements()[0]!.tools).toEqual(['__workspace_attachment_transfer', 'dynamic__echo'])
    expect(announcements()[0]!.mcpTools?.[0]).toEqual(expect.objectContaining({ name: 'dynamic__echo', schemaHash: expect.any(String) }))

    inbound.emit('tool:call', { sessionId: 's', callId: 'c', name: 'dynamic__echo', input: {} }, () => undefined)
    await waitFor(() => announcements().length === 2)
    expect(announcements().at(-1)!.tools).toEqual(['__workspace_attachment_transfer'])
    expect(announcements().at(-1)!.mcpTools).toBeUndefined()
    await executor.close()
  })

  it('live-switches and persists managed MCP config while protecting an in-flight old call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-mcp-live-'))
    temporaryRoots.push(root)
    const configPath = join(root, 'executor.json')
    const oldClosed = join(root, 'old-closed')
    const initial = server('old', 'hang')
    initial.args.push(oldClosed)
    writeFileSync(configPath, `${JSON.stringify({
      version: 1, host: 'https://host', credentialFile: '/credential', sandboxRoots: [],
      installationSource: 'dashboard-native', installationId: 'install-1', privilegeMode: 'restricted',
      unrelated: { retained: true }, mcpServers: [initial],
    })}\n`, { mode: 0o600 })

    const { inbound, emitted, socket } = testSocket()
    const executor = startExecutor({
      host: 'http://localhost', workspaceId: 'workspace', executorId: 'executor', tools: [], receiptStorePath: false,
      installId: 'install-1', mcpServers: [initial], ioFactory: (() => socket) as never,
      managedMcpConfig: { path: configPath, installationSource: 'dashboard-native', installationId: 'install-1', configurationSource: 'managed-config' },
      mcpInitializeTimeoutMs: 1_000, mcpCallTimeoutMs: 2_000,
    })
    inbound.emit('connect')
    await executor.ready

    const oldResult = request<{ ok: boolean }>(inbound, 'tool:call', { sessionId: 's', callId: 'old-call', name: 'old__echo', input: {} })
    await waitFor(() => executor.activeToolCount() === 1)
    const replacement = server('new', 'normal', 'replacement')
    await expect(request(inbound, 'executor:mcp_configure', { requestId: 'configure-1', servers: [replacement] })).resolves.toEqual({ ok: true })

    const announcements = emitted.filter((item) => item.event === 'executor:announce').map((item) => item.args[0] as { tools: string[] })
    expect(announcements.at(-1)?.tools).toEqual(['__workspace_attachment_transfer', 'new__replacement'])
    expect(existsSync(oldClosed)).toBe(false)
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(persisted.unrelated).toEqual({ retained: true })
    expect(persisted.mcpServers).toEqual([replacement])
    if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600)
    await expect(request(inbound, 'executor:mcp_config_status', { requestId: 'status-1' })).resolves.toEqual({ ok: true, servers: [{ name: replacement.name }] })

    inbound.emit('tool:cancel', { sessionId: 's', callId: 'old-call' })
    await expect(oldResult).resolves.toMatchObject({ ok: false })
    await waitFor(() => existsSync(oldClosed))
    await executor.close()
  })

  it('rolls back a failed multi-server replacement and cleans candidate children', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-mcp-rollback-'))
    temporaryRoots.push(root)
    const configPath = join(root, 'executor.json')
    const candidateClosed = join(root, 'candidate-closed')
    const initial = server('old')
    const original = {
      version: 1, host: 'https://host', credentialFile: '/credential', sandboxRoots: [],
      installationSource: 'dashboard-native', installationId: 'install-1', privilegeMode: 'restricted', mcpServers: [initial],
    }
    writeFileSync(configPath, `${JSON.stringify(original)}\n`, { mode: 0o600 })
    const { inbound, emitted, socket } = testSocket()
    const executor = startExecutor({
      host: 'http://localhost', workspaceId: 'workspace', executorId: 'executor', tools: [], receiptStorePath: false,
      installId: 'install-1', mcpServers: [initial], ioFactory: (() => socket) as never,
      managedMcpConfig: { path: configPath, installationSource: 'dashboard-native', installationId: 'install-1', configurationSource: 'managed-config' },
      mcpInitializeTimeoutMs: 1_000,
    })

    inbound.emit('connect')
    await executor.ready

    const good = server('candidate', 'normal', 'echo')
    good.args.push(candidateClosed)
    const failed = await request<{ ok: boolean; error?: string }>(inbound, 'executor:mcp_configure', {
      requestId: 'configure-failed', servers: [good, server('invalid', 'invalid-schema')],
    })
    expect(failed).toEqual({ ok: false, error: 'one or more MCP servers could not be initialized' })
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(original)
    expect((emitted.filter((item) => item.event === 'executor:announce').at(-1)?.args[0] as { tools: string[] }).tools).toEqual(['__workspace_attachment_transfer', 'old__echo'])
    await waitFor(() => existsSync(candidateClosed))
    await executor.close()
  })

  it('persists invite-managed MCP and refuses a capability for a different workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-invite-mcp-'))
    temporaryRoots.push(root)
    const configPath = join(root, 'executor.json')
    const initial = { version: 1, workspaceId: 'workspace', installationSource: 'private-cloud-invite', routeHint: 'retained', mcpServers: [] }
    writeFileSync(configPath, JSON.stringify(initial), { mode: 0o600 })
    for (const installationSource of ['private-cloud-invite', 'enrolled-config'] as const) {
    for (const workspaceId of ['other-workspace', 'workspace']) {
      writeFileSync(configPath, JSON.stringify(initial), { mode: 0o600 })
      const { inbound, socket } = testSocket()
      const executor = startExecutor({
        host: 'http://localhost', workspaceId: 'workspace', tools: [], receiptStorePath: false, ioFactory: (() => socket) as never,
        managedMcpConfig: { path: configPath, installationSource, workspaceId, configurationSource: 'managed-config' },
      })
      inbound.emit('connect')
      await executor.ready
      const servers = [server('invite-server')]
      const reply = await request<{ ok: boolean }>(inbound, 'executor:mcp_configure', { requestId: 'invite-update', servers })
      expect(reply.ok).toBe(workspaceId === 'workspace')
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(workspaceId === 'workspace' ? { ...initial, mcpServers: servers } : initial)
      await executor.close()
    }
    }
  })

  it('rejects unknown fields, env secrets, unsafe files, and unmanaged Executors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-mcp-security-'))
    temporaryRoots.push(root)
    const configPath = join(root, 'executor.json')
    writeFileSync(configPath, JSON.stringify({ version: 1, mcpServers: [] }), { mode: 0o600 })
    const managedSocket = testSocket()
    const managed = startExecutor({
      host: 'http://localhost', workspaceId: 'workspace', executorId: 'executor', tools: [], receiptStorePath: false,
      installId: 'install-1', ioFactory: (() => managedSocket.socket) as never,
      managedMcpConfig: { path: configPath, installationSource: 'dashboard-native', installationId: 'install-1', configurationSource: 'managed-config' },
    })
    managedSocket.inbound.emit('connect')
    await managed.ready
    await expect(request(managedSocket.inbound, 'executor:mcp_configure', {
      requestId: 'bad-env', servers: [{ name: 'bad', command: 'node', args: [], env: { TOKEN: 'secret' } }],
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('unknown field') })
    await expect(request(managedSocket.inbound, 'executor:mcp_configure', { requestId: 'bad-root', servers: [], extra: true })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('unknown field') })
    if (process.platform !== 'win32') {
      chmodSync(configPath, 0o644)
      await expect(request(managedSocket.inbound, 'executor:mcp_config_status', { requestId: 'unsafe' })).resolves.toEqual({ ok: false, error: 'managed Executor MCP config is invalid or unsafe' })
    }
    await managed.close()

    const unmanagedSocket = testSocket()
    const unmanaged = startExecutor({ host: 'http://localhost', workspaceId: 'workspace', executorId: 'executor', tools: [], receiptStorePath: false, ioFactory: (() => unmanagedSocket.socket) as never })
    unmanagedSocket.inbound.emit('connect')
    await unmanaged.ready
    await expect(request(unmanagedSocket.inbound, 'executor:mcp_configure', { requestId: 'denied', servers: [] })).resolves.toEqual({ ok: false, error: 'Dashboard MCP configuration is unavailable for this Executor' })
    await unmanaged.close()
  })
})
