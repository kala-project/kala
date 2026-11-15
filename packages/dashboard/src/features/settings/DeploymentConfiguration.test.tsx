import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { i18n } from '../../i18n/index.js'
import { DeploymentConfiguration } from './DeploymentConfiguration.js'

beforeEach(async () => { await i18n.changeLanguage('en') })
afterEach(cleanup)

it('keeps desired and actually observed local effective revisions distinct without manufacturing a consumer ACK', () => {
  render(<DeploymentConfiguration sources={[{ id: 'models', sourceRef: 'portable.models-json', management: 'dashboard',
    revision: '7', effectiveRevision: '6', observedAt: '2026-01-01T00:00:00Z' },
  { id: 'agent', sourceRef: 'runtime.postgres-agent-settings', management: 'dashboard',
    revision: '3', effectiveRevision: null, observedAt: '2026-01-01T00:00:00Z' }]} />)
  const [models, agent] = screen.getAllByRole('article')
  expect(within(models!).getByText('7')).toBeTruthy()
  expect(within(models!).getByText('6')).toBeTruthy()
  expect(within(agent!).getByText('Not observed')).toBeTruthy()
  expect(screen.queryByText('Applied at the observed scope.')).toBeNull()
})

it('shows only allowlisted protected maintenance guidance, never an arbitrary command or executable link', () => {
  const { container } = render(<DeploymentConfiguration sources={[{ id: 'agent', sourceRef: '<script>untrusted</script>',
    management: 'dashboard', revision: '3', effectiveRevision: null, observedAt: '2026-01-01T00:00:00Z',
    maintenance: 'portable-agent-import' }]} />)
  expect(container.querySelector('script,a,input')).toBeNull()
  expect(screen.queryByText(i18n.t('unifiedSettings.configurationSources.description'))).toBeNull()
  expect(screen.getByText('<script>untrusted</script>')).toBeTruthy()
  expect(screen.queryByText('kala-settings-file import --resource agent --input <protected-file>')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Maintenance' }))
  expect(within(screen.getByRole('dialog')).getByText('kala-settings-file import --resource agent --input <protected-file>')).toBeTruthy()
  expect(within(screen.getByRole('dialog')).getByText(/JSON imports require stopping the owning process/u)).toBeTruthy()
})

it('does not present absent source observations as a configured or effective installation', () => {
  render(<DeploymentConfiguration />)
  expect(screen.getByRole('status').textContent).toContain('did not provide')
  expect(screen.queryByRole('article')).toBeNull()
})
