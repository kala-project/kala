#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { initializeRecoveryCheckpoints, readPostgresRecoveryCheckpoint, readS3RecoveryCheckpoint, assertRecoveryCheckpoint, stateKeySha256 } from '../src/storage/recovery-checkpoint.js'
import {
  claimFreshInstallation,
  createPostgresClaimPool,
  createS3ClaimClient,
} from '../src/storage/fresh-install-claim.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function readRequiredFile(name: string): Promise<string> {
  const value = (await readFile(required(name), 'utf8')).trim()
  if (!value) throw new Error(`${name} points to an empty file`)
  return value
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

async function main(): Promise<void> {
  const installationId = await readRequiredFile('KALA_INSTALLATION_ID_FILE')
  const controlConnectionString = await readRequiredFile('KALA_FRESH_CLAIM_CONTROL_DATABASE_URL_FILE')
  const runtimeConnectionString = await readRequiredFile('KALA_FRESH_CLAIM_RUNTIME_DATABASE_URL_FILE')
  const accessKeyId = await readRequiredFile('KALA_FRESH_CLAIM_S3_ACCESS_KEY_ID_FILE')
  const secretAccessKey = await readRequiredFile('KALA_FRESH_CLAIM_S3_SECRET_ACCESS_KEY_FILE')
  const masterKey = await readFile(required('KALA_FRESH_CLAIM_STATE_MASTER_KEY_FILE'))
  const checkpoint = { installationId, checkpointId: installationId, keySha256: stateKeySha256(masterKey) }
  masterKey.fill(0)
  const bucket = required('KALA_FRESH_CLAIM_S3_BUCKET')
  const region = required('KALA_FRESH_CLAIM_S3_REGION')
  const endpoint = process.env.KALA_FRESH_CLAIM_S3_ENDPOINT?.trim() || undefined
  const controlUrl = new URL(controlConnectionString)
  const runtimeUrl = new URL(runtimeConnectionString)
  if (controlUrl.pathname !== '/runlab_control') throw new Error('control owner URL must select runlab_control')
  if (runtimeUrl.pathname === '/runlab_control') throw new Error('Runtime owner URL must select an independent database, not runlab_control')

  const controlDatabase = createPostgresClaimPool(controlConnectionString, 'kala-fresh-claim-control')
  const runtimeDatabase = createPostgresClaimPool(runtimeConnectionString, 'kala-fresh-claim-runtime')
  const objectStore = createS3ClaimClient({
    ...(endpoint ? { endpoint } : {}),
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseBoolean('KALA_FRESH_CLAIM_S3_FORCE_PATH_STYLE', true),
  })

  try {
    const status = await claimFreshInstallation({
      installationId,
      bucket,
      authorities: { controlDatabase, runtimeDatabase, objectStore },
    })
    if (status === 'claimed') {
      await initializeRecoveryCheckpoints({ control: controlDatabase, runtime: runtimeDatabase, objectStore, bucket, checkpoint })
    } else {
      // Existing installations without an externally persisted recovery set cannot be auto-repaired.
      const [control, runtime, s3] = await Promise.all([
        readPostgresRecoveryCheckpoint(controlDatabase), readPostgresRecoveryCheckpoint(runtimeDatabase),
        readS3RecoveryCheckpoint(objectStore, bucket),
      ])
      // A later quiesced backup may advance the checkpoint; never reset it to the installation UUID.
      if (control.installationId !== installationId || control.keySha256 !== checkpoint.keySha256) {
        throw new Error('control PostgreSQL recovery checkpoint does not match installation or state key')
      }
      assertRecoveryCheckpoint(runtime, control, 'Runtime PostgreSQL')
      assertRecoveryCheckpoint(s3, control, 'S3')
    }
    process.stdout.write(`${JSON.stringify({ event: 'fresh_storage_claim_ready', status, installationId })}\n`)
  } finally {
    await Promise.allSettled([controlDatabase.end(), runtimeDatabase.end()])
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
