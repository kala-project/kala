#!/usr/bin/env node
import process from 'node:process'
import { readFile } from 'node:fs/promises'

import { grantPostgresGatewayRuntimeReader, grantPostgresRuntimeDml, migratePostgres } from '../src/postgres-migrations.js'

function usage(): never {
  console.error('Usage: kala-postgres-migrate [--connection-string URL] [--schema NAME] [--runtime-role EXISTING_ROLE] [--gateway-runtime-reader-role EXISTING_ROLE]')
  console.error('The connection string may instead be supplied in KALA_POSTGRES_MIGRATION_CONNECTION_STRING or its _FILE variant.')
  process.exit(2)
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]?.trim()
  if (!value || value.startsWith('--')) usage()
  return value
}

if (process.argv.includes('--help') || process.argv.includes('-h')) usage()
const known = new Set(['--connection-string', '--schema', '--runtime-role', '--gateway-runtime-reader-role'])
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]!
  if (!known.has(argument)) usage()
  index += 1
}

const direct = option('--connection-string') ?? process.env.KALA_POSTGRES_MIGRATION_CONNECTION_STRING?.trim()
const connectionFile = process.env.KALA_POSTGRES_MIGRATION_CONNECTION_STRING_FILE?.trim()
if (direct && connectionFile) throw new Error('Migration connection string and its _FILE variant are mutually exclusive')
const connectionString = direct ?? (connectionFile ? (await readFile(connectionFile, 'utf8')).trim() : undefined)
if (!connectionString) usage()

const schema = option('--schema')
const result = await migratePostgres({ connectionString, ...(schema ? { schema } : {}) })
const runtimeRole = option('--runtime-role')
if (runtimeRole) {
  await grantPostgresRuntimeDml({ connectionString, runtimeRole, ...(schema ? { schema } : {}) })
}
const gatewayRuntimeReaderRole = option('--gateway-runtime-reader-role')
if (gatewayRuntimeReaderRole) {
  await grantPostgresGatewayRuntimeReader({ connectionString, readerRole: gatewayRuntimeReaderRole, ...(schema ? { schema } : {}) })
}
console.log(JSON.stringify({
  ...result,
  ...(runtimeRole ? { runtimeRoleGranted: runtimeRole } : {}),
  ...(gatewayRuntimeReaderRole ? { gatewayRuntimeReaderRoleGranted: gatewayRuntimeReaderRole } : {}),
}))
