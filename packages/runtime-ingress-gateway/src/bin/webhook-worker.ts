#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createConfiguredSecretResolver, createSecretEnvironmentReader, type SecretResolver } from '@agent-kernel/shared/secret-resolver'
import { createOnlineTelemetryFromEnv } from '@agent-kernel/shared/node-telemetry'
import { loadGatewayProductDeployment } from '../config/product-deployment.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, readControlPlaneMigrations } from '../persistence/postgres.js'
import { WebhookOutboxWorker } from '../webhooks/outbox-worker.js'
import { assertWebhookInstallation, assertWebhookWorkerPrivileges } from '../webhooks/worker-authority.js'

export function scopedWebhookSecrets(resolver: SecretResolver) {
  return async (reference: unknown, organizationId: string, signal: AbortSignal): Promise<string> => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(organizationId) || !reference || typeof reference !== 'object'
      || !('ref' in reference) || typeof reference.ref !== 'string'
      || !reference.ref.startsWith(`bao:organizations/${organizationId}/webhooks/`)) throw new Error('Webhook secret reference denied')
    return resolver.resolve(reference.ref, signal)
  }
}

export async function runWebhookWorker(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deployment = await loadGatewayProductDeployment(environment.KALA_DEPLOYMENT_CONFIG)
  if (deployment.variant !== 'private-cloud') throw new Error('External webhook worker is opt-in Private Cloud only')
  const installationFile = environment.KALA_INSTALLATION_ID_FILE?.trim()
  if (!installationFile) throw new Error('Webhook worker installation identity is required')
  const installationId = (await readFile(installationFile, 'utf8')).trim()
  const resolver = createConfiguredSecretResolver(environment)
  if (!resolver) throw new Error('Webhook worker requires the configured external secret resolver')
  const origins = environment.KALA_WEBHOOK_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  const telemetry = createOnlineTelemetryFromEnv('kala-webhook-worker', environment)
  const database = createPostgresControlPlaneDatabase({
    connectionString: await createSecretEnvironmentReader(environment)('KALA_WEBHOOK_DATABASE_URL'),
    applicationName: 'kala-webhook-worker', maxConnections: 4, statementTimeoutMs: 5_000, telemetry,
  })
  const stopping = new AbortController()
  const stop = () => stopping.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await assertControlPlaneSchema(database, await readControlPlaneMigrations(resolve(environment.KALA_WEBHOOK_MIGRATIONS_DIR ?? 'migrations')))
    await assertWebhookWorkerPrivileges(database)
    await assertWebhookInstallation(database, installationId)
    const worker = new WebhookOutboxWorker(database, { resolveSecret: scopedWebhookSecrets(resolver), allowedOrigins: origins,
      allowLoopbackHttp: environment.KALA_WEBHOOK_ALLOW_LOOPBACK_HTTP === '1' })
    process.stdout.write(`${JSON.stringify({ event: 'webhook_worker_ready' })}\n`)
    do {
      const batch = await worker.runBatch(50, stopping.signal)
      // Fixed-schema aggregate counts only: no endpoint, tenant, event, URL, or raw errors.
      if (batch.claimed || batch.materialized) process.stdout.write(`${JSON.stringify({ event: 'webhook_worker_batch', ...batch })}\n`)
      if (environment.KALA_WEBHOOK_ONCE === '1' || stopping.signal.aborted) break
      if (!batch.claimed && !batch.materialized) await sleep(30_000, undefined, { signal: stopping.signal }).catch((error) => { if (!stopping.signal.aborted) throw error })
    } while (!stopping.signal.aborted)
  } finally {
    stop()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    await database.close()
    await telemetry?.close()
  }
}

const invoked = process.argv[1]
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  runWebhookWorker().catch(() => {
    // Connection, resolver and HTTP exceptions may contain credentials or payloads.
    process.stderr.write(`${JSON.stringify({ event: 'webhook_worker_failed' })}\n`)
    process.exitCode = 1
  })
}
