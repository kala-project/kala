import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AttachedExecutor, ExecutorMcpConfigureRequest, ManagedMcpServer } from '@agent-kernel/shared'

import type { AuditEntry } from '../audit-log.js'
import type { ExecutorMcpTarget } from '../connection/executor.js'
import { attachMcpSettingsRoutes } from './mcp-settings-routes.js'

describe('managed MCP settings routes', () => {
  const servers: ReturnType<typeof createServer>[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  async function start(options: {
    tenancy?: 'single-tenant' | 'multi-tenant'
    auth?: { sharedToken: string }
    binding?: { id: string; workspaceId: string; organizationId?: string }
    executor?: { workspaceId: string; installId?: string }
    statusServers?: Array<{ name: string }>
    configureResult?: { ok: boolean; error?: string }
    trusted?: boolean
    organizationId?: string
  } = {}) {
    const binding = options.binding ?? { id: 'inst-managed', workspaceId: 'ws-managed' }
    const executor = options.executor === undefined ? { workspaceId: binding.workspaceId, installId: binding.id } : options.executor
    const auditEntries: AuditEntry[] = []
    const configureMcp = vi.fn(async (_workspaceId: string, _target: ExecutorMcpTarget, _payload: ExecutorMcpConfigureRequest) => options.configureResult ?? { ok: true })
    const mcpConfigStatus = vi.fn(async () => ({ ok: true, servers: options.statusServers ?? [] }))
    const server = createServer()
    servers.push(server)
    attachMcpSettingsRoutes(server, {
      installations: {
        managedBinding: (id) => id === binding.id ? binding : undefined,
        managedBindingsForWorkspace: (workspaceId) => workspaceId === binding.workspaceId ? [binding] : [],
      },
      executors: {
        snapshot: () => executor ? [{
          executorId: 'exec-managed',
          workspaceName: 'managed',
          tools: [],
          runtime: 'node',
          runtimeVersion: 'test',
          attachedAt: new Date(0).toISOString(),
          ...executor,
        } as AttachedExecutor] : [],
        hasTrustedManagedExecutor: (workspaceId, installId) => options.trusted !== false && workspaceId === binding.workspaceId && installId === binding.id,
        hasTrustedWorkspaceExecutor: (workspaceId, executorId) => options.trusted !== false && workspaceId === executor?.workspaceId && executorId === 'exec-managed',
        configureMcp,
        mcpConfigStatus,
      },
      tenancy: options.tenancy ?? 'single-tenant',
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.auth ? { auth: options.auth } : {}),
      audit: { log: (entry) => auditEntries.push(entry) },
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    return { url: `http://localhost:${address.port}`, configureMcp, mcpConfigStatus, auditEntries }
  }

  it('rejects anonymous GET and PUT on localhost even when dashboard auth is not configured', async () => {
    const { url, configureMcp, mcpConfigStatus } = await start()
    const read = await fetch(`${url}/settings/mcp?workspaceId=ws-managed`)
    expect(read.status).toBe(401)
    expect(await read.json()).toEqual({ error: 'operator_authentication_required' })

    const update = await fetch(`${url}/settings/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-managed', servers: [] }),
    })
    expect(update.status).toBe(401)
    expect(await update.json()).toEqual({ error: 'operator_authentication_required' })
    expect(configureMcp).not.toHaveBeenCalled()
    expect(mcpConfigStatus).not.toHaveBeenCalled()
  })

  it('manages an organization-enrolled workspace without manufacturing a native installation', async () => {
      const { url, mcpConfigStatus, configureMcp } = await start({ organizationId: 'org-a', executor: { workspaceId: 'ws-enrolled' } })
      const headers = { 'x-agent-runlab-principal': 'owner', 'x-agent-runlab-organization-id': 'org-a', 'x-agent-runlab-organization-role': 'owner' }
      expect((await fetch(`${url}/settings/mcp?workspaceId=ws-enrolled`, { headers })).status).toBe(200)
      expect(mcpConfigStatus).toHaveBeenCalledWith('ws-enrolled', { executorId: 'exec-managed' }, expect.any(String))
      expect((await fetch(`${url}/settings/mcp`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-enrolled', servers: [] }) })).status).toBe(200)
      expect(configureMcp).toHaveBeenCalledWith('ws-enrolled', { executorId: 'exec-managed' }, { requestId: expect.any(String), servers: [] })
    })

    it('rejects other organizations and untrusted sockets on the enrolled management path', async () => {
      for (const trusted of [true, false]) {
        const { url, mcpConfigStatus } = await start({ organizationId: 'org-a', executor: { workspaceId: 'ws-enrolled' }, trusted })
        for (const organizationId of ['org-a', 'org-b']) {
          const response = await fetch(`${url}/settings/mcp?workspaceId=ws-enrolled`, { headers: { 'x-agent-runlab-principal': 'owner', 'x-agent-runlab-organization-id': organizationId, 'x-agent-runlab-organization-role': 'owner' } })
          expect(response.status).toBe(organizationId === 'org-b' ? 403 : trusted ? 200 : 409)
        }
        expect(mcpConfigStatus).toHaveBeenCalledTimes(trusted ? 1 : 0)
      }
    })

  it('requires owner or admin role for ingress authentication', async () => {
    const { url, mcpConfigStatus } = await start()
    const response = await fetch(`${url}/settings/mcp?workspaceId=ws-managed`, {
      headers: {
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org-a',
        'x-agent-runlab-organization-role': 'member',
      },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'admin_required' })
    expect(mcpConfigStatus).not.toHaveBeenCalled()
  })

  it('rejects cross-organization and non-matching managed installations', async () => {
    const foreign = await start({
      tenancy: 'multi-tenant',
      binding: { id: 'inst-org-a', workspaceId: 'ws-managed', organizationId: 'org-a' },
    })
    const foreignResponse = await fetch(`${foreign.url}/settings/mcp?workspaceId=ws-managed`, {
      headers: {
        'x-agent-runlab-principal': 'admin@org-b',
        'x-agent-runlab-organization-id': 'org-b',
        'x-agent-runlab-organization-role': 'admin',
      },
    })
    expect(foreignResponse.status).toBe(403)
    expect(await foreignResponse.json()).toEqual({ error: 'tenant_forbidden' })
    expect(foreign.mcpConfigStatus).not.toHaveBeenCalled()

    const mismatched = await start({ auth: { sharedToken: 'operator-secret' }, executor: { workspaceId: 'ws-managed', installId: 'inst-unmanaged' } })
    const mismatchResponse = await fetch(`${mismatched.url}/settings/mcp?workspaceId=ws-managed`, { headers: { authorization: 'Bearer operator-secret' } })
    expect(mismatchResponse.status).toBe(409)
    expect(await mismatchResponse.json()).toEqual({ error: 'unmanaged_executor' })
    expect(mismatched.mcpConfigStatus).not.toHaveBeenCalled()
  })

  it('redacts Executor errors and command details from responses and audit metadata', async () => {
    const secret = 'private-token-value'
    const { url, auditEntries } = await start({ auth: { sharedToken: 'test-token' }, configureResult: { ok: false, error: `spawn failed: ${secret}` } })
    const response = await fetch(`${url}/settings/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ workspaceId: 'ws-managed', servers: [{ name: 'private-server', command: `/bin/server-${secret}`, args: [`--token=${secret}`] }] }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'mcp_configuration_failed' })
    const serializedAudit = JSON.stringify(auditEntries)
    expect(serializedAudit).toContain('private-server')
    expect(serializedAudit).not.toContain(secret)
    expect(serializedAudit).not.toContain('/bin/server')
  })

  it('updates and reads the online managed Executor with the dedicated typed requests', async () => {
    const configured = [{ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'] }]
    const { url, configureMcp, mcpConfigStatus, auditEntries } = await start({ auth: { sharedToken: 'test-token' }, statusServers: configured.map(({ name }) => ({ name })) })
    const update = await fetch(`${url}/settings/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: url, authorization: 'Bearer test-token' },
      body: JSON.stringify({ workspaceId: 'ws-managed', servers: configured }),
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toEqual({ supported: true, workspaceId: 'ws-managed', servers: [{ name: 'filesystem' }] })
    expect(configureMcp).toHaveBeenCalledWith('ws-managed', 'inst-managed', {
      requestId: expect.any(String),
      servers: configured,
    })

    const read = await fetch(`${url}/settings/mcp?workspaceId=ws-managed`, { headers: { authorization: 'Bearer test-token' } })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ supported: true, workspaceId: 'ws-managed', servers: [{ name: 'filesystem' }] })
    expect(mcpConfigStatus).toHaveBeenCalledWith('ws-managed', 'inst-managed', expect.any(String))
    expect(auditEntries.filter((entry) => entry.outcome === 'ok')).toHaveLength(2)
  })

  it('rejects unknown fields instead of accepting secret environment configuration', async () => {
    const { url, configureMcp } = await start({ auth: { sharedToken: 'test-token' } })
    const response = await fetch(`${url}/settings/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ workspaceId: 'ws-managed', servers: [{ name: 'bad', command: 'node', args: [], env: { TOKEN: 'secret' } }] }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(configureMcp).not.toHaveBeenCalled()
  })

  it('fails closed before status or configuration RPC when the online claim lacks a trusted credential binding', async () => {
    const { url, configureMcp, mcpConfigStatus } = await start({ auth: { sharedToken: 'test-token' }, trusted: false })
    const headers = { authorization: 'Bearer test-token' }
    const read = await fetch(`${url}/settings/mcp?workspaceId=ws-managed`, { headers })
    expect(read.status).toBe(409)
    expect(await read.json()).toEqual({ error: 'unmanaged_executor' })

    const update = await fetch(`${url}/settings/mcp`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-managed', servers: [] }),
    })
    expect(update.status).toBe(409)
    expect(await update.json()).toEqual({ error: 'unmanaged_executor' })
    expect(mcpConfigStatus).not.toHaveBeenCalled()
    expect(configureMcp).not.toHaveBeenCalled()
  })

  it('rejects server payloads outside Executor limits without issuing an RPC', async () => {
    const { url, configureMcp } = await start({ auth: { sharedToken: 'test-token' } })
    const valid = { name: 'Server_1', command: 'node', args: [] as string[] }
    const invalidServers: unknown[] = [
      Array.from({ length: 17 }, (_, index) => ({ ...valid, name: `Server${index}` })),
      [{ ...valid, args: Array.from({ length: 65 }, () => 'arg') }],
      [{ ...valid, name: 'bad name' }],
      [valid, { ...valid }],
      [{ ...valid, command: 'node\n--inspect' }],
      [{ ...valid, command: `node\0child` }],
      [{ ...valid, args: [`value\0other`] }],
      [{ ...valid, command: 'x'.repeat(8_193) }],
      [{ ...valid, args: ['x'.repeat(8_193)] }],
    ]
    for (const servers of invalidServers) {
      const response = await fetch(`${url}/settings/mcp`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ workspaceId: 'ws-managed', servers }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
    expect(configureMcp).not.toHaveBeenCalled()
  })
})
