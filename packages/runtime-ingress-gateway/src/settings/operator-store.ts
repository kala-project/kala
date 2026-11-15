import { createHash, randomUUID } from 'node:crypto'
import { schema } from '@agent-kernel/shared'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { authenticateOperatorPlan, createOperatorPlan } from './operator-plan.js'
import type { OperatorModelPolicyCoordinator } from './model-policy-coordinator.js'

type Plan = schema.SettingsOperatorPlan
type Change = schema.SettingsOperatorChange
type Profile = schema.SettingsOperatorProfile
type Snapshot = { revision: string; value: Record<string, unknown> | null; unitId: string }
type Dependency = Plan['dependencies'][number]
type Operation = {
  id: string; installation_fingerprint: string; organization_id: string; resource_kind: string; resource_id: string;
  plan_digest: string; resulting_revision: string | null; state: OperatorReceipt['state'];
  before_value: Record<string, unknown> | null; after_value: Record<string, unknown> | null;
  plan_snapshot: Plan; reverted_by: string | null;
  linked_operation_id: string | null;
}
export type OperatorReceipt = {
  operationId: string; state: 'applying' | 'awaiting_runtime' | 'applied' | 'verified' | 'failed' | 'reverting' | 'reverted';
  resource: Plan['resource']; revision: string | null; persisted: boolean;
  consumerVerification: 'verified' | 'pending' | 'not-applicable' | 'failed'; reasonCode?: string;
  sideEffects?: readonly { effect: string; state: 'verified' | 'pending' | 'not-applicable' | 'failed' }[];
}
export class OperatorExecutionError extends Error {
  constructor(readonly exitCode: 2 | 3 | 4 | 5, readonly code: string) { super(code) }
}
export type OperatorRuntimeReferences = {
  revision: string; quiesced: boolean; activeSessions: number; liveExecutors: number;
  unresolvedWorkspaceEffects: number;
  maintenanceHeld: boolean;
}
export type OperatorConsumerAdapters = {
  authorizeWebhookReference(reference: string, organizationId: string): Promise<void>;
  workspaceReferences?(organizationId: string, unitId: string, workspaceId: string, operationId?: string): Promise<OperatorRuntimeReferences>;
  reserveWorkspace?(input: { organizationId: string; unitId: string; workspaceId: string; operationId: string;
    expectedReferenceRevision: string }): Promise<OperatorRuntimeReferences>;
  modelPolicy?: Pick<OperatorModelPolicyCoordinator, 'dependencies' | 'prepare' | 'advance'>;
  verifyResource?(input: { organizationId: string; unitId: string; resource: Plan['resource']; revision: string;
    effects: Plan['effects']; operationId: string }): Promise<'verified' | 'pending' | 'failed'>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
    : value
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const metadataEffects = new Set(['workspace.rename', 'pool.rename', 'entitlement.reported-metadata', 'webhook-secret-binding.rename'])
function fail(code: string, exitCode: 2 | 3 | 4 | 5 = 3): never { throw new OperatorExecutionError(exitCode, code) }
const columns = {
  workspace: { name: 'name', status: 'status' },
  pool: { name: 'name', mode: 'mode', workspaceId: 'workspace_id' },
  entitlement: { contractReference: 'contract_reference', supportTier: 'support_tier', startsAt: 'starts_at', endsAt: 'ends_at',
    graceEndsAt: 'grace_ends_at', seatLimit: 'seat_limit', concurrentSessionLimit: 'concurrent_session_limit',
    workspaceLimit: 'workspace_limit', monthlyTokenLimit: 'monthly_token_limit', storageBytesLimit: 'storage_bytes_limit' },
  'webhook-secret-binding': { label: 'label' },
} as const

export class PostgresSettingsOperator {
  constructor(private readonly database: ControlPlaneDatabase, private readonly authority: {
    profile: Profile; installationFingerprint: string; key: Uint8Array; consumers: OperatorConsumerAdapters;
  }) {}

  private scope(organizationId: string, kind: string): void {
    if (!this.authority.profile.allowedOrganizations.includes(organizationId)
      || !this.authority.profile.allowedResourceKinds.some(value => value === kind)) fail('profile_scope_denied', 2)
  }
  private async schema(tx: SqlExecutor): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kala:control-settings-schema:v1',0))")
    const available = await tx.query<{ present: boolean }>("SELECT to_regclass('public.settings_operator_operations') IS NOT NULL AS present")
    if (!available.rows[0]?.present) fail('operator_schema_unavailable', 5)
  }
  private async snapshot(tx: SqlExecutor, organizationId: string, resource: Plan['resource'], lock = false): Promise<Snapshot> {
    const organization = (await tx.query<{ runtime_unit_id: string }>(
      'SELECT runtime_unit_id FROM organizations WHERE id=$1', [organizationId])).rows[0]
    if (!organization) fail('organization_not_found')
    let rows: Array<{ revision: string; value: Record<string, unknown> }>
    const suffix = lock ? ' FOR UPDATE' : ''
    if (resource.kind === 'workspace') rows = (await tx.query<{ revision: string; value: Record<string, unknown> }>(
      `SELECT policy_version::text AS revision,jsonb_build_object('name',name,'status',status) AS value
       FROM workspaces WHERE organization_id=$1 AND id=$2${suffix}`, [organizationId, resource.id])).rows
    else if (resource.kind === 'pool') rows = (await tx.query<{ revision: string; value: Record<string, unknown> }>(
      `SELECT settings_revision::text AS revision,jsonb_build_object('name',name,'mode',mode,'workspaceId',workspace_id) AS value
       FROM executor_pools WHERE organization_id=$1 AND id=$2${suffix}`, [organizationId, resource.id])).rows
    else if (resource.kind === 'entitlement') rows = (await tx.query<{ revision: string; value: Record<string, unknown> }>(
      `SELECT settings_revision::text AS revision,jsonb_build_object(
       'contractReference',contract_reference,'supportTier',support_tier,'startsAt',to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
       'endsAt',to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
       'graceEndsAt',CASE WHEN grace_ends_at IS NULL THEN NULL ELSE to_char(grace_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
       'seatLimit',seat_limit,'concurrentSessionLimit',concurrent_session_limit,'workspaceLimit',workspace_limit,
       'monthlyTokenLimit',monthly_token_limit::text,'storageBytesLimit',storage_bytes_limit::text) AS value
       FROM contract_entitlements WHERE organization_id=$1${suffix}`, [organizationId])).rows
    else if (resource.kind === 'webhook-secret-binding') rows = (await tx.query<{ revision: string; value: Record<string, unknown> }>(
      `SELECT revision::text,jsonb_build_object('label',label,'secretRef',secret_ref) AS value
       FROM organization_webhook_secret_bindings WHERE organization_id=$1 AND id=$2${suffix}`, [organizationId, resource.id])).rows
    else rows = (await tx.query<{ revision: string; value: Record<string, unknown> }>(
      `SELECT effective_revision::text AS revision,jsonb_build_object('management',effective_management,'state',state,
       'desiredRevision',desired_revision::text,'operationId',operation_id) AS value
       FROM organization_model_management WHERE organization_id=$1${suffix}`, [organizationId])).rows
    const row = rows[0]
    if (!row && resource.kind !== 'webhook-secret-binding' && resource.kind !== 'model-management') fail('resource_not_found')
    return { unitId: organization.runtime_unit_id, revision: row?.revision ?? (resource.kind === 'model-management' ? '1' : '0'),
      value: row?.value ?? (resource.kind === 'model-management' ? { management: 'operator', state: 'active', desiredRevision: '1', operationId: null } : null) }
  }

  async inspect(organizationId: string, resource: Plan['resource']) {
    this.scope(organizationId, resource.kind)
    if (['entitlement', 'model-management'].includes(resource.kind) && resource.id !== organizationId) fail('invalid_resource', 2)
    return this.database.transaction(async tx => {
      await this.schema(tx)
      const current = await this.snapshot(tx, organizationId, resource)
      return { organizationId, resource, revision: current.revision, value: current.value,
        ...(resource.kind === 'entitlement' ? { enforcement: {
          startsAt: 'enforced', endsAt: 'enforced', graceEndsAt: 'reported-only', seatLimit: 'reported-only',
          concurrentSessionLimit: 'reported-only', workspaceLimit: 'reported-only', monthlyTokenLimit: 'reported-only',
          storageBytesLimit: 'reported-only', supportTier: 'reported-only', contractReference: 'reported-only',
        } } : {}) }
    })
  }

  private async dependencies(tx: SqlExecutor, change: Change, current: Snapshot, heldOperationId?: string): Promise<Dependency[]> {
    const { organizationId, resource, patch } = change
    const dependencies: Dependency[] = [{ kind: 'resource', id: `${resource.kind}/${resource.id}`,
      revision: current.revision, state: !current.value ? 'absent' : current.value.status === 'archived' ? 'archived' : 'active' }]
    if (resource.kind === 'model-management') {
      if (!this.authority.consumers.modelPolicy) fail('model_policy_maintenance_unavailable', 4)
      if (current.value?.state !== 'active') fail('model_policy_transition_in_progress', 4)
      if (!('management' in patch)) fail('invalid_change', 2)
      dependencies.push(...await this.authority.consumers.modelPolicy.dependencies(organizationId, current.unitId,
        patch.management as 'operator' | 'dashboard'))
    } else if (resource.kind === 'workspace' && 'status' in patch && patch.status !== current.value?.status) {
      if (patch.status === 'archived') {
        if (!this.authority.consumers.workspaceReferences) fail('workspace_reference_authority_unavailable', 4)
        const references = await this.authority.consumers.workspaceReferences(organizationId, current.unitId, resource.id, heldOperationId)
        if (!references.quiesced) fail('workspace_maintenance_required', 4)
        if (references.activeSessions || references.liveExecutors || references.unresolvedWorkspaceEffects) fail('workspace_has_active_references')
        if (heldOperationId && !references.maintenanceHeld) fail('workspace_maintenance_reservation_unavailable', 4)
        dependencies.push({ kind: 'workspace-references', id: resource.id, revision: references.revision, state: 'quiesced' })
      } else {
        const usage = (await tx.query<{ count: string; limit: number }>(`SELECT
          (SELECT count(*)::text FROM workspaces WHERE organization_id=$1 AND status='active') AS count,
          workspace_limit AS limit FROM contract_entitlements WHERE organization_id=$1`, [organizationId])).rows[0]
        if (!usage || BigInt(usage.count) >= BigInt(usage.limit)) fail('workspace_admission_denied')
        dependencies.push({ kind: 'workspace-admission', id: organizationId, revision: hash(usage), state: 'ready' })
      }
    } else if (resource.kind === 'pool' && 'mode' in patch
      && (patch.mode !== current.value?.mode || patch.workspaceId !== current.value?.workspaceId)) {
      const references = (await tx.query<{ executors: string; tokens: string }>(`SELECT
        (SELECT count(*)::text FROM executors WHERE organization_id=$1 AND pool_id=$2 AND status<>'revoked') AS executors,
        (SELECT count(*)::text FROM executor_enrollment_tokens WHERE organization_id=$1 AND pool_id=$2
          AND revoked_at IS NULL AND expires_at>clock_timestamp() AND used_count<max_uses) AS tokens`, [organizationId, resource.id])).rows[0]!
      if (references.executors !== '0' || references.tokens !== '0') fail('pool_has_enrollment_references')
      if (patch.mode === 'workspace') {
        const workspace = await tx.query<{ policy_version: string | number }>("SELECT policy_version FROM workspaces WHERE organization_id=$1 AND id=$2 AND status='active'",
          [organizationId, patch.workspaceId])
        if (!workspace.rowCount) fail('pool_workspace_unavailable')
        dependencies.push({ kind: 'workspace-admission', id: patch.workspaceId!, revision: String(workspace.rows[0]!.policy_version), state: 'active' })
      }
      dependencies.push({ kind: 'pool-references', id: resource.id, revision: hash(references), state: 'ready' })
    } else if (resource.kind === 'entitlement') {
      const desired: Record<string, unknown> = { ...current.value, ...patch }
      let terms
      try {
        terms = await tx.query<{ valid: boolean }>(`SELECT $2::timestamptz > $1::timestamptz
          AND ($3::timestamptz IS NULL OR $3::timestamptz >= $2::timestamptz) AS valid`,
        [desired.startsAt, desired.endsAt, desired.graceEndsAt])
      } catch { fail('invalid_entitlement_terms', 2) }
      if (!terms.rows[0]?.valid) fail('invalid_entitlement_terms', 2)
      const usage = (await tx.query<{ seats: string; workspaces: string }>(`SELECT
        (SELECT count(*)::text FROM organization_memberships WHERE organization_id=$1 AND status='active') AS seats,
        (SELECT count(*)::text FROM workspaces WHERE organization_id=$1 AND status='active') AS workspaces`, [organizationId])).rows[0]!
      if ('seatLimit' in patch && patch.seatLimit !== undefined && BigInt(patch.seatLimit) < BigInt(usage.seats)
        || 'workspaceLimit' in patch && patch.workspaceLimit !== undefined && BigInt(patch.workspaceLimit) < BigInt(usage.workspaces)) {
        fail('entitlement_below_protected_use')
      }
      dependencies.push({ kind: 'entitlement-usage', id: organizationId, revision: hash(usage), state: 'ready' })
    } else if (resource.kind === 'webhook-secret-binding' && 'secretRef' in patch && patch.secretRef) {
      await this.authority.consumers.authorizeWebhookReference(patch.secretRef, organizationId)
      dependencies.push({ kind: 'secret-resolver', id: resource.id, revision: 'organization-reference-authorized', state: 'ready' })
    }
    return dependencies
  }

  private effects(change: Change, current: Snapshot): Plan['effects'] {
    switch (change.resource.kind) {
      case 'model-management': return ['model-management.maintenance']
      case 'webhook-secret-binding': return [current.value ? 'webhook-secret-binding.rename' : 'webhook-secret-binding.create']
      case 'workspace': return [...('name' in change.patch ? ['workspace.rename' as const] : []),
        ...('status' in change.patch ? [change.patch.status === 'archived' ? 'workspace.archive' as const : 'workspace.reactivate' as const] : [])]
      case 'pool': return [...('name' in change.patch ? ['pool.rename' as const] : []), ...('mode' in change.patch ? ['pool.rebind' as const] : [])]
      case 'entitlement': return [...(Object.keys(change.patch).some(key => ['startsAt', 'endsAt'].includes(key)) ? ['entitlement.contract-admission' as const] : []),
        ...(Object.keys(change.patch).some(key => !['startsAt', 'endsAt'].includes(key)) ? ['entitlement.reported-metadata' as const] : [])]
    }
  }
  async plan(input: unknown): Promise<Plan> {
    const change = schema.SettingsOperatorChangeSchema.safeParse(input)
    if (!change.success) fail('invalid_change', 2)
    const data = change.data
    this.scope(data.organizationId, data.resource.kind)
    return this.transaction(async tx => {
      await this.schema(tx)
      const current = await this.snapshot(tx, data.organizationId, data.resource)
      if (current.revision !== data.expectedRevision) fail('revision_conflict')
      return createOperatorPlan({ ...this.authority, change: data,
        dependencies: await this.dependencies(tx, data, current), effects: this.effects(data, current),
        reversible: Boolean(current.value) })
    })
  }

  private async transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try { return await this.database.transaction(operation) } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      if (['23505', '23503', '40001', '40P01'].includes(code ?? '')) fail('resource_dependency_conflict')
      if (['23514', '22003', '22007', '22008'].includes(code ?? '')) fail('invalid_resource_configuration', 2)
      throw error
    }
  }

  private async operation(tx: SqlExecutor, id: string, lock = false): Promise<Operation | undefined> {
    return (await tx.query<Operation>(`SELECT id,installation_fingerprint,organization_id,resource_kind,resource_id,
      plan_digest,resulting_revision::text,state,before_value,after_value,plan_snapshot,reverted_by,linked_operation_id
      FROM settings_operator_operations WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]
  }
  private assertOperation(operation: Operation | undefined): asserts operation is Operation {
    if (!operation || operation.installation_fingerprint !== this.authority.installationFingerprint) fail('operation_not_found', 2)
    this.scope(operation.organization_id, operation.resource_kind)
  }
  private receipt(operation: Operation, consumerVerification: OperatorReceipt['consumerVerification'] = 'pending'): OperatorReceipt {
    return { operationId: operation.id, state: operation.state, resource: { kind: operation.resource_kind as Plan['resource']['kind'],
      id: operation.resource_id }, revision: operation.resulting_revision, persisted: operation.resulting_revision !== null,
      consumerVerification }
  }
  async apply(input: unknown, linkedOperationId?: string): Promise<OperatorReceipt> {
    const plan = authenticateOperatorPlan({ ...this.authority, plan: input })
    if (plan.resource.kind === 'workspace' && plan.patch.status === 'archived') {
      if (!this.authority.consumers.reserveWorkspace) fail('workspace_maintenance_reservation_unavailable', 4)
      await this.commitPlan(plan, linkedOperationId, 'prepare')
      return this.finishWorkspace(plan.operationId)
    }
    return this.commitPlan(plan, linkedOperationId)
  }

  private async finishWorkspace(id: string): Promise<OperatorReceipt> {
    let selected = await this.database.transaction(tx => this.operation(tx, id))
    this.assertOperation(selected)
    if (selected.state === 'failed') return { ...this.receipt(selected, 'failed'), reasonCode: 'operation_failed' }
    // The journal is a durably accepted operation, not a fresh authorization after plan expiry.
    const plan = authenticateOperatorPlan({ ...this.authority, plan: selected.plan_snapshot,
      now: Date.parse(selected.plan_snapshot.createdAt) })
    if (selected.resulting_revision !== null) return this.verify(id)
    const dependency = plan.dependencies.find(item => item.kind === 'workspace-references' && item.id === plan.resource.id)
    if (!dependency || !this.authority.consumers.reserveWorkspace) fail('workspace_maintenance_reservation_unavailable', 4)
    let reserving = true
    try {
      const current = await this.database.transaction(tx => this.snapshot(tx, plan.organizationId, plan.resource))
      const hold = await this.authority.consumers.reserveWorkspace({ organizationId: plan.organizationId, unitId: current.unitId,
        workspaceId: plan.resource.id, operationId: id, expectedReferenceRevision: dependency.revision })
      if (!hold.maintenanceHeld || !hold.quiesced || hold.revision !== dependency.revision
        || hold.activeSessions || hold.liveExecutors || hold.unresolvedWorkspaceEffects) fail('workspace_maintenance_reservation_unavailable', 4)
      reserving = false
      await this.commitPlan(plan, selected.linked_operation_id ?? undefined, 'commit')
      return this.verify(id)
    } catch (error) {
      if (reserving && error instanceof OperatorExecutionError && error.code === 'workspace_references_changed') {
        await this.database.query(`UPDATE settings_operator_operations SET state='failed',error_code=$2,updated_at=clock_timestamp()
          WHERE id=$1 AND state='applying' AND resulting_revision IS NULL`, [id, error.code])
      }
      selected = await this.database.transaction(tx => this.operation(tx, id))
      this.assertOperation(selected)
      return { ...this.receipt(selected, selected.state === 'failed' ? 'failed' : 'pending'),
        reasonCode: error instanceof OperatorExecutionError ? error.code : 'workspace_maintenance_pending' }
    }
  }

  private async commitPlan(plan: Plan, linkedOperationId?: string, phase: 'normal' | 'prepare' | 'commit' = 'normal'): Promise<OperatorReceipt> {
    const parsed = schema.SettingsOperatorChangeSchema.parse({
      schemaVersion: 1, operationId: plan.operationId, organizationId: plan.organizationId,
      resource: plan.resource, expectedRevision: plan.expectedRevision, patch: plan.patch,
    })
    const kind = plan.resource.kind
    if (kind === 'model-management' && !this.authority.consumers.modelPolicy) fail('model_policy_maintenance_unavailable', 4)
    const receipt = await this.transaction(async tx => {
      await this.schema(tx)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`kala:settings-operator:operation:${plan.operationId}`])
      const previous = await this.operation(tx, plan.operationId)
      if (previous) {
        this.assertOperation(previous)
        if (previous.plan_digest !== hash(plan)) fail('operation_id_reused')
        if (!(phase === 'commit' && previous.state === 'applying' && previous.resulting_revision === null)) {
          return this.receipt(previous, previous.state === 'verified'
            ? previous.plan_snapshot.effects.every(effect => metadataEffects.has(effect)) ? 'not-applicable' : 'verified' : 'pending')
        }
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`kala:settings-operator:organization:${plan.organizationId}`])
      if ((await tx.query(`SELECT 1 FROM settings_operator_operations WHERE organization_id=$1 AND resource_kind=$2
        AND resource_id=$3 AND id<>$4 AND state='applying' AND resulting_revision IS NULL LIMIT 1`,
      [plan.organizationId, plan.resource.kind, plan.resource.id, plan.operationId])).rowCount) fail('resource_maintenance_in_progress', 4)
      const current = await this.snapshot(tx, plan.organizationId, plan.resource, true)
      if (current.revision !== plan.expectedRevision) fail('revision_conflict')
      const dependencies = await this.dependencies(tx, parsed, current, phase === 'commit' ? plan.operationId : undefined)
      if (JSON.stringify(dependencies) !== JSON.stringify(plan.dependencies)
        || JSON.stringify(this.effects(parsed, current)) !== JSON.stringify(plan.effects)
        || plan.reversible !== Boolean(current.value)) fail('dependency_conflict')
      if (linkedOperationId) {
        const original = await this.operation(tx, linkedOperationId, true)
        this.assertOperation(original)
        if (original.reverted_by || original.organization_id !== plan.organizationId
          || original.resource_kind !== plan.resource.kind || original.resource_id !== plan.resource.id
          || original.resulting_revision !== current.revision || !original.plan_snapshot.reversible) fail('revert_conflict')
        const inverse = Object.fromEntries(Object.keys(original.plan_snapshot.patch).map(key => [key, original.before_value?.[key]]))
        if (hash(inverse) !== hash(parsed.patch)) fail('revert_conflict')
      }
      const desiredRevision = (BigInt(current.revision) + 1n).toString()
      const next: Record<string, unknown> = kind === 'model-management'
        ? { management: 'management' in parsed.patch ? parsed.patch.management : fail('invalid_change', 2),
          state: 'active', desiredRevision, operationId: plan.operationId }
        : { ...current.value, ...parsed.patch }
      if (!previous) await tx.query(`INSERT INTO settings_operator_operations
        (id,installation_fingerprint,organization_id,resource_kind,resource_id,plan_digest,expected_revision,state,before_value,after_value,effects,plan_snapshot,linked_operation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'applying',$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
      [plan.operationId, plan.installationFingerprint, plan.organizationId, plan.resource.kind, plan.resource.id, hash(plan),
        plan.expectedRevision, JSON.stringify(current.value), JSON.stringify(next), JSON.stringify(plan.effects), JSON.stringify(plan), linkedOperationId ?? null])
      if (phase === 'prepare') return this.receipt((await this.operation(tx, plan.operationId))!)
      await tx.query("SELECT set_config('kala.settings_operation_id',$1,true)", [plan.operationId])
      if (kind === 'model-management') {
        await this.authority.consumers.modelPolicy!.prepare(tx, plan, current.unitId)
      } else if (plan.resource.kind === 'webhook-secret-binding' && !current.value) {
        await tx.query(`INSERT INTO organization_webhook_secret_bindings(id,organization_id,label,secret_ref) VALUES($1,$2,$3,$4)`,
          [plan.resource.id, plan.organizationId, next.label, next.secretRef])
      } else {
        const mapping = columns[kind]
        const entries = Object.entries(parsed.patch)
        const selected = entries.map(([key]) => Object.entries(mapping).find(([name]) => name === key)?.[1])
        if (selected.some(column => !column)) fail('invalid_change', 2)
        const table = { workspace: 'workspaces', pool: 'executor_pools', entitlement: 'contract_entitlements',
          'webhook-secret-binding': 'organization_webhook_secret_bindings' }[kind]
        await tx.query(`UPDATE ${table} SET ${selected.map((column, index) => `${column}=$${index + 3}`).join(',')}
          WHERE organization_id=$1${plan.resource.kind === 'entitlement' ? ' AND organization_id=$2' : ' AND id=$2'}`,
        [plan.organizationId, plan.resource.id, ...entries.map(([, value]) => value)])
      }
      const resulting = kind === 'model-management' ? { revision: desiredRevision, value: next }
        : await this.snapshot(tx, plan.organizationId, plan.resource)
      await tx.query(`UPDATE settings_operator_operations SET resulting_revision=$2,state=$4,after_value=$3::jsonb,updated_at=clock_timestamp() WHERE id=$1`,
        [plan.operationId, resulting.revision, JSON.stringify(resulting.value), kind === 'model-management' ? 'awaiting_runtime' : 'applied'])
      await tx.query(`INSERT INTO audit_events(id,organization_id,actor_kind,action,target_type,target_id,result,metadata)
        VALUES($1,$2,'system',$7,$3,$4,'succeeded',jsonb_build_object('operationId',$5::text,'revision',$6::text))`,
      [`aud_${randomUUID()}`, plan.organizationId, plan.resource.kind, plan.resource.id, plan.operationId, resulting.revision,
        kind === 'model-management' ? 'settings.operator.model-policy.preparing' : 'settings.operator.applied'])
      if (linkedOperationId) await tx.query(`UPDATE settings_operator_operations SET reverted_by=$2,
        state=CASE WHEN $3::boolean THEN state ELSE 'reverted' END,updated_at=clock_timestamp() WHERE id=$1`,
      [linkedOperationId, plan.operationId, kind === 'model-management'])
      return this.receipt((await this.operation(tx, plan.operationId))!)
    })
    return kind === 'model-management' ? this.authority.consumers.modelPolicy!.advance(receipt.operationId) : receipt
  }

  async verify(id: string): Promise<OperatorReceipt> {
    const selected = await this.database.transaction(async tx => { await this.schema(tx); return this.operation(tx, id) })
    this.assertOperation(selected)
    if (selected.resource_kind === 'workspace' && selected.plan_snapshot.patch.status === 'archived' && selected.resulting_revision === null) {
      return this.finishWorkspace(id)
    }
    if (selected.resource_kind === 'model-management') {
      if (!this.authority.consumers.modelPolicy) fail('model_policy_maintenance_unavailable', 4)
      return this.authority.consumers.modelPolicy.advance(id)
    }
    return this.database.transaction(async tx => {
      await this.schema(tx)
      const operation = await this.operation(tx, id, true)
      this.assertOperation(operation)
      const current = await this.snapshot(tx, operation.organization_id,
        { kind: operation.resource_kind as Plan['resource']['kind'], id: operation.resource_id }, true)
      if (current.revision !== operation.resulting_revision || JSON.stringify(current.value) !== JSON.stringify(operation.after_value)) {
        return { ...this.receipt(operation, 'failed'), reasonCode: 'resource_changed_after_operation' }
      }
      const bindingCreate = operation.plan_snapshot.effects.includes('webhook-secret-binding.create')
      const metadataOnly = operation.plan_snapshot.effects.every(effect => metadataEffects.has(effect))
      let verified = metadataOnly
      if (bindingCreate) verified = Boolean((await tx.query(`SELECT 1 FROM webhook_deliveries delivery
        JOIN webhook_endpoints endpoint ON endpoint.id=delivery.endpoint_id AND endpoint.organization_id=delivery.organization_id
        WHERE endpoint.organization_id=$1 AND endpoint.secret_binding_id=$2 AND delivery.state='delivered'
          AND delivery.endpoint_generation=endpoint.delivery_generation AND delivery.completed_at >=
            (SELECT created_at FROM settings_operator_operations WHERE id=$3) LIMIT 1`,
      [operation.organization_id, operation.resource_id, id])).rowCount)
      let consumerVerification: OperatorReceipt['consumerVerification'] = metadataOnly ? 'not-applicable' : verified ? 'verified' : 'pending'
      if (!metadataOnly && !bindingCreate && this.authority.consumers.verifyResource) {
        try { consumerVerification = await this.authority.consumers.verifyResource({
          organizationId: operation.organization_id, unitId: current.unitId,
          resource: { kind: operation.resource_kind as Plan['resource']['kind'], id: operation.resource_id },
          revision: current.revision, effects: operation.plan_snapshot.effects, operationId: id,
        }) } catch { consumerVerification = 'pending' }
        verified = consumerVerification === 'verified'
      }
      if (verified && operation.state !== 'reverted') await tx.query("UPDATE settings_operator_operations SET state='verified',updated_at=clock_timestamp() WHERE id=$1", [id])
      return { ...this.receipt({ ...operation, state: operation.state === 'reverted' ? 'reverted' : verified ? 'verified' : operation.state }, consumerVerification),
        sideEffects: operation.plan_snapshot.effects.map(effect => ({ effect, state: metadataEffects.has(effect) ? 'not-applicable' : consumerVerification })),
        ...(!verified ? { reasonCode: bindingCreate ? 'business_delivery_not_observed' : 'consumer_effect_not_observed' } : {}) }
    })
  }

  async revert(id: string, expectedRevision: string): Promise<OperatorReceipt> {
    const original = await this.database.transaction(async tx => { await this.schema(tx); return this.operation(tx, id) })
    this.assertOperation(original)
    if (!original.before_value || !original.plan_snapshot.reversible || original.reverted_by
      || original.resulting_revision !== expectedRevision) fail('revert_conflict')
    const patch = Object.fromEntries(Object.keys(original.plan_snapshot.patch).map(key => [key, original.before_value![key]]))
    const inverse = await this.plan({ schemaVersion: 1, operationId: randomUUID(), organizationId: original.organization_id,
      resource: { kind: original.resource_kind, id: original.resource_id }, expectedRevision, patch })
    return this.apply(inverse, id)
  }
}
