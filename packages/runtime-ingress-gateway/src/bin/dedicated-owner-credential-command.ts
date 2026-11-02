import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import { DedicatedOwnerCredentialService } from '../auth/dedicated-owner.js'
import { resolveRuntimeIngressControlPlaneMode } from '../config/control-plane.js'
import { loadGatewayProductDeployment } from '../config/product-deployment.js'
import { readRequiredSecretEnv } from '../config/secret-env.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, readControlPlaneMigrations } from '../persistence/postgres.js'

export const LOST_PASSWORD_ACKNOWLEDGEMENT = '--acknowledge-local-root-owner-recovery'

type CredentialOperation = 'change' | 'reset'

export async function readPrivatePasswordFile(pathValue: string | undefined, label: string, requireRootOwner: boolean): Promise<string> {
  const path = pathValue?.trim()
  if (!path) throw new Error(`${label} is required`)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must name a regular file, not a symlink`)
  if (process.platform !== 'win32') {
    if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or other users`)
    if (requireRootOwner && metadata.uid !== 0) throw new Error(`${label} must be owned by root`)
  }
  const password = (await readFile(path, 'utf8')).replace(/[\r\n]+$/u, '')
  if (!password) throw new Error(`${label} is empty`)
  return password
}

export async function runDedicatedOwnerCredentialCommand(operation: CredentialOperation, args: string[]): Promise<void> {
  if (operation === 'change' && args.length !== 0) throw new Error('Usage: kala-dedicated-owner-rotate')
  if (operation === 'reset' && (args.length !== 1 || args[0] !== LOST_PASSWORD_ACKNOWLEDGEMENT)) {
    throw new Error(`Usage: kala-dedicated-owner-reset ${LOST_PASSWORD_ACKNOWLEDGEMENT}`)
  }
  const recovery = operation === 'reset'
  if (recovery && process.platform !== 'win32' && process.getuid?.() !== 0) {
    throw new Error('Dedicated Owner lost-password recovery must run as root')
  }
  for (const name of ['KALA_DEDICATED_OWNER_PASSWORD', 'KALA_DEDICATED_OWNER_CURRENT_PASSWORD', 'KALA_DEDICATED_OWNER_NEW_PASSWORD']) {
    if (process.env[name]) throw new Error('Dedicated Owner passwords must be supplied through protected files, never direct environment values')
  }
  const deployment = await loadGatewayProductDeployment(process.env.KALA_DEPLOYMENT_CONFIG)
  if (deployment.variant !== 'dedicated') throw new Error('Dedicated Owner credential operations require the Dedicated product deployment')
  const controlPlane = await resolveRuntimeIngressControlPlaneMode(process.env, readRequiredSecretEnv)
  if (controlPlane.kind !== 'postgres') throw new Error('Dedicated Owner credential operations require the PostgreSQL control plane')

  const newPassword = await readPrivatePasswordFile(process.env.KALA_DEDICATED_OWNER_NEW_PASSWORD_FILE, 'KALA_DEDICATED_OWNER_NEW_PASSWORD_FILE', recovery)
  const confirmation = await readPrivatePasswordFile(process.env.KALA_DEDICATED_OWNER_NEW_PASSWORD_CONFIRM_FILE, 'KALA_DEDICATED_OWNER_NEW_PASSWORD_CONFIRM_FILE', recovery)
  if (newPassword !== confirmation) throw new Error('Dedicated Owner new password confirmation does not match')
  const currentPassword = recovery ? undefined : await readPrivatePasswordFile(
    process.env.KALA_DEDICATED_OWNER_CURRENT_PASSWORD_FILE,
    'KALA_DEDICATED_OWNER_CURRENT_PASSWORD_FILE',
    false,
  )

  const database = createPostgresControlPlaneDatabase({ connectionString: controlPlane.databaseUrl })
  try {
    await assertControlPlaneSchema(database, await readControlPlaneMigrations(resolve(process.env.KALA_INGRESS_MIGRATIONS_DIR ?? 'migrations')))
    const service = new DedicatedOwnerCredentialService(database)
    const result = recovery
      ? await service.resetPassword({ newPassword })
      : await service.changePassword({ currentPassword: currentPassword!, newPassword })
    process.stdout.write(`${JSON.stringify({
      event: recovery ? 'dedicated_owner_password_reset' : 'dedicated_owner_password_changed',
      organizationId: result.organizationId,
      principalId: result.principalId,
      revokedSessionCount: result.revokedSessionCount,
    })}\n`)
  } finally {
    await database.close()
  }
}
