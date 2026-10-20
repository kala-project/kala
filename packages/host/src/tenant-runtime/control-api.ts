import { createHash, timingSafeEqual } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { join } from 'node:path'

import type { RuntimeCapabilities } from '@agent-kernel/shared'

import { parseTenantRuntimeUnitId } from './unit.js'
import type { RuntimeUnitMaterializationCatalog } from './materialization-store.js'
import type { TenantRuntimeService } from './service.js'

export function attachTenantRuntimeControlApi(options: {
  http: HttpServer
  serviceSecret: string
  service: TenantRuntimeService
  store: RuntimeUnitMaterializationCatalog
  dataRoot: string
  capabilities: RuntimeCapabilities
}): void {
  options.http.prependListener('request', (request, response) => {
    if (!(request.url ?? '').startsWith('/internal/')) return
    const supplied = request.headers['x-agent-runlab-ingress-secret']
    if (typeof supplied !== 'string' || !secretsEqual(supplied, options.serviceSecret)) { response.writeHead(403); response.end(); return }
    if (request.url === '/internal/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, ...options.service.status() })); return
    }
    if (!['/internal/runtime-units', '/internal/retention/sessions'].includes(request.url ?? '') || request.method !== 'POST') { response.writeHead(404); response.end(); return }
    let raw = ''; let oversized = false
    request.setTimeout(5_000, () => request.destroy())
    request.on('data', (chunk) => { raw += String(chunk); if (Buffer.byteLength(raw) > 16_384) { oversized = true; request.destroy() } })
    request.on('end', () => { void applyCommand(request.url!, raw, oversized, options).then((result) => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    }).catch((error) => {
      const status = error instanceof ControlApiError ? error.status : 400
      const body = { error: error instanceof Error ? error.message : String(error), ...(error instanceof ControlApiError ? { code: error.code } : {}) }
      if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }) })
  })
}

async function applyCommand(path: string, raw: string, oversized: boolean, options: Parameters<typeof attachTenantRuntimeControlApi>[0]): Promise<unknown> {
  if (oversized) throw new Error('request body too large')
  if (path === '/internal/retention/sessions') {
    const input = JSON.parse(raw) as { unitId?: string; organizationId?: string; before?: string }
    if (!input.unitId || !input.organizationId || !input.before) throw new Error('invalid retention request')
    const unitId = parseTenantRuntimeUnitId(input.unitId)
    const organizationId = parseOrganizationId(input.organizationId)
    const materialization = await options.store.refresh(unitId)
    if (!materialization || materialization.desiredState === 'deleted') throw new Error('runtime unit not found')
    if (!materialization.organizationId || materialization.organizationId !== organizationId) {
      throw new Error('runtime unit organization mismatch')
    }
    const before = new Date(input.before)
    if (!Number.isFinite(before.getTime())) throw new Error('invalid retention cutoff')
    const unit = await options.service.units.getOrLoad(unitId)
    if (!unit.purgeOrganizationSessions) throw new Error('runtime unit retention is not supported')
    return await unit.purgeOrganizationSessions({ organizationId, before })
  }
  const input = JSON.parse(raw) as { unitId: string; organizationId?: string; operationId: string; generation: number; action?: 'provision' | 'suspend' | 'resume' | 'delete' | 'bind-organization'; desiredState?: 'ready' | 'suspended' | 'deleted' }
  if (!input.operationId || input.operationId.length > 200 || !Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('invalid provisioning request')
  const unitId = parseTenantRuntimeUnitId(input.unitId); const action = input.action ?? 'provision'
  const existing = await options.store.refresh(unitId)
  const requestedOrganizationId = input.organizationId === undefined ? undefined : parseOrganizationId(input.organizationId)
  if (existing?.organizationId && requestedOrganizationId && existing.organizationId !== requestedOrganizationId) {
    throw new Error('runtime unit organization binding cannot change')
  }
  if (action === 'bind-organization') {
    if (!existing) throw new Error('organization binding upgrade requires an existing runtime unit')
    if (!requestedOrganizationId) throw new Error('organization binding upgrade requires organizationId')
    if (!input.desiredState || !['ready', 'suspended', 'deleted'].includes(input.desiredState)) throw new Error('organization binding upgrade requires desiredState')
    if (!existing.organizationId && existing.lastOperationId === input.operationId) throw new Error('organization binding upgrade requires a new operationId')
    if (existing.organizationId && existing.lastOperationId !== input.operationId) throw new Error('runtime unit already has an organization binding')
  } else if (existing && !existing.organizationId && requestedOrganizationId) {
    throw new ControlApiError(409, 'organization_binding_upgrade_required', 'runtime unit requires an explicit trusted organization binding upgrade')
  }
  const organizationId = requestedOrganizationId ?? existing?.organizationId
  const requestedState = action === 'bind-organization' ? input.desiredState : undefined
  if (action === 'delete' || requestedState === 'deleted') {
    await options.store.tombstone({ schemaVersion: 1, unitId, ...(organizationId ? { organizationId } : {}), routingKeyDigest: '', routingKeyVersion: 1, generation: input.generation, desiredState: 'deleted', dataRoot: join(options.dataRoot, 'tenant-runtime-units', unitId), capabilities: options.capabilities, lastOperationId: input.operationId, updatedAt: new Date().toISOString() })
    await options.service.suspendUnit(unitId)
  }
  else {
    const desiredState = requestedState ?? (action === 'suspend' ? 'suspended' : 'ready')
    await options.store.apply({ schemaVersion: 1, unitId, ...(organizationId ? { organizationId } : {}), routingKeyDigest: '', routingKeyVersion: 1, generation: input.generation, desiredState, dataRoot: join(options.dataRoot, 'tenant-runtime-units', unitId), capabilities: options.capabilities, lastOperationId: input.operationId, updatedAt: new Date().toISOString() })
    if (desiredState === 'ready') {
      try { await options.service.markRoutable(unitId, organizationId) } catch (error) {
        throw new ControlApiError(503, 'runtime_unit_placement_unavailable', error instanceof Error ? error.message : String(error))
      }
    } else await options.service.suspendUnit(unitId)
  }
  return { ok: true, unitId, action }
}

class ControlApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function parseOrganizationId(value: string): string {
  if (value.length === 0 || value.length > 200 || value !== value.trim()) throw new Error('invalid organizationId')
  return value
}

function secretsEqual(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash('sha256').update(supplied).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(suppliedDigest, expectedDigest)
}
