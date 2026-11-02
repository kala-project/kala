import { randomUUID } from 'node:crypto'

import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { requestRuntime } from '../edge/server.js'
import type { RuntimeOriginResolver } from '../runtime-origin/postgres-runtime-origin-resolver.js'

type Run = { id: string; organization_id: string; runtime_unit_id: string; cutoff: string; state: 'dispatching' | 'succeeded' | 'control_only' | 'unknown';
  control_sessions: number; control_devices: number; host_sessions: number | null; intent_audit_id: string }
export type RetentionResult = { runId: string; state: 'succeeded' | 'control_only'; reused: boolean; sessions: number; devices: number; hostSessions: number }
export type RetentionPurgeResult = RetentionResult & { organizationId: string }
export type RetentionPurgeFailure = { organizationId: string; error: string }
export class RetentionUnsettledError extends Error { constructor() { super('retention_unsettled_requires_review') } }

export class RetentionService {
  constructor(private readonly database: ControlPlaneDatabase, private readonly hostData?: {
    purgeOrganizationSessions(params: { organizationId: string; runtimeUnitId: string; before: Date }): Promise<{ sessions: number }>
  }) {}

  async purgeOrganization(organizationId: string, now?: Date): Promise<RetentionResult> {
    if (now && !Number.isFinite(now.getTime())) throw new Error('invalid retention time')
    const admitted = await this.database.transaction(async (tx) => {
      // A short, database-owned admission lock; never held across Runtime I/O.
      // No Organization UPDATE authority is needed merely to serialize admission.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`kala:retention:${organizationId}`])
      const policy = await tx.query<{ runtime_unit_id: string; period_start: string; cutoff: string }>(`SELECT o.runtime_unit_id,
        (date_trunc('day',COALESCE($2::timestamptz,statement_timestamp()) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS period_start,
        date_trunc('milliseconds',COALESCE($2::timestamptz,statement_timestamp())-r.session_days*interval '1 day')::text AS cutoff
        FROM retention_policies r JOIN organizations o ON o.id=r.organization_id
        WHERE r.organization_id=$1 AND o.status IN ('active','suspended','closing')`, [organizationId, now ?? null])
      const captured = policy.rows[0]
      if (!captured) throw new Error('retention_policy_unavailable')
      const existing = await tx.query<Run>(`SELECT *,cutoff::text AS cutoff FROM retention_runs WHERE organization_id=$1
        AND (period_start=$2 OR state IN ('dispatching','unknown')) ORDER BY created_at DESC LIMIT 1`, [organizationId, captured.period_start])
      if (existing.rows[0]) {
        if (existing.rows[0].state === 'dispatching' || existing.rows[0].state === 'unknown') throw new RetentionUnsettledError()
        return { run: existing.rows[0], reused: true }
      }
      const runId = randomUUID(), intentId = randomUUID()
      await appendRetentionAudit(tx, { id: intentId, runId, organizationId, result: 'allowed', metadata: { before: captured.cutoff, phase: 'started' } })
      const devices = await tx.query(`DELETE FROM notification_devices WHERE organization_id=$1 AND updated_at<$2::timestamptz`, [organizationId, captured.cutoff])
      const sessions = await tx.query(`DELETE FROM browser_sessions WHERE organization_id=$1 AND COALESCE(revoked_at,absolute_expires_at)<$2::timestamptz`, [organizationId, captured.cutoff])
      const inserted = await tx.query<Run>(`INSERT INTO retention_runs(id,organization_id,runtime_unit_id,period_start,cutoff,state,control_sessions,control_devices,intent_audit_id)
        VALUES($1,$2,$3,$4,$5,'dispatching',$6,$7,$8) RETURNING *,cutoff::text AS cutoff`,
      [runId, organizationId, captured.runtime_unit_id, captured.period_start, captured.cutoff, sessions.rowCount ?? 0, devices.rowCount ?? 0, intentId])
      return { run: inserted.rows[0]!, reused: false }
    })
    if (admitted.reused) return completedResult(admitted.run, true)
    const run = admitted.run
    let hostSessions: number | null = null
    if (this.hostData) {
      try {
        hostSessions = (await this.hostData.purgeOrganizationSessions({ organizationId, runtimeUnitId: run.runtime_unit_id, before: new Date(run.cutoff) })).sessions
        if (!Number.isSafeInteger(hostSessions) || hostSessions < 0) throw new Error('invalid_runtime_retention_receipt')
      } catch {
        await this.settle(run, 'unknown', null)
        throw new RetentionUnsettledError()
      }
    }
    // Outside the network catch: persistence failure must not manufacture a
    // remote failure or redispatch. The durable intention remains unresolved.
    return completedResult(await this.settle(run, this.hostData ? 'succeeded' : 'control_only', hostSessions), false)
  }

  private async settle(run: Run, state: 'succeeded' | 'control_only' | 'unknown', hostSessions: number | null): Promise<Run> {
    return this.database.transaction(async (tx) => {
      const current = await tx.query<Run>(`SELECT *,cutoff::text AS cutoff FROM retention_runs WHERE id=$1 FOR UPDATE`, [run.id])
      if (current.rows[0]?.state !== 'dispatching') throw new RetentionUnsettledError()
      const outcomeId = randomUUID()
      await appendRetentionAudit(tx, { id: outcomeId, runId: run.id, organizationId: run.organization_id,
        result: state === 'succeeded' ? 'succeeded' : state === 'unknown' ? 'failed' : 'allowed', metadata: {
          phase: state, intentId: run.intent_audit_id, before: run.cutoff, sessions: run.control_sessions, devices: run.control_devices,
          ...(hostSessions !== null ? { hostSessions } : {}), ...(state === 'unknown' ? { reason: 'runtime_outcome_unknown' } : {}),
        } })
      const updated = await tx.query<Run>(`UPDATE retention_runs SET state=$2,host_sessions=$3,outcome_audit_id=$4,completed_at=clock_timestamp()
        WHERE id=$1 AND state='dispatching' RETURNING *,cutoff::text AS cutoff`, [run.id, state, hostSessions, outcomeId])
      if (updated.rowCount !== 1) throw new RetentionUnsettledError()
      return updated.rows[0]!
    })
  }

  async purgeAllOrganizations(now?: Date, signal?: AbortSignal): Promise<{ purged: RetentionPurgeResult[]; failures: RetentionPurgeFailure[] }> {
    const organizations = await this.database.query<{ organization_id: string }>(`SELECT r.organization_id FROM retention_policies r
      JOIN organizations o ON o.id=r.organization_id WHERE o.status IN ('active','suspended','closing') ORDER BY r.organization_id`)
    const purged: RetentionPurgeResult[] = [], failures: RetentionPurgeFailure[] = []
    for (const row of organizations.rows) {
      if (signal?.aborted) break
      try { purged.push({ organizationId: row.organization_id, ...await this.purgeOrganization(row.organization_id, now) }) }
      catch (error) { failures.push({ organizationId: row.organization_id,
        error: error instanceof RetentionUnsettledError ? error.message : 'retention_unavailable' }) }
    }
    return { purged, failures }
  }

  async exportOrganization(organizationId: string): Promise<Record<string, unknown>> {
    return this.database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const organization = await tx.query('SELECT * FROM organizations WHERE id=$1', [organizationId])
      if (!organization.rows[0]) throw new Error('organization not found')
      const members = await tx.query('SELECT * FROM organization_memberships WHERE organization_id=$1', [organizationId])
      const usage = await tx.query('SELECT * FROM usage_ledger WHERE organization_id=$1 ORDER BY occurred_at,id', [organizationId])
      const audit = await tx.query('SELECT * FROM audit_events WHERE organization_id=$1 ORDER BY occurred_at,id', [organizationId])
      const runs = await tx.query('SELECT * FROM retention_runs WHERE organization_id=$1 ORDER BY created_at,id', [organizationId])
      return { schemaVersion: 1, exportedAt: new Date().toISOString(), organization: organization.rows[0], memberships: members.rows,
        usage: usage.rows, audit: audit.rows, retentionRuns: runs.rows }
    })
  }
}

async function appendRetentionAudit(tx: SqlExecutor, input: { id: string; runId: string; organizationId: string; result: 'allowed' | 'succeeded' | 'failed'; metadata: object }): Promise<void> {
  await tx.query(`INSERT INTO audit_events(id,organization_id,actor_principal_id,actor_kind,action,target_type,target_id,result,request_id,metadata)
    VALUES($1,$2,NULL,'system','retention.purge','organization',$2,$3,$4,$5)`, [input.id, input.organizationId, input.result, input.runId, input.metadata])
}
function completedResult(run: Run, reused: boolean): RetentionResult {
  if (run.state !== 'succeeded' && run.state !== 'control_only') throw new RetentionUnsettledError()
  return { runId: run.id, state: run.state, reused, sessions: run.control_sessions, devices: run.control_devices, hostSessions: run.host_sessions ?? 0 }
}

export function createRuntimeHostRetentionClient(options: {
  origin: string
  runtimeOriginResolver?: RuntimeOriginResolver
  ingressSecret: string
  tls?: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer; servername?: string }
}): { purgeOrganizationSessions(params: { organizationId: string; runtimeUnitId: string; before: Date }): Promise<{ sessions: number }> } {
  return {
    async purgeOrganizationSessions(params) {
      const signal = AbortSignal.timeout(10_000)
      const origin = options.runtimeOriginResolver
        ? await options.runtimeOriginResolver.resolve(params.runtimeUnitId)
        : options.origin
      signal.throwIfAborted()
      if (!origin) throw new Error('Runtime Host retention origin is unavailable')
      const response = await requestRuntime(
        origin,
        '/internal/retention/sessions',
        'POST',
        { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': options.ingressSecret },
        Buffer.from(JSON.stringify({ organizationId: params.organizationId, unitId: params.runtimeUnitId, before: params.before.toISOString() })),
        options.tls,
        { signal, maxResponseBytes: 16_384 },
      )
      if (response.status < 200 || response.status >= 300) {
        throw new Error('runtime_retention_response_rejected')
      }
      let result: { sessions?: unknown }
      try { result = JSON.parse(response.body.toString('utf8')) as { sessions?: unknown } }
      catch { throw new Error('runtime_retention_response_invalid') }
      if (!Number.isSafeInteger(result.sessions) || Number(result.sessions) < 0) throw new Error('Runtime Host retention returned an invalid response')
      return { sessions: Number(result.sessions) }
    },
  }
}

export function startRetentionScheduler(options: {
  service: Pick<RetentionService, 'purgeAllOrganizations'>
  intervalMs: number
  now?: () => Date
  onResult?: (result: Awaited<ReturnType<RetentionService['purgeAllOrganizations']>>) => void
  onError?: (error: Error) => void
}): { stop(): Promise<void> } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 60_000) throw new Error('retention scheduler interval must be at least 60000ms')
  const stopping = new AbortController()
  let active: Promise<void> | undefined
  let running = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = (): void => {
    if (running || stopped) return
    running = true
    active = options.service.purgeAllOrganizations(options.now?.(), stopping.signal)
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
    stop: async () => {
      stopped = true
      stopping.abort()
      if (timer) clearTimeout(timer)
      await active
    },
  }
}
