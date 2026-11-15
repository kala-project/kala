#!/usr/bin/env node
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { schema } from '@agent-kernel/shared'
import { createConfiguredSecretResolver } from '@agent-kernel/shared/secret-resolver'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, readControlPlaneMigrations } from '../persistence/postgres.js'
import { assertWebhookInstallation } from '../webhooks/worker-authority.js'
import { assertSettingsOperatorPrivileges } from '../settings/operator-authority.js'
import { operatorInstallationFingerprint, OperatorPlanError } from '../settings/operator-plan.js'
import { readOperatorProfile, readOperatorProtectedFile, resolveOperatorSecret } from '../settings/operator-profile.js'
import { OperatorExecutionError, PostgresSettingsOperator, type OperatorReceipt } from '../settings/operator-store.js'
import { OperatorModelPolicyTransport } from '../settings/model-policy-transport.js'
import { OperatorModelPolicyCoordinator } from '../settings/model-policy-coordinator.js'

const flags = {
  inspect: ['profile', 'organization', 'resource'], plan: ['profile', 'input', 'out'],
  apply: ['profile', 'plan'], verify: ['profile', 'operation'], revert: ['profile', 'operation', 'expected-revision'],
} as const
function argumentsFor(argv: string[]): { command: keyof typeof flags; values: Record<string, string> } {
  const command = argv[0] as keyof typeof flags
  if (!Object.hasOwn(flags, command) || argv.length !== 1 + flags[command].length * 2) throw new OperatorExecutionError(2, 'invalid_arguments')
  const values: Record<string, string> = {}
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]!.slice(2), value = argv[index + 1]
    if (!argv[index]!.startsWith('--') || !(flags[command] as readonly string[]).includes(key)
      || values[key] || !value || value.startsWith('--')) throw new OperatorExecutionError(2, 'invalid_arguments')
    values[key] = value
  }
  if (Object.keys(values).length !== flags[command].length) throw new OperatorExecutionError(2, 'invalid_arguments')
  return { command, values }
}
async function json(path: string): Promise<unknown> {
  try { return JSON.parse((await readOperatorProtectedFile(resolve(path))).toString('utf8')) }
  catch { throw new OperatorExecutionError(2, 'invalid_protected_input') }
}
async function writePlan(path: string, value: unknown): Promise<void> {
  const target = resolve(path)
  let handle
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close(); handle = undefined
    const directory = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  } catch { throw new OperatorExecutionError(5, 'protected_plan_write_failed') }
  finally { await handle?.close() }
}
export function operatorReceiptExitCode(receipt: OperatorReceipt): 0 | 4 | 5 {
  return receipt.consumerVerification === 'failed' || receipt.state === 'failed' ? 5
    : receipt.consumerVerification === 'pending' || ['applying', 'awaiting_runtime', 'reverting'].includes(receipt.state) ? 4 : 0
}

export async function runSettingsOperator(argv = process.argv.slice(2), environment = process.env): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('kala-control-plane-settings inspect|plan|apply|verify|revert --profile <protected-file>\n')
    return 0
  }
  const { command, values } = argumentsFor(argv)
  const profile = await readOperatorProfile(resolve(values.profile!))
  const resolver = createConfiguredSecretResolver(environment)
  const installationId = (await readOperatorProtectedFile(profile.installationIdFile, 256)).toString('utf8').trim()
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(installationId)) throw new OperatorExecutionError(2, 'invalid_installation')
  const connectionString = await resolveOperatorSecret(profile.controlPlaneDatabaseUrlRef, resolver)
  const signingKey = Buffer.from(await resolveOperatorSecret(profile.planSigningKeyRef, resolver))
  const database = createPostgresControlPlaneDatabase({ connectionString, applicationName: 'kala-settings-operator',
    maxConnections: 2, statementTimeoutMs: 15_000 })
  try {
    await assertControlPlaneSchema(database, await readControlPlaneMigrations(resolve(environment.KALA_INGRESS_MIGRATIONS_DIR ?? 'migrations')))
    await assertSettingsOperatorPrivileges(database)
    await assertWebhookInstallation(database, installationId)
    const identity = (await database.query<{ host: string; port: number; database: string; role: string }>(
      'SELECT inet_server_addr()::text AS host,inet_server_port() AS port,current_database() AS database,current_user AS role')).rows[0]
    if (!identity) throw new OperatorExecutionError(5, 'database_identity_unavailable')
    const installationFingerprint = operatorInstallationFingerprint({ installationId, databaseAuthority: identity,
      runtimeControlOrigin: profile.runtimeControlOrigin })
    const transport = new OperatorModelPolicyTransport({ profile, installationId,
      credential: () => resolveOperatorSecret(profile.internalCredentialRef, resolver) })
    const modelPolicy = new OperatorModelPolicyCoordinator({ database, profile, installationFingerprint, key: signingKey, transport })
    const references = (result: unknown, organizationId: string, unitId: string, workspaceId: string, operationId?: string) => {
      if (!result || typeof result !== 'object') throw new OperatorExecutionError(5, 'runtime_reference_identity_mismatch')
      const value = result as Record<string, unknown>
      if (value.installationId !== installationId || value.organizationId !== organizationId || value.unitId !== unitId || value.workspaceId !== workspaceId
        || operationId !== undefined && value.operationId !== operationId
        || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.revision)
        || typeof value.quiesced !== 'boolean' || typeof value.maintenanceHeld !== 'boolean'
        || ![value.activeSessions, value.liveExecutors, value.unresolvedWorkspaceEffects].every(number => Number.isSafeInteger(number) && Number(number) >= 0)) {
        throw new OperatorExecutionError(5, 'runtime_reference_identity_mismatch')
      }
      return { revision: value.revision, quiesced: value.quiesced, maintenanceHeld: value.maintenanceHeld,
        activeSessions: Number(value.activeSessions), liveExecutors: Number(value.liveExecutors),
        unresolvedWorkspaceEffects: Number(value.unresolvedWorkspaceEffects) }
    }
    const operator = new PostgresSettingsOperator(database, { profile, installationFingerprint, key: signingKey,
      consumers: {
        modelPolicy,
        authorizeWebhookReference: async (reference, organizationId) => {
          if (!schema.validOrganizationWebhookSecretReference(reference, organizationId) || !resolver) {
            throw new OperatorExecutionError(4, 'external_secret_resolver_unavailable')
          }
          try { if (!await resolver.resolve(reference)) throw new Error() }
          catch { throw new OperatorExecutionError(5, 'webhook_reference_not_authorized') }
        },
        workspaceReferences: async (organizationId, unitId, workspaceId, operationId) =>
          references(await transport.operational('workspace-references', { organizationId, unitId, workspaceId,
            ...(operationId ? { operationId } : {}) }), organizationId, unitId, workspaceId),
        reserveWorkspace: async input => references(await transport.operational('workspace-reserve', input),
          input.organizationId, input.unitId, input.workspaceId, input.operationId),
        verifyResource: async input => {
          const result = schema.SettingsOperationalReceiptSchema.safeParse(await transport.operational('operational-consume', {
            organizationId: input.organizationId, unitId: input.unitId, resource: input.resource,
            operationId: input.operationId, revision: input.revision,
          }))
          return result.success && result.data.installationId === installationId
            && result.data.organizationId === input.organizationId && result.data.unitId === input.unitId
            && result.data.resource.kind === input.resource.kind && result.data.resource.id === input.resource.id
            && result.data.revision === input.revision && result.data.operationId === input.operationId ? 'verified' : 'failed'
        },
      } })
    let result: unknown
    if (command === 'inspect') {
      const match = /^([^/]+)\/(.+)$/u.exec(values.resource!)
      const resource = schema.SettingsOperatorResourceKindSchema.safeParse(match?.[1])
      if (!resource.success || !match?.[2]) throw new OperatorExecutionError(2, 'invalid_resource')
      result = await operator.inspect(values.organization!, { kind: resource.data, id: match[2] })
    } else if (command === 'plan') {
      const plan = await operator.plan(await json(values.input!))
      await writePlan(values.out!, plan)
      result = { operationId: plan.operationId, planned: true, effects: plan.effects, reversible: plan.reversible }
    } else {
      if (command !== 'apply' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(values.operation!)) {
        throw new OperatorExecutionError(2, 'invalid_operation_id')
      }
      const receipt = command === 'apply' ? await operator.apply(await json(values.plan!))
        : command === 'verify' ? await operator.verify(values.operation!)
          : await operator.revert(values.operation!, values['expected-revision']!)
      process.stdout.write(`${JSON.stringify(receipt)}\n`)
      return operatorReceiptExitCode(receipt)
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } finally { signingKey.fill(0); await database.close() }
}
const invoked = process.argv[1]
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  runSettingsOperator().then(code => { process.exitCode = code }).catch(error => {
    const known = error instanceof OperatorExecutionError || error instanceof OperatorPlanError
    process.stderr.write(`${JSON.stringify({ error: known ? error.code : 'settings_operator_failed' })}\n`)
    process.exitCode = known ? error.exitCode : 5
  })
}
