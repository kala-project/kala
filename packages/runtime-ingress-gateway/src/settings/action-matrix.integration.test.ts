import { describe, expect, it } from 'vitest'
import { runtimeSettingsCapabilities } from '../../../host/src/http/settings-capabilities.js'
import { organizationSettingsCapabilities } from '../organizations/settings-capabilities.js'
import type { OrganizationAccess } from '../organizations/store.js'
import { capabilityById, mergeSettingsCapabilities, routeCapability, SETTINGS_NAVIGATION } from '../../../dashboard/src/features/settings/navigation.js'
import { parseSettingsRoute } from '../../../dashboard/src/features/settings/routes.js'

type Action = { id: string; path?: string; capability?: string; write?: 'manager' | 'models' | 'webhook' | 'private-manager'; source?: 'device' | 'account' | 'session' | 'operator' }
const actions: readonly Action[] = [
  ...['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08'].map(id => ({ id, path: 'personal/interface', source: 'device' as const })),
  { id: 'P09', path: 'personal/notifications', source: 'device' }, { id: 'P10', path: 'personal/notifications', source: 'device' },
  { id: 'P11', path: 'personal/connection', source: 'device' }, { id: 'P12', path: 'personal/connection', source: 'device' },
  { id: 'P13', path: 'personal/account', source: 'account' }, { id: 'P14', path: 'personal/account', source: 'account' },
  ...['A01', 'A02', 'A03'].map(id => ({ id, path: 'organization/models/providers', capability: 'models.configure', write: 'models' as const })),
  { id: 'A04', path: 'organization/models/prompts', capability: 'agent.configure', write: 'manager' },
  { id: 'A05', path: 'organization/policies/execution', capability: 'execution-policy.configure', write: 'manager' },
  { id: 'A06', path: 'organization/workspaces/ws_fixture/mcp', capability: 'mcp.configure', write: 'manager' },
  { id: 'A07', path: 'organization/integrations/search', capability: 'search.configure', write: 'manager' },
  { id: 'A08', path: 'organization/integrations/speech', capability: 'speech.configure', write: 'manager' },
  { id: 'A09', path: 'organization/integrations/hooks', capability: 'hooks.read' },
  { id: 'A10', path: 'organization/integrations/skills', capability: 'skills.read' },
  { id: 'A11', path: 'organization/models/engines', capability: 'engines.read' },
  { id: 'W01', path: 'organization/workspaces', capability: 'workspace.browse' },
  ...['W02', 'W03', 'W04'].map(id => ({ id, path: 'organization/workspaces/ws_fixture/access', capability: 'executor-invites.manage', write: 'manager' as const })),
  ...['S01', 'S02', 'S03', 'S04'].map(id => ({ id, source: 'session' as const })),
  { id: 'T01', path: 'organization/members', capability: 'members.manage', write: 'private-manager' },
  { id: 'T02', path: 'organization/policies/attachments', capability: 'attachment-policy.configure', write: 'manager' },
  { id: 'T03', path: 'organization/policies/retention', capability: 'retention-policy.configure', write: 'manager' },
  { id: 'T04', path: 'organization/policies/retention', capability: 'policies.read' },
  { id: 'T05', path: 'organization/access/usage', capability: 'usage.read' },
  { id: 'T06', path: 'organization/access/storage', capability: 'storage.read' },
  { id: 'T07', path: 'organization/access/storage', capability: 'storage.read' },
  { id: 'T08', path: 'organization/access/service-accounts', capability: 'service-accounts.manage', write: 'manager' },
  { id: 'T09', path: 'organization/integrations/webhooks', capability: 'webhooks.configure', write: 'webhook' },
  { id: 'T10', path: 'organization/access/audit', capability: 'audit.read' },
  { id: 'D01', path: 'organization/diagnostics', capability: 'diagnostics.read' },
  { id: 'D02', path: 'organization/diagnostics', capability: 'diagnostics.read' },
  { id: 'D03', path: 'deployment/services', capability: 'services.read' },
  { id: 'D04', path: 'deployment/consoles', capability: 'consoles.open' },
  ...['O01', 'O02', 'O03', 'O04'].map(id => ({ id, source: 'operator' as const })),
]

const originalEntries: readonly [string, readonly string[]][] = [
  ['interface', ['personal/interface']], ['notifications', ['personal/notifications']], ['connection', ['personal/connection']],
  ['models', ['organization/models/providers']], ['executorAccess', ['organization/workspaces/ws_fixture/access']],
  ['management', ['deployment/storage', 'deployment/consoles']], ['mcp', ['organization/workspaces/ws_fixture/mcp']],
  ['agent', ['organization/models/prompts']], ['webSearch', ['organization/integrations/search']],
  ['speech', ['organization/integrations/speech']], ['security', ['organization/policies/execution', 'personal/account']],
  ['socketAdmin', ['organization/diagnostics']], ['hooks', ['organization/integrations/hooks']],
  ['runtime', ['organization/models/engines', 'deployment/services']], ['storage', ['organization/access/storage']],
  ['deployment', ['deployment/services']],
  ['Admin Overview', ['organization/access/usage']], ['Admin Members', ['organization/members']],
  ['Admin Workspaces', ['organization/workspaces']], ['Admin Executors', ['organization/workspaces']],
  ['Admin Policies', ['organization/policies/attachments', 'organization/policies/retention']],
  ['Admin Usage/security', ['organization/access/usage', 'organization/access/sessions', 'organization/access/audit']],
  ['Admin Integrations', ['organization/integrations/search', 'organization/integrations/speech', 'organization/integrations/hooks']],
]

it.each(originalEntries)('preserves the original entry %s through real product capability and hash/navigation producers', (_name, destinations) => {
  for (const path of destinations) {
    expect(parseSettingsRoute(`#/settings/${path}`)).toMatchObject({ kind: 'page', path })
    const product = path === 'organization/members' ? 'private-cloud' : 'dedicated'
    const role = 'owner' as const
    const runtime = runtimeSettingsCapabilities({ product,
      actor: { kind: 'ingress', principal: 'fixture', organizationId: 'org_matrix', role },
      projectedReads: true, models: true, agent: true, execution: true, search: true, speech: true })
    const gateway = organizationSettingsCapabilities({
      organization: { id: 'org_matrix', name: 'Fictional', unitId: 'matrix', status: 'active', createdAt: '' },
      membership: { organizationId: 'org_matrix', role, createdAt: '', identity: { issuer: 'fixture', subject: role } },
    }, { dedicated: product === 'dedicated', projections: true, serviceAccounts: true, silo: true, consoles: true })
    const capability = routeCapability(path)
    if (capability) expect(capabilityById(mergeSettingsCapabilities(product, runtime, gateway), capability)?.canRead, path).toBe(true)
    expect(SETTINGS_NAVIGATION.some(item => (!item.products || item.products.includes(product))
      && (path === item.path || path.startsWith(item.path.replace(/\/(?:providers|search|execution|usage)$/u, '') + '/'))), path).toBe(true)
  }
})

describe.each(['portable', 'dedicated', 'private-cloud'] as const)('all51 Settings action/navigation authority: %s', product => {
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    for (const dashboardModels of [false, true]) {
      for (const webhooks of [false, true]) {
        it(`${role}, ${dashboardModels ? 'Dashboard' : 'Operator'} models, Webhooks ${webhooks}`, () => {
          const access: OrganizationAccess = { organization: { id: 'org_matrix', name: 'Fictional', unitId: 'matrix', status: 'active', createdAt: '' },
            membership: { organizationId: 'org_matrix', role, createdAt: '', identity: { issuer: 'fixture', subject: role } } }
          const actor = product === 'portable' ? { kind: 'token' as const }
            : { kind: 'ingress' as const, principal: 'fixture', organizationId: 'org_matrix', role }
          const runtime = runtimeSettingsCapabilities({ product, actor, projectedReads: true,
            models: dashboardModels, agent: true, execution: true, search: true, speech: true })
          const gateway = organizationSettingsCapabilities(access, { dedicated: product === 'dedicated',
            projections: true, serviceAccounts: true, silo: true, consoles: true, webhooks })
          const merged = mergeSettingsCapabilities(product, runtime, gateway)
          for (const action of actions) {
            if (!action.path) {
              // Session authority stays at its current Composer/detail; Operator writes never become browser-role privileges.
              expect(action.source === 'session' || action.source === 'operator', action.id).toBe(true)
              continue
            }
            expect(parseSettingsRoute(`#/settings/${action.path}`), action.id).toMatchObject({ kind: 'page', path: action.path })
            if (action.source) {
              expect(routeCapability(action.path), action.id).toBeUndefined()
              continue
            }
            const route = routeCapability(action.path)!
            const cap = capabilityById(merged, action.capability!)
            const native = product === 'portable' || role === 'owner' || role === 'admin'
            const unsupported = product === 'private-cloud' && action.path.startsWith('deployment/')
              || product !== 'private-cloud' && action.capability === 'members.manage'
              || product === 'portable' && ['policies.read', 'usage.read', 'audit.read', 'attachment-policy.configure', 'retention-policy.configure', 'service-accounts.manage', 'webhooks.configure'].includes(action.capability!)
              || action.id === 'T09' && (product !== 'private-cloud' || !webhooks)
            const write = !unsupported && !!action.write && native
              && (action.write !== 'models' || dashboardModels)
            expect(cap?.canWrite ?? false, `${action.id} write`).toBe(write)
            if (!unsupported && cap?.canRead) {
              expect(capabilityById(merged, route)?.canRead, `${action.id} route`).toBe(true)
              if (!action.path.startsWith('personal/')) {
                expect(SETTINGS_NAVIGATION.some(item => (!item.products || item.products.includes(product))
                  && (action.path === item.path || action.path!.startsWith(item.path.replace(/\/(?:providers|search|execution|usage)$/u, '') + '/'))), action.id).toBe(true)
              }
            }
          }
          expect(capabilityById(merged, 'ownership.transfer')?.canWrite ?? false).toBe(product === 'private-cloud' && role === 'owner')
          expect(capabilityById(merged, 'silo.open')?.canRead ?? false).toBe(product === 'dedicated' && role === 'owner')
        })
      }
    }
  }
})
