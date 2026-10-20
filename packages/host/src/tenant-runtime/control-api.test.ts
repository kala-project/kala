import { createServer, request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'
import { RuntimeUnitMaterializationStore } from './materialization-store.js'
import { attachTenantRuntimeControlApi } from './control-api.js'
import type { TenantRuntimeService } from './service.js'
const roots: string[] = []; const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'control-api-')); roots.push(root); const http = createServer(); servers.push(http)
  const purgeOrganizationSessions = vi.fn(async () => ({ sessions: 1, sessionIds: ['expired-session'] }))
  const units = { getOrLoad: vi.fn(async (id: string) => ({ id, state: 'ready', origin: 'http://unit', purgeOrganizationSessions, drain: vi.fn(), close: vi.fn() })) }
  const service = { http, port: 0, units: units as never, status: () => ({ state: 'ready' as const, units: [] }), drain: vi.fn(), markRoutable: vi.fn(), suspendUnit: vi.fn(), close: vi.fn() } satisfies TenantRuntimeService
  const store = new RuntimeUnitMaterializationStore(join(root, 'catalog.json')); attachTenantRuntimeControlApi({ http, serviceSecret: 'secret', service, store, dataRoot: root, capabilities: AGENT_RUNTIME_CAPABILITIES })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r)); const port = (http.address() as { port: number }).port
  return { root, port, service, store, purgeOrganizationSessions }
}
async function callResult(port: number, path: string, body?: unknown, authenticated = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { 'x-agent-runlab-ingress-secret': 'secret' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => { let responseBody = ''; res.on('data', (chunk) => { responseBody += String(chunk) }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody })) }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end() })
}
async function call(port: number, path: string, body?: unknown, authenticated = false): Promise<number> {
  return (await callResult(port, path, body, authenticated)).status
}
describe('tenant runtime control API', () => {
  it('fails closed without service authentication', async () => { const { port } = await setup(); expect(await call(port, '/internal/health')).toBe(403) })
  it('applies generation-checked provision and suspend commands', async () => {
    const { port, service, store } = await setup(); const command = async (body: unknown) => call(port, '/internal/runtime-units', body, true)
    expect(await command({ unitId: 'a', operationId: 'p1', generation: 1 })).toBe(200); expect(service.markRoutable).toHaveBeenCalledWith('a', undefined); expect(store.list()).toHaveLength(1)
    expect(await command({ unitId: 'a', operationId: 's2', generation: 2, action: 'suspend' })).toBe(200); expect(service.suspendUnit).toHaveBeenCalledWith('a')
    expect(await command({ unitId: 'a', operationId: 'stale', generation: 1 })).toBe(400)
  })
  it('returns unavailable instead of routing a ready materialization when placement acquire fails', async () => {
    const { port, service, store } = await setup()
    service.markRoutable.mockRejectedValueOnce(new Error('runtime unit placement is held'))
    expect(await call(port, '/internal/runtime-units', { unitId: 'held', organizationId: 'org-a', operationId: 'p1', generation: 1 }, true)).toBe(503)
    expect(service.markRoutable).toHaveBeenCalledWith('held', 'org-a')
    expect(store.get('held' as never)).toMatchObject({ desiredState: 'ready', organizationId: 'org-a' })
  })
  it('routes retention only when the authenticated unit has the same trusted organization binding', async () => {
    const { root, port, purgeOrganizationSessions, store } = await setup()
    const retention = { unitId: 'a', organizationId: 'org_acme', before: '2026-06-01T00:00:00.000Z' }
    expect(await call(port, '/internal/retention/sessions', retention, true)).toBe(400)
    expect(await call(port, '/internal/runtime-units', { unitId: 'a', organizationId: 'org_acme', operationId: 'p1', generation: 1 }, true)).toBe(200)
    expect(store.list()[0]).toMatchObject({ unitId: 'a', organizationId: 'org_acme' })
    const reloadedStore = new RuntimeUnitMaterializationStore(join(root, 'catalog.json'))
    await reloadedStore.load()
    expect(reloadedStore.list()[0]).toMatchObject({ unitId: 'a', organizationId: 'org_acme' })
    expect(await call(port, '/internal/retention/sessions', retention)).toBe(403)
    expect(await call(port, '/internal/retention/sessions', { ...retention, organizationId: 'org_other' }, true)).toBe(400)
    expect(await call(port, '/internal/runtime-units', { unitId: 'a', organizationId: 'org_other', operationId: 's2', generation: 2, action: 'suspend' }, true)).toBe(400)
    expect(await call(port, '/internal/retention/sessions', retention, true)).toBe(200)
    expect(purgeOrganizationSessions).toHaveBeenCalledTimes(1)
    expect(purgeOrganizationSessions).toHaveBeenCalledWith({ organizationId: 'org_acme', before: new Date('2026-06-01T00:00:00.000Z') })
  })
  it('keeps retention disabled until a legacy materialization receives an explicit monotonic binding upgrade', async () => {
    const { port, purgeOrganizationSessions, store } = await setup()
    expect(await call(port, '/internal/runtime-units', { unitId: 'legacy', operationId: 'p1', generation: 1 }, true)).toBe(200)
    const implicit = await callResult(port, '/internal/runtime-units', { unitId: 'legacy', organizationId: 'org_acme', operationId: 'materialize-1', generation: 1 }, true)
    expect(implicit).toMatchObject({ status: 409 })
    expect(JSON.parse(implicit.body)).toMatchObject({ code: 'organization_binding_upgrade_required' })
    expect(await call(port, '/internal/retention/sessions', { unitId: 'legacy', organizationId: 'org_acme', before: '2026-06-01T00:00:00.000Z' }, true)).toBe(400)
    expect(await call(port, '/internal/runtime-units', { unitId: 'legacy', organizationId: 'org_acme', operationId: 'bind-2', generation: 1, action: 'bind-organization', desiredState: 'ready' }, true)).toBe(400)
    expect(await call(port, '/internal/runtime-units', { unitId: 'legacy', organizationId: 'org_acme', operationId: 'bind-2', generation: 2, action: 'bind-organization', desiredState: 'ready' }, true)).toBe(200)
    expect(await call(port, '/internal/runtime-units', { unitId: 'legacy', organizationId: 'org_acme', operationId: 'bind-2', generation: 2, action: 'bind-organization', desiredState: 'ready' }, true)).toBe(200)
    expect(store.get('legacy' as never)).toMatchObject({ organizationId: 'org_acme', generation: 2, lastOperationId: 'bind-2' })
    expect(await call(port, '/internal/runtime-units', { unitId: 'legacy', organizationId: 'org_other', operationId: 'bind-3', generation: 3, action: 'bind-organization', desiredState: 'ready' }, true)).toBe(400)
    expect(purgeOrganizationSessions).not.toHaveBeenCalled()
  })
  it('persists delete tombstones and rejects stale resurrection', async () => {
    const { port, service, store } = await setup(); const command = async (body: unknown) => call(port, '/internal/runtime-units', body, true)
    expect(await command({ unitId: 'a', operationId: 'p1', generation: 1 })).toBe(200)
    expect(await command({ unitId: 'a', operationId: 'd2', generation: 2, action: 'delete' })).toBe(200)
    expect(service.suspendUnit).toHaveBeenCalledWith('a')
    expect(store.list()[0]).toMatchObject({ unitId: 'a', desiredState: 'deleted', generation: 2 })
    expect(await command({ unitId: 'a', operationId: 'stale-resume', generation: 1, action: 'resume' })).toBe(400)
    expect(await command({ unitId: 'a', operationId: 'new-resume', generation: 3, action: 'resume' })).toBe(400)
  })
})
