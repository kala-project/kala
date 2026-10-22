#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'

const { Client } = pg

interface ControlPlaneInitConfig {
  adminUrl?: string
  databaseUrl: string
  requireExistingDatabase: boolean
}

export async function resolveControlPlaneInitConfig(
  environment: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<ControlPlaneInitConfig> {
  const databaseUrl = await readConnectionString('KALA_INGRESS_DATABASE_URL', environment, readSecret, true)
  const requireExistingValue = environment.KALA_INGRESS_REQUIRE_EXISTING_DATABASE
  if (requireExistingValue !== undefined && requireExistingValue !== '0' && requireExistingValue !== '1') {
    throw new Error('KALA_INGRESS_REQUIRE_EXISTING_DATABASE must be 0 or 1')
  }
  const requireExistingDatabase = requireExistingValue === '1'
  const adminUrl = await readConnectionString('KALA_INGRESS_ADMIN_DATABASE_URL', environment, readSecret, !requireExistingDatabase)
  return { ...(adminUrl ? { adminUrl } : {}), databaseUrl: databaseUrl!, requireExistingDatabase }
}

async function main(): Promise<void> {
  const { adminUrl, databaseUrl, requireExistingDatabase } = await resolveControlPlaneInitConfig()
  const writerRole = process.env.KALA_INGRESS_CONTROL_WRITER_ROLE
  if (requireExistingDatabase) {
    if (new URL(databaseUrl).pathname !== '/runlab_control') throw new Error('external control database must be runlab_control')
    if (!writerRole) throw new Error('KALA_INGRESS_CONTROL_WRITER_ROLE is required for external control PostgreSQL')
    assertControlWriterRole(writerRole)
    const probe = new Client({ connectionString: databaseUrl })
    try {
      await probe.connect()
      await probe.query('SELECT current_database()')
    } catch (error) {
      throw new Error('the externally managed control database must exist and be reachable before migrations start', { cause: error })
    } finally {
      await probe.end().catch(() => undefined)
    }
  } else {
    const admin = new Client({ connectionString: adminUrl! })
    await admin.connect()
    try {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='runlab_control'")
      if (exists.rowCount === 0) await admin.query('CREATE DATABASE runlab_control')
    } finally { await admin.end() }
  }

  const database = createPostgresControlPlaneDatabase({ connectionString: databaseUrl, applicationName: 'agent-runlab-control-plane-init', maxConnections: 1 })
  try {
    const migrations = await readControlPlaneMigrations(resolve(process.env.KALA_INGRESS_MIGRATIONS_DIR ?? 'migrations'))
    const version = await migrateControlPlane(database, migrations)
    if (writerRole) await grantControlWriter(database, writerRole)
    process.stdout.write(`${JSON.stringify({ event: 'control_plane_initialized', version })}\n`)
  } finally { await database.close() }
}

/** Grant DML, never ownership/DDL, to the existing steady-state Gateway role. */
export async function grantControlWriter(database: { query: (sql: string) => Promise<unknown> }, role: string): Promise<void> {
  // Role names are non-secret identifiers; rejecting quoting avoids SQL injection and ambiguity.
  assertControlWriterRole(role)
  await database.query(`GRANT CONNECT ON DATABASE runlab_control TO "${role}"`)
  await database.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
  await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`)
  await database.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
}

function assertControlWriterRole(role: string): void {
  if (!/^[a-z_][a-z0-9_]*$/u.test(role)) throw new Error('Gateway control writer role must be a simple lowercase PostgreSQL identifier')
}

async function readConnectionString(
  name: string,
  environment: NodeJS.ProcessEnv,
  readSecret: (path: string) => Promise<string>,
  required: boolean,
): Promise<string | undefined> {
  const direct = environment[name]?.trim()
  const file = environment[`${name}_FILE`]?.trim()
  if (direct && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive`)
  const value = direct ?? (file ? (await readSecret(file)).trim() : undefined)
  if (required && !value) throw new Error(`${name} or ${name}_FILE is required`)
  return value || undefined
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })
}
