import pg from 'pg'

import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { safeRuntimeOrigin } from './postgres-runtime-origin-resolver.js'

const { Pool } = pg

const ORGANIZATION_ID = /^org_[0-9A-Za-z_-]{1,123}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const RUNTIME_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/u

export type RuntimeResourceOwnerScope = {
  /** Trusted control-plane organization, eventually supplied by a verified signed route ticket. */
  organizationId: string
  unitId: string
}

export type RuntimeSessionOwnerInput = RuntimeResourceOwnerScope & { sessionId: string }
export type RuntimeTaskOwnerInput = RuntimeResourceOwnerScope & { taskId: string }
export type RuntimeResourceOwnerInput = RuntimeResourceOwnerScope & {
  resourceType: 'session' | 'task'
  resourceId: string
}

/**
 * Experimental read-only Session/Task owner lookup. Callers must not construct
 * these inputs from an unauthenticated query parameter or header.
 */
export interface RuntimeResourceOwnerResolver {
  resolveResourceOwner(input: RuntimeResourceOwnerInput): Promise<string | undefined>
  resolveSessionOwner(input: RuntimeSessionOwnerInput): Promise<string | undefined>
  resolveTaskOwner(input: RuntimeTaskOwnerInput): Promise<string | undefined>
}

export type RuntimeResourceOwnerBinding = {
  origin: string
  replicaId: string
  generation: bigint
}

export type RuntimeSessionRouteState =
  | { status: 'live'; binding: RuntimeResourceOwnerBinding }
  | { status: 'deleting' | 'missing' | 'relocating' }

export interface RuntimeResourceOwnerBindingResolver {
  resolveResourceOwnerBinding(input: RuntimeResourceOwnerInput): Promise<RuntimeResourceOwnerBinding | undefined>
  resolveSessionRouteState?(input: RuntimeSessionOwnerInput): Promise<RuntimeSessionRouteState>
}

type AuthorityRow = { organization_id: string; placement_organization_id: string; runtime_unit_id: string }
type OwnerRow = { origin: string; replica_id: string; generation: string }
type SessionRouteRow = { document: unknown; origin: string | null; replica_id: string | null; generation: string | null }

/**
 * Resolves only an ownership row whose exact replica membership and ownership
 * are both live, after verifying the organization-to-Unit bind in control-plane PG.
 */
export class PostgresRuntimeResourceOwnerResolver implements RuntimeResourceOwnerResolver {
  readonly #allowedOrigins: ReadonlySet<string>

  constructor(
    private readonly resources: SqlExecutor,
    private readonly controlPlane: SqlExecutor,
    allowedOrigins: ReadonlySet<string>,
  ) {
    if (allowedOrigins.size === 0) throw new Error('Runtime resource owner origin allowlist must not be empty')
    for (const origin of allowedOrigins) {
      if (safeRuntimeOrigin(origin) !== origin) {
        throw new Error('Runtime resource owner origin allowlist must contain only exact canonical HTTP(S) origins')
      }
    }
    this.#allowedOrigins = new Set(allowedOrigins)
  }

  async resolveSessionOwner(input: RuntimeSessionOwnerInput): Promise<string | undefined> {
    return this.resolveResourceOwner({ ...input, resourceType: 'session', resourceId: input.sessionId })
  }

  async resolveTaskOwner(input: RuntimeTaskOwnerInput): Promise<string | undefined> {
    return this.resolveResourceOwner({ ...input, resourceType: 'task', resourceId: input.taskId })
  }

  async resolveResourceOwner(input: RuntimeResourceOwnerInput): Promise<string | undefined> {
    return (await this.resolveResourceOwnerBinding(input))?.origin
  }

  async resolveSessionRouteState(input: RuntimeSessionOwnerInput): Promise<RuntimeSessionRouteState> {
    if (!validOrganizationId(input.organizationId) || !validRuntimeId(input.unitId)
      || !validRuntimeId(input.sessionId)) return { status: 'missing' }

    const authority = await this.controlPlane.query<AuthorityRow>(`SELECT o.id AS organization_id,
        p.organization_id AS placement_organization_id,o.runtime_unit_id
      FROM organizations o
      JOIN runtime_unit_placements p ON p.runtime_unit_id=o.runtime_unit_id
      WHERE o.id=$1 AND o.runtime_unit_id=$2`, [input.organizationId, input.unitId])
    if (!hasExactAuthority(authority.rows, authority.rowCount, input)) return { status: 'missing' }

    const routes = await this.resources.query<SessionRouteRow>(`SELECT projection.document,member.origin,
        ownership.replica_id,ownership.generation
      FROM tenant_session_latest_projection AS projection
      LEFT JOIN tenant_runtime_resource_ownerships AS ownership
        ON ownership.organization_id = projection.tenant_id
        AND ownership.unit_id = $2
        AND ownership.resource_type = 'session'
        AND ownership.resource_id = projection.session_id
        AND ownership.expires_at > clock_timestamp()
      LEFT JOIN tenant_runtime_unit_replica_memberships AS member
        ON member.organization_id = ownership.organization_id
        AND member.unit_id = ownership.unit_id
        AND member.replica_id = ownership.replica_id
        AND member.generation = ownership.membership_generation
        AND member.membership_token = ownership.membership_token
        AND member.expires_at > clock_timestamp()
      WHERE projection.tenant_id = $1 AND projection.session_id = $3`, [
      input.organizationId, input.unitId, input.sessionId,
    ])
    if (routes.rowCount === 0) return { status: 'missing' }
    if (routes.rowCount !== 1 || !routes.rows[0]) return { status: 'relocating' }
    const route = routes.rows[0]
    // Final deletion retains the projection row with a JSON null document.
    if (route.document == null) return { status: 'missing' }
    const document = isRecord(route.document) ? route.document : undefined
    if (document?.sessionId !== input.sessionId || document.organizationId !== input.organizationId) {
      return { status: 'relocating' }
    }
    if (Object.prototype.hasOwnProperty.call(document, '__kalaSessionDeletion')) return { status: 'deleting' }
    const binding = this.#safeBinding(route)
    return binding ? { status: 'live', binding } : { status: 'relocating' }
  }

  async resolveResourceOwnerBinding(input: RuntimeResourceOwnerInput): Promise<RuntimeResourceOwnerBinding | undefined> {
    if (!validOrganizationId(input.organizationId) || !validRuntimeId(input.unitId)
      || !validRuntimeId(input.resourceId)
      || (input.resourceType !== 'session' && input.resourceType !== 'task')) return undefined

    const authority = await this.controlPlane.query<AuthorityRow>(`SELECT o.id AS organization_id,
        p.organization_id AS placement_organization_id,o.runtime_unit_id
      FROM organizations o
      JOIN runtime_unit_placements p ON p.runtime_unit_id=o.runtime_unit_id
      WHERE o.id=$1 AND o.runtime_unit_id=$2`, [input.organizationId, input.unitId])
    if (authority.rowCount !== 1 || !authority.rows[0]) return undefined
    const bind = authority.rows[0]
    if (bind.organization_id !== input.organizationId || bind.placement_organization_id !== input.organizationId
      || bind.runtime_unit_id !== input.unitId) return undefined

    const owners = await this.resources.query<OwnerRow>(`SELECT member.origin,ownership.replica_id,ownership.generation
      FROM tenant_runtime_resource_ownerships AS ownership
      INNER JOIN tenant_runtime_unit_replica_memberships AS member
        ON member.organization_id = ownership.organization_id
        AND member.unit_id = ownership.unit_id
        AND member.replica_id = ownership.replica_id
        AND member.generation = ownership.membership_generation
        AND member.membership_token = ownership.membership_token
      WHERE ownership.organization_id = $1 AND ownership.unit_id = $2
        AND ownership.resource_type = $3 AND ownership.resource_id = $4
        AND ownership.expires_at > clock_timestamp()
        AND member.expires_at > clock_timestamp()
        AND (ownership.resource_type <> 'session' OR EXISTS (
          SELECT 1 FROM tenant_session_latest_projection AS projection
          WHERE projection.tenant_id = ownership.organization_id
            AND projection.session_id = ownership.resource_id
            AND projection.document ->> 'sessionId' = ownership.resource_id
            AND projection.document ->> 'organizationId' = ownership.organization_id
            AND NOT (projection.document ? '__kalaSessionDeletion')
        ))`, [
      input.organizationId, input.unitId, input.resourceType, input.resourceId,
    ])
    if (owners.rowCount !== 1 || !owners.rows[0]) return undefined
    return this.#safeBinding(owners.rows[0])
  }

  #safeBinding(owner: { origin: string | null; replica_id: string | null; generation: string | null }): RuntimeResourceOwnerBinding | undefined {
    if (typeof owner.origin !== 'string') return undefined
    const origin = safeRuntimeOrigin(owner.origin)
    const replicaId = owner.replica_id
    if (!origin || !this.#allowedOrigins.has(origin) || !validRuntimeId(replicaId)
      || typeof owner.generation !== 'string' || !/^[1-9][0-9]*$/u.test(owner.generation)) return undefined
    return { origin, replicaId, generation: BigInt(owner.generation) }
  }
}

export function createPostgresRuntimeResourceOwnerResolver(options: {
  connectionString: string
  allowedOrigins: ReadonlySet<string>
  controlPlane: ControlPlaneDatabase
  maxConnections?: number
  statementTimeoutMs?: number
}): RuntimeResourceOwnerResolver & RuntimeResourceOwnerBindingResolver & { close(): Promise<void> } {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: 'kala-runtime-ingress-resource-owner-reader',
    max: options.maxConnections ?? 5,
    statement_timeout: options.statementTimeoutMs ?? 5_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
  const resolver = new PostgresRuntimeResourceOwnerResolver(
    { query: (text, values) => pool.query(text, values as unknown[] | undefined) },
    options.controlPlane,
    options.allowedOrigins,
  )
  return {
    resolveResourceOwner: (input) => resolver.resolveResourceOwner(input),
    resolveResourceOwnerBinding: (input) => resolver.resolveResourceOwnerBinding(input),
    resolveSessionRouteState: (input) => resolver.resolveSessionRouteState(input),
    resolveSessionOwner: (input) => resolver.resolveSessionOwner(input),
    resolveTaskOwner: (input) => resolver.resolveTaskOwner(input),
    close: () => pool.end(),
  }
}

function validOrganizationId(value: unknown): value is string {
  return typeof value === 'string' && (ORGANIZATION_ID.test(value) || UUID.test(value))
}

function validRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_ID.test(value) && value !== '.' && value !== '..'
}

function hasExactAuthority(
  rows: readonly AuthorityRow[],
  rowCount: number | null,
  input: RuntimeResourceOwnerScope,
): boolean {
  if (rowCount !== 1 || !rows[0]) return false
  const bind = rows[0]
  return bind.organization_id === input.organizationId && bind.placement_organization_id === input.organizationId
    && bind.runtime_unit_id === input.unitId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
