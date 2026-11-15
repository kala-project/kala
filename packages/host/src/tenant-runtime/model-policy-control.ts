import { createHash } from 'node:crypto'
import { schema } from '@agent-kernel/shared'
import { ORGANIZATION_MODEL_SETTINGS_CREDENTIAL } from '../llm/organization-model-settings.js'
import { parseOrganizationProviderCatalog } from '../llm/runtime-provider-catalog.js'
import type { HotStateDatabase } from './postgres-hot-state.js'
import { PostgresTenantStateStore } from './postgres-state.js'
import type { RuntimeUnitMaterializationCatalog } from './materialization-store.js'
import type { RuntimeReplicaMembership } from './runtime-replica-membership.js'
import type { RuntimeUnitLiveReplica } from './postgres-runtime-resource-ownership.js'
import type { TenantRuntimeService } from './service.js'
import { ModelPolicyUnavailable, type ModelPolicyClient } from './model-policy-client.js'
import { RuntimeModelPolicyState, type ModelPolicyReplicaIdentity } from './model-policy-state.js'
import { parseTenantRuntimeUnitId } from './unit.js'

export type LoadedModelPolicySnapshot = {
  policyRevision: string; management: 'operator' | 'dashboard'; catalogRevision: string;
  synchronization: 'ready' | 'disconnected' | 'synchronizing'; observedAt: string;
}
type Options = {
  installationId: string; database: HotStateDatabase; masterKey: Uint8Array;
  policy: Pick<ModelPolicyClient, 'read'>; catalog: RuntimeUnitMaterializationCatalog;
  service: TenantRuntimeService; membership: RuntimeReplicaMembership;
  replicas: { lookupLiveReplicas(scope: { organizationId: string; unitId: string }): Promise<readonly RuntimeUnitLiveReplica[]> };
  operatorModelReferences: readonly string[];
  operatorCatalogRevision: string;
  loadedSnapshot(unitId: string): Promise<LoadedModelPolicySnapshot | undefined>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scoped = (value: unknown): { organizationId: string; unitId: string } => {
  const parsed = schema.SettingsModelPolicyRequestSchema.omit({ installationId: true }).parse(value)
  return parsed
}
export class RuntimeModelPolicyControl {
  constructor(private readonly options: Options) {}
  private async scope(organizationId: string, unitId: string) {
    const materialization = await this.options.catalog.refresh(parseTenantRuntimeUnitId(unitId))
    if (!materialization || materialization.desiredState === 'deleted' || materialization.organizationId !== organizationId) {
      throw new ModelPolicyUnavailable('model_policy_placement_mismatch')
    }
    const policy = await this.options.policy.read(organizationId, unitId)
    if (policy.installationId !== this.options.installationId || policy.organizationId !== organizationId || policy.unitId !== unitId) {
      throw new ModelPolicyUnavailable('model_policy_scope_mismatch')
    }
    const state = new PostgresTenantStateStore(this.options.database, organizationId, this.options.masterKey)
    return { policy, state, runtime: new RuntimeModelPolicyState({ installationId: this.options.installationId,
      state, unitId, policy: this.options.policy, operatorModelReferences: this.options.operatorModelReferences }) }
  }
  private identity(unitId: string, organizationId: string): ModelPolicyReplicaIdentity | undefined {
    const lease = this.options.membership.activeLease(unitId, organizationId)
    return lease ? { replicaId: lease.replicaId, generation: lease.generation.toString(), origin: lease.origin } : undefined
  }
  async inspect(input: unknown) {
    const { organizationId, unitId } = scoped(input)
    const { policy, state } = await this.scope(organizationId, unitId)
    const installed = (await this.options.database.query<{ installed: boolean }>(`SELECT
      to_regclass('public.settings_model_policy_transitions') IS NOT NULL
      AND to_regclass('public.settings_model_policy_replica_receipts') IS NOT NULL
      AND to_regclass('public.settings_model_policy_fences') IS NOT NULL AS installed`)).rows[0]?.installed === true
    const catalog = await state.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, async tx => {
      const credential = await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx)
      return { revision: credential ? await state.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx) : '0',
        value: credential ? parseOrganizationProviderCatalog((JSON.parse(credential.secret) as { catalog?: unknown }).catalog)
          : { version: 1 as const, defaultModel: null, providers: [] } }
    })
    const references = (await this.options.database.query<{ session_id: string; reference: string }>(`SELECT
      session_id,document->'preferences'->>'selectedModel' AS reference FROM tenant_session_latest_projection
      WHERE tenant_id=$1 AND document IS NOT NULL AND COALESCE(document->>'agentRuntime','kernel')<>'copilot'
        AND NULLIF(document->'preferences'->>'selectedModel','') IS NOT NULL ORDER BY session_id COLLATE "C"`, [organizationId])).rows
    const owned = new Set(catalog.value.providers.flatMap(provider => provider.models.map(model => model.ref ?? `${provider.id}:${model.id}`)))
    const operator = new Set(this.options.operatorModelReferences)
    const compatible = (models: Set<string>) => (catalog.value.defaultModel === null || models.has(catalog.value.defaultModel))
      && references.every(row => models.has(row.reference))
    const servingScope = (await this.options.replicas.lookupLiveReplicas({ organizationId, unitId }))
      .map(replica => ({ replicaId: replica.replicaId, generation: replica.generation.toString(), origin: replica.origin, phase: 'drain' as const }))
      .sort((a, b) => a.replicaId < b.replicaId ? -1 : a.replicaId > b.replicaId ? 1 : a.generation < b.generation ? -1 : 1)
    return { installationId: this.options.installationId, organizationId, unitId, protocol: 'model-management-v1',
      installed: installed && policy.installed, policyRevision: policy.effectiveRevision, management: policy.effectiveManagement,
      state: policy.state, catalogRevision: catalog.revision, operatorCatalogRevision: this.options.operatorCatalogRevision,
      sessionReferencesRevision: hash(references), compatible: { dashboard: compatible(owned), operator: compatible(operator) }, servingScope }
  }

  async beforeRoutable(unitId: string, organizationId?: string): Promise<void> {
    if (!organizationId) return
    const { policy, runtime } = await this.scope(organizationId, unitId)
    if (policy.state === 'active' && policy.effectiveRevision === '1' && policy.effectiveManagement === 'operator') return
    if (!policy.installed || !['active', 'awaiting_runtime'].includes(policy.state)) {
      throw new ModelPolicyUnavailable('model_policy_transition_fenced')
    }
    await this.options.service.units.getOrLoad(parseTenantRuntimeUnitId(unitId))
    const snapshot = await this.options.loadedSnapshot(unitId), identity = this.identity(unitId, organizationId)
    if (!identity || !snapshot || snapshot.synchronization !== 'ready'
      || snapshot.policyRevision !== policy.effectiveRevision || snapshot.management !== policy.effectiveManagement) {
      throw new ModelPolicyUnavailable('model_policy_startup_snapshot_unavailable')
    }
    await runtime.recordReady(policy, identity, snapshot.catalogRevision)
  }

  async handle(path: string, input: unknown): Promise<unknown> {
    if (path === '/internal/settings/model-management/inspect') return this.inspect(input)
    if (path === '/internal/settings/model-management/reconcile') {
      const command = schema.SettingsModelPolicyReconcileSchema.parse(input)
      const { runtime } = await this.scope(command.organizationId, command.unitId)
      const live = await this.options.replicas.lookupLiveReplicas({ organizationId: command.organizationId, unitId: command.unitId })
      if (live.length) throw new ModelPolicyUnavailable('model_policy_replicas_not_quiescent')
      return runtime.reconcile(command)
    }
    if (path === '/internal/settings/model-management/quiesce') {
      if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'command,replica') {
        throw new ModelPolicyUnavailable('invalid_model_policy_request')
      }
      const command = schema.SettingsModelPolicyReconcileSchema.parse((input as { command: unknown }).command)
      const replica = schema.SettingsModelServingReplicaSchema.omit({ phase: true }).parse((input as { replica: unknown }).replica)
      const { runtime } = await this.scope(command.organizationId, command.unitId)
      await runtime.recordDrained(command, replica, async () => {
        const current = this.identity(command.unitId, command.organizationId)
        if (!current || Object.keys(replica).some(key => replica[key as keyof typeof replica] !== current[key as keyof typeof current])) {
          throw new ModelPolicyUnavailable('model_policy_replica_identity_unavailable')
        }
        await this.options.service.quiesceUnit(command.unitId, command.operationId)
      })
      return { ...command, replicaId: replica.replicaId, generation: replica.generation, drained: true }
    }
    if (path === '/internal/settings/model-management/resume') {
      const scope = schema.SettingsModelPolicyRequestSchema.omit({ installationId: true }).extend({
        operationId: schema.SettingsModelPolicyReconcileSchema.shape.operationId,
      }).strict().parse(input)
      const { policy, runtime } = await this.scope(scope.organizationId, scope.unitId)
      if (!policy.installed || policy.operationId !== scope.operationId || !['active', 'awaiting_runtime'].includes(policy.state)) {
        throw new ModelPolicyUnavailable('model_policy_transition_fenced')
      }
      await this.options.service.resumeUnit(scope.unitId, scope.organizationId, scope.operationId)
      const snapshot = await this.options.loadedSnapshot(scope.unitId), identity = this.identity(scope.unitId, scope.organizationId)
      if (!snapshot || snapshot.synchronization !== 'ready' || !identity
        || snapshot.policyRevision !== policy.effectiveRevision || snapshot.management !== policy.effectiveManagement) {
        throw new ModelPolicyUnavailable('model_policy_startup_snapshot_unavailable')
      }
      return runtime.recordReady(policy, identity, snapshot.catalogRevision)
    }
    if (path === '/internal/settings/model-management/observe') {
      const request = schema.SettingsModelPolicyRequestSchema.omit({ installationId: true }).extend({
        replicaId: schema.SettingsModelServingReplicaSchema.shape.replicaId,
        generation: schema.SettingsModelServingReplicaSchema.shape.generation,
      }).strict().parse(input)
      const { policy, runtime, state } = await this.scope(request.organizationId, request.unitId)
      const snapshot = await this.options.loadedSnapshot(request.unitId), identity = this.identity(request.unitId, request.organizationId)
      if (!policy.operationId || !snapshot || snapshot.synchronization !== 'ready' || !identity
        || identity.replicaId !== request.replicaId || identity.generation !== request.generation
        || snapshot.policyRevision !== policy.effectiveRevision || snapshot.management !== policy.effectiveManagement) {
        throw new ModelPolicyUnavailable('model_policy_consumer_unavailable')
      }
      await state.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, async tx => {
        await runtime.assertSnapshot(policy, tx, true)
        const credential = await state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx)
        const revision = credential ? await state.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx) : '0'
        if (revision !== snapshot.catalogRevision) throw new ModelPolicyUnavailable('model_policy_consumer_revision_pending')
      })
      return { operationId: policy.operationId, organizationId: request.organizationId, unitId: request.unitId,
        policyRevision: snapshot.policyRevision, management: snapshot.management, catalogRevision: snapshot.catalogRevision,
        replicaId: identity.replicaId, generation: identity.generation, observedAt: snapshot.observedAt }
    }
    throw new ModelPolicyUnavailable('invalid_model_policy_request')
  }
}
