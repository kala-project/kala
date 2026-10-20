import pg from 'pg'

import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'

const { Pool } = pg

export interface RuntimeOriginResolver {
  /** Resolve one trusted Runtime Unit to an authoritative control upstream origin. */
  resolve(unitId: string): Promise<string | undefined>
  /** List opaque active replica ids for an operator-gated parallel Unit. */
  listReplicas?(unitId: string): Promise<readonly string[] | undefined>
  /** Resolve one exact active replica without falling back to another member. */
  resolveReplica?(unitId: string, replicaId: string): Promise<string | undefined>
}

/** Control-plane-only resolver used while a Host is acquiring a Unit lease. */
export interface RuntimeProvisioningOriginResolver {
  resolveProvisioningOrigin(unitId: string): Promise<string | undefined>
}

type PlacementRow = { organization_id: string; node_id: string; origin: string }
type ControlPlacementRow = { organization_id: string; placement_organization_id: string }
type ParallelControlRow = {
  feature_version: number
  barrier_generation: string
  node_id: string
  owner_token: string
  origin: string
  generation: string
  replica_id: string | null
  replica_origin: string | null
  owner_count: string
}

const PARALLEL_FEATURE_VERSION = 1
const PARALLEL_PLACEMENT_BARRIER = 'kala-parallel-placement-barrier-v1'
const PARALLEL_PLACEMENT_BARRIER_ORIGIN = 'https://parallel-placement-barrier.invalid'

const GATEWAY_RUNTIME_READER_TABLES = [
  'tenant_runtime_unit_placement_leases',
  'tenant_runtime_unit_protocol_gates',
  'tenant_runtime_unit_replica_memberships',
  'tenant_runtime_resource_ownerships',
  'tenant_session_latest_projection',
] as const

type RuntimeReaderAuditRow = {
  can_create: boolean
  can_create_db: boolean
  elevated: boolean
  forbidden_dml: boolean
  owns_schema: boolean
  owns_table: boolean
  can_select_all: boolean
}

/** Read-only resolver for Runtime-owned placement leases and operator-gated parallel replicas. */
export class PostgresRuntimeOriginResolver implements RuntimeOriginResolver {
  constructor(
    private readonly placements: SqlExecutor,
    private readonly controlPlane: SqlExecutor,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly bootstrapOrigin?: string,
  ) {
    if (allowedOrigins.size === 0) throw new Error('Runtime origin allowlist must not be empty')
    if (bootstrapOrigin && (safeRuntimeOrigin(bootstrapOrigin) !== bootstrapOrigin || !allowedOrigins.has(bootstrapOrigin))) {
      throw new Error('Runtime bootstrap origin must be an exact explicitly allowed origin')
    }
  }

  async resolve(unitId: string): Promise<string | undefined> {
    return this.resolveTrustedOrigin(unitId, false)
  }

  async resolveProvisioningOrigin(unitId: string): Promise<string | undefined> {
    return this.resolveTrustedOrigin(unitId, true)
  }

  async listReplicas(unitId: string): Promise<readonly string[] | undefined> {
    const parallel = await this.resolveParallelReplicasForUnit(unitId)
    return parallel?.map((replica) => replica.replicaId)
  }

  async resolveReplica(unitId: string, replicaId: string): Promise<string | undefined> {
    if (!replicaId) return undefined
    const parallel = await this.resolveParallelReplicasForUnit(unitId)
    return parallel?.find((replica) => replica.replicaId === replicaId)?.origin
  }

  private async resolveTrustedOrigin(unitId: string, allowBootstrap: boolean): Promise<string | undefined> {
    if (!unitId) return undefined
    const [leases, authority] = await Promise.all([
      this.placements.query<PlacementRow>(`SELECT organization_id,node_id,origin
        FROM tenant_runtime_unit_placement_leases
        WHERE unit_id=$1 AND expires_at > clock_timestamp()`, [unitId]),
      this.controlPlane.query<ControlPlacementRow>(`SELECT o.id AS organization_id,p.organization_id AS placement_organization_id
        FROM organizations o
        JOIN runtime_unit_placements p ON p.runtime_unit_id=o.runtime_unit_id
        WHERE o.runtime_unit_id=$1`, [unitId]),
    ])
    if (authority.rowCount !== 1 || !authority.rows[0]) return undefined
    const control = authority.rows[0]
    if (control.organization_id !== control.placement_organization_id) return undefined
    if (leases.rowCount === 0) return allowBootstrap ? this.bootstrapOrigin : undefined
    if (leases.rowCount !== 1 || !leases.rows[0]) return undefined
    const lease = leases.rows[0]
    if (lease.organization_id !== control.organization_id) return undefined
    if (lease.origin === PARALLEL_PLACEMENT_BARRIER_ORIGIN) {
      return this.resolveParallelControlOrigin(unitId, control.organization_id, lease)
    }
    const origin = safeRuntimeOrigin(lease.origin)
    return origin && this.allowedOrigins.has(origin) ? origin : undefined
  }

  private async resolveParallelControlOrigin(
    unitId: string,
    organizationId: string,
    lease: PlacementRow,
  ): Promise<string | undefined> {
    const replicas = await this.resolveParallelReplicas(unitId, organizationId, lease)
    return replicas?.[0]?.origin
  }

  private async resolveParallelReplicasForUnit(unitId: string): Promise<Array<{ replicaId: string; origin: string }> | undefined> {
    if (!unitId) return undefined
    const [leases, authority] = await Promise.all([
      this.placements.query<PlacementRow>(`SELECT organization_id,node_id,origin
        FROM tenant_runtime_unit_placement_leases
        WHERE unit_id=$1 AND expires_at > clock_timestamp()`, [unitId]),
      this.controlPlane.query<ControlPlacementRow>(`SELECT o.id AS organization_id,p.organization_id AS placement_organization_id
        FROM organizations o
        JOIN runtime_unit_placements p ON p.runtime_unit_id=o.runtime_unit_id
        WHERE o.runtime_unit_id=$1`, [unitId]),
    ])
    if (authority.rowCount !== 1 || !authority.rows[0] || leases.rowCount !== 1 || !leases.rows[0]) return undefined
    const control = authority.rows[0]
    const lease = leases.rows[0]
    if (control.organization_id !== control.placement_organization_id || lease.organization_id !== control.organization_id
      || lease.origin !== PARALLEL_PLACEMENT_BARRIER_ORIGIN) return undefined
    return this.resolveParallelReplicas(unitId, control.organization_id, lease)
  }

  private async resolveParallelReplicas(
    unitId: string,
    organizationId: string,
    lease: PlacementRow,
  ): Promise<Array<{ replicaId: string; origin: string }> | undefined> {
    if (lease.node_id !== PARALLEL_PLACEMENT_BARRIER) return undefined
    const result = await this.placements.query<ParallelControlRow>(`SELECT
        gate.feature_version,gate.barrier_generation,
        placement.node_id,placement.owner_token,placement.origin,placement.generation,
        replica.replica_id,replica.origin AS replica_origin,
        count(owner.resource_id)::text AS owner_count
      FROM tenant_runtime_unit_protocol_gates AS gate
      JOIN tenant_runtime_unit_placement_leases AS placement
        ON placement.organization_id=gate.organization_id AND placement.unit_id=gate.unit_id
      LEFT JOIN tenant_runtime_unit_replica_memberships AS replica
        ON replica.organization_id=gate.organization_id AND replica.unit_id=gate.unit_id
        AND replica.expires_at > clock_timestamp()
      LEFT JOIN tenant_runtime_resource_ownerships AS owner
        ON owner.organization_id=replica.organization_id AND owner.unit_id=replica.unit_id
        AND owner.replica_id=replica.replica_id AND owner.expires_at > clock_timestamp()
      WHERE gate.unit_id=$1 AND gate.organization_id=$2
        AND placement.expires_at > clock_timestamp()
      GROUP BY gate.feature_version,gate.barrier_generation,
        placement.node_id,placement.owner_token,placement.origin,placement.generation,
        replica.replica_id,replica.origin
      ORDER BY count(owner.resource_id),replica.replica_id`, [unitId, organizationId])
    const first = result.rows[0]
    if (!first
      || Number(first.feature_version) !== PARALLEL_FEATURE_VERSION
      || first.node_id !== PARALLEL_PLACEMENT_BARRIER
      || first.owner_token !== PARALLEL_PLACEMENT_BARRIER
      || first.origin !== PARALLEL_PLACEMENT_BARRIER_ORIGIN
      || !sameGeneration(first.generation, first.barrier_generation)) return undefined

    const replicas: Array<{ replicaId: string; origin: string }> = []
    for (const replica of result.rows) {
      const origin = replica.replica_origin ? safeRuntimeOrigin(replica.replica_origin) : undefined
      if (replica.replica_id && origin && this.allowedOrigins.has(origin)) replicas.push({ replicaId: replica.replica_id, origin })
    }
    return replicas
  }
}

export type ExperimentalRuntimePlacementConfig = {
  connectionString: string
  readerConnectionString?: string
  allowedOrigins: ReadonlySet<string>
  bootstrapOrigin?: string
}

export function readExperimentalRuntimePlacementConfig(env: NodeJS.ProcessEnv): ExperimentalRuntimePlacementConfig | undefined {
  const enabled = env.KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE
  const connectionString = env.KALA_INGRESS_EXPERIMENTAL_POSTGRES_CONNECTION_STRING?.trim()
  const readerConnectionString = env.KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING?.trim()
  const rawAllowlist = env.KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST?.trim()
  const rawBootstrapOrigin = env.KALA_INGRESS_EXPERIMENTAL_BOOTSTRAP_RUNTIME_ORIGIN?.trim()
  if (enabled !== '1') {
    if (connectionString || readerConnectionString || rawAllowlist || rawBootstrapOrigin || (enabled !== undefined && enabled !== '')) {
      throw new Error('KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE=1 is required for experimental Runtime placement settings')
    }
    return undefined
  }
  if (!connectionString && !readerConnectionString) {
    throw new Error('An experimental Runtime placement PostgreSQL reader connection string is required')
  }
  if (!rawAllowlist) throw new Error('KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST is required')
  const allowedOrigins = new Set<string>()
  for (const value of rawAllowlist.split(',').map((item) => item.trim()).filter(Boolean)) {
    const origin = safeRuntimeOrigin(value)
    if (!origin) throw new Error('KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST must contain only exact HTTP(S) origins')
    allowedOrigins.add(origin)
  }
  if (allowedOrigins.size === 0) throw new Error('KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST must not be empty')
  const bootstrapOrigin = rawBootstrapOrigin ? safeRuntimeOrigin(rawBootstrapOrigin) : undefined
  if (rawBootstrapOrigin && (!bootstrapOrigin || !allowedOrigins.has(bootstrapOrigin))) {
    throw new Error('KALA_INGRESS_EXPERIMENTAL_BOOTSTRAP_RUNTIME_ORIGIN must be an exact HTTP(S) origin in KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST')
  }
  return {
    connectionString: connectionString ?? readerConnectionString!,
    ...(readerConnectionString ? { readerConnectionString } : {}),
    allowedOrigins,
    ...(bootstrapOrigin ? { bootstrapOrigin } : {}),
  }
}

/** Tickets expose Session/Task lookup, so they require the separately provisioned and audited reader credential. */
export function runtimeReaderConnectionString(
  config: ExperimentalRuntimePlacementConfig,
  routingTicketsEnabled: boolean,
): { connectionString: string; audit: boolean } {
  if (config.readerConnectionString) {
    if (routingTicketsEnabled && config.connectionString !== config.readerConnectionString) {
      throw new Error('Remove the legacy Runtime placement PostgreSQL credential when Runtime routing tickets are configured')
    }
    return { connectionString: config.readerConnectionString, audit: true }
  }
  if (routingTicketsEnabled) {
    throw new Error('KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING is required when Runtime routing tickets are configured')
  }
  return { connectionString: config.connectionString, audit: false }
}

/** Verify effective privileges through the supplied credential before any ticket owner-query pool is opened. */
export async function assertPostgresRuntimeReader(executor: SqlExecutor): Promise<void> {
  const tables = GATEWAY_RUNTIME_READER_TABLES.map((table) => `public.${table}`)
  const writeProtectedTables = [...tables, 'public.kala_schema_migrations']
  const result = await executor.query<RuntimeReaderAuditRow>(`SELECT
    has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
    has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_db,
    EXISTS (SELECT 1 FROM pg_roles WHERE pg_has_role(current_user, rolname, 'MEMBER')
      AND (rolsuper OR rolcreatedb OR rolcreaterole)) AS elevated,
    EXISTS (SELECT 1 FROM unnest($2::text[]) AS guarded(table_name)
      WHERE has_table_privilege(current_user, guarded.table_name, 'INSERT')
        OR has_table_privilege(current_user, guarded.table_name, 'UPDATE')
        OR has_table_privilege(current_user, guarded.table_name, 'DELETE')
        OR has_table_privilege(current_user, guarded.table_name, 'TRUNCATE')
        OR has_table_privilege(current_user, guarded.table_name, 'REFERENCES')
        OR has_table_privilege(current_user, guarded.table_name, 'TRIGGER')) AS forbidden_dml,
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public'
      AND pg_has_role(current_user, pg_get_userbyid(nspowner), 'MEMBER')) AS owns_schema,
    EXISTS (SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND pg_has_role(current_user, pg_get_userbyid(c.relowner), 'MEMBER')) AS owns_table,
    NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS required(table_name)
      WHERE NOT has_table_privilege(current_user, required.table_name, 'SELECT')) AS can_select_all`, [tables, writeProtectedTables])
  const permissions = result.rowCount === 1 ? result.rows[0] : undefined
  if (!permissions || permissions.can_create || permissions.can_create_db || permissions.elevated
    || permissions.forbidden_dml || permissions.owns_schema || permissions.owns_table || !permissions.can_select_all) {
    throw new Error('Gateway Runtime reader credential failed the read-only privilege audit')
  }
}

export async function auditPostgresRuntimeReaderConnection(connectionString: string): Promise<void> {
  const pool = new Pool({
    connectionString,
    application_name: 'kala-runtime-ingress-reader-audit',
    max: 1,
    connectionTimeoutMillis: 5_000,
  })
  try {
    await assertPostgresRuntimeReader({ query: (text, values) => pool.query(text, values as unknown[] | undefined) })
  } finally {
    await pool.end()
  }
}

export function createPostgresRuntimeOriginResolver(options: {
  connectionString: string
  allowedOrigins: ReadonlySet<string>
  bootstrapOrigin?: string
  controlPlane: ControlPlaneDatabase
  maxConnections?: number
  statementTimeoutMs?: number
}): RuntimeOriginResolver & RuntimeProvisioningOriginResolver & { close(): Promise<void> } {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: 'kala-runtime-ingress-placement-reader',
    max: options.maxConnections ?? 5,
    statement_timeout: options.statementTimeoutMs ?? 5_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
  const resolver = new PostgresRuntimeOriginResolver(
    { query: (text, values) => pool.query(text, values as unknown[] | undefined) },
    options.controlPlane,
    options.allowedOrigins,
    options.bootstrapOrigin,
  )
  return {
    resolve: (unitId) => resolver.resolve(unitId),
    listReplicas: (unitId) => resolver.listReplicas(unitId),
    resolveReplica: (unitId, replicaId) => resolver.resolveReplica(unitId, replicaId),
    resolveProvisioningOrigin: (unitId) => resolver.resolveProvisioningOrigin(unitId),
    close: () => pool.end(),
  }
}

function sameGeneration(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right)
  } catch {
    return false
  }
}

export function safeRuntimeOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}
