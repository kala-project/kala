import { createHash, randomBytes } from 'node:crypto'
import type { SqlExecutor } from '../persistence/postgres.js'
import { ACTIVE_CONTRACT_SQL } from '../organizations/contract-access.js'

export type ServiceAccountScope = 'organization:read' | 'organization:write' | 'workspace:read' | 'workspace:write' | 'audit:read'
const SERVICE_ACCOUNT_SCOPES = new Set<ServiceAccountScope>(['organization:read', 'organization:write', 'workspace:read', 'workspace:write', 'audit:read'])
const DEFAULT_EXPIRATION_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1_000

export interface ServiceAccountRecord {
  id: string
  name: string
  scopes: readonly ServiceAccountScope[]
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
}

export class ServiceAccountInputError extends Error {}

export class ServiceAccountService {
  constructor(private readonly database: SqlExecutor, private readonly options: {
    maxActiveServiceAccounts?: number
    defaultExpirationMs?: number
    maxExpirationMs?: number
    now?: () => Date
  } = {}) {
    if (options.maxActiveServiceAccounts !== undefined && (!Number.isSafeInteger(options.maxActiveServiceAccounts) || options.maxActiveServiceAccounts < 1)) throw new Error('maxActiveServiceAccounts must be positive')
    const defaultExpirationMs = options.defaultExpirationMs ?? DEFAULT_EXPIRATION_MS
    const maxExpirationMs = options.maxExpirationMs ?? MAX_EXPIRATION_MS
    if (!Number.isSafeInteger(defaultExpirationMs) || defaultExpirationMs < 1) throw new Error('defaultExpirationMs must be positive')
    if (!Number.isSafeInteger(maxExpirationMs) || maxExpirationMs < 1) throw new Error('maxExpirationMs must be positive')
    if (defaultExpirationMs > maxExpirationMs) throw new Error('defaultExpirationMs must not exceed maxExpirationMs')
  }

  async create(input: { organizationId: string; name: string; scopes: readonly ServiceAccountScope[]; expiresAt?: string }): Promise<ServiceAccountRecord & { token: string }> {
    const name = input.name.trim()
    const scopes = [...new Set(input.scopes)]
    if (!name || name.length > 200 || scopes.length === 0 || scopes.some((scope) => !SERVICE_ACCOUNT_SCOPES.has(scope))) throw new ServiceAccountInputError('invalid service account')
    const createdAt = this.now()
    const expiresAt = input.expiresAt === undefined
      ? new Date(createdAt.getTime() + (this.options.defaultExpirationMs ?? DEFAULT_EXPIRATION_MS))
      : parseExpiration(input.expiresAt)
    if (expiresAt.getTime() <= createdAt.getTime()) throw new ServiceAccountInputError('expiration must be in the future')
    if (expiresAt.getTime() - createdAt.getTime() > (this.options.maxExpirationMs ?? MAX_EXPIRATION_MS)) throw new ServiceAccountInputError('expiration exceeds the maximum lifetime')
    if (this.options.maxActiveServiceAccounts !== undefined) {
      const active = await this.database.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM service_account_tokens WHERE organization_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())', [input.organizationId])
      if (Number(active.rows[0]?.count ?? 0) >= this.options.maxActiveServiceAccounts) throw new ServiceAccountInputError('service account quota exceeded')
    }
    const id = `prn_${randomBytes(16).toString('base64url')}`, token = `ak_sa_${randomBytes(32).toString('base64url')}`
    await this.database.query(`INSERT INTO principals(id,kind,display_name) VALUES($1,'service_account',$2)`, [id, name])
    await this.database.query(`INSERT INTO service_account_tokens(id,organization_id,principal_id,token_hash,scopes,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [`sat_${randomBytes(16).toString('base64url')}`, input.organizationId, id, hash(token), scopes, createdAt, expiresAt])
    return { id, token, name, scopes, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), revokedAt: null }
  }

  async list(organizationId: string): Promise<ServiceAccountRecord[]> {
    const result = await this.database.query<{
      id: string
      name: string
      scopes: ServiceAccountScope[]
      created_at: Date | string
      expires_at: Date | string | null
      revoked_at: Date | string | null
    }>(`
      SELECT tokens.principal_id AS id, principals.display_name AS name, tokens.scopes,
             tokens.created_at, tokens.expires_at, tokens.revoked_at
      FROM service_account_tokens AS tokens
      JOIN principals ON principals.id = tokens.principal_id
      WHERE tokens.organization_id=$1
      ORDER BY tokens.created_at DESC, tokens.principal_id
    `, [organizationId])
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      createdAt: toIsoString(row.created_at),
      expiresAt: row.expires_at === null ? null : toIsoString(row.expires_at),
      revokedAt: row.revoked_at === null ? null : toIsoString(row.revoked_at),
    }))
  }

  async authenticate(token: string): Promise<{ principalId: string; organizationId: string; unitId: string; organizationStatus: string; scopes: readonly ServiceAccountScope[] } | undefined> {
    const result = await this.database.query<{ principal_id: string; organization_id: string; runtime_unit_id: string; organization_status: string; scopes: ServiceAccountScope[] }>(`
      SELECT tokens.principal_id, tokens.organization_id, tokens.scopes,
             o.runtime_unit_id,
             CASE WHEN o.status = 'active' AND NOT ${ACTIVE_CONTRACT_SQL} THEN 'expired' ELSE o.status END AS organization_status
      FROM service_account_tokens AS tokens
      JOIN organizations o ON o.id = tokens.organization_id
      WHERE tokens.token_hash=$1 AND tokens.revoked_at IS NULL
        AND (tokens.expires_at IS NULL OR tokens.expires_at>now())
    `, [hash(token)])
    const row = result.rows[0]
    return row ? {
      principalId: row.principal_id,
      organizationId: row.organization_id,
      unitId: row.runtime_unit_id,
      organizationStatus: row.organization_status,
      scopes: row.scopes,
    } : undefined
  }

  async revoke(organizationId: string, principalId: string): Promise<boolean> {
    const result = await this.database.query('UPDATE service_account_tokens SET revoked_at=now() WHERE organization_id=$1 AND principal_id=$2 AND revoked_at IS NULL', [organizationId, principalId])
    return (result.rowCount ?? 0) > 0
  }

  private now(): Date { return this.options.now?.() ?? new Date() }
}

function parseExpiration(value: string): Date {
  const expiration = new Date(value)
  if (!value || !Number.isFinite(expiration.getTime())) throw new ServiceAccountInputError('expiration must be a valid date-time')
  return expiration
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid service account timestamp')
  return date.toISOString()
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
