import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import { createRuntimeUnitIngress, type RuntimeUnitIngress } from './runtime-unit-ingress.js'
import type { RuntimeUnitPlacementOwnership } from './runtime-unit-placement-ownership.js'
import type { RuntimeReplicaMembership } from './runtime-replica-membership.js'
import { TenantRuntimeUnitRegistry, parseTenantRuntimeUnitId, type TenantRuntimeUnit, type TenantRuntimeUnitFactory, type TenantRuntimeUnitId } from './unit.js'

export type TenantRuntimeService = {
  readonly http: HttpServer
  readonly port: number
  readonly units: TenantRuntimeUnitRegistry
  status(): { state: 'ready' | 'draining' | 'closed'; units: readonly { id: string; state: string; origin: string }[] }
  drain(): Promise<void>
  markRoutable(unitId: string, organizationId?: string): Promise<void>
  suspendUnit(unitId: string): Promise<void>
  close(): Promise<void>
}

export async function startTenantRuntimeService(options: {
  port: number
  factory: TenantRuntimeUnitFactory
  resolveUnitId(request: IncomingMessage): string | undefined | Promise<string | undefined>
  /** Required in Private Cloud: service credential shared only with the trusted Gateway. */
  ingressSecret?: string
  listenHost?: string
  requireProvisioning?: boolean
  maxLoadedUnits?: number
  placementOwnership?: RuntimeUnitPlacementOwnership
  replicaMembership?: RuntimeReplicaMembership
  requiresPlacement?: (unitId: TenantRuntimeUnitId) => boolean
  tls?: {
    key: string | Buffer
    cert: string | Buffer
    ca: string | Buffer
  }
}): Promise<TenantRuntimeService> {
  if (options.replicaMembership && !options.placementOwnership) {
    throw new Error('Runtime replica membership requires Unit placement: either exclusive ownership or an operator-gated parallel barrier')
  }
  const units = new TenantRuntimeUnitRegistry(options.factory, options.maxLoadedUnits)
  const allowedUnits = new Set<TenantRuntimeUnitId>()
  const requiresPlacement = options.requiresPlacement ?? (() => true)
  const http = options.tls
    ? createHttpsServer({
        key: options.tls.key,
        cert: options.tls.cert,
        ca: options.tls.ca,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      })
    : createServer()
  const router: RuntimeUnitIngress = createRuntimeUnitIngress({
    isRoutableRequest: (request) => !(request.url ?? '/').startsWith('/internal/'),
    resolve: async (request) => {
      if (options.ingressSecret) {
        const supplied = request.headers['x-agent-runlab-ingress-secret']
        if (typeof supplied !== 'string' || !sameSecret(supplied, options.ingressSecret)) return undefined
      }
      const rawId = await options.resolveUnitId(request)
      if (!rawId) return undefined
      let unitId: TenantRuntimeUnitId
      try { unitId = parseTenantRuntimeUnitId(rawId) } catch { return undefined }
      if (options.placementOwnership && requiresPlacement(unitId) && !await options.placementOwnership.isCurrent(unitId)) {
        throw new Error(`Runtime Unit ${unitId} placement is unavailable`)
      }
      if (options.requireProvisioning && !allowedUnits.has(unitId)) return undefined
      let unit: TenantRuntimeUnit
      try { unit = await units.getOrLoad(unitId) } catch (error) {
        const reason = error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code : error instanceof Error ? error.name : 'unknown'
        process.emitWarning(`Runtime Unit ${unitId} failed to load (${reason})`, { code: 'KALA_RUNTIME_UNIT_LOAD' })
        return undefined
      }
      if (unit.state !== 'ready') return undefined
      return { unitId: unit.id, origin: unit.origin }
    },
  })
  router.attach(http)
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.listenHost ?? '127.0.0.1', () => { http.off('error', reject); resolve() })
  })
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  let state: 'ready' | 'draining' | 'closed' = 'ready'
  const failClosed = async (unitId: TenantRuntimeUnitId): Promise<void> => {
    allowedUnits.delete(unitId)
    try { await units.close(unitId) } finally { await options.replicaMembership?.release(unitId) }
  }
  options.placementOwnership?.setLeaseLostHandler(failClosed)
  options.replicaMembership?.setLeaseLostHandler(async (unitId) => {
    try { await failClosed(unitId) } finally { await options.placementOwnership?.release(unitId) }
  })
  return {
    http,
    port,
    units,
    status: () => ({ state, units: units.list().map((unit) => ({ id: unit.id, state: unit.state, origin: unit.origin })) }),
    async drain() {
      if (state !== 'ready') return
      state = 'draining'
      allowedUnits.clear()
      try { await units.drainAll() } finally {
        if (options.placementOwnership || options.replicaMembership) {
          try { await units.closeAll() } finally {
            try { await options.replicaMembership?.releaseAll() } finally {
              await options.placementOwnership?.releaseAll()
            }
          }
        }
      }
    },
    async markRoutable(rawId, organizationId) {
      const unitId = parseTenantRuntimeUnitId(rawId)
      if (options.placementOwnership && requiresPlacement(unitId)) {
        if (!organizationId) throw new Error(`Runtime Unit ${unitId} requires an organization binding before placement acquisition`)
        await options.placementOwnership.activate(unitId, organizationId)
        try { await options.replicaMembership?.activate(unitId, organizationId) } catch (error) {
          try { await failClosed(unitId) } finally { await options.placementOwnership.release(unitId) }
          throw error
        }
      }
      allowedUnits.add(unitId)
    },
    async suspendUnit(rawId) {
      const unitId = parseTenantRuntimeUnitId(rawId)
      allowedUnits.delete(unitId)
      try { await units.close(unitId) } finally {
        try { await options.replicaMembership?.release(unitId) } finally {
          if (options.placementOwnership && requiresPlacement(unitId)) await options.placementOwnership.release(unitId)
        }
      }
    },
    async close() {
      if (state === 'closed') return
      state = 'closed'
      allowedUnits.clear()
      router.close()
      try {
        try { await units.closeAll() } finally {
          try { await options.replicaMembership?.releaseAll() } finally {
            await options.placementOwnership?.releaseAll()
          }
        }
      } finally {
        await new Promise<void>((resolve) => http.close(() => resolve()))
      }
    },
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}
