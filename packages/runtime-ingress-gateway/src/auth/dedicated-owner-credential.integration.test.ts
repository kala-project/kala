import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'
import { DedicatedOwnerBootstrapService, DedicatedOwnerCredentialService, PostgresDedicatedOwnerAuthenticator } from './dedicated-owner.js'
import { DedicatedOidcOwnerService } from './dedicated-oidc-owner.js'
import { PostgresOrganizationStore } from '../organizations/postgres-store.js'
import { grantControlWriter } from '../bin/init-control-plane.js'

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
      const connectionString = `postgres://postgres:${databasePassword}@127.0.0.1:${port}/runlab_control`
      database = createPostgresControlPlaneDatabase({ connectionString })
      for (let attempt = 0; ; attempt++) {
        try { await database.query('SELECT 1'); break } catch (error) {
          if (attempt === 59) throw error
          await new Promise((done) => setTimeout(done, 100))
        }
      }
      await migrateControlPlane(database, await readControlPlaneMigrations(resolve('migrations')))
      await database.query('CREATE ROLE kala_oidc_gateway NOLOGIN')
      await grantControlWriter(database, 'kala_oidc_gateway')
      expect((await database.query(`SELECT has_table_privilege('kala_oidc_gateway','dedicated_oidc_owner_bindings','SELECT') AS read,
        has_any_column_privilege('kala_oidc_gateway','dedicated_oidc_owner_bindings','INSERT,UPDATE') AS write`)).rows[0]).toEqual({ read: true, write: false })
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
      await database.query("UPDATE organizations SET status='active' WHERE id=$1", [bootstrapped.organizationId])
      const oidc = new DedicatedOidcOwnerService(database)
      const external = { issuer: 'https://identity.example.test', subject: 'explicit-oidc-owner' }
      const binding = { identity: external, expectedOrganizationId: bootstrapped.organizationId, expectedPrincipalId: identity.principal_id }
      await expect(oidc.bindExisting({ ...binding, expectedPrincipalId: 'wrong-principal' })).rejects.toThrow('explicitly selected')
      await expect(oidc.bootstrap(external, 'Must not create a second tenant')).rejects.toThrow('empty control plane')
      await insertSession(database, identity.principal_id, bootstrapped.organizationId, 'before-oidc')
      await database.query(`CREATE FUNCTION reject_oidc_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='dedicated.owner_oidc_bound' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`)
      await database.query('CREATE TRIGGER reject_oidc_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_oidc_audit()')
      await expect(oidc.bindExisting(binding)).rejects.toThrow('fixture audit failure')
      await expect(authenticator.authenticate('lost password recovery replacement')).resolves.toBeDefined()
      expect((await database.query("SELECT id FROM browser_sessions WHERE cache_namespace='cache-before-oidc' AND revoked_at IS NULL")).rowCount).toBe(1)
      await database.query('DROP TRIGGER reject_oidc_audit ON audit_events')
      await expect(oidc.bindExisting(binding)).resolves.toMatchObject({ organizationId: bootstrapped.organizationId, runtimeUnitId: bootstrapped.runtimeUnitId, alreadyBound: false })
      await expect(oidc.bindExisting(binding)).resolves.toMatchObject({ alreadyBound: true })
      await expect(oidc.bindExisting({ ...binding, identity: { ...external, subject: 'different-user' } })).rejects.toThrow('another external identity')
      await expect(oidc.verify(external)).resolves.toEqual(bootstrapped)
      await expect(oidc.verify({ ...external, subject: 'different-user' })).rejects.toThrow('does not match')
      await expect(authenticator.authenticate('lost password recovery replacement')).resolves.toBeUndefined()
      expect((await database.query('SELECT id FROM browser_sessions WHERE revoked_at IS NULL')).rowCount).toBe(0)
      const store = new PostgresOrganizationStore(database, { singleTenantOwner: true })
      const canonical = { issuer: 'urn:kala:dedicated-owner', subject: 'owner' }
      await expect(oidc.resolveIdentity(external)).resolves.toMatchObject(canonical)
      await expect(oidc.resolveIdentity({ ...external, subject: 'different-user' })).resolves.toBeUndefined()
      await expect(store.findAccess(canonical)).resolves.toMatchObject({ organization: { id: bootstrapped.organizationId, unitId: bootstrapped.runtimeUnitId }, membership: { role: 'owner' } })
      expect((await database.query('SELECT id FROM principals WHERE issuer=$1 AND subject=$2', [canonical.issuer, canonical.subject])).rows[0]!.id).toBe(identity.principal_id)
      expect((await database.query('SELECT count(*)::int AS count FROM organizations')).rows[0]!.count).toBe(1)
      await database.query("INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_drift','Unexpected tenant','active','unit_drift')")
      await expect(store.findAccess(canonical)).resolves.toBeUndefined()
      await expect(oidc.resolveIdentity(external)).resolves.toBeUndefined()
      await expect(new PostgresOrganizationStore(database).findAccess(canonical)).resolves.toBeDefined()
      await database.query('CREATE DATABASE oidc_fresh_fixture')
      const freshDatabase = createPostgresControlPlaneDatabase({ connectionString: connectionString.replace(/\/runlab_control$/u, '/oidc_fresh_fixture') })
      try {
        await migrateControlPlane(freshDatabase, await readControlPlaneMigrations(resolve('migrations')))
        const freshService = new DedicatedOidcOwnerService(freshDatabase)
        const conflicting = { ...external, subject: 'already-existing-principal' }
        await freshDatabase.query(`INSERT INTO principals(id,kind,issuer,subject) VALUES('prn_collision','human',$1,$2)`, [conflicting.issuer, conflicting.subject])
        await expect(freshService.bootstrap(conflicting, 'Must not merge identities')).rejects.toThrow('automatic account merging is forbidden')
        expect((await freshDatabase.query('SELECT id FROM organizations')).rowCount).toBe(0)
        const fresh = await freshService.bootstrap(external, 'Fresh OIDC-only Dedicated')
        await expect(freshService.verify(external)).resolves.toEqual(fresh)
        expect((await freshDatabase.query('SELECT singleton FROM dedicated_owner_credentials')).rowCount).toBe(0)
        await expect(freshService.bootstrap({ ...external, subject: 'another-owner' }, 'Second tenant')).rejects.toThrow('empty control plane')
      } finally { await freshDatabase.close() }

      await database.query("UPDATE organizations SET status='suspended' WHERE id=$1", [bootstrapped.organizationId])
      await expect(service.resetPassword({ newPassword: 'must not replace inactive owner' })).rejects.toThrow('update denied')
      await expect(authenticator.authenticate('lost password recovery replacement')).resolves.toBeUndefined()
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
