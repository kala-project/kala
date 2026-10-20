import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SqlExecutor } from '../persistence/postgres.js'
import {
  assertPostgresRuntimeReader,
  PostgresRuntimeOriginResolver,
} from './postgres-runtime-origin-resolver.js'
import { PostgresRuntimeResourceOwnerResolver } from './postgres-runtime-resource-owner-resolver.js'
import { RuntimeRoutingTicketResolver } from './runtime-routing-ticket-resolver.js'

const { Pool } = pg
const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgresRuntimeOriginResolver isolated PostgreSQL integration', () => {
  const testId = randomUUID()
  const container = `kala-origin-resolver-${testId}`
  const databaseName = `kala_origin_${testId.replaceAll('-', '')}`
  const password = randomUUID()
  const readerRole = `kala_gateway_${testId.replaceAll('-', '')}`
  const readerPassword = randomUUID()
  const organizationId = randomUUID()
  const unitId = randomUUID()
  const sessionId = randomUUID()
  const replicaAOrigin = 'https://replica-a.example'
  const replicaBOrigin = 'https://replica-b.example'
  let database: InstanceType<typeof Pool>
  let reader: InstanceType<typeof Pool>
  let operatorExecutor: SqlExecutor
  let readerExecutor: SqlExecutor
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
    operatorExecutor = { query: (text, values) => database.query(text, values as unknown[] | undefined) }
    await eventually(async () => { await database.query('SELECT 1') }, 30_000)
    await createHostV5MinimalSchema(database)
    await seedParallelUnit(database, { organizationId, unitId, sessionId, replicaAOrigin, replicaBOrigin })

    await database.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await database.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}'`)
    await database.query(`GRANT USAGE ON SCHEMA public TO ${readerRole}`)
    for (const table of [
      'tenant_runtime_unit_placement_leases',
      'tenant_runtime_unit_protocol_gates',
      'tenant_runtime_unit_replica_memberships',
      'tenant_runtime_resource_ownerships',
      'tenant_session_latest_projection',
    ]) await database.query(`GRANT SELECT ON ${table} TO ${readerRole}`)

    reader = new Pool({
      connectionString: `postgresql://${readerRole}:${encodeURIComponent(readerPassword)}@127.0.0.1:${port}/${databaseName}`,
    })
    readerExecutor = { query: (text, values) => reader.query(text, values as unknown[] | undefined) }
  }, 120_000)

  afterAll(async () => {
    await reader?.end().catch(() => undefined)
    await database?.end().catch(() => undefined)
    await docker('rm', '--force', container).catch(() => undefined)
    const { stdout } = await docker(
      'ps', '--all', '--quiet', '--filter', `label=dev.kala.test.project=${testId}`,
    )
    expect(stdout.trim()).toBe('')
  }, 30_000)

  it('selects only a live allowlisted replica through the SELECT-only Gateway role and fails closed on a future gate', async () => {
    await expect(assertPostgresRuntimeReader(readerExecutor)).resolves.toBeUndefined()
    await expect(reader.query(`UPDATE tenant_runtime_unit_protocol_gates SET feature_version=2
      WHERE organization_id=$1 AND unit_id=$2`, [organizationId, unitId]))
      .rejects.toMatchObject({ code: '42501' })

    const resolver = new PostgresRuntimeOriginResolver(
      readerExecutor,
      operatorExecutor,
      new Set([replicaAOrigin, replicaBOrigin]),
    )
    await expect(resolver.resolve(unitId)).resolves.toBe(replicaAOrigin)
    await expect(resolver.resolve(unitId)).resolves.not.toBe('https://parallel-placement-barrier.invalid')

    await database.query(`UPDATE tenant_runtime_unit_replica_memberships
      SET expires_at=clock_timestamp() - interval '1 second'
      WHERE organization_id=$1 AND unit_id=$2 AND replica_id='replica-a'`, [organizationId, unitId])
    await expect(resolver.resolve(unitId)).resolves.toBe(replicaBOrigin)
    await database.query(`UPDATE tenant_runtime_unit_replica_memberships
      SET expires_at=clock_timestamp() + interval '1 hour'
      WHERE organization_id=$1 AND unit_id=$2 AND replica_id='replica-a'`, [organizationId, unitId])

    const replicaBOnly = new PostgresRuntimeOriginResolver(
      readerExecutor,
      operatorExecutor,
      new Set([replicaBOrigin]),
    )
    await expect(replicaBOnly.resolve(unitId)).resolves.toBe(replicaBOrigin)

    await database.query(`UPDATE tenant_runtime_unit_protocol_gates SET feature_version=2
      WHERE organization_id=$1 AND unit_id=$2`, [organizationId, unitId])
    try {
      await expect(resolver.resolve(unitId)).resolves.toBeUndefined()
    } finally {
      await database.query(`UPDATE tenant_runtime_unit_protocol_gates SET feature_version=1
        WHERE organization_id=$1 AND unit_id=$2`, [organizationId, unitId])
    }
  })

  it('keeps Session route-ticket owner lookup independent of the parallel Unit control gate', async () => {
    const ownerResolver = new PostgresRuntimeResourceOwnerResolver(
      readerExecutor,
      operatorExecutor,
      new Set([replicaAOrigin, replicaBOrigin]),
    )
    const tickets = new RuntimeRoutingTicketResolver({
      key: new Uint8Array(32).fill(29),
      audience: 'gateway.origin.integration',
      maxTtlMs: 30_000,
      ownerResolver,
      now: Date.now,
    })
    const identity = { principalId: 'integration-principal', organizationId, unitId }

    await database.query(`UPDATE tenant_runtime_unit_protocol_gates SET feature_version=2
      WHERE organization_id=$1 AND unit_id=$2`, [organizationId, unitId])
    try {
      const controlResolver = new PostgresRuntimeOriginResolver(
        readerExecutor,
        operatorExecutor,
        new Set([replicaAOrigin, replicaBOrigin]),
      )
      await expect(controlResolver.resolve(unitId)).resolves.toBeUndefined()
      await expect(ownerResolver.resolveSessionOwner({ organizationId, unitId, sessionId }))
        .resolves.toBe(replicaBOrigin)

      const ticket = await tickets.issueSessionTicketForOrganization(sessionId, identity)
      expect(ticket).toBeTruthy()
      await expect(tickets.resolveSessionTicketForOrganization(ticket, identity)).resolves.toBe(replicaBOrigin)
    } finally {
      await database.query(`UPDATE tenant_runtime_unit_protocol_gates SET feature_version=1
        WHERE organization_id=$1 AND unit_id=$2`, [organizationId, unitId])
    }
  })
})

type ParallelSeed = {
  organizationId: string
  unitId: string
  sessionId: string
  replicaAOrigin: string
  replicaBOrigin: string
}

async function seedParallelUnit(database: InstanceType<typeof Pool>, seed: ParallelSeed): Promise<void> {
  await database.query('INSERT INTO organizations(id,runtime_unit_id) VALUES($1,$2)', [seed.organizationId, seed.unitId])
  await database.query('INSERT INTO runtime_unit_placements(runtime_unit_id,organization_id) VALUES($1,$2)', [
    seed.unitId, seed.organizationId,
  ])
  await database.query(`INSERT INTO tenant_runtime_unit_placement_leases
    (unit_id,organization_id,node_id,owner_token,origin,generation,expires_at)
    VALUES ($1,$2,'kala-parallel-placement-barrier-v1','kala-parallel-placement-barrier-v1',
      'https://parallel-placement-barrier.invalid',7,'infinity')`, [seed.unitId, seed.organizationId])
  await database.query(`INSERT INTO tenant_runtime_unit_protocol_gates
    (organization_id,unit_id,feature_version,barrier_generation) VALUES($1,$2,1,7)`, [
    seed.organizationId, seed.unitId,
  ])
  await database.query(`INSERT INTO tenant_runtime_unit_replica_memberships
    (organization_id,unit_id,replica_id,membership_token,origin,generation,expires_at)
    VALUES ($1,$2,'replica-a','membership-a',$3,1,clock_timestamp() + interval '1 hour'),
           ($1,$2,'replica-b','membership-b',$4,1,clock_timestamp() + interval '1 hour')`, [
    seed.organizationId, seed.unitId, seed.replicaAOrigin, seed.replicaBOrigin,
  ])
  await database.query(`INSERT INTO tenant_runtime_resource_ownerships
    (organization_id,resource_type,resource_id,unit_id,replica_id,membership_generation,
      membership_token,owner_token,generation,expires_at)
    VALUES ($1,'session',$3,$2,'replica-b',1,'membership-b','session-owner',1,
      clock_timestamp() + interval '1 hour')`, [seed.organizationId, seed.unitId, seed.sessionId])
  await database.query(`INSERT INTO tenant_session_latest_projection
    (tenant_id,session_id,version,document) VALUES($1,$2,1,$3::jsonb)`, [
    seed.organizationId,
    seed.sessionId,
    JSON.stringify({ sessionId: seed.sessionId, organizationId: seed.organizationId }),
  ])
}

/**
 * Exact minimal copies of the Host v1/v3/v5 tables and v5 operator triggers used here.
 * This exercises PostgreSQL constraints and the operator gate, but intentionally does
 * not claim coverage of migratePostgres ordering, checksums, or unrelated Host tables.
 */
async function createHostV5MinimalSchema(database: InstanceType<typeof Pool>): Promise<void> {
  await database.query(`CREATE TABLE organizations (
    id text PRIMARY KEY,
    runtime_unit_id text NOT NULL UNIQUE
  );
  CREATE TABLE runtime_unit_placements (
    runtime_unit_id text PRIMARY KEY,
    organization_id text NOT NULL UNIQUE
  );
  CREATE TABLE kala_schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE TABLE tenant_runtime_unit_placement_leases (
    unit_id text NOT NULL,
    organization_id text NOT NULL,
    node_id text NOT NULL,
    owner_token text NOT NULL,
    origin text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (unit_id, organization_id)
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
    PRIMARY KEY (organization_id, unit_id, replica_id)
  );
  CREATE TABLE tenant_runtime_resource_ownerships (
    organization_id text NOT NULL,
    resource_type text NOT NULL CHECK (resource_type IN ('session', 'task')),
    resource_id text NOT NULL,
    unit_id text NOT NULL,
    replica_id text NOT NULL,
    membership_generation bigint NOT NULL CHECK (membership_generation > 0),
    membership_token text NOT NULL,
    owner_token text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, unit_id, resource_type, resource_id),
    FOREIGN KEY (organization_id, unit_id, replica_id)
      REFERENCES tenant_runtime_unit_replica_memberships (organization_id, unit_id, replica_id)
      ON DELETE RESTRICT
  );
  CREATE TABLE tenant_session_latest_projection (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    document jsonb,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, session_id)
  );
  CREATE TABLE tenant_runtime_unit_protocol_gates (
    organization_id text NOT NULL,
    unit_id text NOT NULL,
    feature_version integer NOT NULL CHECK (feature_version > 0),
    barrier_generation bigint NOT NULL CHECK (barrier_generation > 0),
    enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, unit_id)
  );
  CREATE OR REPLACE FUNCTION kala_guard_parallel_placement_barrier()
    RETURNS trigger LANGUAGE plpgsql AS $kala$
    DECLARE gate_exists boolean;
    BEGIN
      IF NEW.node_id = 'kala-parallel-placement-barrier-v1' THEN
        IF NEW.owner_token <> 'kala-parallel-placement-barrier-v1'
          OR NEW.origin <> 'https://parallel-placement-barrier.invalid'
          OR NEW.expires_at <> 'infinity'::timestamptz THEN
          RAISE EXCEPTION 'invalid Kala parallel placement barrier' USING ERRCODE = 'check_violation';
        END IF;
        IF TG_OP = 'UPDATE'
          AND OLD.node_id <> 'kala-parallel-placement-barrier-v1'
          AND OLD.expires_at > clock_timestamp() THEN
          RAISE EXCEPTION 'cannot replace a live legacy Runtime Unit placement with a parallel barrier'
            USING ERRCODE = 'object_in_use';
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.node_id = 'kala-parallel-placement-barrier-v1'
        AND (NEW.node_id, NEW.owner_token, NEW.origin, NEW.generation, NEW.expires_at)
          IS DISTINCT FROM (OLD.node_id, OLD.owner_token, OLD.origin, OLD.generation, OLD.expires_at) THEN
        SELECT EXISTS (SELECT 1 FROM tenant_runtime_unit_protocol_gates
          WHERE organization_id = OLD.organization_id AND unit_id = OLD.unit_id) INTO gate_exists;
        IF gate_exists THEN
          RAISE EXCEPTION 'cannot modify an enabled Kala parallel placement barrier'
            USING ERRCODE = 'object_in_use';
        END IF;
      END IF;
      RETURN NEW;
    END
    $kala$;
  CREATE TRIGGER kala_guard_parallel_placement_barrier
    BEFORE INSERT OR UPDATE ON tenant_runtime_unit_placement_leases
    FOR EACH ROW EXECUTE FUNCTION kala_guard_parallel_placement_barrier();
  CREATE OR REPLACE FUNCTION kala_validate_runtime_unit_protocol_gate()
    RETURNS trigger LANGUAGE plpgsql AS $kala$
    DECLARE placement record;
    BEGIN
      SELECT node_id, owner_token, origin, generation, expires_at INTO placement
        FROM tenant_runtime_unit_placement_leases
        WHERE organization_id = NEW.organization_id AND unit_id = NEW.unit_id
        FOR UPDATE;
      IF NOT FOUND
        OR placement.node_id <> 'kala-parallel-placement-barrier-v1'
        OR placement.owner_token <> 'kala-parallel-placement-barrier-v1'
        OR placement.origin <> 'https://parallel-placement-barrier.invalid'
        OR placement.generation <> NEW.barrier_generation
        OR placement.expires_at <> 'infinity'::timestamptz THEN
        RAISE EXCEPTION 'Runtime Unit protocol gate requires its exact permanent placement barrier'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $kala$;
  CREATE TRIGGER kala_validate_runtime_unit_protocol_gate
    BEFORE INSERT OR UPDATE ON tenant_runtime_unit_protocol_gates
    FOR EACH ROW EXECUTE FUNCTION kala_validate_runtime_unit_protocol_gate()`)
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
