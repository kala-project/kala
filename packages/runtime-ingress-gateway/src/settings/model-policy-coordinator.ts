import { createHash, randomUUID } from 'node:crypto'
import { schema } from '@agent-kernel/shared'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { authenticateOperatorPlan } from './operator-plan.js'
import { OperatorExecutionError, type OperatorReceipt } from './operator-store.js'
import type { OperatorModelPolicyTransport } from './model-policy-transport.js'

type Plan = schema.SettingsOperatorPlan
type Replica = schema.SettingsModelPolicy['requiredServingScope'][number]
type Policy = {
  desired_management: 'operator' | 'dashboard'; desired_revision: string;
  effective_management: 'operator' | 'dashboard'; effective_revision: string;
  state: 'active' | 'preparing' | 'awaiting_runtime' | 'failed'; operation_id: string; required_serving_scope: Replica[];
}
type Operation = { id: string; organization_id: string; resource_id: string; state: OperatorReceipt['state'];
  resulting_revision: string; plan_snapshot: Plan; linked_operation_id: string | null }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const key = (replica: Replica) => `${replica.phase}:${replica.replicaId}:${replica.generation}`
function pending(code: string): never { throw new OperatorExecutionError(4, code) }

export class OperatorModelPolicyCoordinator {
  constructor(private readonly options: {
    database: ControlPlaneDatabase; transport: OperatorModelPolicyTransport;
    profile: schema.SettingsOperatorProfile; installationFingerprint: string; key: Uint8Array;
  }) {}
  private async inspections(organizationId: string, unitId: string) {
    const root = await this.options.transport.inspect(organizationId, unitId)
    const observations = new Map([[this.options.profile.runtimeControlOrigin, root]])
    for (const origin of [...new Set(root.servingScope.map(replica => replica.origin))].sort()) {
      if (!observations.has(origin)) observations.set(origin, await this.options.transport.inspect(organizationId, unitId, origin))
    }
    return { root, observations }
  }
  private dependenciesFor(observations: Map<string, schema.SettingsModelPolicyInspection>, management: 'operator' | 'dashboard'): Plan['dependencies'] {
    const dependencies: Plan['dependencies'] = []
    for (const [origin, observation] of observations) {
      if (!observation.compatible[management]) pending('model_policy_references_incompatible')
      dependencies.push({ kind: 'model-catalog', id: origin,
        revision: `${observation.catalogRevision}:${observation.operatorCatalogRevision}:${observation.sessionReferencesRevision}`,
        state: observation.catalogRevision === '0' ? 'unconfigured' : 'ready' })
    }
    const scope = [...observations.values()][0]!.servingScope
    // The full membership digest is already signed in the plan; identities themselves
    // are persisted in the policy before any quiescence request is dispatched.
    dependencies.push({ kind: 'serving-membership', id: [...observations.values()][0]!.unitId,
      revision: membershipDigest(scope), state: 'ready' })
    return dependencies
  }
  async dependencies(organizationId: string, unitId: string, management: 'operator' | 'dashboard'): Promise<Plan['dependencies']> {
    const { observations } = await this.inspections(organizationId, unitId)
    return this.dependenciesFor(observations, management)
  }
  async prepare(tx: SqlExecutor, plan: Plan, unitId: string): Promise<void> {
    const management = plan.patch.management as 'operator' | 'dashboard'
    const { root, observations } = await this.inspections(plan.organizationId, unitId)
    if (root.state !== 'active' || root.policyRevision !== plan.expectedRevision
      || !same(this.dependenciesFor(observations, management), plan.dependencies.filter(dependency => dependency.kind !== 'resource'))) {
      throw new OperatorExecutionError(3, 'model_policy_dependency_conflict')
    }
    const next = (BigInt(plan.expectedRevision) + 1n).toString()
    await tx.query(`INSERT INTO organization_model_management
      (organization_id,desired_management,desired_revision,effective_management,effective_revision,state,operation_id,required_serving_scope)
      VALUES($1,$2,$3,'operator',1,'preparing',$4,$5::jsonb)
      ON CONFLICT(organization_id) DO UPDATE SET desired_management=EXCLUDED.desired_management,
        desired_revision=EXCLUDED.desired_revision,state='preparing',operation_id=EXCLUDED.operation_id,
        required_serving_scope=EXCLUDED.required_serving_scope,updated_at=clock_timestamp()`,
    [plan.organizationId, management, next, plan.operationId, JSON.stringify(root.servingScope)])
  }
  private async load(id: string) {
    const operation = (await this.options.database.query<Operation>(`SELECT id,organization_id,resource_id,state,
      resulting_revision::text,plan_snapshot,linked_operation_id FROM settings_operator_operations
      WHERE id=$1 AND resource_kind='model-management' AND installation_fingerprint=$2`, [id, this.options.installationFingerprint])).rows[0]
    if (!operation) throw new OperatorExecutionError(2, 'operation_not_found')
    // A committed journal is the authority for resuming a dispatched operation after
    // its planning TTL. It does not authorize dispatch of an expired new operation.
    authenticateOperatorPlan({ ...this.options, plan: operation.plan_snapshot, now: Date.parse(operation.plan_snapshot.createdAt) + 1 })
    const organization = (await this.options.database.query<{ runtime_unit_id: string }>(
      'SELECT runtime_unit_id FROM organizations WHERE id=$1', [operation.organization_id])).rows[0]
    if (!organization) pending('model_policy_placement_unavailable')
    return { operation, unitId: organization.runtime_unit_id }
  }
  private async policy(organizationId: string): Promise<Policy> {
    const row = (await this.options.database.query<Policy>(`SELECT desired_management,desired_revision::text,
      effective_management,effective_revision::text,state,operation_id,required_serving_scope
      FROM organization_model_management WHERE organization_id=$1`, [organizationId])).rows[0]
    if (!row) pending('model_policy_state_unavailable')
    return row
  }
  private receipt(operation: Operation, state = operation.state, verification: OperatorReceipt['consumerVerification'] = 'pending'): OperatorReceipt {
    return { operationId: operation.id, state, resource: { kind: 'model-management', id: operation.resource_id },
      revision: operation.resulting_revision, persisted: true, consumerVerification: verification,
      sideEffects: [{ effect: 'model-management.maintenance', state: verification }] }
  }
  private async remember(operation: Operation, replicas: Replica[]): Promise<Policy> {
    return this.options.database.transaction(async tx => {
      const current = (await tx.query<Policy>(`SELECT desired_management,desired_revision::text,effective_management,
        effective_revision::text,state,operation_id,required_serving_scope FROM organization_model_management
        WHERE organization_id=$1 FOR UPDATE`, [operation.organization_id])).rows[0]
      if (!current || current.operation_id !== operation.id || current.desired_revision !== operation.resulting_revision) pending('model_policy_operation_changed')
      const scope = [...current.required_serving_scope], identities = new Set(scope.map(key))
      for (const replica of replicas) if (!identities.has(key(replica))) { scope.push(replica); identities.add(key(replica)) }
      if (!same(scope, current.required_serving_scope)) await tx.query(`UPDATE organization_model_management
        SET required_serving_scope=$2::jsonb,updated_at=clock_timestamp() WHERE organization_id=$1`, [operation.organization_id, JSON.stringify(scope)])
      return { ...current, required_serving_scope: scope }
    })
  }
  async advance(id: string): Promise<OperatorReceipt> {
    const { operation, unitId } = await this.load(id)
    try {
      let policy = await this.policy(operation.organization_id)
      if (policy.operation_id !== id || policy.desired_revision !== operation.resulting_revision) {
        return { ...this.receipt(operation, operation.state, 'failed'), reasonCode: 'resource_changed_after_operation' }
      }
      if (policy.state === 'active') {
        const current = await this.options.transport.inspect(operation.organization_id, unitId)
        const drains = policy.required_serving_scope.filter(replica => replica.phase === 'drain')
        const required = new Map<string, number>()
        for (const replica of drains) required.set(replica.origin, (required.get(replica.origin) ?? 0) + 1)
        if (!required.size && !current.servingScope.length) pending('model_policy_consumer_unavailable')
        for (const [origin, count] of required) {
          if (current.servingScope.filter(replica => replica.origin === origin).length < count) pending('model_policy_consumer_unavailable')
        }
        for (const replica of current.servingScope) {
          const observed = schema.SettingsModelPolicyReadySchema.safeParse(await this.options.transport.request('observe', {
            organizationId: operation.organization_id, unitId, replicaId: replica.replicaId, generation: replica.generation,
          }, replica.origin))
          if (!observed.success || observed.data.operationId !== id || observed.data.organizationId !== operation.organization_id
            || observed.data.unitId !== unitId || observed.data.replicaId !== replica.replicaId || observed.data.generation !== replica.generation
            || observed.data.policyRevision !== operation.resulting_revision || observed.data.management !== policy.effective_management
            || observed.data.catalogRevision !== current.catalogRevision) pending('model_policy_consumer_revision_pending')
        }
        return this.receipt(operation, 'verified', 'verified')
      }
      if (policy.state === 'failed') pending('model_policy_transition_failed')
      const command: schema.SettingsModelPolicyReconcile = { operationId: id, organizationId: operation.organization_id,
        unitId, expectedEffectivePolicyRevision: operation.plan_snapshot.expectedRevision,
        desiredPolicyRevision: operation.resulting_revision, management: operation.plan_snapshot.patch.management as 'operator' | 'dashboard' }
      if (policy.state === 'preparing') {
        const inspection = await this.options.transport.inspect(operation.organization_id, unitId)
        // A replica admitted just before the committed fence must also drain. Never
        // remove an unreachable/expired identity from the persisted required scope.
        policy = await this.remember(operation, inspection.servingScope)
        for (const replica of policy.required_serving_scope.filter(replica => replica.phase === 'drain')) {
          const result = await this.options.transport.request('quiesce', {
            command, replica: { replicaId: replica.replicaId, generation: replica.generation, origin: replica.origin },
          }, replica.origin)
          if (!result || typeof result !== 'object'
            || (result as { drained?: unknown }).drained !== true
            || !Object.entries({ ...command, replicaId: replica.replicaId, generation: replica.generation })
              .every(([name, value]) => (result as Record<string, unknown>)[name] === value)) pending('model_policy_quiescence_unverified')
        }
        const result = schema.SettingsModelPolicyReconciliationSchema.safeParse(await this.options.transport.request('reconcile', command))
        if (!result.success || result.data.operationId !== id || result.data.organizationId !== operation.organization_id
          || result.data.unitId !== unitId || result.data.policyRevision !== operation.resulting_revision
          || result.data.management !== command.management) pending('model_policy_reconciliation_unverified')
        await this.options.database.transaction(async tx => {
          await tx.query(`UPDATE organization_model_management SET effective_management=desired_management,effective_revision=desired_revision,
            state='awaiting_runtime',updated_at=clock_timestamp()
            WHERE organization_id=$1 AND operation_id=$2 AND desired_revision=$3 AND state='preparing'`,
          [operation.organization_id, id, operation.resulting_revision])
        })
        policy = await this.policy(operation.organization_id)
      }
      if (policy.state !== 'awaiting_runtime' || policy.operation_id !== id) pending('model_policy_transition_changed')
      const drains = policy.required_serving_scope.filter(replica => replica.phase === 'drain')
      const required = new Map<string, number>()
      for (const replica of drains) required.set(replica.origin, (required.get(replica.origin) ?? 0) + 1)
      if (!required.size) required.set(this.options.profile.runtimeControlOrigin, 1)
      for (const [origin, count] of required) {
        for (let attempt = 0; attempt < count; attempt++) {
          const result = schema.SettingsModelPolicyReadySchema.safeParse(await this.options.transport.request('resume',
            { operationId: id, organizationId: operation.organization_id, unitId }, origin))
          if (!result.success || result.data.operationId !== id || result.data.organizationId !== operation.organization_id
            || result.data.unitId !== unitId || result.data.policyRevision !== operation.resulting_revision
            || result.data.management !== command.management) pending('model_policy_readiness_unverified')
          const current = await this.options.transport.inspect(operation.organization_id, unitId, origin)
          const member = current.servingScope.find(replica => replica.replicaId === result.data.replicaId && replica.generation === result.data.generation)
          if (!member || current.catalogRevision !== result.data.catalogRevision) pending('model_policy_startup_membership_unverified')
          const dependency = operation.plan_snapshot.dependencies.find(item => item.kind === 'model-catalog' && item.id === origin)
          if (command.management === 'operator' && dependency && dependency.revision.split(':')[1] !== current.operatorCatalogRevision) {
            pending('operator_model_catalog_changed_during_transition')
          }
          policy = await this.remember(operation, [{ ...member, phase: 'startup' }])
        }
      }
      const current = await this.options.transport.inspect(operation.organization_id, unitId)
      const ready = current.servingScope.filter(member => policy.required_serving_scope.some(replica =>
        replica.phase === 'startup' && replica.replicaId === member.replicaId && replica.generation === member.generation && replica.origin === member.origin))
      for (const [origin, count] of required) {
        if ((drains.length ? ready.filter(member => member.origin === origin) : ready).length < count) pending('model_policy_required_serving_scope_not_ready')
      }
      await this.options.database.transaction(async tx => {
        const updated = await tx.query(`UPDATE organization_model_management SET state='active',updated_at=clock_timestamp()
          WHERE organization_id=$1 AND operation_id=$2 AND effective_revision=$3 AND state='awaiting_runtime'`,
        [operation.organization_id, id, operation.resulting_revision])
        if (!updated.rowCount) pending('model_policy_transition_changed')
        await tx.query("UPDATE settings_operator_operations SET state='verified',updated_at=clock_timestamp() WHERE id=$1", [id])
        if (operation.linked_operation_id) await tx.query("UPDATE settings_operator_operations SET state='reverted',updated_at=clock_timestamp() WHERE id=$1 AND reverted_by=$2",
          [operation.linked_operation_id, id])
        await tx.query(`INSERT INTO audit_events(id,organization_id,actor_kind,action,target_type,target_id,result,metadata)
          VALUES($1,$2,'system','settings.operator.model-policy.active','model-management',$2,'succeeded',jsonb_build_object('operationId',$3::text,'revision',$4::text))`,
        [`aud_${randomUUID()}`, operation.organization_id, id, operation.resulting_revision])
      })
      return this.receipt(operation, 'verified', 'verified')
    } catch (error) {
      return { ...this.receipt(operation), reasonCode: error instanceof OperatorExecutionError
        ? error.code : 'model_policy_progress_unavailable' }
    }
  }
}

function membershipDigest(value: Replica[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
