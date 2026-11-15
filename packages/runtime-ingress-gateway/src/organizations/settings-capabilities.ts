import type { SettingsCapabilities, SettingsCapability } from '@agent-kernel/shared'
import type { OrganizationAccess } from './store.js'

export function organizationSettingsCapabilities(access: OrganizationAccess, options: {
  dedicated: boolean
  serviceAccounts: boolean
  projections: boolean
  silo: boolean
  consoles: boolean
  webhooks?: boolean
}): SettingsCapabilities {
  const { role } = access.membership
  const manager = role === 'owner' || role === 'admin'
  const entries: SettingsCapability[] = []
  const add = (id: string, supported: boolean, read: boolean, write: boolean, scope: SettingsCapability['scope'] = 'organization', reasonCode?: string): void => {
    entries.push({ id, scope, resourceId: access.organization.id, supported, canRead: supported && read, canWrite: supported && write,
      management: scope === 'deployment' ? 'operator' : 'dashboard', ...(reasonCode ? { reasonCode } : {}) })
  }
  add('workspace.browse', options.projections, true, false)
  add('executor-invites.manage', true, manager, manager)
  add('members.manage', !options.dedicated, manager, manager, 'organization', options.dedicated ? 'dedicated_single_owner' : undefined)
  add('ownership.transfer', !options.dedicated, role === 'owner', role === 'owner', 'organization', options.dedicated ? 'dedicated_single_owner' : undefined)
  for (const id of ['policies.read', 'usage.read', 'sessions.read', 'audit.read', 'storage.read', 'diagnostics.read']) add(id, true, manager, false)
  add('attachment-policy.configure', true, manager, manager)
  add('retention-policy.configure', true, manager, manager)
  add('service-accounts.manage', options.serviceAccounts, manager, manager)
  add('webhooks.configure', !options.dedicated && options.webhooks === true, manager, manager, 'organization',
    options.dedicated ? 'dedicated_webhook_delivery_unsupported' : options.webhooks ? undefined : 'webhook_management_not_installed')
  if (options.dedicated) {
    add('services.read', true, role === 'owner', false, 'deployment')
    add('silo.open', true, role === 'owner', false, 'deployment', options.silo ? undefined : 'console_not_enabled')
    add('consoles.open', options.consoles, role === 'owner', false, 'deployment')
  }
  return { product: options.dedicated ? 'dedicated' : 'private-cloud', organizationId: access.organization.id, capabilities: entries }
}
