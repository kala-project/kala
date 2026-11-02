import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'
import { DedicatedOwnerBootstrapService, DedicatedOwnerCredentialService, PostgresDedicatedOwnerAuthenticator } from './dedicated-owner.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const docker = (...args: string[]) => exec('sudo', ['-n', 'docker', ...args])
const testScrypt = { N: 16_384, r: 8, p: 1, keyLength: 32, maxmem: 32 * 1024 * 1024 }

integration('Dedicated Owner credential lifecycle on real control PostgreSQL', () => {
  it('serializes competing changes, preserves authority, and atomically revokes sessions on change and recovery', async () => {
    const name = `kala-owner-credential-${randomUUID()}`
    const databasePassword = randomUUID()
    let database: ReturnType<typeof createPostgresControlPlaneDatabase> | undefined
    try {
      await docker('run', '-d', '--rm', '--name', name, '--label', `dev.kala.test.project=${name}`,
        '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
        '--env', `POSTGRES_PASSWORD=${databasePassword}`, '--env', 'POSTGRES_DB=runlab_control',
        '--publish', '127.0.0.1::5432', 'postgres:16-alpine')
      const port = (await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name)).stdout.trim()
      database = createPostgresControlPlaneDatabase({ connectionString: `postgres://postgres:${databasePassword}@127.0.0.1:${port}/runlab_control` })
      for (let attempt = 0; ; attempt++) {
        try { await database.query('SELECT 1'); break } catch (error) {
          if (attempt === 59) throw error
          await new Promise((done) => setTimeout(done, 100))
        }
      }
      await migrateControlPlane(database, await readControlPlaneMigrations(resolve('migrations')))
      const initialPassword = 'initial owner password fixture'
      const bootstrapped = await new DedicatedOwnerBootstrapService(database, testScrypt)
        .bootstrap({ password: initialPassword, organizationName: 'Credential fixture' })
      const identity = (await database.query<{ principal_id: string }>('SELECT principal_id FROM dedicated_owner_credentials')).rows[0]!
      await insertSession(database, identity.principal_id, bootstrapped.organizationId, 'one')
      await insertSession(database, identity.principal_id, bootstrapped.organizationId, 'two')

      const service = new DedicatedOwnerCredentialService(database, testScrypt)
      const attempts = await Promise.allSettled([
        service.changePassword({ currentPassword: initialPassword, newPassword: 'first competing replacement' }),
        service.changePassword({ currentPassword: initialPassword, newPassword: 'second competing replacement' }),
      ])
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
      expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM browser_sessions WHERE revoked_at IS NULL")).rows[0]!.count).toBe(0)
      expect((await database.query('SELECT principal_id,organization_id FROM dedicated_owner_credentials')).rows[0]).toEqual({
        principal_id: identity.principal_id, organization_id: bootstrapped.organizationId,
      })
      const authenticator = new PostgresDedicatedOwnerAuthenticator(database)
      await expect(authenticator.authenticate(initialPassword)).resolves.toBeUndefined()
      const winner = (await authenticator.authenticate('first competing replacement')) ? 'first competing replacement' : 'second competing replacement'
      await expect(authenticator.authenticate(winner)).resolves.toBeDefined()

      await insertSession(database, identity.principal_id, bootstrapped.organizationId, 'after-change')
      const reset = await service.resetPassword({ newPassword: 'lost password recovery replacement' })
      expect(reset).toMatchObject({ principalId: identity.principal_id, organizationId: bootstrapped.organizationId, revokedSessionCount: 1 })
      await expect(authenticator.authenticate(winner)).resolves.toBeUndefined()
      await expect(authenticator.authenticate('lost password recovery replacement')).resolves.toBeDefined()

      await database.query("UPDATE organizations SET status='suspended' WHERE id=$1", [bootstrapped.organizationId])
      await expect(service.resetPassword({ newPassword: 'must not replace inactive owner' })).rejects.toThrow('update denied')
      await expect(authenticator.authenticate('lost password recovery replacement')).resolves.toBeDefined()
    } finally {
      await database?.close()
      await docker('rm', '--force', name).catch(() => undefined)
    }
  }, 90_000)
})

async function insertSession(
  database: NonNullable<ReturnType<typeof createPostgresControlPlaneDatabase>>,
  principalId: string,
  organizationId: string,
  suffix: string,
): Promise<void> {
  await database.query(`INSERT INTO browser_sessions(
    id,principal_id,organization_id,token_hash,cache_namespace,device,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,now(),now(),now()+interval '1 hour',now()+interval '1 day')`, [
    `bs_${randomUUID()}`, principalId, organizationId, `hash-${suffix}-${randomUUID()}`, `cache-${suffix}`, { label: suffix },
  ])
}
