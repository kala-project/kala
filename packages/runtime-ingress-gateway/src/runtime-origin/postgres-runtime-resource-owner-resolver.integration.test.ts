import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { issueRuntimeRoutingTicket } from '@agent-kernel/shared'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SqlExecutor } from '../persistence/postgres.js'
import { PostgresRuntimeResourceOwnerResolver } from './postgres-runtime-resource-owner-resolver.js'
import { assertPostgresRuntimeReader } from './postgres-runtime-origin-resolver.js'
import { RuntimeRoutingTicketResolver } from './runtime-routing-ticket-resolver.js'

const { Pool } = pg
const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgresRuntimeResourceOwnerResolver isolated PostgreSQL integration', () => {
  const testId = randomUUID()
  const container = `kala-resource-resolver-${testId}`
  const databaseName = `kala_resource_resolver_${testId.replaceAll('-', '')}`
  const password = randomUUID()
  const organizationId = randomUUID()
  const otherOrganizationId = randomUUID()
  const unitId = randomUUID()
  const sessionA = randomUUID()
  const sessionB = randomUUID()
  const taskId = randomUUID()
  let database: InstanceType<typeof Pool>
  let executor: SqlExecutor
  let port = ''

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', container,
      '--label', `dev.kala.test.project=${testId}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', `POSTGRES_PASSWORD=${password}`,
      '--env', `POSTGRES_DB=${databaseName}`,
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker(
      'inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container,
    )
    port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    database = new Pool({
      connectionString: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`,
    })
    executor = { query: (text, values) => database.query(text, values as unknown[] | undefined) }
    await eventually(async () => { await database.query('SELECT 1') }, 30_000)
    await createSchema(database)
    await seedOwners(database)
  }, 120_000)

  afterAll(async () => {
    await database?.end().catch(() => undefined)
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  it('audits a real SELECT-only Gateway credential and rejects migration-history write grants', async () => {
    const readerRole = `kala_reader_${testId.replaceAll('-', '')}`
    const readerPassword = randomUUID()
    await database.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await database.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}'`)
    await database.query(`GRANT USAGE ON SCHEMA public TO ${readerRole}`)
    for (const table of [
      'tenant_runtime_unit_placement_leases', 'tenant_runtime_unit_replica_memberships',
      'tenant_runtime_resource_ownerships', 'tenant_session_latest_projection',
      'tenant_runtime_unit_protocol_gates',
    ]) await database.query(`GRANT SELECT ON ${table} TO ${readerRole}`)
    const reader = new Pool({ connectionString: `postgresql://${readerRole}:${encodeURIComponent(readerPassword)}@127.0.0.1:${port}/${databaseName}` })
    try {
      const executor = { query: (text: string, values?: readonly unknown[]) => reader.query(text, values as unknown[] | undefined) }
      await expect(assertPostgresRuntimeReader(executor)).resolves.toBeUndefined()
      await database.query(`GRANT UPDATE ON kala_schema_migrations TO ${readerRole}`)
      await expect(assertPostgresRuntimeReader(executor)).rejects.toThrow('read-only privilege audit')
      await database.query(`REVOKE UPDATE ON kala_schema_migrations FROM ${readerRole}`)
    } finally { await reader.end() }
  })

  it('routes two Sessions and one Task to their live owners across two replicas', async () => {
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      executor, executor, new Set(['https://replica-a.example', 'https://replica-b.example']),
    )

    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionA }))
      .resolves.toBe('https://replica-a.example')
    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionB }))
      .resolves.toBe('https://replica-b.example')
    await expect(resolver.resolveTaskOwner({ organizationId, unitId, taskId }))
      .resolves.toBe('https://replica-b.example')
  })

  it('re-checks UUID-scoped tickets and rejects old generation, expired membership, cross-organization, forgery, expiry, and non-allowlisted origin', async () => {
    const key = new Uint8Array(32).fill(23)
    const nowMs = Date.now()
    const pgOwner = new PostgresRuntimeResourceOwnerResolver(
      executor, executor, new Set(['https://replica-a.example', 'https://replica-b.example']),
    )
    const resolver = new RuntimeRoutingTicketResolver({
      key, audience: 'gateway.integration', maxTtlMs: 60_000, ownerResolver: pgOwner, now: () => nowMs + 1,
    })
    const authenticatedScope = { principalId: 'integration_principal', organizationId, unitId }
    const ticket = issueRuntimeRoutingTicket({
      audience: 'gateway.integration', principalId: 'integration_principal', organizationId, unitId, resourceKind: 'session', resourceId: sessionA,
      ownerReplicaId: 'replica-a', ownerGeneration: 1n, ttlMs: 30_000,
    }, { key, maxTtlMs: 60_000, nowMs })
    await expect(resolver.resolveTicketForOrganization(ticket, authenticatedScope)).resolves.toBe('https://replica-a.example')

    await database.query(`UPDATE tenant_runtime_resource_ownerships SET generation=2
      WHERE organization_id=$1 AND unit_id=$2 AND resource_type='session' AND resource_id=$3`,
    [organizationId, unitId, sessionA])
    await expect(resolver.resolveTicketForOrganization(ticket, authenticatedScope)).resolves.toBeUndefined()
    await database.query(`UPDATE tenant_runtime_resource_ownerships SET generation=1
      WHERE organization_id=$1 AND unit_id=$2 AND resource_type='session' AND resource_id=$3`,
    [organizationId, unitId, sessionA])

    await database.query(`UPDATE tenant_runtime_unit_replica_memberships
      SET expires_at=clock_timestamp() - interval '1 second'
      WHERE organization_id=$1 AND unit_id=$2 AND replica_id='replica-a'`, [organizationId, unitId])
    await expect(resolver.resolveTicketForOrganization(ticket, authenticatedScope)).resolves.toBeUndefined()
    await database.query(`UPDATE tenant_runtime_unit_replica_memberships
      SET expires_at=clock_timestamp() + interval '1 minute'
      WHERE organization_id=$1 AND unit_id=$2 AND replica_id='replica-a'`, [organizationId, unitId])

    const crossOrganizationTicket = issueRuntimeRoutingTicket({
      audience: 'gateway.integration', principalId: 'integration_principal', organizationId: otherOrganizationId, unitId,
      resourceKind: 'session', resourceId: sessionA, ownerReplicaId: 'replica-a', ownerGeneration: 1n, ttlMs: 30_000,
    }, { key, maxTtlMs: 60_000, nowMs })
    await expect(resolver.resolveTicketForOrganization(crossOrganizationTicket, authenticatedScope)).resolves.toBeUndefined()
    await expect(resolver.resolveTicketForOrganization(`${ticket.slice(0, -1)}x`, authenticatedScope)).resolves.toBeUndefined()

    const expired = issueRuntimeRoutingTicket({
      audience: 'gateway.integration', principalId: 'integration_principal', organizationId, unitId, resourceKind: 'session', resourceId: sessionA,
      ownerReplicaId: 'replica-a', ownerGeneration: 1n, ttlMs: 1_000,
    }, { key, maxTtlMs: 60_000, nowMs: nowMs - 2_000 })
    await expect(resolver.resolveTicketForOrganization(expired, authenticatedScope)).resolves.toBeUndefined()

    const nonAllowlisted = new RuntimeRoutingTicketResolver({
      key, audience: 'gateway.integration', maxTtlMs: 60_000,
      ownerResolver: new PostgresRuntimeResourceOwnerResolver(executor, executor, new Set(['https://replica-b.example'])),
      now: () => nowMs + 1,
    })
    await expect(nonAllowlisted.resolveTicketForOrganization(ticket, authenticatedScope)).resolves.toBeUndefined()
  })

  it('rejects an owner row without a matching live Session document, while Task routes remain independent', async () => {
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      executor, executor, new Set(['https://replica-a.example', 'https://replica-b.example']),
    )
    const update = (document: object | null) => database.query(`UPDATE tenant_session_latest_projection
      SET document=$3::jsonb WHERE tenant_id=$1 AND session_id=$2`,
    [organizationId, sessionB, JSON.stringify(document)])
    const issuer = new RuntimeRoutingTicketResolver({
      key: new Uint8Array(32).fill(13), audience: 'gateway.integration', maxTtlMs: 20_000,
      ownerResolver: resolver, now: Date.now,
    })
    const identity = { principalId: 'integration_principal', organizationId, unitId }
    await update({ sessionId: sessionB, organizationId: otherOrganizationId })
    await expect(issuer.issueSessionTicketForOrganization(sessionB, identity)).resolves.toBeUndefined()
    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionB })).resolves.toBeUndefined()
    await update({ sessionId: sessionB, organizationId, __kalaSessionDeletion: { requestedAt: new Date().toISOString() } })
    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionB })).resolves.toBeUndefined()
    await update(null)
    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionB })).resolves.toBeUndefined()
    await expect(resolver.resolveTaskOwner({ organizationId, unitId, taskId })).resolves.toBe('https://replica-b.example')
    await update({ sessionId: sessionB, organizationId })
    const signed = await issuer.issueSessionTicketForOrganization(sessionB, identity)
    expect(signed).toBeTruthy()
    await expect(issuer.resolveSessionTicketForOrganization(signed, identity)).resolves.toBe('https://replica-b.example')
  })

  it('rejects stale ownership and stale exact replica membership', async () => {
    await database.query(`UPDATE tenant_runtime_resource_ownerships
      SET expires_at=clock_timestamp() - interval '1 second'
      WHERE organization_id=$1 AND unit_id=$2 AND resource_type='session' AND resource_id=$3`,
    [organizationId, unitId, sessionA])
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      executor, executor, new Set(['https://replica-a.example', 'https://replica-b.example']),
    )
    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionA })).resolves.toBeUndefined()

    await database.query(`UPDATE tenant_runtime_unit_replica_memberships
      SET expires_at=clock_timestamp() - interval '1 second'
      WHERE organization_id=$1 AND unit_id=$2 AND replica_id='replica-b'`, [organizationId, unitId])
    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionB })).resolves.toBeUndefined()
    await expect(resolver.resolveTaskOwner({ organizationId, unitId, taskId })).resolves.toBeUndefined()
  })

  it('rejects a different trusted organization and an origin outside the exact allowlist', async () => {
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      executor, executor, new Set(['https://replica-a.example']),
    )
    await expect(resolver.resolveSessionOwner({ organizationId: otherOrganizationId, unitId, sessionId: sessionB }))
      .resolves.toBeUndefined()

    await database.query(`UPDATE tenant_runtime_unit_replica_memberships
      SET expires_at=clock_timestamp() + interval '1 minute'
      WHERE organization_id=$1 AND unit_id=$2 AND replica_id='replica-b'`, [organizationId, unitId])
    await expect(resolver.resolveSessionOwner({ organizationId, unitId, sessionId: sessionB })).resolves.toBeUndefined()
  })

  async function seedOwners(database: InstanceType<typeof Pool>): Promise<void> {
    await database.query(`INSERT INTO organizations(id,runtime_unit_id) VALUES($1,$2)`, [organizationId, unitId])
    await database.query(`INSERT INTO runtime_unit_placements(runtime_unit_id,organization_id) VALUES($1,$2)`, [unitId, organizationId])
    await database.query(`INSERT INTO tenant_runtime_unit_replica_memberships
      (organization_id,unit_id,replica_id,membership_token,origin,generation,expires_at)
      VALUES ($1,$2,'replica-a','membership-a','https://replica-a.example',1,clock_timestamp() + interval '1 minute'),
             ($1,$2,'replica-b','membership-b','https://replica-b.example',1,clock_timestamp() + interval '1 minute')`,
    [organizationId, unitId])
    await database.query(`INSERT INTO tenant_runtime_resource_ownerships
      (organization_id,unit_id,resource_type,resource_id,replica_id,membership_generation,membership_token,owner_token,generation,expires_at)
      VALUES ($1,$2,'session',$3,'replica-a',1,'membership-a','owner-a',1,clock_timestamp() + interval '1 minute'),
             ($1,$2,'session',$4,'replica-b',1,'membership-b','owner-b',1,clock_timestamp() + interval '1 minute'),
             ($1,$2,'task',$5,'replica-b',1,'membership-b','owner-task',1,clock_timestamp() + interval '1 minute')`,
    [organizationId, unitId, sessionA, sessionB, taskId])
    await database.query(`INSERT INTO tenant_session_latest_projection (tenant_id,session_id,version,document)
      VALUES ($1,$2,1,$3::jsonb),($1,$4,1,$5::jsonb)`, [
      organizationId, sessionA, JSON.stringify({ sessionId: sessionA, organizationId }),
      sessionB, JSON.stringify({ sessionId: sessionB, organizationId }),
    ])
  }
})

async function createSchema(database: InstanceType<typeof Pool>): Promise<void> {
  await database.query(`CREATE TABLE organizations (
    id text PRIMARY KEY,
    runtime_unit_id text NOT NULL UNIQUE
  );
  CREATE TABLE runtime_unit_placements (
    runtime_unit_id text PRIMARY KEY,
    organization_id text NOT NULL UNIQUE
  );
  CREATE TABLE kala_schema_migrations (version integer PRIMARY KEY);
  CREATE TABLE tenant_runtime_unit_placement_leases (
    unit_id text PRIMARY KEY, organization_id text NOT NULL, origin text NOT NULL,
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE tenant_runtime_unit_protocol_gates (
    organization_id text NOT NULL, unit_id text NOT NULL,
    feature_version integer NOT NULL, barrier_generation bigint NOT NULL,
    PRIMARY KEY (organization_id, unit_id)
  );
  CREATE TABLE tenant_session_latest_projection (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    version bigint NOT NULL,
    document jsonb,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, session_id)
  );
  CREATE TABLE tenant_runtime_unit_replica_memberships (
    organization_id text NOT NULL,
    unit_id text NOT NULL,
    replica_id text NOT NULL,
    membership_token text NOT NULL,
    origin text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id,unit_id,replica_id)
  );
  CREATE TABLE tenant_runtime_resource_ownerships (
    organization_id text NOT NULL,
    resource_type text NOT NULL CHECK (resource_type IN ('session','task')),
    resource_id text NOT NULL,
    unit_id text NOT NULL,
    replica_id text NOT NULL,
    membership_generation bigint NOT NULL CHECK (membership_generation > 0),
    membership_token text NOT NULL,
    owner_token text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id,unit_id,resource_type,resource_id),
    FOREIGN KEY (organization_id,unit_id,replica_id)
      REFERENCES tenant_runtime_unit_replica_memberships(organization_id,unit_id,replica_id)
      ON DELETE RESTRICT
  )`)
}

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
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw lastError
}
