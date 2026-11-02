import { randomUUID } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import type { SqlExecutor } from '../persistence/postgres.js'
import type { BrowserSession, BrowserSessionRevocationReason, BrowserSessionStore, CreateBrowserSessionInput } from './browser-session-store.js'
import type { EncryptedSecret } from './session-secret-box.js'

export class PostgresBrowserSessionStore implements BrowserSessionStore {
  constructor(private readonly database: SqlExecutor) {}

  async create(input: CreateBrowserSessionInput): Promise<BrowserSession> {
    const principal = await this.database.query<{ id: string; organization_id: string }>(`
      SELECT p.id, m.organization_id FROM principals p
      JOIN organization_memberships m ON m.principal_id = p.id AND m.status = 'active'
      JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
      WHERE p.issuer = $1 AND p.subject = $2 ORDER BY m.created_at LIMIT 1`, [input.identity.issuer, input.identity.subject])
    const access = principal.rows[0]
    if (!access) throw new Error('organization_not_provisioned')
    const id = `bs_${randomUUID()}`
    await this.database.query(`INSERT INTO browser_sessions(
      id, principal_id, organization_id, token_hash, cache_namespace, device, encrypted_refresh_token,
      provider_refresh_after, created_at, last_seen_at, idle_expires_at, absolute_expires_at, identity_profile)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12)`, [
      id, access.id, access.organization_id, input.tokenHash, input.cacheNamespace, input.device,
      input.refreshToken ?? null, dateOrNull(input.providerRefreshAfter), new Date(input.createdAt),
      new Date(input.idleExpiresAt), new Date(input.absoluteExpiresAt),
      { displayName: input.identity.displayName, username: input.identity.username, email: input.identity.email },
    ])
    return { ...input, id, lastSeenAt: input.createdAt }
  }

  async findByTokenHash(tokenHash: string): Promise<BrowserSession | undefined> {
    const result = await this.database.query<SessionRow>(`${SESSION_SELECT} WHERE s.token_hash = $1`, [tokenHash])
    return result.rows[0] ? fromRow(result.rows[0]) : undefined
  }

  async touch(sessionId: string, now: number, idleExpiresAt: number): Promise<BrowserSession | undefined> {
    const result = await this.database.query<SessionRow>(`WITH updated AS (
      UPDATE browser_sessions SET last_seen_at=$2, idle_expires_at=LEAST($3, absolute_expires_at)
      WHERE id=$1 AND revoked_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2 RETURNING id)
      SELECT ${SESSION_COLUMNS} FROM browser_sessions s JOIN principals p ON p.id=s.principal_id JOIN updated u ON u.id=s.id`,
    [sessionId, new Date(now), new Date(idleExpiresAt)])
    return result.rows[0] ? fromRow(result.rows[0]) : undefined
  }

  async updateProvider(sessionId: string, expected: EncryptedSecret | undefined, update: { refreshToken?: EncryptedSecret; providerRefreshAfter?: number }): Promise<BrowserSession | undefined> {
    const expectedJson = expected === undefined ? null : JSON.stringify(expected)
    const result = await this.database.query<SessionRow>(`WITH updated AS (
      UPDATE browser_sessions SET encrypted_refresh_token=COALESCE($3, encrypted_refresh_token), provider_refresh_after=COALESCE($4, provider_refresh_after)
      WHERE id=$1 AND encrypted_refresh_token IS NOT DISTINCT FROM $2::jsonb RETURNING id)
      SELECT ${SESSION_COLUMNS} FROM browser_sessions s JOIN principals p ON p.id=s.principal_id JOIN updated u ON u.id=s.id`,
    [sessionId, expectedJson, update.refreshToken ? JSON.stringify(update.refreshToken) : null, dateOrNull(update.providerRefreshAfter)])
    return result.rows[0] ? fromRow(result.rows[0]) : undefined
  }

  async listForIdentity(identity: AuthenticatedIdentity, now: number): Promise<readonly BrowserSession[]> {
    const result = await this.database.query<SessionRow>(`${SESSION_SELECT}
      WHERE p.issuer=$1 AND p.subject=$2 AND s.revoked_at IS NULL AND s.idle_expires_at>$3 AND s.absolute_expires_at>$3
      ORDER BY s.last_seen_at DESC`, [identity.issuer, identity.subject, new Date(now)])
    return result.rows.map(fromRow)
  }

  async revoke(sessionId: string, reason: BrowserSessionRevocationReason, now: number): Promise<boolean> {
    const result = await this.database.query('UPDATE browser_sessions SET revoked_at=$3, revocation_reason=$2 WHERE id=$1 AND revoked_at IS NULL', [sessionId, reason, new Date(now)])
    return result.rowCount === 1
  }

  async revokeAllForIdentity(identity: AuthenticatedIdentity, reason: BrowserSessionRevocationReason, now: number, exceptSessionId?: string): Promise<number> {
    const result = await this.database.query(`UPDATE browser_sessions s SET revoked_at=$4, revocation_reason=$3 FROM principals p
      WHERE s.principal_id=p.id AND p.issuer=$1 AND p.subject=$2 AND s.revoked_at IS NULL AND ($5::text IS NULL OR s.id<>$5)`,
    [identity.issuer, identity.subject, reason, new Date(now), exceptSessionId ?? null])
    return result.rowCount ?? 0
  }

  async prune(now: number): Promise<number> {
    const result = await this.database.query(`DELETE FROM browser_sessions WHERE absolute_expires_at <= $1 OR idle_expires_at <= $1 OR revoked_at <= $1 - interval '7 days'`, [new Date(now)])
    return result.rowCount ?? 0
  }
}

const SESSION_COLUMNS = `s.id,s.token_hash,s.cache_namespace,s.device,s.encrypted_refresh_token,s.provider_refresh_after,
  s.created_at,s.last_seen_at,s.idle_expires_at,s.absolute_expires_at,s.revoked_at,s.revocation_reason,
  p.issuer,p.subject,p.display_name,p.email,s.identity_profile`
const SESSION_SELECT = `SELECT ${SESSION_COLUMNS} FROM browser_sessions s JOIN principals p ON p.id=s.principal_id`
type SessionRow = {
  id: string; token_hash: string; cache_namespace: string; device: BrowserSession['device']; encrypted_refresh_token: EncryptedSecret | null
  provider_refresh_after: Date | null; created_at: Date; last_seen_at: Date; idle_expires_at: Date; absolute_expires_at: Date
  revoked_at: Date | null; revocation_reason: BrowserSessionRevocationReason | null
  issuer: string; subject: string; display_name: string | null; email: string | null
  identity_profile: Pick<AuthenticatedIdentity, 'displayName' | 'username' | 'email'> | null
}
function fromRow(row: SessionRow): BrowserSession {
  const identity: AuthenticatedIdentity = {
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...row.identity_profile,
    issuer: row.issuer, subject: row.subject,
  }
  const session: BrowserSession = {
    id: row.id, tokenHash: row.token_hash, identity, cacheNamespace: row.cache_namespace, device: row.device,
    createdAt: row.created_at.getTime(), lastSeenAt: row.last_seen_at.getTime(), idleExpiresAt: row.idle_expires_at.getTime(), absoluteExpiresAt: row.absolute_expires_at.getTime(),
    ...(row.provider_refresh_after ? { providerRefreshAfter: row.provider_refresh_after.getTime() } : {}),
    ...(row.encrypted_refresh_token ? { refreshToken: row.encrypted_refresh_token } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.getTime() } : {}),
    ...(row.revocation_reason ? { revocationReason: row.revocation_reason } : {}),
  }
  return session
}
function dateOrNull(value?: number): Date | null { return value === undefined ? null : new Date(value) }
