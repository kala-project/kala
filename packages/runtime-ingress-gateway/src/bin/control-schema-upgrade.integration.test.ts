import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { QueryResultRow } from 'pg'

import { assertControlUpgradeSource, migrationIdentities, validateControlUpgradePlan } from './control-schema-upgrade.js'
import { grantControlWriter } from './init-control-plane.js'
import { PostgresOrganizationStore } from '../organizations/postgres-store.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'
import { PostgresModelPolicyReader } from '../settings/model-policy-reader.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integration('control schema 10-to-11 and attachment policy migration on isolated PostgreSQL', () => {
  it('preserves existing browser sessions and rejects replay or altered source history', async () => {
    const name = `kala-control-10-11-${randomUUID()}`
    const password = randomUUID()
    const installationId = randomUUID()
    const checkpointId = randomUUID()
    const docker = (...args: string[]) => exec('docker', args)
    let database: ReturnType<typeof createPostgresControlPlaneDatabase> | undefined
    let admin: ReturnType<typeof createPostgresControlPlaneDatabase> | undefined
    try {
      const migrations = await readControlPlaneMigrations(resolve('migrations'))
      const reviewedMigrations = migrations.slice(0, 11)
      const plan = validateControlUpgradePlan({
        fromVersion: 10,
        toVersion: 11,
        writerRole: 'kala_gateway',
        migrations: migrationIdentities(reviewedMigrations),
      }, reviewedMigrations)
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
      await admin.query(`CREATE ROLE kala_gateway LOGIN PASSWORD '${password}'`)
      await admin.query('CREATE DATABASE runlab_control OWNER kala_control_owner')
      await admin.close()
      admin = undefined

      database = createPostgresControlPlaneDatabase({
        connectionString: `postgres://kala_control_owner:${password}@127.0.0.1:${port}/runlab_control`,
        maxConnections: 4,
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
      await expect(migrateControlPlane(database, reviewedMigrations, {
        beforeApply: (tx) => assertControlUpgradeSource(tx, plan, installationId, 16, true),
        afterApply: (tx) => grantControlWriter(tx, plan.writerRole),
      })).resolves.toBe(11)
      expect((await database.query<{ identity_profile: unknown; token_hash: string }>(
        "SELECT identity_profile, token_hash FROM browser_sessions WHERE id='bs_upgrade'")).rows[0])
        .toMatchObject({ identity_profile: null, token_hash: 'upgrade-token' })
      expect((await database.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('kala_gateway','control_plane_schema_migrations','UPDATE') AS allowed")).rows[0]?.allowed)
        .toBe(false)
      await expect(migrateControlPlane(database, reviewedMigrations, {
        beforeApply: (tx) => assertControlUpgradeSource(tx, plan, installationId, 16, true),
      })).rejects.toThrow('Source migration history differs')
      expect((await database.health()).schemaVersion).toBe(11)
      await expect(migrateControlPlane(database, migrations.slice(0, 12))).resolves.toBe(12)
      await expect(assertControlPlaneSchema(database, migrations)).resolves.toBe(12)
      const identity = { issuer: 'issuer', subject: 'subject' }
      const bridge = new PostgresOrganizationStore(database)
      await database.query(`INSERT INTO contract_entitlements(organization_id,contract_reference,support_tier,starts_at,ends_at,seat_limit,concurrent_session_limit)
        VALUES('org_upgrade','bridge-fixture','standard',now()-interval '1 day',now()+interval '1 day',10,10);
        INSERT INTO executor_pools(id,organization_id,name,mode) VALUES('pool_upgrade','org_upgrade','Bridge pool','organization')`)
      const admission = (invite: string, executorId: string) => ({ installationId, organizationId: 'org_upgrade', unitId: 'unit-upgrade',
        executorId, workspaceId: 'bridge-native-workspace', enrollmentHash: createHash('sha256').update(invite).digest('hex'),
        enrollmentInviteId: executorId })
      await bridge.bindExecutorInvite('fictional-old-native', 'unit-upgrade')
      await bridge.bindExecutorInvite('fictional-old-native-late', 'unit-upgrade')
      await database.query("UPDATE executor_enrollment_tokens SET expires_at=now()-interval '1 hour',created_at=now()-interval '2 hours'")
      expect(await new PostgresModelPolicyReader(database, installationId).executor(admission('fictional-old-native', 'old-native')))
        .toMatchObject({ admitted: true, registry: 'registered', pool: { revision: '1' } })
      expect(await bridge.attachmentConfiguration('org_upgrade')).toEqual({ value: { maxBytes: 2 * 1024 * 1024 } })
      await expect(bridge.updateAttachmentLimit('org_upgrade', 4 * 1024 * 1024, identity, { expectedRevision: '1' }))
        .rejects.toMatchObject({ status: 503 })
      let release = (): void => {}
      let observed = (): void => {}
      const released = new Promise<void>(resolve => { release = resolve })
      const probed = new Promise<void>(resolve => { observed = resolve })
      const pausedBridge = new PostgresOrganizationStore({
        query: database.query,
        transaction: operation => database!.transaction(transaction => operation({
          query: async <Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
            const result = await transaction.query<Row>(sql, values)
            if (sql.includes("to_regclass('public.settings_resource_versions')")) { observed(); await released }
            return result
          },
        })),
      })
      const oldWrite = pausedBridge.updateAttachmentLimit('org_upgrade', 4 * 1024 * 1024, identity)
      await probed
      const expansion = migrateControlPlane(database, migrations)
      void expansion.catch(() => undefined)
      try {
        let waiting = false
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = (await database.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted) AS waiting",
          )).rows[0]?.waiting === true
          if (waiting) break
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(waiting).toBe(true)
      } finally { release() }
      await oldWrite
      await expect(expansion).resolves.toBe(17)
      expect(await bridge.attachmentConfiguration('org_upgrade')).toEqual({ revision: '1', value: { maxBytes: 4 * 1024 * 1024 } })
      await expect(assertControlPlaneSchema(database, migrations)).resolves.toBe(17)
      await expect(assertControlPlaneSchema(database, migrations.slice(0, 14))).rejects.toThrow('ahead expected version 14')
      await expect(assertControlPlaneSchema(database, migrations.slice(0, 15))).rejects.toThrow('ahead expected version 15')
      await expect(assertControlPlaneSchema(database, migrations.slice(0, 13))).rejects.toThrow('ahead expected version 13')
      await expect(assertControlPlaneSchema(database, migrations.slice(0, 12))).rejects.toThrow('ahead expected version 12')
      expect((await database.query<{ token_hash: string }>("SELECT token_hash FROM browser_sessions WHERE id='bs_upgrade'")).rows[0]?.token_hash).toBe('upgrade-token')
      const store = new PostgresOrganizationStore(database)
      expect((await store.findAccess(identity))?.organization.attachmentMaxBytes).toBe(4 * 1024 * 1024)
      await bridge.updateAttachmentLimit('org_upgrade', 8 * 1024 * 1024, identity, { expectedRevision: '1' })
      expect(await bridge.attachmentConfiguration('org_upgrade')).toEqual({ revision: '2', value: { maxBytes: 8 * 1024 * 1024 } })
      expect((await store.findAccess(identity))?.organization.attachmentMaxBytes).toBe(8 * 1024 * 1024)
      await expect(store.updateAttachmentLimit('org_upgrade', 3 * 1024 * 1024, identity)).rejects.toThrow('invalid_attachment_limit')
      expect((await database.query<{ action: string; actor_principal_id: string }>(
        "SELECT action,actor_principal_id FROM audit_events WHERE organization_id='org_upgrade' AND action='organization.attachment_limit.update'"
      )).rows).toEqual([
        { action: 'organization.attachment_limit.update', actor_principal_id: 'prn_upgrade' },
        { action: 'organization.attachment_limit.update', actor_principal_id: 'prn_upgrade' },
      ])
      await database.query('CREATE TABLE unreviewed_operator_resource (id text PRIMARY KEY, protected_value text)')
      await database.query('CREATE SEQUENCE unreviewed_operator_sequence')
      await database.query('GRANT UPDATE (state) ON settings_operator_operations TO kala_gateway')
      await grantControlWriter(database, 'kala_gateway')
      const gateway = createPostgresControlPlaneDatabase({
        connectionString: `postgres://kala_gateway:${password}@127.0.0.1:${port}/runlab_control`, maxConnections: 1,
      })
      try {
        const rollback = new PostgresOrganizationStore(gateway)
        const reader = new PostgresModelPolicyReader(gateway, installationId)
        expect(await reader.executor(admission('fictional-old-native-late', 'old-native-late'))).toMatchObject({ admitted: true })
        await rollback.revokeExecutorInviteBinding('old-native-late', 'unit-upgrade', true)
        expect(await reader.executor(admission('fictional-old-native-late', 'old-native-late'))).toMatchObject({ admitted: false })
        const binding = { id: 'new-native', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }
        await rollback.bindExecutorInvite('fictional-new-native', 'unit-upgrade', binding)
        expect(await reader.executor(admission('fictional-new-native', 'new-native'))).toMatchObject({ admitted: true })
        await rollback.bindExecutorInvite('fictional-new-native', 'unit-upgrade', binding)
        expect((await gateway.query("SELECT used_count FROM executor_enrollment_tokens WHERE token_hash=$1",
          [createHash('sha256').update('fictional-new-native').digest('base64url')])).rows[0]?.used_count).toBe(1)
        await rollback.revokeExecutorInviteBinding('new-native', 'unit-upgrade', false)
        expect(await reader.executor(admission('fictional-new-native', 'new-native'))).toMatchObject({ admitted: true })
        await rollback.revokeExecutorInviteBinding('new-native', 'unit-upgrade', true)
        expect(await reader.executor(admission('fictional-new-native', 'new-native'))).toMatchObject({ admitted: false })
        await rollback.bindExecutorInvite('fictional-expired-new-native', 'unit-upgrade',
          { id: 'expired-new-native', expiresAt: binding.expiresAt })
        await database.query("UPDATE executor_enrollment_tokens SET expires_at=clock_timestamp()+interval '30 milliseconds' WHERE token_hash=$1",
          [createHash('sha256').update('fictional-expired-new-native').digest('base64url')])
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(await reader.executor(admission('fictional-expired-new-native', 'expired-new-native'))).toMatchObject({ admitted: false })
        await rollback.updateAttachmentLimit('org_upgrade', 16 * 1024 * 1024, identity, { expectedRevision: '2', writeProtocol: 'conditional-required' })
        await expect(rollback.updateAttachmentLimit('org_upgrade', 2 * 1024 * 1024, identity, { writeProtocol: 'conditional-required' })).rejects.toMatchObject({ status: 428 })
        await rollback.updateAttachmentLimit('org_upgrade', 4 * 1024 * 1024, identity)
        expect(await rollback.attachmentConfiguration('org_upgrade')).toEqual({ revision: '4', value: { maxBytes: 4 * 1024 * 1024 } })
        await expect(gateway.query('DELETE FROM settings_resource_versions')).rejects.toMatchObject({ code: '42501' })
        await expect(gateway.query('SELECT * FROM organization_model_management')).resolves.toHaveProperty('rowCount', 1)
        await expect(gateway.query('SELECT * FROM organization_webhook_secret_bindings')).resolves.toHaveProperty('rowCount', 0)
        for (const sql of [
          'INSERT INTO organization_model_management(organization_id,desired_management) VALUES (\'forbidden\',\'dashboard\')',
          'UPDATE organization_webhook_secret_bindings SET label=\'forbidden\'',
          'SELECT * FROM settings_operator_operations', 'UPDATE settings_operator_operations SET state=\'failed\'',
          'SELECT * FROM unreviewed_operator_resource', 'DELETE FROM unreviewed_operator_resource',
          "SELECT nextval('unreviewed_operator_sequence')",
        ]) await expect(gateway.query(sql)).rejects.toMatchObject({ code: '42501' })
        await expect(gateway.query("UPDATE workspaces SET name=name WHERE organization_id='org_upgrade'")).resolves.toHaveProperty('rowCount', 0)
      } finally { await gateway.close() }
      await database.query('GRANT UPDATE (desired_management) ON organization_model_management TO PUBLIC')
      try {
        await expect(grantControlWriter(database, 'kala_gateway')).rejects.toThrow('Gateway writer must not inherit Settings Operator authority')
      } finally { await database.query('REVOKE UPDATE (desired_management) ON organization_model_management FROM PUBLIC') }
    } finally {
      await database?.close()
      await admin?.close()
      await docker('rm', '--force', name).catch(() => undefined)
    }
  }, 90_000)
})
