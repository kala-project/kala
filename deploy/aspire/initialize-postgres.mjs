#!/usr/bin/env node
import { createRequire } from 'node:module'
import { lstat, readFile } from 'node:fs/promises'

const require = createRequire('/app/packages/host/package.json')
const { Client } = require('pg')
const secretRoot = '/run/kala-init-secrets'
const expected = {
  postgres_admin_url: { user: 'postgres', database: 'postgres' },
  control_owner_url: { user: 'kala_control_owner', database: 'runlab_control' },
  gateway_database_url: { user: 'kala_gateway', database: 'runlab_control' },
  runtime_owner_url: { user: 'kala_runtime_owner', database: 'kala_runtime' },
  runtime_database_url: { user: 'kala_runtime', database: 'kala_runtime' },
  runtime_reader_database_url: { user: 'kala_runtime_reader', database: 'kala_runtime' },
}

async function secret(name) {
  const path = `${secretRoot}/${name}`
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must be a regular file inaccessible to group and other users`)
  }
  const value = (await readFile(path, 'utf8')).trim()
  if (!value) throw new Error(`${name} is empty`)
  return value
}

function parseDatabaseUrl(name, value) {
  const url = new URL(value)
  const contract = expected[name]
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres'
    || (url.port && url.port !== '5432') || decodeURIComponent(url.username) !== contract.user
    || decodeURIComponent(url.pathname.slice(1)) !== contract.database || !url.password) {
    throw new Error(`${name} must select ${contract.user}@postgres:5432/${contract.database}`)
  }
  return { url: value, user: contract.user, database: contract.database, password: decodeURIComponent(url.password) }
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}
function literal(value) {
  return `'${value.replaceAll("'", "''")}'`
}
async function query(client, text, values) {
  return await client.query(text, values)
}

const urls = {}
for (const name of Object.keys(expected)) urls[name] = parseDatabaseUrl(name, await secret(name))
const installationId = await secret('installation_id')
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(installationId)) {
  throw new Error('installation_id must contain one canonical UUID')
}
const identities = Object.values(urls)
if (new Set(identities.map(({ user }) => user)).size !== identities.length
  || new Set(identities.map(({ password }) => password)).size !== identities.length) {
  throw new Error('all PostgreSQL principals and passwords must be distinct')
}

let admin
for (let attempt = 0; ; attempt += 1) {
  admin = new Client({ connectionString: urls.postgres_admin_url.url, application_name: 'kala-aspire-postgres-provisioner' })
  try {
    await admin.connect()
    break
  } catch (error) {
    await admin.end().catch(() => undefined)
    if (attempt >= 29) throw error
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}
try {
  await query(admin, "SELECT pg_advisory_lock(hashtextextended('kala-aspire-postgres-provision', 0))")
  const markerTable = await query(admin, "SELECT to_regclass('kala_aspire_provisioning.installation')::text AS name")
  if (!markerTable.rows[0]?.name) {
    const markerSchema = await query(admin, "SELECT 1 FROM pg_namespace WHERE nspname='kala_aspire_provisioning'")
    const databases = await query(admin, "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND datname <> 'postgres'")
    const roles = await query(admin, "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname <> 'postgres' AND rolname !~ '^pg_'")
    const objects = await query(admin, `SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_' LIMIT 1`)
    if (markerSchema.rowCount !== 0 || databases.rowCount !== 0 || roles.rowCount !== 0 || objects.rowCount !== 0) {
      throw new Error('PostgreSQL cluster is not pristine and has no complete Aspire provisioning marker; initialization refused')
    }
    await query(admin, 'CREATE SCHEMA kala_aspire_provisioning')
    await query(admin, `CREATE TABLE kala_aspire_provisioning.installation (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), installation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
    await query(admin, 'INSERT INTO kala_aspire_provisioning.installation(singleton, installation_id) VALUES(true, $1)', [installationId])
  } else {
    const marker = await query(admin, 'SELECT installation_id::text AS installation_id FROM kala_aspire_provisioning.installation WHERE singleton=true')
    if (marker.rowCount !== 1 || marker.rows[0].installation_id !== installationId) {
      throw new Error('PostgreSQL Aspire provisioning marker belongs to another or incomplete installation')
    }
  }

  for (const role of identities.slice(1)) {
    const present = await query(admin, `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname=$1`, [role.user])
    if (present.rowCount === 0) {
      await query(admin, `CREATE ROLE ${identifier(role.user)} LOGIN PASSWORD ${literal(role.password)}
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
    } else {
      const value = present.rows[0]
      if (!value.rolcanlogin || value.rolsuper || value.rolcreatedb || value.rolcreaterole || value.rolreplication || value.rolbypassrls) {
        throw new Error(`existing role ${role.user} has unsafe attributes`)
      }
      await query(admin, `ALTER ROLE ${identifier(role.user)} PASSWORD ${literal(role.password)}`)
    }
  }

  for (const [database, owner] of [['runlab_control', 'kala_control_owner'], ['kala_runtime', 'kala_runtime_owner']]) {
    const present = await query(admin, 'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [database])
    if (present.rowCount === 0) {
      await query(admin, `CREATE DATABASE ${identifier(database)} OWNER ${identifier(owner)}`)
    } else if (present.rowCount !== 1 || present.rows[0].owner !== owner) {
      throw new Error(`existing database ${database} has an unexpected owner`)
    }
    await query(admin, `REVOKE ALL ON DATABASE ${identifier(database)} FROM PUBLIC`)
  }
  await query(admin, 'GRANT CONNECT ON DATABASE runlab_control TO kala_control_owner, kala_gateway')
  await query(admin, 'GRANT CONNECT ON DATABASE kala_runtime TO kala_runtime_owner, kala_runtime, kala_runtime_reader')
} finally {
  await admin.query("SELECT pg_advisory_unlock(hashtextextended('kala-aspire-postgres-provision', 0))").catch(() => undefined)
  await admin.end()
}

for (const name of ['control_owner_url', 'runtime_owner_url']) {
  const target = urls[name]
  const client = new Client({ connectionString: target.url, application_name: 'kala-aspire-postgres-hardener' })
  await client.connect()
  try {
    await query(client, 'REVOKE ALL ON SCHEMA public FROM PUBLIC')
    await query(client, `GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(target.user)}`)
  } finally {
    await client.end()
  }
}
process.stdout.write(`${JSON.stringify({ event: 'aspire_postgres_provisioned', installationId })}\n`)
