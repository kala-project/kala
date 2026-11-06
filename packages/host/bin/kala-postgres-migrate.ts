#!/usr/bin/env node
import process from 'node:process'
import { readFile } from 'node:fs/promises'

import { checkPostgresSchemaVersion, grantPostgresArenaOperator, grantPostgresGatewayRuntimeReader, grantPostgresRuntimeDml, migratePostgres } from '../src/postgres-migrations.js'

function usage(): never {
  console.error('Usage: kala-postgres-migrate [--connection-string URL] [--schema NAME] [--runtime-role EXISTING_ROLE] [--gateway-runtime-reader-role EXISTING_ROLE] [--grant-only --arena-operator-role EXISTING_LOGIN --organization-id UUID]')
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
const known = new Set(['--connection-string', '--schema', '--runtime-role', '--gateway-runtime-reader-role', '--arena-operator-role', '--organization-id', '--grant-only'])
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]!
  if (!known.has(argument)) usage()
  if (argument === '--grant-only') continue
  index += 1
}

const direct = option('--connection-string') ?? process.env.KALA_POSTGRES_MIGRATION_CONNECTION_STRING?.trim()
const connectionFile = process.env.KALA_POSTGRES_MIGRATION_CONNECTION_STRING_FILE?.trim()
if (direct && connectionFile) throw new Error('Migration connection string and its _FILE variant are mutually exclusive')
const connectionString = direct ?? (connectionFile ? (await readFile(connectionFile, 'utf8')).trim() : undefined)
if (!connectionString) usage()

const schema = option('--schema')
const grantOnly = process.argv.includes('--grant-only')
const arenaOperatorRole = option('--arena-operator-role')
const organizationId = option('--organization-id')
if (grantOnly && (!arenaOperatorRole || !organizationId || option('--runtime-role') || option('--gateway-runtime-reader-role'))
  || (arenaOperatorRole || organizationId) && !grantOnly) usage()
const result = grantOnly
  ? { currentVersion: await checkPostgresSchemaVersion({ connectionString, ...(schema ? { schema } : {}) }),
    appliedVersions: [] as number[] }
  : await migratePostgres({ connectionString, ...(schema ? { schema } : {}) })
const runtimeRole = option('--runtime-role')
if (runtimeRole) {
  await grantPostgresRuntimeDml({ connectionString, runtimeRole, ...(schema ? { schema } : {}) })
}
const gatewayRuntimeReaderRole = option('--gateway-runtime-reader-role')
if (gatewayRuntimeReaderRole) {
  await grantPostgresGatewayRuntimeReader({ connectionString, readerRole: gatewayRuntimeReaderRole, ...(schema ? { schema } : {}) })
}
if (arenaOperatorRole) {
  await grantPostgresArenaOperator({ connectionString, operatorRole: arenaOperatorRole, organizationId: organizationId!, ...(schema ? { schema } : {}) })
}
console.log(JSON.stringify({
  ...result,
  ...(grantOnly ? { grantOnly: true } : {}),
  ...(runtimeRole ? { runtimeRoleGranted: runtimeRole } : {}),
  ...(gatewayRuntimeReaderRole ? { gatewayRuntimeReaderRoleGranted: gatewayRuntimeReaderRole } : {}),
  ...(arenaOperatorRole ? { arenaOperatorRoleGranted: arenaOperatorRole } : {}),
}))
