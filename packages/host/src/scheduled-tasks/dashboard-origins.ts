import type { AgentEvent } from '@agent-kernel/kernel'
import type { SessionRecord } from '../store/session.js'
import type { DashboardActor } from '../auth-control.js'
import { occurrenceSessionId } from './scheduler.js'
import type { ScheduledTaskStorage } from './store.js'

type ScopedSession = Pick<SessionRecord, 'sessionId' | 'organizationId' | 'principal'>

export function dashboardOriginsOwner(record: ScopedSession, actor?: DashboardActor): string | undefined {
  if (record.organizationId) {
    if (actor && (actor.kind !== 'ingress' || actor.organizationId !== record.organizationId)) return undefined
    return `organization:${record.organizationId}`
  }
  if (actor) return actor.kind === 'ingress' ? undefined : `principal:${actor.kind === 'github_user' ? actor.login : actor.kind}`
  return record.principal ? `principal:${record.principal}` : undefined
}

export function createDashboardScheduledOrigins(store: Pick<ScheduledTaskStorage, 'origins' | 'claimedRuns'>) {
  const pending = new WeakMap<ScopedSession, { operationId: string; taskId: string; ownerKey: string }>()
  return {
    async snapshot(record: ScopedSession, actor?: DashboardActor): Promise<Record<string, string>> {
      const owner = dashboardOriginsOwner(record, actor)
      return owner ? await store.origins(owner, record.sessionId) : {}
    },
    async prepare(record: ScopedSession, operationId: string, scheduledOwnerKey?: string): Promise<void> {
      if (!operationId.startsWith('schedule_')) return
      pending.delete(record)
      const owner = record.organizationId ? dashboardOriginsOwner(record) : scheduledOwnerKey ?? dashboardOriginsOwner(record)
      if (record.organizationId && scheduledOwnerKey && scheduledOwnerKey !== owner) return
      if (!owner) return
      const origins = await store.origins(owner, record.sessionId)
      let taskId = Object.hasOwn(origins, operationId) ? origins[operationId] : undefined
      if (!taskId) {
        // A claimed run can dispatch before the scheduler commits its final sessionId.
        const run = (await store.claimedRuns()).find((run) => run.operationId === operationId
          && run.task.ownerKey === owner
          && (run.sessionId ?? (run.task.target.kind === 'session'
            ? run.task.target.sessionId : occurrenceSessionId(run.occurrenceId))) === record.sessionId)
        taskId = run?.taskId
      }
      if (taskId) pending.set(record, { operationId, taskId, ownerKey: owner })
    },
    take(record: ScopedSession | undefined, event: AgentEvent): { taskId: string; ownerKey: string } | undefined {
      if (!record || event.kind !== 'user_message' || !event.operationId) return undefined
      const attribution = pending.get(record)
      if (attribution?.operationId !== event.operationId) return undefined
      pending.delete(record)
      return { taskId: attribution.taskId, ownerKey: attribution.ownerKey }
    },
  }
}
