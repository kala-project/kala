import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecuritySection } from './SecuritySection.js'

function settings(required = false): ServerSettingsPayload {
  return {
    providers: [], defaultModel: '', hooks: [],
    desktopAccess: { manualAuthorizationRequired: required },
    agentPrompt: {
      selectedSlotId: 'slot-1', configPath: 'postgres:organization/test/agent-prompt',
      slots: [
        { id: 'slot-1', name: 'Default', prompt: 'Keep my prompt' },
        { id: 'slot-2', name: 'Second', prompt: 'Second' },
        { id: 'slot-3', name: 'Third', prompt: 'Third' },
      ],
    },
    paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
    mcp: { supported: false, note: '' },
  }
}

describe('desktop authorization settings', () => {
  it('keeps preview opt-in separate when enabling Computer Use', async () => {
    const initial = { ...settings(), desktopAccess: { manualAuthorizationRequired: false, computerUseEnabled: false, desktopPreviewEnabled: false } }
    const next = { ...initial, desktopAccess: { ...initial.desktopAccess, computerUseEnabled: true } }
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => next })
    const changed = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<QueryClientProvider client={new QueryClient()}><SecuritySection payload={initial} onPayloadChange={changed} /></QueryClientProvider>)
    expect(screen.getByTestId('settings-desktop-preview').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('settings-computer-use'))
    await waitFor(() => expect(changed).toHaveBeenCalledWith(next))
    expect(fetch).toHaveBeenCalledWith('/settings/desktop-access', expect.objectContaining({
      body: JSON.stringify({ manualAuthorizationRequired: false, computerUseEnabled: true }),
    }))
    expect(next.desktopAccess.desktopPreviewEnabled).toBe(false)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the current default and saves only the desktop policy, not prompt slots', async () => {
    const onPayloadChange = vi.fn()
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => settings(true) })
    vi.stubGlobal('fetch', fetch)
    render(<QueryClientProvider client={new QueryClient()}>
      <SecuritySection payload={settings()} onPayloadChange={onPayloadChange} />
    </QueryClientProvider>)
    const toggle = screen.getByTestId('settings-desktop-manual-authorization')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(onPayloadChange).toHaveBeenCalledWith(settings(true)))
    expect(fetch).toHaveBeenCalledWith('/settings/desktop-access', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ manualAuthorizationRequired: true }),
    }))
  })

  it('does not show an unsuccessful save as enabled', async () => {
    const onPayloadChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'administrator required' }),
    }))
    render(<QueryClientProvider client={new QueryClient()}>
      <SecuritySection payload={settings()} onPayloadChange={onPayloadChange} />
    </QueryClientProvider>)
    fireEvent.click(screen.getByTestId('settings-desktop-manual-authorization'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(onPayloadChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('settings-desktop-manual-authorization').getAttribute('aria-checked')).toBe('false')
  })
})
