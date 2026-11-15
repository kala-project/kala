import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n/index.js'
import { IntegrationStatus } from './IntegrationStatus.js'
import { SettingsRequestContext } from './configuration-request.js'
import { writeTextToClipboard } from '../../lib/clipboard.js'

vi.mock('../../lib/clipboard.js', () => ({ writeTextToClipboard: vi.fn(async () => {}) }))

beforeEach(async () => { await i18n.changeLanguage('en') })
afterEach(cleanup)
const status = (component: 'runtime' | 'gateway') => ({
  component, id: 'telemetry', configured: true, health: 'unknown', sourceRef: `${component}-telemetry-adapter`,
  observedAt: '2026-01-01T00:00:00Z',
})

it('keeps installed configuration distinct from observed health and reads only the selected target context', async () => {
  const request = vi.fn(async (path: string) => Response.json({
    organizationId: 'org-a', integrationStatus: [status(path.startsWith('/organization/') ? 'gateway' : 'runtime')],
  }))
  render(<QueryClientProvider client={new QueryClient()}><SettingsRequestContext.Provider value={request}>
    <IntegrationStatus cacheNamespace="target-a" organizationId="org-a" hosted />
  </SettingsRequestContext.Provider></QueryClientProvider>)
  await screen.findByText('gateway')
  expect(screen.getAllByText('Configured')).toHaveLength(2)
  expect(screen.getAllByText('Health unknown')).toHaveLength(2)
  expect(screen.getAllByText('Configuration')).toHaveLength(2)
  expect(screen.getAllByText('Health')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
  expect(writeTextToClipboard).toHaveBeenLastCalledWith(JSON.stringify([status('runtime'), status('gateway')], null, 2))
  expect(request.mock.calls.map(([path]) => path).sort()).toEqual(['/organization/settings/integrations', '/settings/sections/integrations'])
})

it('does not render a different authenticated organization receipt as this target’s configured status', async () => {
  const request = vi.fn(async (path: string) => Response.json({
    organizationId: 'org-b', integrationStatus: [status(path.startsWith('/organization/') ? 'gateway' : 'runtime')],
  }))
  render(<QueryClientProvider client={new QueryClient()}><SettingsRequestContext.Provider value={request}>
    <IntegrationStatus cacheNamespace="target-a" organizationId="org-a" hosted />
  </SettingsRequestContext.Provider></QueryClientProvider>)
  await screen.findByRole('alert')
  expect(screen.queryByText('Configured · Health unknown')).toBeNull()
})
