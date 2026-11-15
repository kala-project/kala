import { schema } from '@agent-kernel/shared'
import { ORGANIZATION_MODEL_SETTINGS_CREDENTIAL } from '../llm/organization-model-settings.js'
import { parseOrganizationProviderCatalog } from '../llm/runtime-provider-catalog.js'
import type { HotStateSqlExecutor } from './postgres-hot-state.js'
import type { PostgresTenantStateStore } from './postgres-state.js'
import { ModelPolicyUnavailable, type ModelPolicyClient } from './model-policy-client.js'

export function modelPolicySchemaStatements(namespace: string): readonly string[] {
  return [
    `CREATE TABLE ${namespace}.settings_model_policy_transitions (
      operation_id uuid PRIMARY KEY,
      installation_id uuid NOT NULL,
      organization_id text NOT NULL,
      unit_id text NOT NULL,
      expected_revision bigint NOT NULL CHECK (expected_revision > 0),
      policy_revision bigint NOT NULL CHECK (policy_revision > expected_revision),
      management text NOT NULL CHECK (management IN ('operator','dashboard')),
      catalog_revision bigint NOT NULL CHECK (catalog_revision >= 0),
      completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (organization_id,policy_revision)
    )`,
    `CREATE TABLE ${namespace}.settings_model_policy_fences (
      organization_id text PRIMARY KEY,
      unit_id text NOT NULL,
      policy_revision bigint NOT NULL CHECK (policy_revision > 1),
      management text NOT NULL CHECK (management IN ('operator','dashboard')),
      operation_id uuid NOT NULL UNIQUE REFERENCES ${namespace}.settings_model_policy_transitions(operation_id),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE ${namespace}.settings_model_policy_replica_receipts (
      operation_id uuid NOT NULL,
      installation_id uuid NOT NULL,
      organization_id text NOT NULL,
      unit_id text NOT NULL,
      replica_id text NOT NULL,
      generation bigint NOT NULL CHECK (generation > 0),
      phase text NOT NULL CHECK (phase IN ('drained','ready')),
      policy_revision bigint NOT NULL CHECK (policy_revision > 0),
      management text NOT NULL CHECK (management IN ('operator','dashboard')),
      catalog_revision bigint NOT NULL CHECK (catalog_revision >= 0),
      observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (operation_id,replica_id,generation,phase,catalog_revision)
    )`,
    `CREATE FUNCTION ${namespace}.kala_advance_model_policy_fence() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog AS $fence$ BEGIN
        IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
          OR NEW.policy_revision <= OLD.policy_revision THEN
          RAISE EXCEPTION 'model_policy_fence_conflict' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $fence$`,
    `CREATE TRIGGER advance_model_policy_fence BEFORE UPDATE ON ${namespace}.settings_model_policy_fences
      FOR EACH ROW EXECUTE FUNCTION ${namespace}.kala_advance_model_policy_fence()`,
    ...['settings_model_policy_transitions', 'settings_model_policy_fences', 'settings_model_policy_replica_receipts']
      .map(table => `REVOKE ALL ON ${namespace}.${table} FROM PUBLIC`),
  ]
}

type TransitionRow = Record<string, unknown> & {
  operation_id: string; installation_id: string; organization_id: string; unit_id: string;
  expected_revision: string; policy_revision: string; management: 'operator' | 'dashboard'; catalog_revision: string;
}
export type ModelPolicyReconciliation = {
  operationId: string; organizationId: string; unitId: string; policyRevision: string;
  management: 'operator' | 'dashboard'; catalogRevision: string;
}
export type ModelPolicyReplicaIdentity = { replicaId: string; generation: string; origin: string }
export class RuntimeModelPolicyState {
  constructor(private readonly options: {
    installationId: string; state: PostgresTenantStateStore; unitId: string; policy: Pick<ModelPolicyClient, 'read'>;
    /** The Operator source's exact IDs/references, never its credentials. */
    operatorModelReferences: readonly string[];
  }) {}

  private async available(tx: HotStateSqlExecutor): Promise<void> {
    if (!(await tx.query<{ present: boolean }>(
      "SELECT to_regclass('public.settings_model_policy_transitions') IS NOT NULL AS present")).rows[0]?.present) {
      throw new ModelPolicyUnavailable('model_policy_storage_unavailable')
    }
  }
  private async trusted(): Promise<schema.SettingsModelPolicy> {
    const policy = await this.options.policy.read(this.options.state.tenantId, this.options.unitId)
    if (policy.installationId !== this.options.installationId || policy.organizationId !== this.options.state.tenantId
      || policy.unitId !== this.options.unitId) throw new ModelPolicyUnavailable('model_policy_scope_mismatch')
    return policy
  }
  async assertSnapshot(expected: Pick<schema.SettingsModelPolicy, 'effectiveRevision' | 'effectiveManagement'>,
    transaction?: HotStateSqlExecutor, allowStartup = false): Promise<void> {
    const policy = await this.trusted()
    if ((!allowStartup || policy.state !== 'awaiting_runtime') && policy.state !== 'active'
      || policy.effectiveRevision !== expected.effectiveRevision || policy.effectiveManagement !== expected.effectiveManagement) {
      throw new ModelPolicyUnavailable('model_policy_transition_fenced')
    }
    // The reviewed pre-expansion bridge has no tenant model rights to grant.
    if (policy.effectiveRevision === '1' && policy.effectiveManagement === 'operator') return
    const read = async (tx: HotStateSqlExecutor) => {
      await this.available(tx)
      const row = (await tx.query<{ policy_revision: string; management: string; unit_id: string }>(
        'SELECT policy_revision::text,management,unit_id FROM settings_model_policy_fences WHERE organization_id=$1',
        [this.options.state.tenantId])).rows[0]
      if (!row || row.unit_id !== this.options.unitId || row.policy_revision !== policy.effectiveRevision
        || row.management !== policy.effectiveManagement) throw new ModelPolicyUnavailable('model_policy_runtime_fence_mismatch')
    }
    if (transaction) await read(transaction)
    else await this.options.state.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, read)
  }

  private assertPending(policy: schema.SettingsModelPolicy, command: schema.SettingsModelPolicyReconcile): void {
    if (!policy.installed || policy.state !== 'preparing' || policy.operationId !== command.operationId
      || policy.desiredRevision !== command.desiredPolicyRevision || policy.effectiveRevision !== command.expectedEffectivePolicyRevision
      || policy.desiredManagement !== command.management) throw new ModelPolicyUnavailable('model_policy_operation_not_pending')
  }
  async recordDrained(command: schema.SettingsModelPolicyReconcile, identity: ModelPolicyReplicaIdentity,
    drain: () => Promise<void>): Promise<void> {
    const policy = await this.trusted()
    if (command.organizationId !== policy.organizationId || command.unitId !== policy.unitId
      || policy.operationId !== command.operationId || policy.desiredRevision !== command.desiredPolicyRevision
      || policy.desiredManagement !== command.management || !policy.requiredServingScope.some(replica =>
        replica.phase === 'drain' && replica.replicaId === identity.replicaId && replica.generation === identity.generation
        && replica.origin === identity.origin)) throw new ModelPolicyUnavailable('model_policy_replica_scope_mismatch')
    const existing = await this.options.state.database.transaction(async tx => {
      await this.available(tx)
      return Boolean((await tx.query(`SELECT 1 FROM settings_model_policy_replica_receipts WHERE operation_id=$1 AND installation_id=$2
        AND organization_id=$3 AND unit_id=$4 AND replica_id=$5 AND generation=$6 AND phase='drained'
        AND policy_revision=$7`,
      [command.operationId, this.options.installationId, command.organizationId, command.unitId,
        identity.replicaId, identity.generation, command.expectedEffectivePolicyRevision])).rowCount)
    })
    if (existing) return
    this.assertPending(policy, command)
    await drain()
    await this.options.state.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, async tx => {
      this.assertPending(await this.trusted(), command)
      const credential = await this.options.state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx)
      const catalogRevision = credential ? await this.options.state.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx) : '0'
      if (!catalogRevision) throw new ModelPolicyUnavailable('model_policy_storage_unavailable')
      await tx.query(`INSERT INTO settings_model_policy_replica_receipts(operation_id,installation_id,organization_id,unit_id,
        replica_id,generation,phase,policy_revision,management,catalog_revision)
        VALUES($1,$2,$3,$4,$5,$6,'drained',$7,$8,$9) ON CONFLICT DO NOTHING`,
      [command.operationId, this.options.installationId, command.organizationId, command.unitId, identity.replicaId,
        identity.generation, command.expectedEffectivePolicyRevision, policy.effectiveManagement, catalogRevision])
    })
  }

  async recordReady(expected: Pick<schema.SettingsModelPolicy, 'effectiveRevision' | 'effectiveManagement'>,
    identity: ModelPolicyReplicaIdentity, catalogRevision: string): Promise<ModelPolicyReconciliation & { replicaId: string; generation: string; observedAt: string }> {
    return this.options.state.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, async tx => {
      await this.assertSnapshot(expected, tx, true)
      const policy = await this.trusted()
      if (!policy.installed || !policy.operationId || !['active', 'awaiting_runtime'].includes(policy.state)
        || policy.effectiveRevision !== expected.effectiveRevision || policy.effectiveManagement !== expected.effectiveManagement) {
        throw new ModelPolicyUnavailable('model_policy_transition_fenced')
      }
      const credential = await this.options.state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx)
      const current = credential ? await this.options.state.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx) : '0'
      if (!current || current !== catalogRevision || policy.effectiveManagement === 'dashboard' && current === '0') {
        throw new ModelPolicyUnavailable('model_policy_catalog_snapshot_mismatch')
      }
      await tx.query(`INSERT INTO settings_model_policy_replica_receipts(operation_id,installation_id,organization_id,unit_id,
        replica_id,generation,phase,policy_revision,management,catalog_revision)
        VALUES($1,$2,$3,$4,$5,$6,'ready',$7,$8,$9) ON CONFLICT DO NOTHING`,
      [policy.operationId, this.options.installationId, policy.organizationId, policy.unitId, identity.replicaId,
        identity.generation, policy.effectiveRevision, policy.effectiveManagement, catalogRevision])
      const observed = (await tx.query<{ observed_at: Date }>(`SELECT observed_at FROM settings_model_policy_replica_receipts
        WHERE operation_id=$1 AND replica_id=$2 AND generation=$3 AND phase='ready' AND catalog_revision=$4`,
      [policy.operationId, identity.replicaId, identity.generation, catalogRevision])).rows[0]
      if (!observed) throw new ModelPolicyUnavailable('model_policy_readiness_unverified')
      return { operationId: policy.operationId, organizationId: policy.organizationId, unitId: policy.unitId,
        policyRevision: policy.effectiveRevision, management: policy.effectiveManagement, catalogRevision,
        replicaId: identity.replicaId, generation: identity.generation, observedAt: new Date(observed.observed_at).toISOString() }
    })
  }
  async reconcile(input: unknown): Promise<ModelPolicyReconciliation> {
    const command = schema.SettingsModelPolicyReconcileSchema.parse(input)
    if (command.organizationId !== this.options.state.tenantId || command.unitId !== this.options.unitId) {
      throw new ModelPolicyUnavailable('model_policy_scope_mismatch')
    }
    const policy = await this.trusted()
    if (policy.operationId !== command.operationId || policy.desiredRevision !== command.desiredPolicyRevision
      || policy.desiredManagement !== command.management || policy.state === 'failed') {
      throw new ModelPolicyUnavailable('model_policy_operation_not_pending')
    }
    return this.options.state.withCredentialLock(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, async tx => {
      await this.available(tx)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`kala:model-policy-operation:${command.operationId}`])
      const recorded = (await tx.query<TransitionRow>(`SELECT operation_id,installation_id,organization_id,unit_id,
        expected_revision::text,policy_revision::text,management,catalog_revision::text
        FROM settings_model_policy_transitions WHERE operation_id=$1`, [command.operationId])).rows[0]
      if (recorded) {
        if (recorded.installation_id !== this.options.installationId || recorded.organization_id !== command.organizationId
          || recorded.unit_id !== command.unitId || recorded.expected_revision !== command.expectedEffectivePolicyRevision
          || recorded.policy_revision !== command.desiredPolicyRevision || recorded.management !== command.management) {
          throw new ModelPolicyUnavailable('model_policy_operation_reused')
        }
        return { operationId: recorded.operation_id, organizationId: recorded.organization_id, unitId: recorded.unit_id,
          policyRevision: recorded.policy_revision, management: recorded.management, catalogRevision: recorded.catalog_revision }
      }
      this.assertPending(policy, command)
      const current = (await tx.query<{ policy_revision: string; unit_id: string }>(
        'SELECT policy_revision::text,unit_id FROM settings_model_policy_fences WHERE organization_id=$1 FOR UPDATE',
        [command.organizationId])).rows[0]
      if ((current?.policy_revision ?? '1') !== command.expectedEffectivePolicyRevision
        || current && current.unit_id !== command.unitId) throw new ModelPolicyUnavailable('model_policy_runtime_fence_mismatch')
      for (const replica of policy.requiredServingScope.filter(member => member.phase === 'drain')) {
        const proof = await tx.query(`SELECT 1 FROM settings_model_policy_replica_receipts WHERE operation_id=$1
          AND installation_id=$2 AND organization_id=$3 AND unit_id=$4 AND replica_id=$5 AND generation=$6
          AND phase='drained' AND policy_revision=$7 AND management=$8`,
        [command.operationId, this.options.installationId, command.organizationId, command.unitId, replica.replicaId,
          replica.generation, command.expectedEffectivePolicyRevision, policy.effectiveManagement])
        if (!proof.rowCount) throw new ModelPolicyUnavailable('model_policy_quiescence_unverified')
      }
      const credential = await this.options.state.getCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx)
      const catalog = credential ? parseOrganizationProviderCatalog((JSON.parse(credential.secret) as { catalog?: unknown }).catalog)
        : { version: 1 as const, defaultModel: null, providers: [] }
      const modelReferences = command.management === 'operator' ? new Set(this.options.operatorModelReferences)
        : new Set(catalog.providers.flatMap(provider => provider.models.map(model => model.ref ?? `${provider.id}:${model.id}`)))
      if (catalog.defaultModel !== null && !modelReferences.has(catalog.defaultModel)) {
        throw new ModelPolicyUnavailable('model_policy_default_reference_incompatible')
      }
      const references = await tx.query<{ reference: string }>(`SELECT DISTINCT document->'preferences'->>'selectedModel' AS reference
        FROM tenant_session_latest_projection WHERE tenant_id=$1 AND document IS NOT NULL
          AND COALESCE(document->>'agentRuntime','kernel')<>'copilot'
          AND NULLIF(document->'preferences'->>'selectedModel','') IS NOT NULL`, [command.organizationId])
      if (references.rows.some(row => !modelReferences.has(row.reference))) throw new ModelPolicyUnavailable('model_policy_session_reference_incompatible')
      if (command.management === 'dashboard' && !credential) {
        await this.options.state.setCredential(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, JSON.stringify({
          version: 1, catalog, keys: {},
        }), {}, undefined, tx)
      }
      const catalogRevision = credential || command.management === 'dashboard'
        ? await this.options.state.credentialRevision(ORGANIZATION_MODEL_SETTINGS_CREDENTIAL, tx) : '0'
      if (!catalogRevision) throw new ModelPolicyUnavailable('model_policy_storage_unavailable')
      // Re-read after all local checks: a different control operation must not provision the object.
      this.assertPending(await this.trusted(), command)
      await tx.query(`INSERT INTO settings_model_policy_transitions
        (operation_id,installation_id,organization_id,unit_id,expected_revision,policy_revision,management,catalog_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [command.operationId, this.options.installationId, command.organizationId, command.unitId,
        command.expectedEffectivePolicyRevision, command.desiredPolicyRevision, command.management, catalogRevision])
      await tx.query(`INSERT INTO settings_model_policy_fences(organization_id,unit_id,policy_revision,management,operation_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id) DO UPDATE SET policy_revision=EXCLUDED.policy_revision,
        management=EXCLUDED.management,operation_id=EXCLUDED.operation_id,updated_at=clock_timestamp()`,
      [command.organizationId, command.unitId, command.desiredPolicyRevision, command.management, command.operationId])
      return { operationId: command.operationId, organizationId: command.organizationId, unitId: command.unitId,
        policyRevision: command.desiredPolicyRevision, management: command.management, catalogRevision }
    })
  }
}
