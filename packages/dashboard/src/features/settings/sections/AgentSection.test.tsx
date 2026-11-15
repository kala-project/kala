import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ServerSettingsPayload } from '@agent-kernel/shared'

import { AgentSection } from './AgentSection.js'

function settings(path: string, prompt: string): ServerSettingsPayload {
  return {
    providers: [], defaultModel: '', hooks: [],
    agentPrompt: {
      selectedSlotId: 'slot-1',
      configPath: path,
      slots: [
        { id: 'slot-1', name: 'Default', prompt },
        { id: 'slot-2', name: 'Second', prompt: 'Second prompt' },
        { id: 'slot-3', name: 'Third', prompt: 'Third prompt' },
      ],
    },
  } as ServerSettingsPayload
}

describe('organization-scoped agent prompt drafts', () => {
  it('lets authorized readers inspect every slot without offering configuration writes', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const dirty = vi.fn()
    const queryClient = new QueryClient()
    const view = render(<QueryClientProvider client={queryClient}>
      <AgentSection payload={settings('/org-a/agent.json', 'Original')} readOnly onDirtyChange={dirty} onPayloadChange={vi.fn()} />
    </QueryClientProvider>)
    try {
      fireEvent.click(screen.getByTestId('settings-agent-edit-slot-2'))
      const prompt = screen.getByTestId('settings-agent-slot-prompt') as HTMLTextAreaElement
      expect(prompt.value).toBe('Second prompt')
      expect(prompt.readOnly).toBe(true)
      fireEvent.change(prompt, { target: { value: 'Not permitted' } })
      fireEvent.click(screen.getByTestId('settings-agent-default-slot-2'))
      fireEvent.click(screen.getByTestId('settings-agent-slot-save'))
      expect((screen.getByTestId('settings-agent-slot-save') as HTMLButtonElement).disabled).toBe(true)
      expect(dirty).not.toHaveBeenCalledWith(true)
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore(); view.unmount(); queryClient.clear() }
  })

  it('discards unsaved content immediately when switching organizations', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onPayloadChange = vi.fn()
    const a = settings('/org-a/agent.json', 'Organization A private prompt')
    const b = settings('/org-b/agent.json', 'Organization B prompt')
    const renderSection = (payload: ServerSettingsPayload) => (
      <QueryClientProvider client={queryClient}>
        <AgentSection payload={payload} onPayloadChange={onPayloadChange} />
      </QueryClientProvider>
    )
    const { rerender } = render(renderSection(a))
    fireEvent.change(screen.getByTestId('settings-agent-slot-prompt'), {
      target: { value: 'Unsaved A private prompt' },
    })
    rerender(renderSection(b))
    expect((screen.getByTestId('settings-agent-slot-prompt') as HTMLTextAreaElement).value).toBe('Organization B prompt')
    expect(screen.queryByText('Unsaved A private prompt')).toBeNull()
    expect((screen.getByTestId('settings-agent-slot-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('distinguishes saved settings awaiting session synchronization from a real failed save', async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const saved of [true, false]) {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const onPayloadChange = vi.fn()
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          json: async () => saved
            ? { error: 'Sessions pending retry', settingsSaved: true }
            : { error: 'Host not writable' },
        })
        const view = render(<QueryClientProvider client={queryClient}>
          <AgentSection payload={settings('/org-a/agent.json', 'Original')} onPayloadChange={onPayloadChange} />
        </QueryClientProvider>)
        fireEvent.change(screen.getByTestId('settings-agent-slot-prompt'), { target: { value: 'Updated prompt' } })
        fireEvent.click(screen.getByTestId('settings-agent-slot-save'))
        if (saved) {
          await waitFor(() => expect(onPayloadChange).toHaveBeenCalledOnce())
          expect(onPayloadChange.mock.calls[0]?.[0]?.agentPrompt?.slots[0]?.prompt).toBe('Updated prompt')
          expect(screen.getByTestId('settings-agent-save-feedback').textContent).toMatch(/savedPending|saved|保存/)
          expect((screen.getByTestId('settings-agent-slot-save') as HTMLButtonElement).disabled).toBe(true)
        } else {
          await waitFor(() => expect(screen.getByTestId('settings-agent-save-feedback').textContent).toMatch(/saveFailed|Could not save|无法保存/))
          expect(onPayloadChange).not.toHaveBeenCalled()
          expect((screen.getByTestId('settings-agent-slot-save') as HTMLButtonElement).disabled).toBe(false)
        }
        view.unmount()
        queryClient.clear()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
