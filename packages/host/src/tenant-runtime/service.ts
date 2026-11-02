import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import { createRuntimeUnitIngress, type RuntimeUnitIngress } from './runtime-unit-ingress.js'
import type { RuntimeUnitPlacementOwnership } from './runtime-unit-placement-ownership.js'
import type { RuntimeReplicaMembership } from './runtime-replica-membership.js'
import type { RuntimeUnitMaterializationCatalog } from './materialization-store.js'
import { TenantRuntimeUnitRegistry, parseTenantRuntimeUnitId, type TenantRuntimeUnit, type TenantRuntimeUnitFactory, type TenantRuntimeUnitId } from './unit.js'

export type TenantRuntimeService = {
  readonly http: HttpServer
  readonly port: number
  readonly units: TenantRuntimeUnitRegistry
  status(): { state: 'ready' | 'draining' | 'closed'; units: readonly { id: string; state: string; origin: string }[] }
  drain(): Promise<void>
  markRoutable(unitId: string, organizationId?: string): Promise<void>
  suspendUnit(unitId: string): Promise<void>
  /** Scan one authoritative page and schedule bounded, independent Unit recovery. */
  reconcile(): Promise<void>
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
  /** Opt-in composition-root authority; legacy/local services keep their existing lifecycle. */
  catalog?: RuntimeUnitMaterializationCatalog
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
  const generations = new Map<TenantRuntimeUnitId, number>()
  const epochs = new Map<TenantRuntimeUnitId, number>()
  const retiring = new Map<TenantRuntimeUnitId, Promise<void>>()
  const activating = new Map<TenantRuntimeUnitId, Promise<void>>()
  const reconcilingUnits = new Map<TenantRuntimeUnitId, Promise<void>>()
  let state: 'ready' | 'draining' | 'closed' = 'ready'
  let scan: Promise<void> | undefined
  let after: TenantRuntimeUnitId | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
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
      if (state !== 'ready') return undefined
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
      if (state !== 'ready' || unit.state !== 'ready' || (options.requireProvisioning && !allowedUnits.has(unitId))) return undefined
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
  function retire(unitId: TenantRuntimeUnitId): Promise<void> {
    // Withdraw synchronously, including loss callbacks fired during activation.
    allowedUnits.delete(unitId)
    generations.delete(unitId)
    epochs.set(unitId, (epochs.get(unitId) ?? 0) + 1)
    const existing = retiring.get(unitId)
    if (existing) return existing
    let closed = false
    const operation = Promise.resolve().then(async () => {
      try {
        await units.close(unitId)
        closed = true
      } finally {
        try { await options.replicaMembership?.release(unitId) } finally {
          if (requiresPlacement(unitId)) await options.placementOwnership?.release(unitId)
        }
      }
    })
    retiring.set(unitId, operation)
    const forget = (): void => {
      if (retiring.get(unitId) === operation) retiring.delete(unitId)
    }
    // A failed remote release does not undo completed local teardown. Both
    // managers forget their capability before I/O; a future activation is new.
    // A failed local teardown, however, remains a barrier, never a timed-out success.
    void operation.then(forget, () => { if (closed) forget() })
    return operation
  }
  options.placementOwnership?.setLeaseLostHandler(retire)
  options.replicaMembership?.setLeaseLostHandler(retire)

  function markRoutable(rawId: string, organizationId?: string): Promise<void> {
    const unitId = parseTenantRuntimeUnitId(rawId)
    const existing = activating.get(unitId)
    if (existing) return existing
    const operation = Promise.resolve().then(async () => {
      try {
        await retiring.get(unitId)
        if (state !== 'ready') throw new Error('Runtime Host is not accepting activations')
        const catalog = requiresPlacement(unitId) ? options.catalog : undefined
        const before = await catalog?.refresh(unitId)
        if (catalog && (before?.desiredState !== 'ready' || before.organizationId !== organizationId)) {
          throw new Error(`Runtime Unit ${unitId} is not authoritatively ready for this organization`)
        }
        if (before && allowedUnits.has(unitId) && generations.get(unitId) !== before.generation) await retire(unitId)
        // Loss can arrive while the first catalog refresh is in flight.
        await retiring.get(unitId)
        const epoch = epochs.get(unitId) ?? 0
        if (options.placementOwnership && requiresPlacement(unitId)) {
          if (!organizationId) throw new Error(`Runtime Unit ${unitId} requires an organization binding before placement acquisition`)
          await options.placementOwnership.activate(unitId, organizationId)
          await options.replicaMembership?.activate(unitId, organizationId)
        }
        const current = await catalog?.refresh(unitId)
        if (catalog && (current?.desiredState !== 'ready' || current.organizationId !== organizationId || current.generation !== before?.generation)) {
          throw new Error(`Runtime Unit ${unitId} lifecycle changed during activation`)
        }
        if (options.placementOwnership && requiresPlacement(unitId)) {
          if (!await options.placementOwnership.isCurrent(unitId)) throw new Error(`Runtime Unit ${unitId} placement is unavailable`)
          if (options.replicaMembership && !options.replicaMembership.activeLease(unitId, organizationId!)) {
            throw new Error(`Runtime Unit ${unitId} membership is unavailable`)
          }
        }
        if (state !== 'ready' || (epochs.get(unitId) ?? 0) !== epoch) throw new Error(`Runtime Unit ${unitId} activation was withdrawn`)
        if (current) generations.set(unitId, current.generation)
        allowedUnits.add(unitId)
      } catch (error) {
        await retire(unitId)
        throw error
      }
    })
    activating.set(unitId, operation)
    const forget = (): void => { if (activating.get(unitId) === operation) activating.delete(unitId) }
    void operation.then(forget, forget)
    return operation
  }

  function report(error: unknown, unitId?: TenantRuntimeUnitId): void {
    const reason = error instanceof Error ? error.name : 'unknown'
    if (reason === 'RuntimeUnitPlacementHeldError') return
    process.emitWarning(`Runtime desired-state recovery${unitId ? ` for ${unitId}` : ''} unavailable (${reason})`, { code: 'KALA_RUNTIME_RECONCILE' })
  }

  function reconcile(): Promise<void> {
    if (!options.catalog || state !== 'ready') return Promise.resolve()
    if (scan) return scan
    const operation = Promise.resolve().then(async () => {
      const page = await options.catalog!.scan(after, 16)
      if (state !== 'ready') return
      after = page.length === 16 ? page.at(-1)!.unitId : undefined
      for (const entry of page) {
        if (reconcilingUnits.has(entry.unitId) || reconcilingUnits.size >= 16) continue
        if (entry.desiredState === 'ready' && allowedUnits.has(entry.unitId) && generations.get(entry.unitId) === entry.generation) continue
        if (entry.desiredState !== 'ready' && !allowedUnits.has(entry.unitId) && !units.get(entry.unitId) && !activating.has(entry.unitId)) continue
        const task = Promise.resolve().then(async () => {
          // Page results are discovery, never authorization. Another node may
          // have suspended/deleted/rebound the Unit while this page was read.
          const current = await options.catalog!.refresh(entry.unitId)
          if (state !== 'ready') return
          if (current?.desiredState === 'ready') await markRoutable(current.unitId, current.organizationId)
          else await retire(entry.unitId)
        }).catch((error: unknown) => { report(error, entry.unitId) })
        reconcilingUnits.set(entry.unitId, task)
        void task.then(() => { if (reconcilingUnits.get(entry.unitId) === task) reconcilingUnits.delete(entry.unitId) })
      }
    })
    scan = operation
    const forget = (): void => { if (scan === operation) scan = undefined }
    void operation.then(forget, forget)
    return operation
  }

  function schedule(): void {
    if (!options.catalog || state !== 'ready') return
    timer = setTimeout(() => {
      timer = undefined
      void reconcile().catch((error: unknown) => { report(error) }).finally(schedule)
    }, 4_000 + Math.floor(Math.random() * 2_000))
    timer.unref()
  }
  function stop(): void {
    allowedUnits.clear()
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  async function finishActivations(): Promise<void> {
    // state was changed first, so in-flight scans/activations cannot publish or
    // start more work. Independent Unit teardown does not block the scan loop.
    await Promise.allSettled([...(scan ? [scan] : []), ...reconcilingUnits.values(), ...activating.values(), ...retiring.values()])
  }
  schedule()
  return {
    http,
    port,
    units,
    status: () => ({ state, units: units.list().map((unit) => ({ id: unit.id, state: unit.state, origin: unit.origin })) }),
    markRoutable,
    reconcile,
    suspendUnit: (rawId) => retire(parseTenantRuntimeUnitId(rawId)),
    async drain() {
      if (state !== 'ready') return
      state = 'draining'
      stop()
      try { await units.drainAll() } finally {
        await finishActivations()
        if (options.placementOwnership || options.replicaMembership) {
          try { await units.closeAll() } finally {
            try { await options.replicaMembership?.releaseAll() } finally { await options.placementOwnership?.releaseAll() }
          }
        }
      }
    },
    async close() {
      if (state === 'closed') return
      state = 'closed'
      stop()
      router.close()
      try {
        await finishActivations()
        try { await units.closeAll() } finally {
          try { await options.replicaMembership?.releaseAll() } finally { await options.placementOwnership?.releaseAll() }
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
