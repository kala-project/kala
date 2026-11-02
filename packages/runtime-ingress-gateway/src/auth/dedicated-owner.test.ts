import { describe, expect, it } from 'vitest'

import type { ControlPlaneDatabase, SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import { DedicatedOwnerBootstrapService, DedicatedOwnerCredentialService, PostgresDedicatedOwnerAuthenticator } from './dedicated-owner.js'

describe('Dedicated Owner control PostgreSQL credential', () => {
  it('bootstraps exactly one Owner and verifies only the correct scrypt password', async () => {
    const database = new DedicatedOwnerDatabase()
    const service = new DedicatedOwnerBootstrapService(database, testScrypt)
    const result = await service.bootstrap({ password: 'correct horse battery staple', organizationName: 'Dedicated' })

    expect(result.organizationId).toBe(database.organizationId)
    expect(database.credential?.password_hash).not.toContain('correct horse')
    const authenticator = new PostgresDedicatedOwnerAuthenticator(database)
    await expect(authenticator.authenticate('definitely-not-the-password')).resolves.toBeUndefined()
    await expect(authenticator.authenticate('correct horse battery staple')).resolves.toMatchObject({
      organizationId: database.organizationId,
      identity: { issuer: 'urn:kala:dedicated-owner', subject: 'owner' },
    })
    expect(database.authenticatedUpdates).toBe(1)
  })

  it('rejects a duplicate bootstrap before creating another Organization', async () => {
    const database = new DedicatedOwnerDatabase()
    const service = new DedicatedOwnerBootstrapService(database, testScrypt)
    await service.bootstrap({ password: 'correct horse battery staple', organizationName: 'Dedicated' })
    const firstOrganization = database.organizationId

    await expect(service.bootstrap({ password: 'another strong owner password', organizationName: 'Other' }))
      .rejects.toThrow('already bootstrapped')
    expect(database.organizationId).toBe(firstOrganization)
    expect(database.organizationInsertions).toBe(1)
  })

  it('changes only a verified active Owner credential and revokes its sessions', async () => {
    const database = new DedicatedOwnerDatabase()
    const bootstrap = new DedicatedOwnerBootstrapService(database, testScrypt)
    await bootstrap.bootstrap({ password: 'correct horse battery staple', organizationName: 'Dedicated' })
    database.liveSessions = 2
    const originalPrincipal = database.credential!.principal_id
    const originalOrganization = database.credential!.organization_id
    const service = new DedicatedOwnerCredentialService(database, testScrypt)

    await expect(service.changePassword({ currentPassword: 'wrong current credential', newPassword: 'a distinct replacement password' }))
      .rejects.toThrow('update denied')
    expect(database.liveSessions).toBe(2)
    const changed = await service.changePassword({ currentPassword: 'correct horse battery staple', newPassword: 'a distinct replacement password' })
    expect(changed).toEqual({ organizationId: originalOrganization, principalId: originalPrincipal, revokedSessionCount: 2 })
    expect(database.credential).toMatchObject({ principal_id: originalPrincipal, organization_id: originalOrganization })
    await expect(new PostgresDedicatedOwnerAuthenticator(database).authenticate('correct horse battery staple')).resolves.toBeUndefined()
    await expect(new PostgresDedicatedOwnerAuthenticator(database).authenticate('a distinct replacement password')).resolves.toBeDefined()
  })

  it('recovery rejects reuse and inactive canonical credentials', async () => {
    const database = new DedicatedOwnerDatabase()
    await new DedicatedOwnerBootstrapService(database, testScrypt)
      .bootstrap({ password: 'correct horse battery staple', organizationName: 'Dedicated' })
    const service = new DedicatedOwnerCredentialService(database, testScrypt)
    await expect(service.resetPassword({ newPassword: 'correct horse battery staple' })).rejects.toThrow('must differ')
    database.credential!.disabled_at = new Date()
    await expect(service.resetPassword({ newPassword: 'a distinct replacement password' })).rejects.toThrow('update denied')
  })
})

const testScrypt = { N: 16_384, r: 8, p: 1, keyLength: 32, maxmem: 32 * 1024 * 1024 }

type StoredCredential = {
  principal_id: string; organization_id: string; password_algorithm: 'scrypt'; password_salt: string; password_hash: string
  scrypt_n: number; scrypt_r: number; scrypt_p: number; disabled_at: Date | null; display_name: string; email: null
}

class DedicatedOwnerDatabase implements ControlPlaneDatabase {
  credential?: StoredCredential
  organizationId?: string
  principalId?: string
  organizationInsertions = 0
  authenticatedUpdates = 0
  liveSessions = 0

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return await operation(this) }
  async health(): Promise<{ ok: true; schemaVersion: number }> { return { ok: true, schemaVersion: 7 } }
  async close(): Promise<void> {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    if (sql.includes('FROM dedicated_owner_credentials c JOIN principals')) return rows(this.credential ? [this.credential as unknown as Row] : [])
    if (sql.startsWith('UPDATE dedicated_owner_credentials SET last_authenticated_at')) { this.authenticatedUpdates += 1; return rows([], 1) }
    if (sql.startsWith("UPDATE dedicated_owner_credentials SET password_algorithm='scrypt'")) {
      if (!this.credential || this.credential.disabled_at) return rows([], 0)
      Object.assign(this.credential, {
        password_salt: values[0], password_hash: values[1], scrypt_n: values[2], scrypt_r: values[3], scrypt_p: values[4],
      })
      return rows([], 1)
    }
    if (sql.startsWith('UPDATE browser_sessions SET revoked_at=now()')) {
      const count = this.liveSessions
      this.liveSessions = 0
      return rows([], count)
    }
    if (sql === 'SELECT singleton FROM dedicated_owner_credentials WHERE singleton=true') return rows(this.credential ? [{ singleton: true } as unknown as Row] : [])
    if (sql === 'SELECT id FROM organizations LIMIT 1') return rows(this.organizationId ? [{ id: this.organizationId } as unknown as Row] : [])
    if (sql.startsWith('SELECT e.aggregate_id')) return rows([])
    if (sql.startsWith('INSERT INTO principals')) { this.principalId = values[0] as string; return rows([], 1) }
    if (sql.startsWith('SELECT m.organization_id')) return rows([])
    if (sql.startsWith('INSERT INTO organizations')) { this.organizationId = values[0] as string; this.organizationInsertions += 1; return rows([], 1) }
    if (sql === 'SELECT id FROM principals WHERE issuer=$1 AND subject=$2') return rows([{ id: this.principalId } as unknown as Row])
    if (sql.startsWith('INSERT INTO dedicated_owner_credentials')) {
      this.credential = {
        principal_id: values[0] as string,
        organization_id: values[1] as string,
        password_algorithm: 'scrypt',
        password_salt: values[2] as string,
        password_hash: values[3] as string,
        scrypt_n: values[4] as number,
        scrypt_r: values[5] as number,
        scrypt_p: values[6] as number,
        disabled_at: null,
        display_name: 'Owner',
        email: null,
      }
      return rows([], 1)
    }
    return rows([], 1)
  }
}

function rows<Row extends Record<string, unknown>>(value: Row[], rowCount = value.length): SqlQueryResult<Row> {
  return { rows: value, rowCount, command: '', oid: 0, fields: [] }
}
