#!/usr/bin/env node
import { resolve } from 'node:path'
import process from 'node:process'
import { readFile } from 'node:fs/promises'

import { parsePublicUrls } from '@agent-kernel/shared'

import { JsonOrganizationStore } from '../organizations/json-store.js'
import { PostgresOrganizationStore } from '../organizations/postgres-store.js'
import { startRuntimeIngressGateway } from '../edge/server.js'
import { createOidcClient } from '../auth/oidc-client.js'
import { readRequiredSecretEnv } from '../config/secret-env.js'
import { FileLoginStateStore } from '../auth/login-state-store.js'
import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import { PostgresBrowserSessionStore } from '../auth/postgres-browser-session-store.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, readControlPlaneMigrations, type ControlPlaneDatabase } from '../persistence/postgres.js'
import { createSessionSecretBox } from '../auth/session-secret-box.js'
import { loadEnterpriseSsoResolver } from '../auth/enterprise-sso-config.js'
import { SlidingWindowRateLimiter } from '../governance/rate-limit.js'
import { resolveRuntimeIngressControlPlaneMode } from '../config/control-plane.js'
import { ServiceAccountService } from '../api/service-accounts.js'
import { createRuntimeHostRetentionClient, RetentionService, startRetentionScheduler } from '../governance/retention.js'
import { OwnerBootstrapService } from '../organizations/owner-bootstrap.js'
import { createRuntimeHostProvisioningClient, RuntimeUnitProvisioner } from '../organizations/runtime-unit-provisioner.js'
import {
  auditPostgresRuntimeReaderConnection,
  createPostgresRuntimeOriginResolver,
  readExperimentalRuntimePlacementConfig,
  runtimeReaderConnectionString,
} from '../runtime-origin/postgres-runtime-origin-resolver.js'
import { createPostgresRuntimeResourceOwnerResolver } from '../runtime-origin/postgres-runtime-resource-owner-resolver.js'
import { RuntimeRoutingTicketResolver } from '../runtime-origin/runtime-routing-ticket-resolver.js'

async function main(): Promise<void> {
  const port = Number(process.env.KALA_INGRESS_PORT ?? 13001)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('KALA_INGRESS_PORT must be a valid port')
  const publicUrlValues = requiredPublicUrls()
  const publicUrls = parsePublicUrls(publicUrlValues.join(','))
  const publicOrigin = publicUrlValues.find((value) => !value.includes('*'))
  if (!publicOrigin) throw new Error('KALA_PUBLIC_URLS must contain an exact URL for OAuth callbacks')
  const cacheNamespaceSecret = await readRequiredSecretEnv('KALA_INGRESS_SESSION_SECRET')
  const ingressSecret = await readRequiredSecretEnv('KALA_INGRESS_SHARED_SECRET')
  if (Buffer.byteLength(cacheNamespaceSecret) < 32 || Buffer.byteLength(ingressSecret) < 32) throw new Error('Private Cloud secrets must contain at least 32 bytes')
  let database: ControlPlaneDatabase | undefined
  const controlPlane = await resolveRuntimeIngressControlPlaneMode(process.env, readRequiredSecretEnv)
  const organizations = controlPlane.kind === 'postgres'
    ? new PostgresOrganizationStore(database = createPostgresControlPlaneDatabase({ connectionString: controlPlane.databaseUrl }))
    : new JsonOrganizationStore(resolve(controlPlane.directoryPath))
  if (organizations instanceof JsonOrganizationStore) await organizations.load()
  else await assertControlPlaneSchema(database!, await readControlPlaneMigrations(resolve(process.env.KALA_INGRESS_MIGRATIONS_DIR ?? 'migrations')))
  const loginStates = new FileLoginStateStore(resolve(await readRequiredSecretEnv('KALA_INGRESS_LOGIN_STATE_STORE')))
  await loginStates.load()
  const sessions = database
    ? new PostgresBrowserSessionStore(database)
    : new FileBrowserSessionStore(resolve(process.env.KALA_INGRESS_BROWSER_SESSION_STORE ?? `${await readRequiredSecretEnv('KALA_INGRESS_LOGIN_STATE_STORE')}.sessions`))
  if (sessions instanceof FileBrowserSessionStore) await sessions.load()
  const secretBox = createSessionSecretBox('active', [{ id: 'active', key: Buffer.from(cacheNamespaceSecret).subarray(0, 32) }])
  const oidc = await createOidcClient({
    issuer: new URL(await readRequiredSecretEnv('OIDC_ISSUER')),
    clientId: await readRequiredSecretEnv('OIDC_CLIENT_ID'),
    clientSecret: await readRequiredSecretEnv('OIDC_CLIENT_SECRET'),
    discoveryOrigin: new URL(await readRequiredSecretEnv('KALA_INGRESS_IDENTITY_ORIGIN')),
    allowInsecureHttp: process.env.KALA_INGRESS_ALLOW_INSECURE_HTTP === '1',
  })
  const enterpriseSso = process.env.KALA_INGRESS_ENTERPRISE_SSO_CONFIG
    ? await loadEnterpriseSsoResolver(resolve(process.env.KALA_INGRESS_ENTERPRISE_SSO_CONFIG))
    : undefined
  const hostOrigin = await readRequiredSecretEnv('KALA_RUNTIME_HOST_ORIGIN')
  const runtimePlacementConfig = readExperimentalRuntimePlacementConfig(process.env)
  if (runtimePlacementConfig && !database) {
    throw new Error('KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE=1 requires the PostgreSQL control plane so organization placement can be verified')
  }
  const routingTicketConfigured = [
    process.env.KALA_INGRESS_RUNTIME_ROUTING_TICKET_KEY,
    process.env.KALA_INGRESS_RUNTIME_ROUTING_TICKET_KEY_FILE,
    process.env.KALA_INGRESS_RUNTIME_ROUTING_TICKET_AUDIENCE,
    process.env.KALA_INGRESS_RUNTIME_ROUTING_TICKET_MAX_TTL_MS,
  ].some((value) => Boolean(value?.trim()))
  if (routingTicketConfigured && (!runtimePlacementConfig || !database)) {
    throw new Error('Runtime routing tickets require experimental PostgreSQL Runtime placement and the PostgreSQL control plane')
  }
  const runtimeReader = runtimePlacementConfig
    ? runtimeReaderConnectionString(runtimePlacementConfig, routingTicketConfigured)
    : undefined
  if (runtimeReader?.audit) await auditPostgresRuntimeReaderConnection(runtimeReader.connectionString)
  const runtimeOriginResolver = runtimePlacementConfig && runtimeReader
    ? createPostgresRuntimeOriginResolver({
        connectionString: runtimeReader.connectionString,
        allowedOrigins: runtimePlacementConfig.allowedOrigins,
        ...(runtimePlacementConfig.bootstrapOrigin ? { bootstrapOrigin: runtimePlacementConfig.bootstrapOrigin } : {}),
        controlPlane: database!,
      })
    : undefined
  let runtimeResourceOwnerResolver: ReturnType<typeof createPostgresRuntimeResourceOwnerResolver> | undefined
  let runtimeRoutingTicketResolver: RuntimeRoutingTicketResolver | undefined
  if (routingTicketConfigured) {
    const encodedKey = await readRequiredSecretEnv('KALA_INGRESS_RUNTIME_ROUTING_TICKET_KEY')
    const key = Buffer.from(encodedKey, 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== encodedKey) {
      throw new Error('KALA_INGRESS_RUNTIME_ROUTING_TICKET_KEY must be canonical base64url encoding of exactly 32 bytes')
    }
    const audience = process.env.KALA_INGRESS_RUNTIME_ROUTING_TICKET_AUDIENCE?.trim()
    if (!audience) throw new Error('KALA_INGRESS_RUNTIME_ROUTING_TICKET_AUDIENCE is required when Runtime routing tickets are configured')
    runtimeResourceOwnerResolver = createPostgresRuntimeResourceOwnerResolver({
      connectionString: runtimeReader!.connectionString,
      allowedOrigins: runtimePlacementConfig!.allowedOrigins,
      controlPlane: database!,
    })
    runtimeRoutingTicketResolver = new RuntimeRoutingTicketResolver({
      key,
      audience,
      maxTtlMs: numberEnv('KALA_INGRESS_RUNTIME_ROUTING_TICKET_MAX_TTL_MS'),
      ownerResolver: runtimeResourceOwnerResolver,
    })
  }
  const runtimeTlsPaths = [
    process.env.KALA_INGRESS_RUNTIME_TLS_KEY_FILE,
    process.env.KALA_INGRESS_RUNTIME_TLS_CERT_FILE,
    process.env.KALA_INGRESS_RUNTIME_TLS_CA_FILE,
  ]
  if (runtimeTlsPaths.some(Boolean) && !runtimeTlsPaths.every(Boolean)) {
    throw new Error('KALA_INGRESS_RUNTIME_TLS_KEY_FILE, KALA_INGRESS_RUNTIME_TLS_CERT_FILE, and KALA_INGRESS_RUNTIME_TLS_CA_FILE must be configured together')
  }
  const runtimeTls = runtimeTlsPaths.every(Boolean)
    ? {
        key: await readFile(runtimeTlsPaths[0]!),
        cert: await readFile(runtimeTlsPaths[1]!),
        ca: await readFile(runtimeTlsPaths[2]!),
        servername: process.env.KALA_INGRESS_RUNTIME_TLS_SERVERNAME ?? 'runtime-host',
      }
    : undefined
  const rateLimiter = process.env.KALA_INGRESS_RATE_LIMIT_MAX_REQUESTS
    ? new SlidingWindowRateLimiter({
      maxRequests: numberEnv('KALA_INGRESS_RATE_LIMIT_MAX_REQUESTS'),
      windowMs: numberEnv('KALA_INGRESS_RATE_LIMIT_WINDOW_MS', 60_000),
    })
    : undefined
  const requestHostProvisioning = createRuntimeHostProvisioningClient({
    origin: hostOrigin,
    ...(runtimeOriginResolver ? { runtimeProvisioningOriginResolver: runtimeOriginResolver } : {}),
    ingressSecret,
    ...(runtimeTls ? { tls: runtimeTls } : {}),
  })
  const postgresProvisioner = database ? new RuntimeUnitProvisioner(database, requestHostProvisioning) : undefined
  const gateway = await startRuntimeIngressGateway({
    port,
    listenHost: process.env.KALA_INGRESS_LISTEN_HOST ?? '127.0.0.1',
    oidc,
    organizations,
    ...(database ? { ownerBootstrap: new OwnerBootstrapService(database) } : {}),
    ...(enterpriseSso ? { enterpriseSso } : {}),
    directory: {
      getOrCreateForIdentity: async (identity) => { const access = await organizations.getOrCreateForIdentity(identity); return { unitId: access.organization.unitId, identity } },
      findByIdentity: async (identity) => { const access = await organizations.findAccess(identity); return access ? { unitId: access.organization.unitId, identity } : undefined },
      bindExecutorInvite: (token, unitId) => organizations.bindExecutorInvite(token, unitId),
      findUnitByExecutorInvite: (token) => organizations.findUnitByExecutorInvite(token),
      findUnitByExecutorRouteHint: (inviteHash) => organizations.findUnitByExecutorRouteHint(inviteHash),
    },
    loginStates,
    sessions,
    hostOrigin,
    ...(runtimeOriginResolver ? { runtimeOriginResolver } : {}),
    ...(runtimeRoutingTicketResolver ? { runtimeRoutingTicketResolver } : {}),
    ...(runtimeTls ? { runtimeTls } : {}),
    ...(process.env.KALA_INGRESS_DASHBOARD_ORIGIN ? { dashboardOrigin: await readRequiredSecretEnv('KALA_INGRESS_DASHBOARD_ORIGIN') } : {}),
    publicOrigin,
    publicUrls,
    cacheNamespaceSecret,
    secretBox,
    ingressSecret,
    ...(database ? {
      serviceAccounts: new ServiceAccountService(database, {
        maxActiveServiceAccounts: numberEnv('KALA_INGRESS_MAX_SERVICE_ACCOUNTS', 100),
      }),
    } : {}),
    ...(rateLimiter ? { rateLimiter } : {}),
    provision: async (unitId) => {
      if (postgresProvisioner) return await postgresProvisioner.provision(unitId)
      const response = await requestHostProvisioning({ unitId, operationId: `provision:${unitId}`, generation: 1 })
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Tenant provisioning failed: ${response.status} ${response.body.toString('utf8')}`)
      }
    },
  })
  const retentionScheduler = database && process.env.KALA_INGRESS_RETENTION_ENABLED !== '0' ? startRetentionScheduler({
    service: new RetentionService(database, createRuntimeHostRetentionClient({
      origin: hostOrigin,
      ...(runtimeOriginResolver ? { runtimeOriginResolver } : {}),
      ingressSecret,
      ...(runtimeTls ? { tls: runtimeTls } : {}),
    })),
    intervalMs: numberEnv('KALA_INGRESS_RETENTION_INTERVAL_MS', 24 * 60 * 60 * 1000),
    onResult: (result) => {
      process.stdout.write(`${JSON.stringify({ event: 'retention_purge_completed', purged: result.purged, failures: result.failures })}\n`)
    },
    onError: (error) => {
      process.stderr.write(`${JSON.stringify({ event: 'retention_purge_failed', error: error.message })}\n`)
    },
  }) : undefined
  if (database && !retentionScheduler) process.stdout.write(`${JSON.stringify({ event: 'retention_scheduler_disabled' })}\n`)
  process.stdout.write(`${JSON.stringify({ event: 'private_cloud_gateway_ready', port: gateway.port })}\n`)
  const close = async (): Promise<void> => { retentionScheduler?.stop(); await gateway.close(); await runtimeResourceOwnerResolver?.close(); await runtimeOriginResolver?.close(); await database?.close(); process.exit(0) }
  process.on('SIGTERM', () => { void close() }); process.on('SIGINT', () => { void close() })
}

function requiredPublicUrls(): string[] {
  const values = (process.env.KALA_PUBLIC_URLS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  if (values.length === 0) throw new Error('KALA_PUBLIC_URLS is required')
  return values
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

function numberEnv(name: string, fallback?: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} is required`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}
