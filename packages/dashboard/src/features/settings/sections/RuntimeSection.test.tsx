import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { COPILOT_AGENT_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'
import { RuntimeSection } from './RuntimeSection.js'

const settings: ServerSettingsPayload = {
  providers: [], defaultModel: '', hooks: [], mcp: { supported: false },
  paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
}

describe('RuntimeSection', () => {
  it('shows externally managed Runtime status without unsupported restart controls', () => {
    render(<RuntimeSection payload={{
      ...settings,
      runtime: { pid: 123, startedAt: '2026-10-30T00:00:00Z', current: null, last: null },
      runtimeManagement: 'external',
      agentRuntimes: [{
        id: 'copilot', label: 'GitHub Copilot', description: '', available: false,
        status: 'unavailable', reason: 'Copilot CLI is not authenticated',
        capabilities: COPILOT_AGENT_RUNTIME_CAPABILITIES,
      }],
    }} />)
    expect(screen.getByText(/PID 123/)).toBeTruthy()
    expect(screen.getByText('Copilot CLI is not authenticated')).toBeTruthy()
    expect(screen.getByText('Backend service')).toBeTruthy()
    expect(screen.getByText('GitHub Copilot agent engine')).toBeTruthy()
    expect(screen.queryByText(/managed by the deployment operator/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Backend service' }))
    expect(screen.getByRole('tooltip').textContent).toContain('managed by the deployment operator')
    expect(screen.queryByRole('button', { name: /restart/i })).toBeNull()
  })

  it('explains missing status instead of rendering an empty section', () => {
    render(<RuntimeSection payload={settings} />)
    expect(screen.getByText('Runtime status is not available from this server.')).toBeTruthy()
  })

  it('explains an engine model source and opens the model catalog', () => {
    const onOpenModels = vi.fn()
    render(<RuntimeSection onOpenModels={onOpenModels} payload={{
      ...settings,
      agentRuntimes: [{
        id: 'copilot', label: 'GitHub Copilot', description: '', available: true, status: 'ready',
        capabilities: COPILOT_AGENT_RUNTIME_CAPABILITIES,
        models: [{ ref: 'copilot:test', id: 'test', label: 'Test', provider: 'GitHub Copilot', providerId: 'copilot' }],
      }],
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'About GitHub Copilot agent engine' }))
    expect(screen.getByRole('tooltip').textContent).toContain('not custom base URLs')
    fireEvent.click(screen.getByRole('button', { name: '1 available models' }))
    expect(onOpenModels).toHaveBeenCalledTimes(1)
  })
})
