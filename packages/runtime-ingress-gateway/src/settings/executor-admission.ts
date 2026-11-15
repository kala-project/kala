import { createHash } from 'node:crypto'
import { schema } from '@agent-kernel/shared'
import type { ControlPlaneDatabase } from '../persistence/postgres.js'
import { ACTIVE_CONTRACT_SQL } from '../organizations/contract-access.js'

/** Registry membership is durable enrollment, never a claim that a device is online. */
export async function admitRegisteredExecutor(database: ControlPlaneDatabase, request: schema.SettingsExecutorAdmissionRequest,
  requireRegisteredEnrollment = true) {
  return database.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kala:control-settings-schema:v1',0))")
    const organization = (await tx.query<{ admitted: boolean }>(
      `SELECT o.status='active' AND ${ACTIVE_CONTRACT_SQL} AS admitted FROM organizations o
       WHERE o.id=$1 AND o.runtime_unit_id=$2`, [request.organizationId, request.unitId])).rows[0]
    if (!organization) throw new Error('executor_scope_denied')
    const workspace = (await tx.query<{ status: 'active' | 'archived' }>(
      'SELECT status FROM workspaces WHERE organization_id=$1 AND id=$2 FOR SHARE', [request.organizationId, request.workspaceId])).rows[0]
    const id = `exe_${createHash('sha256').update(JSON.stringify([request.organizationId, request.executorId])).digest('hex')}`
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`kala:executor-enrollment:${id}`])
    const registered = (await tx.query<{ pool_id: string; status: string; platform: Record<string, unknown> }>(
      'SELECT pool_id,status,platform FROM executors WHERE organization_id=$1 AND id=$2 FOR UPDATE', [request.organizationId, id])).rows[0]
    // Pre-17 rows were routing hints with a 15-minute placeholder; Native already verified its seven-day invitation.
    const token = registered?.status !== 'active' && request.enrollmentHash ? (await tx.query<{
      id: string; pool_id: string; usable: boolean;
    }>(`SELECT id,pool_id,revoked_at IS NULL AND used_count<max_uses AND
         (expires_at>now() OR created_at<coalesce((SELECT applied_at FROM control_plane_schema_migrations WHERE version=17),'infinity')) AS usable
       FROM executor_enrollment_tokens WHERE organization_id=$1 AND token_hash=$2 FOR UPDATE`,
    [request.organizationId, Buffer.from(request.enrollmentHash, 'hex').toString('base64url')])).rows[0] : undefined
    const poolId = token?.pool_id ?? registered?.pool_id
    const pool = poolId ? (await tx.query<{ id: string; revision: string; mode: 'organization' | 'workspace'; workspace_id: string | null }>(
      `SELECT id,coalesce(to_jsonb(p)->>'settings_revision','1') AS revision,mode,workspace_id
       FROM executor_pools p WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [request.organizationId, poolId])).rows[0] : undefined
    const admitted = organization.admitted && workspace?.status !== 'archived'
      && (registered?.status === 'active' ? registered.platform.nativeWorkspaceId === request.workspaceId
        && registered.platform.nativeExecutorId === request.executorId
        : registered ? token?.usable === true
          : request.enrollmentHash ? token?.usable === true || !token && !requireRegisteredEnrollment : true)
      && (!poolId || !!pool && (pool.mode === 'organization' || pool.workspace_id === request.workspaceId))
    if (admitted && registered?.status !== 'active' && token && pool) {
      const associated = await tx.query(`INSERT INTO executors(id,organization_id,pool_id,name,status,platform,enrolled_at,last_seen_at)
        VALUES($1,$2,$3,$4,'active',$5::jsonb,now(),now())
        ON CONFLICT(id) DO UPDATE SET pool_id=EXCLUDED.pool_id,status='active',platform=EXCLUDED.platform,
          enrolled_at=EXCLUDED.enrolled_at,last_seen_at=EXCLUDED.last_seen_at
        WHERE executors.organization_id=EXCLUDED.organization_id AND executors.status='revoked'`,
      [id, request.organizationId, pool.id, request.executorId,
        JSON.stringify({ nativeExecutorId: request.executorId, nativeWorkspaceId: request.workspaceId,
          nativeEnrollmentId: token.id, ...(request.enrollmentInviteId ? { nativeInviteId: request.enrollmentInviteId } : {}) })])
      if (associated.rowCount !== 1) throw new Error('executor_registration_changed')
      await tx.query('UPDATE executor_enrollment_tokens SET used_count=used_count+1 WHERE id=$1', [token.id])
    } else if (admitted && registered) {
      await tx.query('UPDATE executors SET last_seen_at=now() WHERE id=$1', [id])
    }
    return schema.SettingsExecutorAdmissionSchema.parse({
      ...request, admitted, registry: registered || admitted && token ? 'registered' : 'legacy-unregistered',
      pool: pool ? { id: pool.id, revision: pool.revision, mode: pool.mode, workspaceId: pool.workspace_id } : null,
      workspaceStatus: workspace?.status ?? 'unregistered', observedAt: new Date().toISOString(),
    })
  })
}
