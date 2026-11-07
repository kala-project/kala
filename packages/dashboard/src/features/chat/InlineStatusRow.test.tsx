import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CompactFeedbackRow, InlineStatusRow, formatElapsedDuration, formatTokensShort } from './InlineStatusRow.js'

describe('agent activity card', () => {
  const state = { sessionId: 's', status: 'thinking' as const, messages: [], pendingCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, cursor: 0, approvalMode: 'auto' as const }

  it('uses Intention as the primary copy and expresses prior success visually', () => {
    render(<InlineStatusRow state={state} streamingActive={false} toolExecutionStartedAt={Date.now() - 2_000} progress={{ phase: 'thinking', label: 'Inspect the real activity component.', intention: 'Inspect the real activity component.', outcome: 'succeeded', callId: 'c1' }} />)
    expect(screen.getByTestId('inline-status-label').textContent).toContain('Inspect the real activity component.')
    expect(screen.getByLabelText('Succeeded')).toBeTruthy()
    expect(screen.getByTestId('inline-status-thinking').className).toContain('w-fit')
    expect(screen.queryByTestId('inline-status-intention')).toBeNull()
    expect(screen.getByTestId('inline-status-thinking').textContent).not.toContain('In progress')
    expect(screen.getByTestId('inline-status-thinking').textContent).not.toContain('Previous step completed')
  })

  it('restores working after A → B → A while A has stale cached idle state but a running summary', () => {
    const cachedIdle = { ...state, status: 'idle' as const }
    const { rerender } = render(<InlineStatusRow state={cachedIdle} fallbackStatus="idle" streamingActive={false} hydrated />)
    expect(screen.queryByTestId('inline-status-thinking')).toBeNull()
    // The switch clears the optimistic acknowledgement; A's new ready payload
    // has not arrived yet, but the authoritative control summary is thinking.
    rerender(<InlineStatusRow state={cachedIdle} fallbackStatus="thinking" streamingActive={false} hydrated={false} />)
    expect(screen.getByTestId('inline-status-thinking')).toBeTruthy()
    rerender(<InlineStatusRow state={{ ...state, status: 'thinking' }} fallbackStatus="thinking" streamingActive={false} hydrated />)
    expect(screen.getByTestId('inline-status-thinking')).toBeTruthy()
    rerender(<InlineStatusRow state={{ ...state, status: 'done' }} fallbackStatus="done" streamingActive={false} hydrated />)
    expect(screen.queryByTestId('inline-status-thinking')).toBeNull()
  })

  it('shows only Thinking when no persisted Tool intention exists', () => {
    render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Thinking' }} />)
    expect(screen.getByTestId('inline-status-label').textContent).toContain('Thinking')
    expect(screen.queryByTestId('inline-status-intention')).toBeNull()
  })

  it('stops showing optimistic activity when the turn fails', () => {
    const { rerender } = render(<InlineStatusRow state={{ ...state, status: 'idle' }} awaitingAck streamingActive={false} />)
    expect(screen.getByTestId('inline-status-thinking')).toBeTruthy()
    rerender(<InlineStatusRow state={{ ...state, status: 'error' }} awaitingAck streamingActive={false}
      progress={{ phase: 'error', label: 'Message failed. Check the error before retrying.' }} />)
    expect(screen.queryByTestId('inline-status-thinking')).toBeNull()
  })

  it('keeps breathing and authoritative elapsed feedback live and yields to streaming', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'))
    try {
      const startedAt = Date.now()
      const { rerender } = render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Thinking', startedAt }} />)
      const row = screen.getByTestId('inline-status-thinking')
      expect(row.getAttribute('role')).toBe('status')
      expect(row.getAttribute('aria-live')).toBe('polite')
      expect(screen.getByTestId('inline-status-label').classList.contains('ak-thinking-text')).toBe(true)
      expect(screen.getByTestId('inline-status-label').className).toContain('font-semibold')
      expect(screen.getByTestId('inline-status-elapsed').closest('.ak-thinking-text')).toBe(screen.getByTestId('inline-status-label'))
      expect(row.className).not.toContain('rounded-xl')
      expect(row.className).not.toContain('border')
      expect(row.className).toContain('text-ui')
      expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('0s')
      act(() => vi.advanceTimersByTime(2_100))
      expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('2s')
      rerender(<InlineStatusRow state={state} streamingActive progress={{ phase: 'thinking', label: 'Thinking', startedAt }} />)
      expect(screen.queryByTestId('inline-status-thinking')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues from the absolute turn start after remount instead of resetting to zero', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T12:00:12.000Z'))
    try {
      const progress = { phase: 'thinking' as const, label: 'Thinking', startedAt: Date.now() - 12_000 }
      const first = render(<InlineStatusRow state={state} streamingActive={false} progress={progress} />)
      expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('12s')
      first.unmount()
      render(<InlineStatusRow state={state} streamingActive={false} progress={progress} />)
      expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('12s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides elapsed time while the authoritative start is ahead of the browser clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'))
    try {
      render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Thinking', startedAt: Date.now() + 2_000 }} />)
      expect(screen.queryByTestId('inline-status-elapsed')).toBeNull()
      act(() => vi.advanceTimersByTime(2_100))
      expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('0s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides elapsed time for legacy activity without a trustworthy start', () => {
    render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Thinking' }} />)
    expect(screen.queryByTestId('inline-status-elapsed')).toBeNull()
  })

  it('expresses failure and approval without verbose lifecycle prefixes', () => {
    const { rerender } = render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Verify the change.', intention: 'Verify the change.', outcome: 'failed' }} />)
    expect(screen.getByLabelText('Failed')).toBeTruthy()
    expect(screen.getByTestId('inline-status-label').textContent).toContain('Verify the change.')
    rerender(<InlineStatusRow state={{ ...state, status: 'awaiting_approval' }} streamingActive={false} progress={{ phase: 'approval', label: 'Apply the requested patch.', intention: 'Apply the requested patch.', outcome: 'approval' }} />)
    expect(screen.getByLabelText('Approval needed')).toBeTruthy()
    expect(screen.getByTestId('inline-status-thinking').textContent).not.toContain('Awaiting approval')
  })

  it('keeps settled Tool duration fixed and omits approval timing without duration evidence', () => {
    const { rerender } = render(<InlineStatusRow state={state} streamingActive={false} progress={{ phase: 'thinking', label: 'Check the persisted result.', intention: 'Check the persisted result.', outcome: 'succeeded', durationMs: 2_400 }} />)
    expect(screen.getByTestId('inline-status-elapsed').textContent).toBe('2s')
    rerender(<InlineStatusRow state={{ ...state, status: 'awaiting_approval' }} streamingActive={false} progress={{ phase: 'approval', label: 'Approve the write.', intention: 'Approve the write.', outcome: 'approval' }} />)
    expect(screen.queryByTestId('inline-status-elapsed')).toBeNull()
  })

  it('formats elapsed activity time as seconds, minutes, and hours', () => {
    expect(formatElapsedDuration(59.9)).toBe('59s')
    expect(formatElapsedDuration(60)).toBe('1m 0s')
    expect(formatElapsedDuration(125)).toBe('2m 5s')
    expect(formatElapsedDuration(3_661)).toBe('1h 1m 1s')
  })
})

describe('compact context display', () => {
  it('keeps automatic compaction status concise', () => {
    render(<CompactFeedbackRow kind="running" trigger="auto" startedAt={Date.now()} tokensBefore={100_000} />)
    const row = screen.getByTestId('inline-compact-running')
    expect(row.textContent).toContain('Compacting conversation')
    expect(row.textContent).not.toContain('current tools and subagents continue')
    expect(screen.getByTestId('inline-compact-progress-label').classList.contains('ak-thinking-text')).toBe(true)
    expect(row.className).not.toContain('border')
    expect(row.querySelector('.animate-spin')).toBeNull()
  })

  it('labels the value as current context rather than cumulative token usage', () => {
    render(<CompactFeedbackRow kind="running" startedAt={Date.now()} tokensBefore={823_456} />)
    expect(screen.getByTestId('inline-compact-running').textContent).toContain('context 823.5k tokens')
    expect(screen.getByTestId('inline-compact-running').textContent).not.toContain('↑')
    expect(screen.getByTestId('inline-compact-running').textContent).not.toContain('↳')
  })

  it('formats only genuinely million-sized snapshots as millions', () => {
    expect(formatTokensShort(999_999)).toBe('1000.0k tokens')
    expect(formatTokensShort(1_100_000)).toBe('1.1m tokens')
  })
})
