import type { DashboardActor } from '../auth-control.js'
import type { ScheduledInboxScope } from './inbox-changes.js'

export function dashboardInboxScope(actor?: DashboardActor): ScheduledInboxScope | undefined {
  if (!actor) return undefined
  const principal = actor.kind === 'ingress' ? actor.principal : actor.kind === 'github_user' ? actor.login : actor.kind
  return { ownerKey: actor.kind === 'ingress' ? `organization:${actor.organizationId}` : `principal:${principal}`, principal }
}

export function canReceiveInboxChange(actor: DashboardActor | undefined, change?: ScheduledInboxScope): boolean {
  const scope = dashboardInboxScope(actor)
  return Boolean(scope && (!change || (scope.ownerKey === change.ownerKey && scope.principal === change.principal)))
}
