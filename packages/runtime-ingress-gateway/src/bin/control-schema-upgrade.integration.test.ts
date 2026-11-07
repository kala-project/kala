import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { assertControlUpgradeSource, migrationIdentities, validateControlUpgradePlan } from './control-schema-upgrade.js'
import { grantControlWriter } from './init-control-plane.js'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integration('control schema 10-to-12 on isolated PostgreSQL', () => {
  it('preserves existing browser sessions and rejects replay or altered source history', async () => {
    const name = `kala-control-10-12-${randomUUID()}`
    const password = randomUUID()
    const installationId = randomUUID()
    const checkpointId = randomUUID()
    const docker = (...args: string[]) => exec('docker', args)
    let database: ReturnType<typeof createPostgresControlPlaneDatabase> | undefined
    let admin: ReturnType<typeof createPostgresControlPlaneDatabase> | undefined
    try {
      const migrations = await readControlPlaneMigrations(resolve('migrations'))
      const plan = validateControlUpgradePlan({
        fromVersion: 10,
        toVersion: 12,
        writerRole: 'kala_gateway',
        migrations: migrationIdentities(migrations),
      }, migrations)
      await docker('run', '-d', '--rm', '--pull=never', '--name', name,
        '--label', `dev.kala.test.project=${name}`,
        '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
        '--env', `POSTGRES_PASSWORD=${password}`, '--publish', '127.0.0.1::5432', 'postgres:16-alpine')
      const port = (await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name)).stdout.trim()
      admin = createPostgresControlPlaneDatabase({
        connectionString: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
        maxConnections: 1,
      })
      for (let attempt = 0; ; attempt += 1) {
        try { await admin.query('SELECT 1'); break } catch (error) {
          if (attempt === 59) throw error
          await new Promise((done) => setTimeout(done, 100))
        }
      }
      await admin.query(`CREATE ROLE kala_control_owner LOGIN PASSWORD '${password}'`)
      await admin.query('ALTER ROLE kala_control_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
      await admin.query('CREATE ROLE kala_gateway NOLOGIN')
      await admin.query('CREATE DATABASE runlab_control OWNER kala_control_owner')
      await admin.close()
      admin = undefined

      database = createPostgresControlPlaneDatabase({
        connectionString: `postgres://kala_control_owner:${password}@127.0.0.1:${port}/runlab_control`,
        maxConnections: 1,
      })
      await migrateControlPlane(database, migrations.slice(0, 10))
      await database.query(`CREATE SCHEMA kala_installation_claim`)
      await database.query(`CREATE TABLE kala_installation_claim.marker (singleton boolean PRIMARY KEY, installation_id uuid NOT NULL)`)
      await database.query(`CREATE TABLE kala_installation_claim.recovery_checkpoint
        (singleton boolean PRIMARY KEY, installation_id uuid NOT NULL, checkpoint_id uuid NOT NULL, key_sha256 text NOT NULL)`)
      await database.query('INSERT INTO kala_installation_claim.marker VALUES (true, $1)', [installationId])
      await database.query('INSERT INTO kala_installation_claim.recovery_checkpoint VALUES (true, $1, $2, $3)',
        [installationId, checkpointId, 'a'.repeat(64)])
      await database.query(`INSERT INTO organizations (id, name, status, runtime_unit_id)
        VALUES ('org_upgrade', 'Upgrade test', 'active', 'unit-upgrade')`)
      await database.query(`INSERT INTO principals (id, kind, issuer, subject)
        VALUES ('prn_upgrade', 'human', 'issuer', 'subject')`)
      await database.query(`INSERT INTO organization_memberships (organization_id, principal_id, role)
        VALUES ('org_upgrade', 'prn_upgrade', 'owner')`)
      await database.query(`INSERT INTO browser_sessions
        (id, principal_id, organization_id, token_hash, cache_namespace, device, idle_expires_at, absolute_expires_at)
        VALUES ('bs_upgrade', 'prn_upgrade', 'org_upgrade', 'upgrade-token', 'upgrade', '{}', now() + interval '1 day', now() + interval '2 days')`)

      expect((await database.health()).schemaVersion).toBe(10)
      await expect(database.transaction(async (tx) =>
        assertControlUpgradeSource(tx, plan, installationId, 16, false))).resolves.toBeUndefined()
      await database.query("UPDATE control_plane_schema_migrations SET checksum='unreviewed' WHERE version=10")
      await expect(database.transaction(async (tx) =>
        assertControlUpgradeSource(tx, plan, installationId, 16, false)))
        .rejects.toThrow('Source migration history differs')
      await database.query('UPDATE control_plane_schema_migrations SET checksum=$1 WHERE version=10', [migrations[9]!.checksum])
      await expect(migrateControlPlane(database, migrations, {
        beforeApply: (tx) => assertControlUpgradeSource(tx, plan, installationId, 16, true),
        afterApply: (tx) => grantControlWriter(tx, plan.writerRole),
      })).resolves.toBe(12)
      expect((await database.query<{ identity_profile: unknown; token_hash: string }>(
        "SELECT identity_profile, token_hash FROM browser_sessions WHERE id='bs_upgrade'")).rows[0])
        .toMatchObject({ identity_profile: null, token_hash: 'upgrade-token' })
      expect((await database.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('kala_gateway','control_plane_schema_migrations','UPDATE') AS allowed")).rows[0]?.allowed)
        .toBe(false)
      await expect(migrateControlPlane(database, migrations, {
        beforeApply: (tx) => assertControlUpgradeSource(tx, plan, installationId, 16, true),
      })).rejects.toThrow('Source migration history differs')
      expect((await database.health()).schemaVersion).toBe(12)
    } finally {
      await database?.close()
      await admin?.close()
      await docker('rm', '--force', name).catch(() => undefined)
    }
  }, 90_000)
})
