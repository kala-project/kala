import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'
import type { SessionSummary } from '@agent-kernel/shared'

vi.mock('../../components/ui/select.js', async () => {
  const React = await import('react')
  type SelectContextValue = {
    value?: string
    onValueChange?(value: string): void
  }
  const SelectContext = React.createContext<SelectContextValue>({})
  return {
    Select: ({ value, onValueChange, children }: React.PropsWithChildren<SelectContextValue>) => React.createElement(
      SelectContext.Provider,
      { value: { value, onValueChange } },
      children,
    ),
    SelectTrigger: ({ children, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => React.createElement(
      'button',
      { type: 'button', ...props },
      children,
    ),
    SelectValue: () => {
      const ctx = React.useContext(SelectContext)
      return React.createElement('span', null, ctx.value)
    },
    SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
    SelectItem: ({ value, children }: React.PropsWithChildren<{ value: string }>) => {
      const ctx = React.useContext(SelectContext)
      return React.createElement(
        'button',
        { type: 'button', role: 'option', onClick: () => ctx.onValueChange?.(value) },
        children,
      )
    },
  }
})

import { SessionMetadataDialog, formatCompactNumber } from './SessionMetadataDialog.js'
import { governedSessionTaskCandidate } from '../../evaluation-integration.js'
import { saveFile } from '../../lib/save-file.js'
import * as desktop from '../../lib/desktop-bridge.js'
import { notify } from '../../notify.js'

vi.mock('../../lib/save-file.js', () => ({ saveFile: vi.fn(async () => 'downloaded') }))

const baseState: AgentState = {
  status: 'idle',
  messages: [],
  pendingCalls: [],
  usage: {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  approvalMode: 'auto',
  cwd: '/tmp/current',
}

const baseSummary: SessionSummary = {
  sessionId: '01JXXXXXXXXXXXXXXXXXXXXX',
  agentRuntime: 'kernel',
  createdAt: '2026-07-01T00:00:00.000Z',
  lastEventAt: '2026-07-05T00:00:00.000Z',
  eventCount: 12,
  workspaceId: 'ws-1',
  workspaceName: 'my-mbp',
  currentCwd: '/tmp/current',
  firstUserMessage: 'hello',
  label: 'my session',
}

describe('SessionMetadataDialog', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    history.replaceState({}, '', '/')
    if (!HTMLElement.prototype.hasPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
        configurable: true,
        value: () => false,
      })
    }
  })

  it('copies a bounded desktop link without credentials and reports clipboard failures', async () => {
    vi.spyOn(desktop, 'getDesktopBridge').mockReturnValue({
      version: 1,
      getInfo: async () => ({ version: '0.2.0-rc.5', focused: true, visible: true }),
      setActivity: async () => {},
      notify: async () => {},
      subscribe: () => () => {},
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const success = vi.spyOn(notify, 'success').mockImplementation(() => {})
    const failure = vi.spyOn(notify, 'error').mockImplementation(() => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      history.replaceState({}, '', '/?token=private&sessionId=other')
      render(<SessionMetadataDialog open onOpenChange={() => {}} sessionId="fork.1:branch" state={baseState} selectedModel={null} onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
      fireEvent.click(screen.getByTestId('copy-desktop-session-link'))
      await waitFor(() => expect(success).toHaveBeenCalled())
      expect(writeText).toHaveBeenCalledWith('agent-runlab://session/fork.1:branch')
      writeText.mockRejectedValueOnce(new Error('Clipboard denied'))
      fireEvent.click(screen.getByTestId('copy-desktop-session-link'))
      await waitFor(() => expect(failure).toHaveBeenCalled())
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('exports a governed private reference and links only an explicit evaluation reference', async () => {
    history.replaceState({}, '', '/?evaluationSessionId=' + baseSummary.sessionId + '&evaluationRunId=run-one&evaluationDefectId=finding-one')
    render(<SessionMetadataDialog open onOpenChange={() => {}} sessionId={baseSummary.sessionId} summary={baseSummary} state={baseState} selectedModel="model-one" evaluationUrl="https://evaluation.example.test" onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
    fireEvent.click(screen.getByTestId('session-export-task-candidate'))
    expect(saveFile).toHaveBeenCalledOnce()
    const input = vi.mocked(saveFile).mock.calls[0]![0]
    expect(input).toMatchObject({
      suggestedName: `agent-eval-task-candidate-${baseSummary.sessionId}.json`,
      mimeType: 'application/json',
    })
    expect(input.blob).toBeInstanceOf(Blob)
    const candidate = governedSessionTaskCandidate(baseSummary.sessionId, baseSummary, 'model-one')
    expect(candidate).toMatchObject({ sourceClassification: 'private_workspace', publicTaskPack: false, candidateMetadata: { contentIncluded: false, workspacePathIncluded: false }, governance: { requiresExplicitOperatorReview: true, redactionStatus: 'not_reviewed', provenanceApprovalStatus: 'not_reviewed' } })
    expect(JSON.stringify(candidate)).not.toContain('/tmp/current')
    expect(screen.getByTestId('session-open-evaluation-reference').getAttribute('href')).toContain('/defects?runId=run-one&findingId=finding-one')
  })

  it('does not infer an evaluation link without an explicit session-scoped reference', () => {
    history.replaceState({}, '', '/?evaluationRunId=run-one')
    render(<SessionMetadataDialog open onOpenChange={() => {}} sessionId={baseSummary.sessionId} summary={baseSummary} state={baseState} selectedModel={null} onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
    expect(screen.queryByTestId('session-open-evaluation-reference')).toBeNull()
  })

  it('renders read-only summary fields', () => {
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel="claude-opus-4-7"
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )
    const dlg = screen.getByTestId('session-metadata-dialog')
    expect(screen.queryByTestId('copy-desktop-session-link')).toBeNull()
    expect(dlg.textContent).toContain(baseSummary.sessionId)
    expect(dlg.textContent).toContain('my-mbp')
    expect(dlg.textContent).toContain('claude-opus-4-7')
    expect(dlg.textContent).not.toContain('Current context')
    expect(screen.getByTestId('session-metadata-label').className).toContain('text-base')
    fireEvent.click(screen.getByTestId('session-info-statistics-tab'))
    expect(screen.getByTestId('session-statistics').textContent).toContain('1.2 K')
    expect(dlg.className).toContain('!top-[calc(var(--ak-viewport-offset-top,0px)+var(--ak-viewport-h,100dvh))]')
    expect(dlg.className).toContain('grid-rows-[auto_minmax(0,1fr)_auto]')
    expect(screen.getByTestId('session-metadata-body').className).toContain('overflow-y-auto')
    expect(screen.getByTestId('session-metadata-footer').className).toContain('border-t')
  })

  it('does not mislabel provider context occupancy as cumulative API input usage', () => {
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={{ ...baseSummary, agentRuntime: 'copilot' }}
        state={{ ...baseState, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } }}
        contextSnapshot={{
          model: { ref: 'gpt-5.6-sol', provider: 'github-copilot', id: 'gpt-5.6-sol' },
          contextWindow: { tokens: 272000, source: 'api_reported' },
          usage: { inputTokens: 137141, totalTokens: 137141 },
          breakdown: { system: 2000, transcript: 130000, tools: 5000, memory: 141, attachments: 0, pendingUserInput: 0 },
          estimator: {
            total: { kind: 'provider_reported', confidence: 'exact' },
            breakdown: { kind: 'heuristic', confidence: 'estimated' },
            version: 'copilot-sdk-usage-info-v1',
          },
          updatedAt: Date.now(),
        }}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('session-info-statistics-tab'))
    const dialog = screen.getByTestId('session-metadata-dialog')
    expect(dialog.textContent).toContain('Current context')
    expect(dialog.textContent).toContain('137.14 K')
    expect(dialog.textContent).toContain('Cumulative API usage')
    expect(dialog.textContent).toContain('IN0OUT0')
    expect(dialog.textContent).not.toContain('137,141 / 0')
  })

  it('shows the persisted agent runtime identity and version', () => {
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={{ ...baseSummary, agentRuntime: 'copilot', agentRuntimeVersion: '1.0.11' }}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )

    expect(screen.getByTestId('session-metadata-agent-runtime').textContent).toBe(
      'GitHub Copilot SDK (copilot) · v1.0.11',
    )
  })

  it('shows the current cwd as a read-only display next to a Change trigger', () => {
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )
    expect(screen.getByTestId('session-metadata-cwd').textContent).toContain(
      '/tmp/current',
    )
    // The cwd display is not an <input>: users go through the Change… button,
    // which opens the Finder-style picker.
    expect(
      screen.getByTestId('session-metadata-cwd').tagName.toLowerCase(),
    ).not.toBe('input')
    expect(screen.getByTestId('session-metadata-cwd-change')).toBeTruthy()
  })

  it('closes itself and opens the change-cwd dialog when Change is clicked', () => {
    const onOpenChange = vi.fn()
    const onOpenChangeCwdDialog = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={onOpenChange}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={onOpenChangeCwdDialog}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('session-metadata-cwd-change'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenChangeCwdDialog).toHaveBeenCalledTimes(1)
  })

  it('saves the trimmed label only when Save is clicked', () => {
    const onRename = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={onRename}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )
    const input = screen.getByTestId('session-metadata-label') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  renamed  ' } })
    fireEvent.blur(input)
    expect(onRename).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onRename).toHaveBeenCalledWith('renamed')
  })

  it('ignores empty label commits', () => {
    const onRename = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={{ ...baseSummary, label: undefined }}
        state={baseState}
        selectedModel={null}
        onRename={onRename}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )
    const labelInput = screen.getByTestId('session-metadata-label') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onRename).not.toHaveBeenCalled()
  })

  it('saves approval mode changes only when Save is clicked', () => {
    const onChangeApprovalMode = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={onChangeApprovalMode}
        onChangeToolCardMode={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('option', { name: 'Ask everything' }))
    expect(onChangeApprovalMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onChangeApprovalMode).toHaveBeenCalledWith('ask')
  })

  it('defaults Tool Card Mode to Dots and saves an explicit Standard choice', () => {
    const onChangeToolCardMode = vi.fn()
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={onChangeToolCardMode}
      />,
    )

    expect(screen.getByTestId('session-metadata-tool-card-mode').textContent).toContain('dots')
    fireEvent.click(screen.getByRole('option', { name: 'Standard' }))
    expect(onChangeToolCardMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('session-metadata-save'))
    expect(onChangeToolCardMode).toHaveBeenCalledWith('standard')
  })

  it('requires two confirmations before executing sub-agent detail cleanup', async () => {
    const emit = vi.fn((event: string, _payload: unknown, ack: (result: unknown) => void) => {
      if (event === 'client:get_session_storage') {
        ack({
          ok: true,
          value: {
            session: {
              sessionId: baseSummary.sessionId,
              directBytes: 100,
              treeBytes: 200,
              descendantCount: 1,
              categories: {},
              treeCategories: {},
            },
            descendants: [{
              sessionId: 'child-session',
              parentSessionId: baseSummary.sessionId,
              directBytes: 100,
              treeBytes: 150,
              descendantCount: 1,
              categories: {},
              treeCategories: {},
            }, {
              sessionId: 'second-child-session',
              parentSessionId: 'child-session',
              directBytes: 50,
              treeBytes: 50,
              descendantCount: 0,
              categories: {},
              treeCategories: {},
            }, {
              sessionId: 'sibling-session',
              parentSessionId: baseSummary.sessionId,
              directBytes: 25,
              treeBytes: 25,
              descendantCount: 0,
              categories: {},
              treeCategories: {},
            }],
            tokenUsage: {
              direct: {
                currentContextTokens: 500,
                cumulativeInputTokens: 1_200,
                cumulativeOutputTokens: 340,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                sessionCount: 1,
              },
              tree: {
                currentContextTokens: 800,
                cumulativeInputTokens: 1_900,
                cumulativeOutputTokens: 510,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                sessionCount: 2,
              },
            },
            state: { measuredAt: '2026-09-30T00:00:00.000Z', generation: 1, stale: false, scan: { status: 'idle' } },
          },
        })
      } else if (event === 'client:prepare_storage_cleanup') {
        ack({
          ok: true,
          value: {
            planId: '00000000-0000-4000-8000-000000000001',
            operation: 'subagent-details',
            targetId: (_payload as { targetId: string }).targetId,
            sessionIds: [(_payload as { targetId: string }).targetId],
            estimatedBytes: 100,
            itemCount: 4,
            expiresAt: '2026-09-30T00:05:00.000Z',
          },
        })
      } else if (event === 'client:execute_storage_cleanup') {
        ack({
          ok: true,
          value: {
            planId: '00000000-0000-4000-8000-000000000001',
            operation: 'subagent-details',
            targetId: 'child-session',
            logicalDeletion: true,
            bytesQuarantined: 100,
            completedAt: '2026-09-30T00:01:00.000Z',
          },
        })
      }
    })
    render(
      <SessionMetadataDialog
        open
        onOpenChange={() => {}}
        sessionId={baseSummary.sessionId}
        summary={baseSummary}
        state={baseState}
        selectedModel={null}
        storageSocket={{ emit } as never}
        onRename={() => {}}
        onOpenChangeCwdDialog={() => {}}
        onChangeApprovalMode={() => {}}
        onChangeToolCardMode={() => {}}
      />,
    )

    const dialog = await screen.findByTestId('session-metadata-dialog')
    fireEvent.click(screen.getByTestId('session-info-statistics-tab'))
    expect(dialog.textContent).toContain('All sessionsThis sessionCurrent context800500')
    expect(dialog.textContent).toContain('Cumulative API usageIN1.9 KOUT510IN1.2 KOUT340')
    fireEvent.click(screen.getByTestId('session-info-storage-tab'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all sub-agents' }))
    expect(screen.getByTestId('storage-selection-bar').textContent).toContain('3 selected')
    fireEvent.click(screen.getByRole('button', { name: 'Review cleanup…' }))
    await screen.findByTestId('storage-cleanup-confirmation')
    const prepareCalls = emit.mock.calls.filter(([event]) => event === 'client:prepare_storage_cleanup')
    expect(prepareCalls).toHaveLength(2)
    expect(prepareCalls.map(([, payload]) => (payload as { targetId: string }).targetId)).toEqual(['child-session', 'sibling-session'])
    fireEvent.click(await screen.findByTestId('storage-cleanup-first-confirm'))
    expect(emit.mock.calls.some(([event]) => event === 'client:execute_storage_cleanup')).toBe(false)
    fireEvent.click(screen.getByTestId('storage-cleanup-final-confirm'))
    await waitFor(() => expect(emit.mock.calls.filter(([event]) => event === 'client:execute_storage_cleanup')).toHaveLength(2))
  })

  it('formats compact K, M, and B values and toggles exact token counts', () => {
    expect(formatCompactNumber(1_200)).toBe('1.2 K')
    expect(formatCompactNumber(12_345)).toBe('12.35 K')
    expect(formatCompactNumber(1_250_000)).toBe('1.25 M')
    expect(formatCompactNumber(2_400_000_000)).toBe('2.4 B')
    render(<SessionMetadataDialog open onOpenChange={() => {}} sessionId={baseSummary.sessionId} summary={baseSummary} state={{ ...baseState, usage: { ...baseState.usage, inputTokens: 1_250_000, outputTokens: 12_345 } }} selectedModel={null} onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
    fireEvent.click(screen.getByTestId('session-info-statistics-tab'))
    expect(screen.getByTestId('session-statistics').textContent).toContain('IN1.25 M')
    expect(screen.getByTestId('session-statistics').textContent).toContain('OUT12.35 K')
    expect(screen.getAllByTestId('session-token-pair')).toHaveLength(1)
    expect(screen.getByTestId('session-statistics-grid').querySelectorAll('[data-testid="session-statistics-row"]').length).toBeGreaterThan(5)
    fireEvent.click(screen.getByTestId('session-statistics-number-exact'))
    expect(screen.getByTestId('session-statistics').textContent).toContain('IN1,250,000')
    expect(screen.getByTestId('session-statistics').textContent).toContain('OUT12,345')
  })

  it('distinguishes zero cost from unavailable cost', () => {
    const { rerender } = render(<SessionMetadataDialog open onOpenChange={() => {}} sessionId={baseSummary.sessionId} summary={{ ...baseSummary, costUsd: 0 }} state={baseState} selectedModel={null} onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
    fireEvent.click(screen.getByTestId('session-info-statistics-tab'))
    expect(screen.getByTestId('session-cost-value').textContent).toBe('$0.00')
    rerender(<SessionMetadataDialog open onOpenChange={() => {}} sessionId={baseSummary.sessionId} summary={{ ...baseSummary, costUsd: null }} state={baseState} selectedModel={null} onRename={() => {}} onOpenChangeCwdDialog={() => {}} onChangeApprovalMode={() => {}} onChangeToolCardMode={() => {}} />)
    expect(screen.getByTestId('session-cost-unavailable').textContent).toContain('did not report billable cost')
  })
})
