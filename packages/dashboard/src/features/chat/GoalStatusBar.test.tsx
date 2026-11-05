import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SessionSummary } from '@agent-kernel/shared'

import { GoalStatusBar } from './GoalStatusBar.js'

const goal: NonNullable<SessionSummary['goal']> = {
  objective: 'Ship the feature',
  successCriteria: 'Focused tests pass',
  maxTurns: 12,
  turns: 2,
  status: 'active',
  lastTerminalCursor: 3,
}

describe('GoalStatusBar', () => {
  it('shows controls outside the composer and displays the persisted turn budget', () => {
    const onAction = vi.fn()
    render(<GoalStatusBar goal={goal} busy={false} onAction={onAction} />)
    expect(screen.getByTestId('goal-status').textContent).toContain('2 / 12 turns')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(onAction).toHaveBeenCalledWith('pause')
    fireEvent.click(screen.getByRole('button', { name: 'End Goal' }))
    expect(onAction).not.toHaveBeenCalledWith('cancel')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm end' }))
    expect(onAction).toHaveBeenCalledWith('cancel')
  })

  it('shows model completion as awaiting review, not verified success', () => {
    const onAction = vi.fn()
    const { rerender } = render(<GoalStatusBar goal={{ ...goal, status: 'completed', completionSource: 'model' }} busy={false} onAction={onAction} />)
    expect(screen.getByTestId('goal-status').textContent).toContain('review required')
    fireEvent.click(screen.getByRole('button', { name: 'Accept completion' }))
    expect(onAction).toHaveBeenCalledWith('complete')
    rerender(<GoalStatusBar goal={{ ...goal, status: 'completed', completionSource: 'user' }} busy={false} onAction={onAction} />)
    expect(screen.getByTestId('goal-status').textContent).toContain('confirmed by you')
    expect(screen.queryByRole('button', { name: 'Accept completion' })).toBeNull()
  })

  it('only offers resume for a paused Goal and no controls at the turn limit', () => {
    const onAction = vi.fn()
    const { rerender } = render(<GoalStatusBar goal={{ ...goal, status: 'paused' }} busy={false} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onAction).toHaveBeenCalledWith('resume')
    rerender(<GoalStatusBar goal={{ ...goal, status: 'budget_exhausted', turns: 12 }} busy={false} onAction={onAction} />)
    expect(screen.getByTestId('goal-status').textContent).toContain('Turn limit reached')
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })
})
