import type { SqlExecutor } from '../persistence/postgres.js'
import { ACTIVE_CONTRACT_SQL } from './contract-access.js'

export type BackgroundAuthorityInput = { organizationId: string; unitId: string; principal: string }
export interface BackgroundAuthority {
  authorize(input: BackgroundAuthorityInput): Promise<'owner' | 'admin' | 'member' | undefined>
}

/** Shared control authority, never the Runtime's projection of a creator role. */
export class PostgresBackgroundAuthority implements BackgroundAuthority {
  constructor(private readonly database: SqlExecutor) {}
  async authorize(input: BackgroundAuthorityInput): Promise<'owner' | 'admin' | 'member' | undefined> {
    if (input.principal.startsWith('prn_')) {
      const result = await this.database.query<{ role: 'member' }>(`SELECT 'member' AS role FROM organizations o
        WHERE o.id=$1 AND o.runtime_unit_id=$2 AND o.status='active' AND ${ACTIVE_CONTRACT_SQL}
          AND EXISTS (SELECT 1 FROM service_account_tokens t JOIN principals p ON p.id=t.principal_id
            WHERE t.organization_id=o.id AND p.kind='service_account' AND p.id=$3
              AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())
              AND 'workspace:write'=ANY(t.scopes))`, [input.organizationId, input.unitId, input.principal])
      return result.rows[0]?.role
    }
    const decoded = Buffer.from(input.principal, 'base64url').toString('utf8')
    if (Buffer.from(decoded).toString('base64url') !== input.principal) return undefined
    const parts = decoded.split('\0')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined
    const result = await this.database.query<{ role: 'owner' | 'admin' | 'member' }>(`SELECT m.role FROM organizations o
      JOIN organization_memberships m ON m.organization_id=o.id AND m.status='active'
      JOIN principals p ON p.id=m.principal_id AND p.kind='human'
      WHERE o.id=$1 AND o.runtime_unit_id=$2 AND o.status='active' AND ${ACTIVE_CONTRACT_SQL}
        AND p.issuer=$3 AND p.subject=$4 AND m.role IN ('owner','admin','member')
        AND NOT EXISTS (SELECT 1 FROM organization_memberships other
          WHERE other.principal_id=p.id AND other.status='active' AND other.organization_id<>o.id)`,
    [input.organizationId, input.unitId, parts[0], parts[1]])
    return result.rows[0]?.role
  }
}
