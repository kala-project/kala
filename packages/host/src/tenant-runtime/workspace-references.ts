import { createHash } from 'node:crypto'
import { schema } from '@agent-kernel/shared'
import type { HotStateDatabase, HotStateSqlExecutor } from './postgres-hot-state.js'
import { ModelPolicyUnavailable } from './model-policy-client.js'
import type { ModelPolicyClient } from './model-policy-client.js'
import { parseTenantRuntimeUnitId } from './unit.js'

export class PostgresWorkspaceReferenceAuthority {
  constructor(private readonly options: { database: HotStateDatabase; installationId: string;
    policy?: Pick<ModelPolicyClient, 'resource'> }) {}

  private scope(input: unknown, additional: readonly string[] = []) {
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !==
      ['installationId', 'organizationId', 'unitId', 'workspaceId', ...additional].sort().join(',')) {
      throw new ModelPolicyUnavailable('invalid_workspace_reference_request')
    }
    const request = input as Record<string, unknown>
    for (const key of ['organizationId', 'unitId', 'workspaceId']) {
      if (typeof request[key] !== 'string' || !request[key] || request[key].length > 512
        || request[key] !== request[key].trim() || /[\u0000-\u001f\u007f]/u.test(request[key])) {
        throw new ModelPolicyUnavailable('invalid_workspace_reference_request')
      }
    }
    if (request.installationId !== this.options.installationId) throw new ModelPolicyUnavailable('workspace_reference_installation_mismatch')
    return { installationId: this.options.installationId, organizationId: request.organizationId as string,
      unitId: parseTenantRuntimeUnitId(request.unitId as string), workspaceId: request.workspaceId as string }
  }

  async inspect(input: unknown) {
    const operationId = input && typeof input === 'object' && 'operationId' in input ? input.operationId : undefined
    const request = this.scope(input, operationId === undefined ? [] : ['operationId'])
    if (operationId !== undefined && !schema.SettingsModelPolicyReconcileSchema.shape.operationId.safeParse(operationId).success) {
      throw new ModelPolicyUnavailable('invalid_workspace_reservation')
    }
    return this.options.database.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      const snapshot = await this.snapshot(tx, request)
      if (operationId === undefined) return snapshot
      await this.installed(tx)
      const hold = await tx.query<{ reference_revision: string }>(`SELECT reference_revision FROM settings_workspace_maintenance_holds WHERE operation_id=$1
        AND installation_id=$2 AND organization_id=$3 AND unit_id=$4 AND workspace_id=$5 AND state='held'`,
      [operationId, request.installationId, request.organizationId, request.unitId, request.workspaceId])
      return { ...snapshot, revision: hold.rows[0] && !snapshot.activeSessions && !snapshot.unresolvedWorkspaceEffects
        ? hold.rows[0].reference_revision : snapshot.revision, maintenanceHeld: Boolean(hold.rowCount) }
    })
  }

  private async snapshot(tx: HotStateSqlExecutor, request: ReturnType<PostgresWorkspaceReferenceAuthority['scope']>) {
      const { organizationId, unitId, workspaceId } = request
      const placement = (await tx.query<{ organization_id: string; desired_state: string; generation: string; operation_id: string }>(
        `SELECT organization_id,desired_state,generation::text,operation_id FROM tenant_runtime_unit_materializations
         WHERE unit_id=$1 FOR UPDATE`, [unitId])).rows[0]
      if (!placement || placement.organization_id !== organizationId || placement.desired_state === 'deleted') {
        throw new ModelPolicyUnavailable('workspace_reference_placement_mismatch')
      }
      const members = (await tx.query<{ replica_id: string; generation: string }>(`SELECT replica_id,generation::text
        FROM tenant_runtime_unit_replica_memberships WHERE organization_id=$1 AND unit_id=$2
          AND expires_at>clock_timestamp() ORDER BY replica_id COLLATE "C",generation`, [organizationId, unitId])).rows
      // Disappearance alone is not a checkpoint. Suspension fences fresh admissions;
      // durable active Session/effect references below still block archival.
      if (placement.desired_state !== 'suspended' || members.length) {
        throw new ModelPolicyUnavailable('workspace_maintenance_required')
      }
      const sessions = (await tx.query<{ session_id: string; version: string; status: string | null }>(`SELECT
        session_id,version::text,document->'state'->>'status' AS status FROM tenant_session_latest_projection
        WHERE tenant_id=$1 AND document IS NOT NULL AND document->>'workspaceId'=$2
        ORDER BY session_id COLLATE "C"`, [organizationId, workspaceId])).rows
      const effects = (await tx.query<{ resource_id: string; effect_id: string; generation: string }>(`SELECT
        resource_id,effect_id,generation::text FROM tenant_runtime_active_workspace_effects
        WHERE organization_id=$1 AND unit_id=$2 AND workspace_id=$3
        ORDER BY resource_id COLLATE "C",effect_id COLLATE "C"`, [organizationId, unitId, workspaceId])).rows
      return { ...request,
        revision: createHash('sha256').update(JSON.stringify({ placement, sessions, effects })).digest('hex'),
        quiesced: true, maintenanceHeld: false,
        activeSessions: sessions.filter(session => !['done', 'error'].includes(session.status ?? '')).length,
        liveExecutors: 0, unresolvedWorkspaceEffects: effects.length }
  }

  private async installed(tx: HotStateSqlExecutor) {
    if (!(await tx.query<{ present: boolean }>(
      "SELECT to_regclass('settings_workspace_maintenance_holds') IS NOT NULL AS present")).rows[0]?.present) {
      throw new ModelPolicyUnavailable('workspace_maintenance_schema_unavailable')
    }
  }

  async reserve(input: unknown) {
    const request = this.scope(input, ['operationId', 'expectedReferenceRevision'])
    const values = input as { operationId: string; expectedReferenceRevision: string }
    if (!schema.SettingsModelPolicyReconcileSchema.shape.operationId.safeParse(values.operationId).success
      || !/^[a-f0-9]{64}$/u.test(values.expectedReferenceRevision)) throw new ModelPolicyUnavailable('invalid_workspace_reservation')
    return this.options.database.transaction(async tx => {
      await this.installed(tx)
      await tx.query("SET LOCAL lock_timeout='3s'")
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`kala:workspace-admission:${request.organizationId}:${request.workspaceId}`])
      const prior = (await tx.query<{ installation_id: string; organization_id: string; unit_id: string; workspace_id: string;
        reference_revision: string; reference_snapshot: Awaited<ReturnType<PostgresWorkspaceReferenceAuthority['inspect']>>; state: string }>(
        'SELECT * FROM settings_workspace_maintenance_holds WHERE operation_id=$1 FOR UPDATE', [values.operationId])).rows[0]
      if (prior) {
        if (prior.installation_id !== request.installationId || prior.organization_id !== request.organizationId
          || prior.unit_id !== request.unitId || prior.workspace_id !== request.workspaceId
          || prior.reference_revision !== values.expectedReferenceRevision) throw new ModelPolicyUnavailable('workspace_reservation_identity_mismatch')
        return { ...prior.reference_snapshot, operationId: values.operationId, maintenanceHeld: prior.state === 'held' }
      }
      const snapshot = await this.snapshot(tx, request)
      if (snapshot.revision !== values.expectedReferenceRevision) throw new ModelPolicyUnavailable('workspace_references_changed')
      if (snapshot.activeSessions || snapshot.liveExecutors || snapshot.unresolvedWorkspaceEffects) {
        throw new ModelPolicyUnavailable('workspace_has_active_references')
      }
      await tx.query(`INSERT INTO settings_workspace_maintenance_holds(operation_id,installation_id,organization_id,unit_id,
        workspace_id,reference_revision,reference_snapshot,state) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'held')`,
      [values.operationId, request.installationId, request.organizationId, request.unitId, request.workspaceId,
        snapshot.revision, JSON.stringify(snapshot)])
      return { ...snapshot, operationId: values.operationId, maintenanceHeld: true }
    })
  }

  async consume(input: unknown) {
    const parsed = schema.SettingsOperationalRequestSchema.extend({
      operationId: schema.SettingsModelPolicyReconcileSchema.shape.operationId,
      revision: schema.SettingsOperationalObservationSchema.shape.revision,
    }).strict().safeParse(input)
    if (!parsed.success || parsed.data.installationId !== this.options.installationId || !this.options.policy) {
      throw new ModelPolicyUnavailable('invalid_operational_consumer_request')
    }
    const request = parsed.data
    const observed = await this.options.policy.resource(request.organizationId, request.unitId, request.resource)
    if (observed.revision !== request.revision) throw new ModelPolicyUnavailable('operational_consumer_revision_changed')
    await this.options.database.transaction(async tx => {
      await this.installed(tx)
      if (observed.value.kind !== 'workspace') return
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`kala:workspace-admission:${request.organizationId}:${request.resource.id}`])
      const hold = (await tx.query<{ installation_id: string; organization_id: string; unit_id: string; workspace_id: string; state: string }>(
        'SELECT * FROM settings_workspace_maintenance_holds WHERE operation_id=$1 FOR UPDATE', [request.operationId])).rows[0]
      if (observed.value.status === 'archived' && (!hold || hold.installation_id !== request.installationId
        || hold.organization_id !== request.organizationId || hold.unit_id !== request.unitId || hold.workspace_id !== request.resource.id)) {
        throw new ModelPolicyUnavailable('workspace_reservation_required')
      }
      const consumed = await tx.query(`INSERT INTO settings_workspace_admissions(organization_id,unit_id,workspace_id,revision,status,operation_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,workspace_id) DO UPDATE SET
        revision=EXCLUDED.revision,status=EXCLUDED.status,operation_id=EXCLUDED.operation_id,observed_at=clock_timestamp()
        WHERE settings_workspace_admissions.unit_id=EXCLUDED.unit_id AND settings_workspace_admissions.revision<=EXCLUDED.revision`,
      [request.organizationId, request.unitId, request.resource.id, request.revision, observed.value.status, request.operationId])
      if (consumed.rowCount !== 1) throw new ModelPolicyUnavailable('workspace_admission_revision_changed')
      if (hold) await tx.query(`UPDATE settings_workspace_maintenance_holds SET state='committed',resulting_revision=$2,
        completed_at=clock_timestamp() WHERE operation_id=$1`, [request.operationId, request.revision])
    })
    return { ...observed, operationId: request.operationId, consumed: true }
  }
}
