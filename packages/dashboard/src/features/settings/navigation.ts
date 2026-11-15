import type { ProductVariant, SettingsCapabilities, SettingsCapability } from '@agent-kernel/shared'

const gatewayCapabilities = new Set(['workspace.browse', 'executor-invites.manage', 'members.manage', 'ownership.transfer', 'policies.read',
  'usage.read', 'sessions.read', 'audit.read', 'storage.read', 'diagnostics.read', 'attachment-policy.configure', 'retention-policy.configure',
  'service-accounts.manage', 'webhooks.configure', 'services.read', 'silo.open', 'consoles.open'])

export function mergeSettingsCapabilities(product: ProductVariant, runtime?: SettingsCapabilities, gateway?: SettingsCapabilities): readonly SettingsCapability[] {
  if (product === 'portable') return runtime?.capabilities ?? []
  return [...runtime?.capabilities.filter(item => !gatewayCapabilities.has(item.id)) ?? [],
    ...gateway?.capabilities.filter(item => gatewayCapabilities.has(item.id)) ?? []]
}

export type SettingsNavigationItem = {
  path: string
  label: string
  group: 'personal' | 'organization' | 'deployment'
  capability?: string
  products?: readonly ProductVariant[]
}

export const SETTINGS_NAVIGATION: readonly SettingsNavigationItem[] = [
  { path: 'personal/interface', label: 'interface', group: 'personal' },
  { path: 'personal/notifications', label: 'notifications', group: 'personal' },
  { path: 'personal/connection', label: 'connection', group: 'personal' },
  { path: 'personal/account', label: 'account', group: 'personal' },
  { path: 'organization/members', label: 'members', group: 'organization', capability: 'members.manage', products: ['private-cloud'] },
  { path: 'organization/models/providers', label: 'models', group: 'organization', capability: 'models.read' },
  { path: 'organization/workspaces', label: 'workspaces', group: 'organization', capability: 'workspace.browse' },
  { path: 'organization/integrations/search', label: 'integrations', group: 'organization', capability: 'integrations.read' },
  { path: 'organization/policies/execution', label: 'policies', group: 'organization', capability: 'execution-policy.configure' },
  { path: 'organization/access/usage', label: 'access', group: 'organization', capability: 'usage.read' },
  { path: 'organization/diagnostics', label: 'diagnostics', group: 'organization', capability: 'diagnostics.read' },
  { path: 'deployment/services', label: 'services', group: 'deployment', capability: 'services.read', products: ['dedicated', 'portable'] },
  { path: 'deployment/storage', label: 'silo', group: 'deployment', capability: 'silo.open', products: ['dedicated'] },
  { path: 'deployment/consoles', label: 'consoles', group: 'deployment', capability: 'consoles.open', products: ['dedicated', 'portable'] },
  { path: 'deployment/configuration', label: 'configuration', group: 'deployment', capability: 'services.read', products: ['dedicated', 'portable'] },
]

export function capabilityById(capabilities: readonly SettingsCapability[] | undefined, id: string): SettingsCapability | undefined {
  return capabilities?.find(capability => capability.id === id)
}

export function routeCapability(path: string): string | undefined {
  if (path.startsWith('personal/')) return undefined
  if (path === 'organization/members') return 'members.manage'
  if (path.includes('/mcp')) return 'mcp.configure'
  if (path.includes('/access') && path.startsWith('organization/workspaces/')) return 'executor-invites.manage'
  if (path.startsWith('organization/workspaces')) return 'workspace.browse'
  if (path === 'organization/models/prompts') return 'agent.configure'
  if (path === 'organization/models/engines') return 'engines.read'
  if (path.startsWith('organization/models/')) return 'models.read'
  if (path.startsWith('organization/integrations/webhooks')) return 'webhooks.configure'
  if (path === 'organization/integrations/hooks') return 'hooks.read'
  if (path === 'organization/integrations/skills') return 'skills.read'
  if (path.startsWith('organization/integrations/')) return 'integrations.read'
  if (path.startsWith('organization/policies/execution')) return 'execution-policy.configure'
  if (path === 'organization/policies/attachments') return 'attachment-policy.configure'
  if (path === 'organization/policies/retention') return 'retention-policy.configure'
  if (path.startsWith('organization/policies/')) return 'policies.read'
  if (path === 'organization/access/service-accounts') return 'service-accounts.manage'
  if (path === 'organization/access/storage') return 'storage.read'
  if (path === 'organization/access/sessions') return 'sessions.read'
  if (path === 'organization/access/audit') return 'audit.read'
  if (path.startsWith('organization/access/')) return 'usage.read'
  if (path === 'organization/diagnostics') return 'diagnostics.read'
  if (path === 'deployment/storage') return 'silo.open'
  if (path === 'deployment/consoles') return 'consoles.open'
  return 'services.read'
}
