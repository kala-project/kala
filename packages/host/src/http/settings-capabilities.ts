import type { ProductVariant, SettingsCapabilities, SettingsCapability } from '@agent-kernel/shared'
import type { DashboardActor } from '../auth-control.js'

export function runtimeSettingsCapabilities(input: {
  product: ProductVariant
  actor: DashboardActor
  projectedReads: boolean
  models: boolean
  agent: boolean
  execution: boolean
  search: boolean
  speech: boolean
}): SettingsCapabilities {
  const { actor, product } = input
  const manager = actor.kind === 'ingress' ? actor.role === 'owner' || actor.role === 'admin' : actor.kind !== 'anonymous' || product === 'portable'
  const entries: SettingsCapability[] = []
  const add = (id: string, supported: boolean, read: boolean, write: boolean, management: SettingsCapability['management'] = 'dashboard'): void => {
    entries.push({ id, scope: 'organization', ...(actor.kind === 'ingress' ? { resourceId: actor.organizationId } : {}),
      supported, canRead: supported && read, canWrite: supported && write, management,
      ...(!supported ? { reasonCode: 'adapter_not_installed' } : {}) })
  }
  add('models.read', true, true, false, 'read-only')
  add('models.configure', input.models, manager, manager, input.models ? 'dashboard' : 'operator')
  add('agent.configure', input.agent, manager, manager)
  add('execution-policy.configure', input.execution, manager, manager)
  add('engines.read', input.projectedReads, true, false, 'read-only')
  add('integrations.read', true, true, false, 'read-only')
  add('search.configure', input.search, manager, manager)
  add('speech.configure', input.speech, manager, manager)
  add('hooks.read', input.projectedReads, manager, false, 'operator')
  add('skills.read', true, true, false, 'read-only')
  add('mcp.configure', true, manager && actor.kind !== 'anonymous', manager && actor.kind !== 'anonymous')
  if (product === 'portable') {
    add('workspace.browse', true, true, false, 'read-only')
    add('executor-invites.manage', true, manager, manager)
    add('storage.read', true, true, false, 'read-only')
    add('diagnostics.read', true, manager, false, 'read-only')
    add('services.read', true, manager, false, 'operator')
    add('consoles.open', true, manager, false, 'operator')
  }
  return { product, ...(actor.kind === 'ingress' ? { organizationId: actor.organizationId } : {}), capabilities: entries }
}
