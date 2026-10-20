import { randomUUID } from 'node:crypto'

import type { ControlPlaneDatabase } from '../persistence/postgres.js'
import { requestRuntime } from '../edge/server.js'
import type { RuntimeOriginResolver } from '../runtime-origin/postgres-runtime-origin-resolver.js'

export type RetentionPurgeResult = {
  organizationId: string
  sessions: number
  devices: number
  hostSessions: number
}

export type RetentionPurgeFailure = {
  organizationId: string
  error: string
}

export class RetentionService {
  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly hostData?: {
      purgeOrganizationSessions(params: { organizationId: string; runtimeUnitId: string; before: Date }): Promise<{ sessions: number }>
    },
  ) {}
  async purgeOrganization(organizationId: string, now = new Date()): Promise<{ sessions: number; devices: number; hostSessions: number }> {
    const controlPlane = await this.database.transaction(async (transaction) => {
      const policy = await transaction.query<{ session_days: number; runtime_unit_id: string }>(`SELECT r.session_days,o.runtime_unit_id
        FROM retention_policies r JOIN organizations o ON o.id=r.organization_id
        WHERE r.organization_id=$1`, [organizationId])
      if (!policy.rows[0]) throw new Error('retention policy not found')
      const before = new Date(now.getTime() - policy.rows[0].session_days * 24 * 60 * 60 * 1000)
      const auditId = randomUUID()
      // Commit an audit intention together with control-plane deletion before touching Host/NFS.
      await transaction.query(
        `INSERT INTO audit_events(id,organization_id,actor_principal_id,actor_kind,action,target_type,target_id,result,metadata) VALUES($1,$2,NULL,'system','retention.purge','organization',$2,'allowed',$3)`,
        [auditId, organizationId, { before: before.toISOString(), phase: 'started' }],
      )
      const devices = await transaction.query(`DELETE FROM notification_devices WHERE organization_id=$1 AND updated_at < $2::timestamptz - ($3::text || ' days')::interval`, [organizationId, now, policy.rows[0].session_days])
      const sessions = await transaction.query(`DELETE FROM browser_sessions WHERE organization_id=$1 AND COALESCE(revoked_at,absolute_expires_at) < $2::timestamptz - ($3::text || ' days')::interval`, [organizationId, now, policy.rows[0].session_days])
      return { auditId, before, runtimeUnitId: policy.rows[0].runtime_unit_id, sessions: sessions.rowCount ?? 0, devices: devices.rowCount ?? 0 }
    })
    let hostSessions = 0
    try {
      hostSessions = this.hostData ? (await this.hostData.purgeOrganizationSessions({ organizationId, runtimeUnitId: controlPlane.runtimeUnitId, before: controlPlane.before })).sessions : 0
    } catch (error) {
      await this.database.query('UPDATE audit_events SET result=$2,metadata=$3 WHERE id=$1', [controlPlane.auditId, 'failed', { before: controlPlane.before.toISOString(), phase: 'host_failed' }]).catch(() => undefined)
      throw error
    }
    const result = { sessions: controlPlane.sessions, devices: controlPlane.devices, hostSessions }
    await this.database.query('UPDATE audit_events SET result=$2,metadata=$3 WHERE id=$1', [controlPlane.auditId, 'succeeded', { before: controlPlane.before.toISOString(), ...result }])
    return result
  }
  async purgeAllOrganizations(now = new Date()): Promise<{ purged: RetentionPurgeResult[]; failures: RetentionPurgeFailure[] }> {
    const organizations = await this.database.query<{ organization_id: string }>(`
      SELECT r.organization_id
      FROM retention_policies r
      JOIN organizations o ON o.id=r.organization_id
      WHERE o.status IN ('active','suspended','closing')
      ORDER BY r.organization_id
    `)
    const purged: RetentionPurgeResult[] = []
    const failures: RetentionPurgeFailure[] = []
    for (const row of organizations.rows) {
      try {
        purged.push({ organizationId: row.organization_id, ...await this.purgeOrganization(row.organization_id, now) })
      } catch (error) {
        failures.push({ organizationId: row.organization_id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { purged, failures }
  }
  async exportOrganization(organizationId: string): Promise<Record<string, unknown>> {
    const [organization, members, usage, audit] = await Promise.all([
      this.database.query('SELECT * FROM organizations WHERE id=$1', [organizationId]),
      this.database.query('SELECT m.* FROM organization_memberships m WHERE organization_id=$1', [organizationId]),
      this.database.query('SELECT * FROM usage_ledger WHERE organization_id=$1 ORDER BY occurred_at', [organizationId]),
      this.database.query('SELECT * FROM audit_events WHERE organization_id=$1 ORDER BY occurred_at', [organizationId]),
    ])
    if (!organization.rows[0]) throw new Error('organization not found')
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), organization: organization.rows[0], memberships: members.rows, usage: usage.rows, audit: audit.rows }
  }

}

export function createRuntimeHostRetentionClient(options: {
  origin: string
  runtimeOriginResolver?: RuntimeOriginResolver
  ingressSecret: string
  tls?: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer; servername?: string }
}): { purgeOrganizationSessions(params: { organizationId: string; runtimeUnitId: string; before: Date }): Promise<{ sessions: number }> } {
  return {
    async purgeOrganizationSessions(params) {
      const origin = options.runtimeOriginResolver
        ? await options.runtimeOriginResolver.resolve(params.runtimeUnitId)
        : options.origin
      if (!origin) throw new Error('Runtime Host retention origin is unavailable')
      const response = await requestRuntime(
        origin,
        '/internal/retention/sessions',
        'POST',
        { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': options.ingressSecret },
        Buffer.from(JSON.stringify({ organizationId: params.organizationId, unitId: params.runtimeUnitId, before: params.before.toISOString() })),
        options.tls,
      )
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Runtime Host retention failed: ${response.status} ${response.body.toString('utf8')}`)
      }
      const result = JSON.parse(response.body.toString('utf8')) as { sessions?: unknown }
      if (!Number.isSafeInteger(result.sessions) || Number(result.sessions) < 0) throw new Error('Runtime Host retention returned an invalid response')
      return { sessions: Number(result.sessions) }
    },
  }
}

export function startRetentionScheduler(options: {
  service: RetentionService
  intervalMs: number
  now?: () => Date
  onResult?: (result: Awaited<ReturnType<RetentionService['purgeAllOrganizations']>>) => void
  onError?: (error: Error) => void
}): { stop(): void } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 60_000) throw new Error('retention scheduler interval must be at least 60000ms')
  let running = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = (): void => {
    if (running || stopped) return
    running = true
    void options.service.purgeAllOrganizations(options.now?.() ?? new Date())
      .then((result) => options.onResult?.(result))
      .catch((error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        running = false
        schedule()
      })
  }
  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(run, options.intervalMs)
    timer.unref?.()
  }
  run()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
