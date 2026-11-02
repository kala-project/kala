#!/usr/bin/env node
/** Image-contained, deliberately narrow Dedicated 7 -> 9 maintenance entrypoint. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations, type ControlPlaneMigration, type SqlExecutor } from '../persistence/postgres.js'
import { grantControlWriter } from './init-control-plane.js'
import { assertWebhookInstallation } from '../webhooks/worker-authority.js'

export type MigrationIdentity = Pick<ControlPlaneMigration, 'version' | 'name' | 'checksum'>
export interface ControlUpgradePlan {
  fromVersion: 7
  toVersion: 9
  writerRole: 'kala_gateway'
  migrations: readonly MigrationIdentity[]
}
export function migrationIdentities(migrations: readonly ControlPlaneMigration[]): MigrationIdentity[] {
  return migrations.map(({ version, name, checksum }) => ({ version, name, checksum }))
}

export function validateControlUpgradePlan(value: unknown, migrations: readonly ControlPlaneMigration[]): ControlUpgradePlan {
  const plan = value as Partial<ControlUpgradePlan> | null
  if (!plan || plan.fromVersion !== 7 || plan.toVersion !== 9 || plan.writerRole !== 'kala_gateway'
    || Object.keys(plan).sort().join(',') !== 'fromVersion,migrations,toVersion,writerRole'
    || !Array.isArray(plan.migrations) || migrations.length !== 9 || plan.migrations.length !== migrations.length) {
    throw new Error('Unsupported reviewed control upgrade plan')
  }
  for (const [index, actual] of migrations.entries()) {
    const reviewed = plan.migrations[index]
    if (!reviewed || Object.keys(reviewed).sort().join(',') !== 'checksum,name,version'
      || actual.version !== index + 1 || reviewed.version !== actual.version
      || reviewed.name !== actual.name || reviewed.checksum !== actual.checksum) {
      throw new Error('Reviewed migration manifest differs from packaged release')
    }
  }
  return plan as ControlUpgradePlan
}

export async function assertControlUpgradeSource(
  tx: SqlExecutor, plan: ControlUpgradePlan, installationId: string, postgresMajor: number, exclusive: boolean,
): Promise<void> {
  const identity = await tx.query<{ valid: boolean; major: number }>(`SELECT session_user=current_user
    AND current_user='kala_control_owner' AND current_database()='runlab_control'
    AND pg_get_userbyid(datdba)=current_user
    AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS valid,
    (current_setting('server_version_num')::integer/10000)::integer AS major
    FROM pg_database JOIN pg_roles ON rolname=current_user WHERE datname=current_database()`)
  if (!identity.rows[0]?.valid || identity.rows[0].major !== postgresMajor) throw new Error('Migration database authority differs from reviewed installation')
  await assertWebhookInstallation(tx, installationId)
  const history = await tx.query<MigrationIdentity>('SELECT version,name,checksum FROM control_plane_schema_migrations ORDER BY version')
  const expected = plan.migrations.slice(0, plan.fromVersion)
  if (history.rows.length !== expected.length || history.rows.some((row, i) => row.version !== expected[i]!.version
    || row.name !== expected[i]!.name || row.checksum !== expected[i]!.checksum)) {
    throw new Error('Source migration history differs; partial/ahead/unknown results require operator review')
  }
  if (exclusive) {
    const peers = await tx.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() LIMIT 1`)
    if (peers.rowCount !== 0) throw new Error('Other control clients remain; fence all application and background writers')
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['--describe', '--check-source', '--apply'].includes(mode ?? '')) throw new Error('Unsupported migration action')
  const migrations = await readControlPlaneMigrations(resolve('migrations'))
  const identities = migrationIdentities(migrations)
  if (mode === '--describe') {
    process.stdout.write(JSON.stringify({ event: 'control_schema_bundle', version: migrations.at(-1)?.version, migrations: identities }) + '\n')
    return
  }
  const policy = JSON.parse(await readFile('/run/kala-upgrade/policy.json', 'utf8')) as { postgresMajor?: unknown; controlSchema?: unknown }
  if (!Number.isSafeInteger(policy.postgresMajor) || Number(policy.postgresMajor) < 10) throw new Error('Invalid reviewed PostgreSQL major')
  const plan = validateControlUpgradePlan(policy.controlSchema, migrations)
  const installation = (await readFile('/run/kala-upgrade/installation-id', 'utf8')).trim()
  const connectionString = (await readFile('/run/kala-upgrade/control-owner-url', 'utf8')).trim()
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' || (url.port && url.port !== '5432')
    || decodeURIComponent(url.username) !== 'kala_control_owner' || url.pathname !== '/runlab_control' || !url.password
    || url.search || url.hash) throw new Error('Only the original local control owner authority is allowed')
  const database = createPostgresControlPlaneDatabase({ connectionString, maxConnections: 1, applicationName: 'kala-dedicated-control-upgrade' })
  try {
    if (mode === '--check-source') {
      await database.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY')
        await assertControlUpgradeSource(tx, plan, installation, Number(policy.postgresMajor), false)
      })
    } else {
      await migrateControlPlane(database, migrations, {
        beforeApply: (tx) => assertControlUpgradeSource(tx, plan, installation, Number(policy.postgresMajor), true),
        afterApply: (tx) => grantControlWriter(tx, plan.writerRole),
      })
    }
    process.stdout.write(JSON.stringify({ event: mode === '--apply' ? 'control_schema_upgrade_committed' : 'control_schema_source_verified',
      fromVersion: plan.fromVersion, toVersion: plan.toVersion, migrations: identities }) + '\n')
  } finally { await database.close() }
}

const invoked = process.argv[1]
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main().catch(() => { process.stderr.write('control_schema_upgrade_rejected_or_unknown\n'); process.exitCode = 1 })
}
