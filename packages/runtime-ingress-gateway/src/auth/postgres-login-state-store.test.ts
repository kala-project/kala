import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import type { LoginState } from './login-state-store.js'
import { PostgresLoginStateStore } from './postgres-login-state-store.js'

type StoredRow = {
  code_verifier: string
  state: string
  oidc_nonce: string | null
  redirect_uri: string
  expires_at: Date
  sso_connection_id: string | null
  organization_invite_hash: string | null
  owner_bootstrap_hash: string | null
}

class SharedLoginStateDatabase implements SqlExecutor {
  readonly rows = new Map<string, StoredRow>()

  async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    if (text.startsWith('DELETE FROM oidc_login_states WHERE expires_at')) {
      let deleted = 0
      for (const [nonce, row] of this.rows) {
        if (row.expires_at.getTime() <= Date.now()) {
          this.rows.delete(nonce)
          deleted += 1
        }
      }
      return queryResult<Row>([], deleted)
    }
    if (text.includes('INSERT INTO oidc_login_states')) {
      const nonce = values[0] as string
      if (this.rows.has(nonce)) throw new Error('duplicate key value violates unique constraint')
      this.rows.set(nonce, {
        code_verifier: values[1] as string,
        state: values[2] as string,
        oidc_nonce: values[3] as string | null,
        redirect_uri: values[4] as string,
        expires_at: values[5] as Date,
        sso_connection_id: values[6] as string | null,
        organization_invite_hash: values[7] as string | null,
        owner_bootstrap_hash: values[8] as string | null,
      })
      return queryResult<Row>([], 1)
    }
    if (text.includes('DELETE FROM oidc_login_states WHERE nonce = $1')) {
      const nonce = values[0] as string
      const row = this.rows.get(nonce)
      this.rows.delete(nonce)
      return queryResult((row && row.expires_at.getTime() > Date.now() ? [row] : []) as unknown as Row[], row ? 1 : 0)
    }
    throw new Error(`unexpected query: ${text}`)
  }
}

afterEach(() => vi.useRealTimers())

describe('PostgresLoginStateStore', () => {
  it('shares complete OIDC/PKCE state between Gateway replicas and consumes it once', async () => {
    const database = new SharedLoginStateDatabase()
    const gatewayA = new PostgresLoginStateStore(database)
    const gatewayB = new PostgresLoginStateStore(database)
    const state: LoginState = {
      codeVerifier: 'pkce-verifier', state: 'oauth-state', oidcNonce: 'oidc-nonce',
      redirectUri: 'https://gateway.example/callback', expiresAt: Date.now() + 60_000,
      ssoConnectionId: 'sso-1', organizationInviteHash: 'invite-hash', ownerBootstrapHash: 'owner-hash',
    }

    await gatewayA.put('browser-nonce', state)
    await expect(gatewayB.take('browser-nonce')).resolves.toEqual(state)
    await expect(gatewayA.take('browser-nonce')).resolves.toBeUndefined()
  })

  it('allows only one concurrent consumer across Gateway replicas', async () => {
    const database = new SharedLoginStateDatabase()
    const gatewayA = new PostgresLoginStateStore(database)
    const gatewayB = new PostgresLoginStateStore(database)
    await gatewayA.put('nonce', { codeVerifier: 'v', state: 's', redirectUri: 'https://example.test/cb', expiresAt: Date.now() + 60_000 })

    const consumed = await Promise.all([gatewayA.take('nonce'), gatewayB.take('nonce')])
    expect(consumed.filter((value) => value !== undefined)).toHaveLength(1)
    expect(consumed.filter((value) => value === undefined)).toHaveLength(1)
  })

  it('never returns expired state and opportunistically prunes other expired attempts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const database = new SharedLoginStateDatabase()
    const store = new PostgresLoginStateStore(database)
    await store.put('expired-on-take', { codeVerifier: 'v1', state: 's1', redirectUri: 'https://example.test/cb', expiresAt: Date.now() + 1_000 })
    await store.put('expired-on-put', { codeVerifier: 'v2', state: 's2', redirectUri: 'https://example.test/cb', expiresAt: Date.now() + 1_000 })

    vi.advanceTimersByTime(1_001)
    await expect(store.take('expired-on-take')).resolves.toBeUndefined()
    await store.put('fresh', { codeVerifier: 'v3', state: 's3', redirectUri: 'https://example.test/cb', expiresAt: Date.now() + 1_000 })

    expect(database.rows.has('expired-on-put')).toBe(false)
    expect(database.rows.has('fresh')).toBe(true)
  })
})

function queryResult<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { command: '', rowCount, oid: 0, fields: [], rows }
}
