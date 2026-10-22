import type { SqlExecutor } from '../persistence/postgres.js'
import type { LoginState, LoginStateStore } from './login-state-store.js'

type LoginStateRow = {
  code_verifier: string
  state: string
  oidc_nonce: string | null
  redirect_uri: string
  expires_at: Date
  sso_connection_id: string | null
  organization_invite_hash: string | null
  owner_bootstrap_hash: string | null
}

/** PostgreSQL-backed, replica-safe storage for short-lived OIDC login state. */
export class PostgresLoginStateStore implements LoginStateStore {
  constructor(private readonly database: SqlExecutor) {}

  async put(nonce: string, state: LoginState): Promise<void> {
    // Opportunistic cleanup bounds retained state without requiring a per-replica scheduler.
    await this.database.query('DELETE FROM oidc_login_states WHERE expires_at <= now()')
    await this.database.query(`INSERT INTO oidc_login_states(
      nonce, code_verifier, state, oidc_nonce, redirect_uri, expires_at,
      sso_connection_id, organization_invite_hash, owner_bootstrap_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      nonce,
      state.codeVerifier,
      state.state,
      state.oidcNonce ?? null,
      state.redirectUri,
      new Date(state.expiresAt),
      state.ssoConnectionId ?? null,
      state.organizationInviteHash ?? null,
      state.ownerBootstrapHash ?? null,
    ])
  }

  async take(nonce: string): Promise<LoginState | undefined> {
    // DELETE ... RETURNING makes consumption atomic across every Gateway replica. Expired
    // rows are consumed too, but filtered according to the database clock and never returned.
    const result = await this.database.query<LoginStateRow>(`WITH consumed AS (
      DELETE FROM oidc_login_states WHERE nonce = $1
      RETURNING code_verifier, state, oidc_nonce, redirect_uri, expires_at,
        sso_connection_id, organization_invite_hash, owner_bootstrap_hash)
      SELECT * FROM consumed WHERE expires_at > now()`, [nonce])
    const row = result.rows[0]
    if (!row) return undefined
    return {
      codeVerifier: row.code_verifier,
      state: row.state,
      redirectUri: row.redirect_uri,
      expiresAt: row.expires_at.getTime(),
      ...(row.oidc_nonce !== null ? { oidcNonce: row.oidc_nonce } : {}),
      ...(row.sso_connection_id !== null ? { ssoConnectionId: row.sso_connection_id } : {}),
      ...(row.organization_invite_hash !== null ? { organizationInviteHash: row.organization_invite_hash } : {}),
      ...(row.owner_bootstrap_hash !== null ? { ownerBootstrapHash: row.owner_bootstrap_hash } : {}),
    }
  }
}
