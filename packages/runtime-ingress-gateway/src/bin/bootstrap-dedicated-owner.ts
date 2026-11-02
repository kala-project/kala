#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { DedicatedOwnerBootstrapService } from '../auth/dedicated-owner.js'
import { resolveRuntimeIngressControlPlaneMode } from '../config/control-plane.js'
import { loadGatewayProductDeployment } from '../config/product-deployment.js'
import { readRequiredSecretEnv } from '../config/secret-env.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, readControlPlaneMigrations } from '../persistence/postgres.js'

export async function readProtectedOwnerPassword(pathValue: string | undefined): Promise<string> {
  const path = pathValue?.trim()
  if (!path) throw new Error('KALA_DEDICATED_OWNER_PASSWORD_FILE is required')
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Dedicated Owner password path must be a regular file, not a symlink')
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new Error('Dedicated Owner password file must not be accessible by group or other users')
  const password = (await readFile(path, 'utf8')).replace(/[\r\n]+$/u, '')
  if (!password) throw new Error('Dedicated Owner password file is empty')
  return password
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--verify-existing')) {
    throw new Error('Usage: bootstrap-dedicated-owner [--verify-existing]')
  }
  const verifyExisting = args[0] === '--verify-existing'
  const deployment = await loadGatewayProductDeployment(process.env.KALA_DEPLOYMENT_CONFIG)
  if (deployment.variant !== 'dedicated') throw new Error('Dedicated Owner bootstrap requires the Dedicated product deployment')
  if (process.env.KALA_DEDICATED_OWNER_PASSWORD) throw new Error('Dedicated Owner password must be supplied through its protected file, never a direct environment value')
  const controlPlane = await resolveRuntimeIngressControlPlaneMode(process.env, readRequiredSecretEnv)
  if (controlPlane.kind !== 'postgres') throw new Error('Dedicated Owner bootstrap requires the PostgreSQL control plane')
  const database = createPostgresControlPlaneDatabase({ connectionString: controlPlane.databaseUrl })
  try {
    await assertControlPlaneSchema(database, await readControlPlaneMigrations(resolve(process.env.KALA_INGRESS_MIGRATIONS_DIR ?? 'migrations')))
    const password = await readProtectedOwnerPassword(process.env.KALA_DEDICATED_OWNER_PASSWORD_FILE)
    const organizationName = process.env.KALA_DEDICATED_ORGANIZATION_NAME?.trim()
    if (!organizationName) throw new Error('KALA_DEDICATED_ORGANIZATION_NAME is required')
    const service = new DedicatedOwnerBootstrapService(database)
    const result = await service[verifyExisting ? 'verifyExisting' : 'bootstrap']({
      password,
      organizationName,
      ...(process.env.KALA_DEDICATED_OWNER_EMAIL?.trim() ? { ownerEmail: process.env.KALA_DEDICATED_OWNER_EMAIL } : {}),
    })
    process.stdout.write(`${JSON.stringify({ event: verifyExisting ? 'dedicated_owner_verified' : 'dedicated_owner_bootstrapped', organizationId: result.organizationId, runtimeUnitId: result.runtimeUnitId })}\n`)
  } finally {
    await database.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
