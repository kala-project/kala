import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import type { ControlPlaneDatabase, SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import { PostgresRuntimeOriginResolver } from '../runtime-origin/postgres-runtime-origin-resolver.js'
import { createRuntimeHostProvisioningClient, RuntimeUnitProvisioner } from './runtime-unit-provisioner.js'

describe('Runtime Unit provisioning placement routing', () => {
  it('resolves the control-plane-derived Unit and organization to the dynamic Runtime origin', async () => {
    const requests: unknown[] = []
    const runtime = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(204).end()
    })
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    const address = runtime.address()
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const units: string[] = []
    const requestHost = createRuntimeHostProvisioningClient({
      origin: 'http://127.0.0.1:9',
      ingressSecret: 'test-secret',
      runtimeProvisioningOriginResolver: { async resolveProvisioningOrigin(unitId) { units.push(unitId); return origin } },
    })
    try {
      await new RuntimeUnitProvisioner(new PlacementDatabase(), requestHost).provision('unit_acme')
      expect(units).toEqual(['unit_acme'])
      expect(requests).toEqual([{
        unitId: 'unit_acme', organizationId: 'org_acme', operationId: 'host-materialize:unit_acme:3:ready', generation: 3, action: 'provision',
      }])
    } finally {
      await new Promise<void>((resolve) => runtime.close(() => resolve()))
    }
  })

  it('bootstraps a new organization without a live lease and uses the acquired lease for normal routing afterward', async () => {
    const leases: Array<Record<string, unknown>> = []
    const requests: unknown[] = []
    const runtime = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      leases.push({ organization_id: 'org_acme', origin })
      response.writeHead(204).end()
    })
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    const address = runtime.address()
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const resolver = new PostgresRuntimeOriginResolver(
      executor(leases),
      executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }]),
      new Set([origin]),
      origin,
    )
    const requestHost = createRuntimeHostProvisioningClient({
      origin: 'http://127.0.0.1:9',
      ingressSecret: 'test-secret',
      runtimeProvisioningOriginResolver: resolver,
    })

    try {
      await expect(resolver.resolve('unit_acme')).resolves.toBeUndefined()
      await new RuntimeUnitProvisioner(new PlacementDatabase(), requestHost).provision('unit_acme')
      await expect(resolver.resolve('unit_acme')).resolves.toBe(origin)
      expect(requests).toEqual([expect.objectContaining({
        unitId: 'unit_acme', organizationId: 'org_acme', action: 'provision',
      })])
    } finally {
      await new Promise<void>((resolve) => runtime.close(() => resolve()))
    }
  })

  it('does not use static Host when the dynamic placement is unavailable', async () => {
    const requestHost = createRuntimeHostProvisioningClient({
      origin: 'http://127.0.0.1:9',
      ingressSecret: 'test-secret',
      runtimeProvisioningOriginResolver: { async resolveProvisioningOrigin() { return undefined } },
    })
    await expect(new RuntimeUnitProvisioner(new PlacementDatabase(), requestHost).provision('unit_acme'))
      .rejects.toThrow('runtime origin is unavailable')
  })

  it('keeps default mode compatible by using the configured static Host when no resolver is installed', async () => {
    let requests = 0
    const runtime = createServer((_request, response) => { requests += 1; response.writeHead(204).end() })
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    const address = runtime.address()
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    try {
      const requestHost = createRuntimeHostProvisioningClient({ origin, ingressSecret: 'test-secret' })
      await new RuntimeUnitProvisioner(new PlacementDatabase(), requestHost).provision('unit_acme')
      expect(requests).toBe(1)
    } finally {
      await new Promise<void>((resolve) => runtime.close(() => resolve()))
    }
  })
})

function executor(rows: Array<Record<string, unknown>>): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
      return { rows: rows as Row[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
    },
  }
}

class PlacementDatabase implements ControlPlaneDatabase, SqlExecutor {
  async query<Row extends Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
    const rows = [{
      organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: '3', desired_state: 'ready', last_operation_id: 'provision:unit_acme',
    }] as unknown as Row[]
    return { rows, rowCount: 1, command: 'SELECT', oid: 0, fields: [] }
  }
  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return operation(this) }
  async health() { return { ok: true as const, schemaVersion: 1 } }
  async close() {}
}
