#!/usr/bin/env node
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { DedicatedOidcOwnerService } from '../auth/dedicated-oidc-owner.js'
import { resolveRuntimeIngressControlPlaneMode } from '../config/control-plane.js'
import { loadGatewayProductDeployment } from '../config/product-deployment.js'
import { readRequiredSecretEnv } from '../config/secret-env.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, readControlPlaneMigrations } from '../persistence/postgres.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const verify = args.length === 1 && args[0] === '--verify-existing'
  const bind = args.length === 3 && args[0] === '--bind-existing'
  if (args.length && !verify && !bind) {
    throw new Error('Usage: bootstrap-dedicated-oidc-owner [--verify-existing | --bind-existing ORGANIZATION_ID PRINCIPAL_ID]')
  }
  const deployment = await loadGatewayProductDeployment(process.env.KALA_DEPLOYMENT_CONFIG)
  if (deployment.variant !== 'dedicated') throw new Error('Dedicated OIDC Owner operation requires a Dedicated deployment')
  const control = await resolveRuntimeIngressControlPlaneMode(process.env, readRequiredSecretEnv)
  if (control.kind !== 'postgres') throw new Error('Dedicated OIDC Owner operation requires PostgreSQL')
  const issuer = new URL(await readRequiredSecretEnv('OIDC_ISSUER')).href.replace(/\/$/u, '')
  const subject = process.env.KALA_DEDICATED_OWNER_OIDC_SUBJECT?.trim()
  if (!subject) throw new Error('KALA_DEDICATED_OWNER_OIDC_SUBJECT must be the explicitly verified OIDC subject, never an email or login name')
  const database = createPostgresControlPlaneDatabase({ connectionString: control.databaseUrl })
  try {
    await assertControlPlaneSchema(database, await readControlPlaneMigrations(resolve(process.env.KALA_INGRESS_MIGRATIONS_DIR ?? 'migrations')))
    const service = new DedicatedOidcOwnerService(database)
    const identity = { issuer, subject, displayName: 'Owner' }
    let result
    if (bind) {
      result = await service.bindExisting({ identity, expectedOrganizationId: args[1]!, expectedPrincipalId: args[2]! })
    } else if (verify) {
      result = await service.verify(identity)
    } else {
      const name = process.env.KALA_DEDICATED_ORGANIZATION_NAME?.trim()
      if (!name) throw new Error('KALA_DEDICATED_ORGANIZATION_NAME is required')
      result = await service.bootstrap(identity, name)
    }
    process.stdout.write(`${JSON.stringify({ event: bind ? 'dedicated_owner_oidc_bound' : verify ? 'dedicated_oidc_owner_verified' : 'dedicated_oidc_owner_bootstrapped', ...result })}\n`)
  } finally { await database.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) })
}
