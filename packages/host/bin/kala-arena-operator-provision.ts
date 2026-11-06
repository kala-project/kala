#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { checkPostgresSchemaVersion, grantPostgresArenaOperator } from '../src/postgres-migrations.js'

const [adminFile, organizationId, outputFile, flag] = process.argv.slice(2)
if (!adminFile || !outputFile || adminFile === outputFile || !organizationId
  || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(organizationId)
  || (flag !== undefined && flag !== '--rotate') || process.argv.length !== (flag ? 6 : 5)) {
  throw new Error('Usage: kala-arena-operator-provision <0600-PG-admin-URL-file> <organization-UUID> <operator-URL-file> [--rotate]')
}
const checkedFile = async (path: string) => {
  const info = await lstat(path)
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('Credential must be a regular, user-owned file without group/other access')
  }
  return (await readFile(path, 'utf8')).trim()
}
const adminUrl = await checkedFile(adminFile)
const priorUrl = flag ? await checkedFile(outputFile) : undefined
if (!flag) {
  await lstat(outputFile).then(() => { throw new Error('Operator credential already exists; use --rotate') },
    (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
}
await checkPostgresSchemaVersion({ connectionString: adminUrl })

const role = `arena_operator_${organizationId.replaceAll('-', '')}`
const password = randomBytes(48).toString('base64url')
const endpoint = new URL(adminUrl)
if (!['postgres:', 'postgresql:'].includes(endpoint.protocol) || !endpoint.hostname || !endpoint.pathname) {
  throw new Error('Admin URL must identify a PostgreSQL database')
}
if ([...endpoint.searchParams.keys()].some((key) => key !== 'sslmode')) {
  throw new Error('Admin URL options or client certificate cannot be reused as operator credentials')
}
endpoint.username = role
endpoint.password = password
if (priorUrl) {
  const prior = new URL(priorUrl)
  if (prior.username !== role || prior.hostname !== endpoint.hostname
    || prior.port !== endpoint.port || prior.pathname !== endpoint.pathname) {
    throw new Error('Existing credential does not belong to this operator and database')
  }
}
const nextFile = `${outputFile}.next-${randomUUID()}`
const file = await open(nextFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
try { await file.writeFile(`${endpoint.toString()}\n`); await file.sync() }
finally { await file.close() }

const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: object) => {
  connect(): Promise<{ query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(): void }>
  end(): Promise<void>
} }
const pool = new Pool({ connectionString: adminUrl, max: 1 })
try {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [role])
    const visibility = await client.query(`SELECT
      pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')
      OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS can_drain`)
    if (visibility.rows[0]?.can_drain !== true) {
      throw new Error('Provisioner cannot prove all operator sessions have drained')
    }
    const active = await client.query('SELECT pid FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()', [role])
    if (active.rows.length) throw new Error('Operator still has active database connections; freeze and drain before rotation')
    if (flag) {
      const current = await client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [role])
      if (current.rows[0]?.rolcanlogin !== true) throw new Error('Existing operator LOGIN is missing')
      await client.query(`ALTER ROLE "${role}" PASSWORD '${password}'`)
    } else {
      await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'
        NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
  await grantPostgresArenaOperator({ connectionString: adminUrl, operatorRole: role, organizationId })
  const verify = new Pool({ connectionString: endpoint.toString(), max: 1 })
  try {
    const verifier = await verify.connect()
    try {
      const identity = await verifier.query('SELECT session_user AS login')
      if (identity.rows[0]?.login !== role) throw new Error('New operator credential did not authenticate as its dedicated LOGIN')
    } finally { verifier.release() }
  } finally { await verify.end() }
  await rename(nextFile, outputFile)
  console.log(JSON.stringify({ operatorId: role, organizationId, credentialFile: outputFile, rotated: Boolean(flag) }))
} catch (error) {
  await unlink(nextFile).catch(() => undefined)
  throw error
} finally { await pool.end() }
