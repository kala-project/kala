import { describe, expect, it } from 'vitest'

import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import {
  assertPostgresRuntimeReader,
  PostgresRuntimeOriginResolver,
  readExperimentalRuntimePlacementConfig,
  runtimeReaderConnectionString,
  safeRuntimeOrigin,
} from './postgres-runtime-origin-resolver.js'

const parallelBarrier = {
  organization_id: 'org_acme',
  node_id: 'kala-parallel-placement-barrier-v1',
  origin: 'https://parallel-placement-barrier.invalid',
}

const validParallelControl = {
  feature_version: 1,
  barrier_generation: '7',
  node_id: 'kala-parallel-placement-barrier-v1',
  owner_token: 'kala-parallel-placement-barrier-v1',
  origin: 'https://parallel-placement-barrier.invalid',
  generation: '7',
}

describe('PostgresRuntimeOriginResolver', () => {
  it('returns the sole PG-live, control-plane-matching, explicitly allowed origin', async () => {
    const placements = executor([{ organization_id: 'org_acme', origin: 'https://runtime-a.example:8443' }])
    const control = executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }])
    const resolver = new PostgresRuntimeOriginResolver(placements, control, new Set(['https://runtime-a.example:8443']))

    await expect(resolver.resolve('unit_acme')).resolves.toBe('https://runtime-a.example:8443')
    expect(placements.queries[0]).toMatchObject({ values: ['unit_acme'] })
    expect(placements.queries[0]!.sql).toContain('expires_at > clock_timestamp()')
    expect(placements.queries[0]!.sql).not.toContain('owner_token')
    expect(control.queries[0]!.sql).toContain('JOIN runtime_unit_placements')
  })

  it('selects the least-loaded allowlisted live replica with a stable tie-break for an operator-gated parallel barrier', async () => {
    const parallelRows = [
      { ...validParallelControl, replica_id: 'replica-a', replica_origin: 'https://runtime-outside.example' },
      { ...validParallelControl, replica_id: 'replica-b', replica_origin: 'https://runtime-b.example' },
      { ...validParallelControl, replica_id: 'replica-c', replica_origin: 'https://runtime-c.example' },
    ]
    const placements = scriptedExecutor([parallelBarrier], parallelRows, [parallelBarrier], parallelRows)
    const control = executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }])
    const resolver = new PostgresRuntimeOriginResolver(
      placements,
      control,
      new Set(['https://runtime-b.example', 'https://runtime-c.example']),
    )

    await expect(resolver.resolve('unit_acme')).resolves.toBe('https://runtime-b.example')
    await expect(resolver.resolve('unit_acme')).resolves.toBe('https://runtime-b.example')
    const parallelQuery = placements.queries[1]!
    expect(parallelQuery.values).toEqual(['unit_acme', 'org_acme'])
    expect(parallelQuery.sql).toContain('tenant_runtime_unit_protocol_gates')
    expect(parallelQuery.sql).toContain('replica.expires_at > clock_timestamp()')
    expect(parallelQuery.sql).toContain('placement.expires_at > clock_timestamp()')
    expect(parallelQuery.sql).toContain('tenant_runtime_resource_ownerships')
    expect(parallelQuery.sql).toContain('owner.expires_at > clock_timestamp()')
    expect(parallelQuery.sql).toContain('ORDER BY count(owner.resource_id),replica.replica_id')
    expect(parallelQuery.sql).toContain('placement.owner_token')
  })

  it('lists opaque live members and resolves only the exact requested replica', async () => {
    const rows = [
      { ...validParallelControl, replica_id: 'replica-x', replica_origin: 'https://runtime-x.example' },
      { ...validParallelControl, replica_id: 'replica-y', replica_origin: 'https://runtime-y.example' },
    ]
    const placements = scriptedExecutor([parallelBarrier], rows, [parallelBarrier], rows, [parallelBarrier], rows)
    const resolver = new PostgresRuntimeOriginResolver(
      placements,
      executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }]),
      new Set(['https://runtime-x.example', 'https://runtime-y.example']),
    )

    await expect(resolver.listReplicas('unit_acme')).resolves.toEqual(['replica-x', 'replica-y'])
    await expect(resolver.resolveReplica('unit_acme', 'replica-y')).resolves.toBe('https://runtime-y.example')
    await expect(resolver.resolveReplica('unit_acme', 'stale-replica')).resolves.toBeUndefined()
  })

  it('routes a new control connection to a less-loaded live replica', async () => {
    const placements = scriptedExecutor([parallelBarrier], [
      { ...validParallelControl, replica_id: 'replica-b', replica_origin: 'https://runtime-b.example', owner_count: '0' },
      { ...validParallelControl, replica_id: 'replica-a', replica_origin: 'https://runtime-a.example', owner_count: '1' },
    ])
    const resolver = new PostgresRuntimeOriginResolver(
      placements,
      executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }]),
      new Set(['https://runtime-a.example', 'https://runtime-b.example']),
    )

    await expect(resolver.resolve('unit_acme')).resolves.toBe('https://runtime-b.example')
  })

  it.each([
    { name: 'missing operator gate', rows: [] },
    { name: 'unknown feature version', rows: [{ ...validParallelControl, feature_version: 2, replica_id: 'replica-a', replica_origin: 'https://runtime-a.example' }] },
    { name: 'barrier generation mismatch', rows: [{ ...validParallelControl, barrier_generation: '8', replica_id: 'replica-a', replica_origin: 'https://runtime-a.example' }] },
    { name: 'malformed barrier generation', rows: [{ ...validParallelControl, generation: 'invalid', replica_id: 'replica-a', replica_origin: 'https://runtime-a.example' }] },
    { name: 'barrier owner mismatch', rows: [{ ...validParallelControl, owner_token: 'not-the-barrier', replica_id: 'replica-a', replica_origin: 'https://runtime-a.example' }] },
    { name: 'no active replicas', rows: [{ ...validParallelControl, replica_id: null, replica_origin: null }] },
    { name: 'no allowlisted active replicas', rows: [{ ...validParallelControl, replica_id: 'replica-a', replica_origin: 'https://runtime-outside.example' }] },
    { name: 'unsafe active replica origin', rows: [{ ...validParallelControl, replica_id: 'replica-a', replica_origin: 'https://runtime-a.example/path' }] },
  ])('fails closed for a parallel barrier with $name', async ({ rows }) => {
    const resolver = new PostgresRuntimeOriginResolver(
      scriptedExecutor([parallelBarrier], rows),
      executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }]),
      new Set(['https://runtime-a.example']),
    )

    await expect(resolver.resolve('unit_acme')).resolves.toBeUndefined()
  })

  it('never treats the parallel barrier origin itself as an upstream', async () => {
    const resolver = new PostgresRuntimeOriginResolver(
      scriptedExecutor([parallelBarrier], [{ ...validParallelControl, replica_id: null, replica_origin: null }]),
      executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }]),
      new Set(['https://parallel-placement-barrier.invalid']),
    )

    await expect(resolver.resolve('unit_acme')).resolves.toBeUndefined()
  })

  it('uses an explicit bootstrap candidate only for provisioning when no live placement exists', async () => {
    const placements = executor([])
    const control = executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }])
    const resolver = new PostgresRuntimeOriginResolver(
      placements,
      control,
      new Set(['https://runtime-bootstrap.example']),
      'https://runtime-bootstrap.example',
    )

    await expect(resolver.resolve('unit_acme')).resolves.toBeUndefined()
    await expect(resolver.resolveProvisioningOrigin('unit_acme')).resolves.toBe('https://runtime-bootstrap.example')
    const withoutCandidate = new PostgresRuntimeOriginResolver(placements, control, new Set(['https://runtime-bootstrap.example']))
    await expect(withoutCandidate.resolveProvisioningOrigin('unit_acme')).resolves.toBeUndefined()
  })

  it('prefers the live placement over the bootstrap candidate', async () => {
    const resolver = new PostgresRuntimeOriginResolver(
      executor([{ organization_id: 'org_acme', origin: 'https://runtime-owner.example' }]),
      executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }]),
      new Set(['https://runtime-owner.example', 'https://runtime-bootstrap.example']),
      'https://runtime-bootstrap.example',
    )

    await expect(resolver.resolveProvisioningOrigin('unit_acme')).resolves.toBe('https://runtime-owner.example')
  })

  it.each([
    {
      name: 'no live lease',
      leases: [],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }],
    },
    {
      name: 'multiple live leases',
      leases: [
        { organization_id: 'org_acme', origin: 'https://runtime-a.example' },
        { organization_id: 'org_other', origin: 'https://runtime-a.example' },
      ],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }],
    },
    {
      name: 'lease organization mismatch',
      leases: [{ organization_id: 'org_other', origin: 'https://runtime-a.example' }],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }],
    },
    {
      name: 'control placement mismatch',
      leases: [{ organization_id: 'org_acme', origin: 'https://runtime-a.example' }],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_other' }],
    },
    {
      name: 'origin outside allowlist',
      leases: [{ organization_id: 'org_acme', origin: 'https://runtime-b.example' }],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }],
    },
  ])('fails closed for $name', async ({ leases, authority }) => {
    const resolver = new PostgresRuntimeOriginResolver(executor(leases), executor(authority), new Set(['https://runtime-a.example']))
    await expect(resolver.resolve('unit_acme')).resolves.toBeUndefined()
  })

  it.each([
    {
      name: 'a live lease owned by the wrong organization',
      leases: [{ organization_id: 'org_other', origin: 'https://runtime-owner.example' }],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }],
    },
    {
      name: 'multiple live owners',
      leases: [
        { organization_id: 'org_acme', origin: 'https://runtime-owner.example' },
        { organization_id: 'org_acme', origin: 'https://runtime-owner.example' },
      ],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }],
    },
    {
      name: 'a cross-organization control placement',
      leases: [],
      authority: [{ organization_id: 'org_acme', placement_organization_id: 'org_other' }],
    },
    {
      name: 'no authoritative organization placement',
      leases: [],
      authority: [],
    },
  ])('does not fall back to bootstrap for $name', async ({ leases, authority }) => {
    const resolver = new PostgresRuntimeOriginResolver(
      executor(leases),
      executor(authority),
      new Set(['https://runtime-owner.example', 'https://runtime-bootstrap.example']),
      'https://runtime-bootstrap.example',
    )
    await expect(resolver.resolveProvisioningOrigin('unit_acme')).resolves.toBeUndefined()
  })

  it('treats an expired owner as absent so an authorized recovery Host can acquire the lease', async () => {
    const placements = executor([])
    const resolver = new PostgresRuntimeOriginResolver(
      placements,
      executor([{ organization_id: 'org_acme', placement_organization_id: 'org_acme' }]),
      new Set(['https://runtime-recovery.example']),
      'https://runtime-recovery.example',
    )

    await expect(resolver.resolveProvisioningOrigin('unit_acme')).resolves.toBe('https://runtime-recovery.example')
    expect(placements.queries[0]!.sql).toContain('expires_at > clock_timestamp()')
  })
})

describe('experimental Runtime placement configuration', () => {
  it('requires an independent explicit ingress opt-in', () => {
    expect(() => readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://placement',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime-a.example',
    })).toThrow('KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE=1')
    expect(readExperimentalRuntimePlacementConfig({ KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE: '1' })).toBeUndefined()
  })

  it('requires the placement DB and an exact HTTP(S) origin allowlist', () => {
    expect(() => readExperimentalRuntimePlacementConfig({ KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1' })).toThrow('placement PostgreSQL reader connection string')
    expect(() => readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://placement',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime.example/path',
    })).toThrow('exact HTTP(S) origins')
  })

  it('normalizes and de-duplicates explicit allowed origins', () => {
    const config = readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://placement',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime.example:443, http://127.0.0.1:13000',
      KALA_INGRESS_EXPERIMENTAL_BOOTSTRAP_RUNTIME_ORIGIN: 'https://runtime.example:443',
    })
    expect([...config!.allowedOrigins]).toEqual(['https://runtime.example', 'http://127.0.0.1:13000'])
    expect(config!.bootstrapOrigin).toBe('https://runtime.example')
  })

  it('preserves the legacy placement credential unless a distinct reader is configured', () => {
    const legacy = readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://placement',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime.example',
    })!
    expect(runtimeReaderConnectionString(legacy, false)).toEqual({ connectionString: 'postgres://placement', audit: false })
    expect(() => runtimeReaderConnectionString(legacy, true)).toThrow('POSTGRES_READER_CONNECTION_STRING is required')

    const separated = readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://runtime-writer',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING: 'postgres://gateway-reader',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime.example',
    })!
    expect(runtimeReaderConnectionString(separated, false)).toEqual({ connectionString: 'postgres://gateway-reader', audit: true })
    expect(() => runtimeReaderConnectionString(separated, true)).toThrow('Remove the legacy Runtime placement PostgreSQL credential')
    const readerOnly = readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING: 'postgres://gateway-reader',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime.example',
    })!
    expect(runtimeReaderConnectionString(readerOnly, true)).toEqual({ connectionString: 'postgres://gateway-reader', audit: true })
    expect(() => readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING: 'postgres://gateway-reader',
    })).toThrow('KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE=1')
  })

  it('requires the bootstrap candidate to be explicit, valid, allowlisted, and experiment-gated', () => {
    expect(() => readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_BOOTSTRAP_RUNTIME_ORIGIN: 'https://runtime.example',
    })).toThrow('KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE=1')
    expect(() => readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://placement',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime-a.example',
      KALA_INGRESS_EXPERIMENTAL_BOOTSTRAP_RUNTIME_ORIGIN: 'https://runtime-b.example',
    })).toThrow('must be an exact HTTP(S) origin in')
    expect(() => readExperimentalRuntimePlacementConfig({
      KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://placement',
      KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST: 'https://runtime.example',
      KALA_INGRESS_EXPERIMENTAL_BOOTSTRAP_RUNTIME_ORIGIN: 'https://runtime.example/callback',
    })).toThrow('must be an exact HTTP(S) origin in')
  })
})

describe('Gateway Runtime reader audit', () => {
  const allowed = {
    can_create: false,
    can_create_db: false,
    elevated: false,
    forbidden_dml: false,
    owns_schema: false,
    owns_table: false,
    can_select_all: true,
  }

  it('accepts only a role with all five SELECT grants and no effective write, DDL, ownership, or elevation', async () => {
    const reader = executor([allowed])
    await expect(assertPostgresRuntimeReader(reader)).resolves.toBeUndefined()
    expect(reader.queries[0]!.values).toEqual([[
      'public.tenant_runtime_unit_placement_leases',
      'public.tenant_runtime_unit_protocol_gates',
      'public.tenant_runtime_unit_replica_memberships',
      'public.tenant_runtime_resource_ownerships',
      'public.tenant_session_latest_projection',
    ], [
      'public.tenant_runtime_unit_placement_leases',
      'public.tenant_runtime_unit_protocol_gates',
      'public.tenant_runtime_unit_replica_memberships',
      'public.tenant_runtime_resource_ownerships',
      'public.tenant_session_latest_projection',
      'public.kala_schema_migrations',
    ]])
    expect(reader.queries[0]!.sql).toContain("pg_has_role(current_user, rolname, 'MEMBER')")
  })

  it.each(['can_create', 'can_create_db', 'elevated', 'forbidden_dml', 'owns_schema', 'owns_table'] as const)(
    'rejects effective %s privilege',
    async (privilege) => {
      await expect(assertPostgresRuntimeReader(executor([{ ...allowed, [privilege]: true }]))).rejects.toThrow('read-only privilege audit')
    },
  )

  it('rejects a role missing any required SELECT grant', async () => {
    await expect(assertPostgresRuntimeReader(executor([{ ...allowed, can_select_all: false }]))).rejects.toThrow('read-only privilege audit')
  })
})

describe('safeRuntimeOrigin', () => {
  it.each([
    Object.assign(new URL('https://runtime.example'), { username: 'user' }).href,
    'https://runtime.example/path',
    'https://runtime.example?target=other',
    'https://runtime.example/#fragment',
    'file:///tmp/runtime.sock',
    'not a URL',
  ])('rejects unsafe origin %s', (value) => {
    expect(safeRuntimeOrigin(value)).toBeUndefined()
  })
})

type FakeExecutor = SqlExecutor & { queries: Array<{ sql: string; values: readonly unknown[] }> }

function executor(rows: Array<Record<string, unknown>>): FakeExecutor {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = []
  return {
    queries,
    async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
      queries.push({ sql, values })
      return { rows: rows as Row[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
    },
  }
}

function scriptedExecutor(...results: Array<Array<Record<string, unknown>>>): FakeExecutor {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = []
  return {
    queries,
    async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
      queries.push({ sql, values })
      const rows = results[queries.length - 1] ?? []
      return { rows: rows as Row[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
    },
  }
}
