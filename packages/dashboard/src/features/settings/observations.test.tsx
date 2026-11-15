import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import type { AttachedExecutor } from '@agent-kernel/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { OrganizationTask } from './OrganizationTask.js'
import { WorkspaceOverview } from './WorkspaceOverview.js'
import { ConfigurationApplication } from './ConfigurationApplication.js'
import { SettingsRequestContext } from './configuration-request.js'
import { RuntimeSection } from './sections/RuntimeSection.js'
import { NotificationsSection } from './sections/NotificationsSection.js'
import { i18n } from '../../i18n/index.js'
import { writeTextToClipboard } from '../../lib/clipboard.js'

vi.mock('../../lib/clipboard.js', () => ({ writeTextToClipboard: vi.fn(async () => {}) }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const executor: AttachedExecutor = { executorId: 'native-one', workspaceId: 'ws_one', workspaceName: 'Native workspace',
  tools: [], runtime: 'node', runtimeVersion: '1', attachedAt: '2026-01-01' }
function mount(element: JSX.Element): void {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider>)
}
const pool = { id: 'pool-one', name: 'Actual pool', mode: 'workspace', workspaceId: 'ws_one', revision: '7' }
const registration = (id: string, nativeExecutorId: string, workspaceId: string) => ({
  id, name: id, poolId: 'pool-one', nativeExecutorId, workspaceId, status: 'active', lastSeenAt: '2026-01-01',
})

it('retains paged registry records and only labels the exact Native device/workspace pair connected', async () => {
  const request = vi.fn(async (path: string) => Response.json(path.includes('cursor=next')
    ? { executorPools: [], executorRegistrations: [registration('second-device', 'native-other', 'ws_one'),
      registration('third-device', 'native-one', 'ws_other')] }
    : { executorPools: [pool], executorRegistrations: [registration('first-device', 'native-one', 'ws_one')], nextCursor: 'next' }))
  vi.stubGlobal('fetch', request)
  mount(<OrganizationTask section="executors" cacheNamespace="one" organizationId="org_one" role="owner"
    executors={[executor]} onWorkspace={() => {}} />)
  await screen.findByRole('heading', { name: 'first-device' })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('unifiedSettings.loadMore') }))
  await screen.findByRole('heading', { name: 'second-device' })
  expect(screen.getByRole('heading', { name: 'Actual pool' })).toBeTruthy()
  expect(within(screen.getByRole('heading', { name: 'first-device' }).closest('li')!).getByText(i18n.t('unifiedSettings.workspaceUi.observed'))).toBeTruthy()
  for (const id of ['second-device', 'third-device']) {
    expect(within(screen.getByRole('heading', { name: id }).closest('li')!).getByText(i18n.t('unifiedSettings.workspaceUi.notObserved'))).toBeTruthy()
  }
  expect(request.mock.calls.some(([path]) => path.includes('cursor=next'))).toBe(true)
})

it('does not request the manager-only registry for a viewer browsing scoped workspaces', async () => {
  const request = vi.fn(async () => Response.json({ workspaces: [{ id: 'ws_one', name: 'Registered workspace', status: 'active' }] }))
  vi.stubGlobal('fetch', request)
  mount(<OrganizationTask section="workspaces" cacheNamespace="one" organizationId="org_one" role="viewer"
    executors={[executor]} onWorkspace={() => {}} />)
  await screen.findByText('Registered workspace')
  expect(request.mock.calls).toHaveLength(1)
  expect(screen.queryByText(i18n.t('unifiedSettings.executorRegistry'))).toBeNull()
  expect(screen.queryByTestId('settings-pool-list')).toBeNull()
})

it('groups workspace observations once, copies diagnostics without tiny disclosures and preserves exact navigation', async () => {
  const navigate = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ workspaces: [{ id: 'ws_one', name: 'Registered workspace', status: 'active' }] })))
  mount(<OrganizationTask section="workspaces" cacheNamespace="one" organizationId="org_one" role="viewer"
    executors={[executor, { ...executor, executorId: 'native-two' }]} onWorkspace={navigate} />)
  const name = await screen.findByRole('button', { name: 'Registered workspace' })
  expect(screen.getByTestId('settings-workspace-list').querySelectorAll('li')).toHaveLength(1)
  expect(screen.queryByText(i18n.t('unifiedSettings.registryNotLiveness'))).toBeNull()
  for (const id of ['ws_one', 'native-one', 'native-two']) expect(screen.queryByText(id)).toBeNull()
  expect(screen.getByTestId('settings-workspace-list').querySelector('details')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('unifiedSettings.copyDiagnostics') }))
  expect(writeTextToClipboard).toHaveBeenLastCalledWith(JSON.stringify([{
    id: 'ws_one', name: 'Registered workspace', status: 'active', executorIds: ['native-one', 'native-two'],
  }], null, 2))
  fireEvent.click(name)
  expect(navigate).toHaveBeenCalledExactlyOnceWith('ws_one')
})

it('rejects a foreign workspace row rather than projecting it as the selected identity', async () => {
  const request = vi.fn(async () => Response.json({ workspaces: [{ id: 'ws_foreign', name: 'Foreign title', status: 'active' }] }))
  vi.stubGlobal('fetch', request)
  mount(<WorkspaceOverview workspaceId="ws_one" organizationId="org_one" executor={executor} cacheNamespace="one" />)
  await screen.findByRole('alert')
  expect(screen.queryByText('Foreign title')).toBeNull()
  expect(request.mock.calls[0]?.[0]).toBe('/organization/settings-view?section=workspaces&workspaceId=ws_one')
})

it('does not manufacture a registry query for a Portable Native-only workspace', () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  mount(<WorkspaceOverview workspaceId="native-workspace" executor={{ ...executor, workspaceId: 'native-workspace' }} cacheNamespace="portable-one" />)
  expect(request).not.toHaveBeenCalled()
  expect(screen.getByText(i18n.t('unifiedSettings.workspaceUi.observed'))).toBeTruthy()
})

it('labels desired and effective revisions while preserving the complete consumer and loaded-Session receipt in diagnostics', () => {
  const application: ComponentProps<typeof ConfigurationApplication>['application'] = {
    state: 'unknown', desiredRevision: '17', effectiveRevision: null, applyMode: 'next-turn', scope: 'unit',
    observations: [{ unitId: 'unit-one', replicaId: 'replica-two', generation: 'generation-new',
      revision: null, synchronization: 'disconnected', observedAt: '2026-01-01T00:00:00Z' }],
    sessionObservations: [{ sessionId: 'session-local', state: 'pending', desiredRevision: '17', effectiveRevision: '16', observedAt: null }],
  }
  mount(<ConfigurationApplication application={application} />)
  expect(screen.getByRole('status').textContent).toBe(i18n.t('unifiedSettings.configuration.application.unknown'))
  expect(screen.getByText(i18n.t('unifiedSettings.configurationSources.desired')).nextElementSibling?.textContent).toBe('17')
  expect(screen.getByText(i18n.t('unifiedSettings.configurationSources.effective')).nextElementSibling?.textContent).toBe('—')
  expect(screen.queryByText('session-local')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('unifiedSettings.copyDiagnostics') }))
  expect(writeTextToClipboard).toHaveBeenLastCalledWith(JSON.stringify(application, null, 2))
  expect(screen.queryByText(i18n.t('unifiedSettings.configuration.servingScope'))).toBeNull()
})

it('uses the captured target transport for actual lifecycle and personal Push controls rather than a mutable global fetch', async () => {
  const globalRequest = vi.fn()
  vi.stubGlobal('fetch', globalRequest)
  const request = vi.fn(async () => Response.json({ devices: [] }))
  mount(<SettingsRequestContext.Provider value={request}>
    <RuntimeSection payload={{ providers: [], defaultModel: '', hooks: [], runtimeManagement: 'local',
      runtime: { pid: 123, startedAt: '2026-01-01', current: null, last: null },
      mcp: { supported: false }, paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' } }} />
    <NotificationsSection />
  </SettingsRequestContext.Provider>)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.runtime.restartHost') }))
  await waitFor(() => expect(request).toHaveBeenCalledWith('/runtime/restart', expect.objectContaining({ method: 'POST' })))
  expect(request).toHaveBeenCalledWith(expect.stringMatching(/^\/push\/devices\?currentDeviceId=/u), expect.anything())
  expect(globalRequest).not.toHaveBeenCalled()
})
