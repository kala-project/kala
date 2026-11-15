import { schema } from '@agent-kernel/shared'
import type { ControlPlaneDatabase } from '../persistence/postgres.js'
import { ACTIVE_CONTRACT_SQL } from '../organizations/contract-access.js'
import { admitRegisteredExecutor } from './executor-admission.js'

export class ModelPolicyReadError extends Error {
  constructor(readonly status: 400 | 403 | 503, readonly code: string) { super(code) }
}
/** This service has no policy mutation or Operator-journal API. */
export class PostgresModelPolicyReader {
  constructor(private readonly database: ControlPlaneDatabase, private readonly installationId: string,
    private readonly options: { executorRegistryRequired?: boolean } = {}) {
    if (!schema.SettingsModelPolicyRequestSchema.shape.installationId.safeParse(installationId).success) {
      throw new ModelPolicyReadError(503, 'model_policy_installation_unavailable')
    }
  }
  async executor(input: unknown) {
    const request = schema.SettingsExecutorAdmissionRequestSchema.safeParse(input)
    if (!request.success) throw new ModelPolicyReadError(400, 'invalid_executor_admission_request')
    if (request.data.installationId !== this.installationId) throw new ModelPolicyReadError(403, 'model_policy_installation_mismatch')
    return admitRegisteredExecutor(this.database, request.data, this.options.executorRegistryRequired !== false)
  }
  async resource(input: unknown): Promise<schema.SettingsOperationalObservation> {
    const request = schema.SettingsOperationalRequestSchema.safeParse(input)
    if (!request.success) throw new ModelPolicyReadError(400, 'invalid_operational_settings_request')
    if (request.data.installationId !== this.installationId) throw new ModelPolicyReadError(403, 'model_policy_installation_mismatch')
    return this.database.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kala:control-settings-schema:v1',0))")
      const { organizationId, unitId, resource } = request.data
      if (!(await tx.query('SELECT id FROM organizations WHERE id=$1 AND runtime_unit_id=$2', [organizationId, unitId])).rowCount) {
        throw new ModelPolicyReadError(403, 'model_policy_scope_denied')
      }
      let row: { revision: string; value: unknown } | undefined
      if (resource.kind === 'workspace') row = (await tx.query<{ revision: string; value: unknown }>(
        `SELECT policy_version::text AS revision,jsonb_build_object('kind','workspace','status',status) AS value
           FROM workspaces WHERE organization_id=$1 AND id=$2`, [organizationId, resource.id])).rows[0]
        else if (resource.kind === 'pool') row = (await tx.query<{ revision: string; value: unknown }>(
          `SELECT p.settings_revision::text AS revision,jsonb_build_object('kind','pool','mode',p.mode,'workspaceId',p.workspace_id,
            'workspaceStatus',w.status) AS value FROM executor_pools p LEFT JOIN workspaces w
            ON w.id=p.workspace_id AND w.organization_id=p.organization_id WHERE p.organization_id=$1 AND p.id=$2`,
          [organizationId, resource.id])).rows[0]
      else if (resource.id === organizationId) row = (await tx.query<{ revision: string; value: unknown }>(
          `SELECT c.settings_revision::text AS revision,jsonb_build_object('kind','entitlement',
            'admitted',o.status='active' AND ${ACTIVE_CONTRACT_SQL},
            'startsAt',c.starts_at::text,'endsAt',c.ends_at::text) AS value FROM contract_entitlements c
            JOIN organizations o ON o.id=c.organization_id WHERE c.organization_id=$1`, [organizationId])).rows[0]
      if (!row) throw new ModelPolicyReadError(403, 'operational_resource_scope_denied')
      return schema.SettingsOperationalObservationSchema.parse({ ...request.data, ...row, observedAt: new Date().toISOString() })
    })
  }
  async read(input: unknown): Promise<schema.SettingsModelPolicy> {
    const request = schema.SettingsModelPolicyRequestSchema.safeParse(input)
    if (!request.success) throw new ModelPolicyReadError(400, 'invalid_model_policy_request')
    if (request.data.installationId !== this.installationId) throw new ModelPolicyReadError(403, 'model_policy_installation_mismatch')
    return this.database.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kala:control-settings-schema:v1',0))")
      const organization = await tx.query('SELECT id FROM organizations WHERE id=$1 AND runtime_unit_id=$2',
        [request.data.organizationId, request.data.unitId])
      if (!organization.rowCount) throw new ModelPolicyReadError(403, 'model_policy_scope_denied')
      const installed = (await tx.query<{ present: boolean }>(
        "SELECT to_regclass('public.organization_model_management') IS NOT NULL AS present")).rows[0]?.present === true
      const row = installed ? (await tx.query<{
        desired_management: string; desired_revision: string; effective_management: string; effective_revision: string;
        state: string; operation_id: string | null; required_serving_scope: unknown;
      }>(`SELECT desired_management,desired_revision::text,effective_management,effective_revision::text,
        state,operation_id,required_serving_scope FROM organization_model_management WHERE organization_id=$1`,
      [request.data.organizationId])).rows[0] : undefined
      const parsed = schema.SettingsModelPolicySchema.safeParse({
        ...request.data, installed,
        desiredManagement: row?.desired_management ?? 'operator', desiredRevision: row?.desired_revision ?? '1',
        effectiveManagement: row?.effective_management ?? 'operator', effectiveRevision: row?.effective_revision ?? '1',
        state: row?.state ?? 'active', operationId: row?.operation_id ?? null, requiredServingScope: row?.required_serving_scope ?? [],
      })
      if (!parsed.success) throw new ModelPolicyReadError(503, 'model_policy_state_invalid')
      return parsed.data
    })
  }
}
