#!/usr/bin/env node
/** Offline evaluation operator step: advances the three recovery markers, NOT a backup or restore. */
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { assertInstallationId, assertPostgresInstallationClaim, assertS3InstallationClaim, createPostgresClaimPool, createS3ClaimClient } from '../src/storage/fresh-install-claim.js'
import { advanceRecoveryCheckpoints, stateKeySha256 } from '../src/storage/recovery-checkpoint.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
async function secret(name: string): Promise<string> {
  const value = (await readFile(required(name), 'utf8')).trim()
  if (!value) throw new Error(`${name} points to an empty file`)
  return value
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  if (args.size !== process.argv.length - 2 || [...args].some((arg) => !['--acknowledge-all-writers-stopped', '--resume-partial'].includes(arg))
    || !args.has('--acknowledge-all-writers-stopped')) {
    throw new Error('Usage: kala-recovery-checkpoint --acknowledge-all-writers-stopped [--resume-partial]; isolate all former Gateway/Runtime writers and revoke old credentials before reuse')
  }
  const installationId = (await secret('KALA_INSTALLATION_ID_FILE'))
  const previousId = required('KALA_RECOVERY_PREVIOUS_CHECKPOINT_ID')
  const nextId = required('KALA_RECOVERY_NEXT_CHECKPOINT_ID')
  for (const id of [installationId, previousId, nextId]) assertInstallationId(id)
  const masterKey = await readFile(required('KALA_RECOVERY_STATE_MASTER_KEY_FILE'))
  const keySha256 = stateKeySha256(masterKey)
  masterKey.fill(0)
  const controlUrl = await secret('KALA_RECOVERY_CONTROL_DATABASE_URL_FILE')
  const runtimeUrl = await secret('KALA_RECOVERY_RUNTIME_DATABASE_URL_FILE')
  const controlTarget = new URL(controlUrl)
  const runtimeTarget = new URL(runtimeUrl)
  if (controlTarget.pathname !== '/runlab_control' || runtimeTarget.pathname === '/runlab_control'
    || !['postgres:', 'postgresql:'].includes(controlTarget.protocol) || !['postgres:', 'postgresql:'].includes(runtimeTarget.protocol)) {
    throw new Error('Recovery requires separate existing control and Runtime PostgreSQL databases')
  }
  const pathStyle = required('KALA_RECOVERY_S3_FORCE_PATH_STYLE')
  if (pathStyle !== 'true' && pathStyle !== 'false') throw new Error('KALA_RECOVERY_S3_FORCE_PATH_STYLE must be true or false')
  const control = createPostgresClaimPool(controlUrl, 'kala-offline-recovery-control')
  const runtime = createPostgresClaimPool(runtimeUrl, 'kala-offline-recovery-runtime')
  const s3 = createS3ClaimClient({
    endpoint: required('KALA_RECOVERY_S3_ENDPOINT'), region: required('KALA_RECOVERY_S3_REGION'),
    accessKeyId: await secret('KALA_RECOVERY_S3_ACCESS_KEY_ID_FILE'),
    secretAccessKey: await secret('KALA_RECOVERY_S3_SECRET_ACCESS_KEY_FILE'),
    forcePathStyle: pathStyle === 'true',
  })
  const bucket = required('KALA_RECOVERY_S3_BUCKET')
  try {
    await assertPostgresInstallationClaim(control, installationId, 'control PostgreSQL')
    await assertPostgresInstallationClaim(runtime, installationId, 'Runtime PostgreSQL')
    await assertS3InstallationClaim(s3, bucket, installationId)
    await advanceRecoveryCheckpoints({
      control, runtime, objectStore: s3, bucket, resumePartial: args.has('--resume-partial'),
      previous: { installationId, checkpointId: previousId, keySha256 },
      next: { installationId, checkpointId: nextId, keySha256 },
    })
    process.stdout.write(`${JSON.stringify({ event: 'offline_recovery_checkpoint_advanced', installationId, checkpointId: nextId, warning: 'No backup, snapshot, writer isolation, old credential revocation or restore was performed by this command' })}\n`)
  } finally {
    await Promise.allSettled([control.end(), runtime.end()])
    s3.destroy?.()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
