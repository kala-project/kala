import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TasksButton } from './TasksButton.js'

describe('TasksButton', () => {
  it('keeps long task content scrollable and wrapped inside the popover', () => {
    render(
      <TasksButton
        todos={[
          {
            status: 'in_progress',
            content: 'Investigate a very long task description with a-long-unbroken-token-that-must-not-disappear-at-the-end '.repeat(12),
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('tasks-button-trigger'))

    expect(screen.getByTestId('tasks-popover').textContent).toContain('a-long-unbroken-token')
    expect(screen.getByTestId('tasks-popover-scroll').querySelector('[data-radix-scroll-area-viewport]')).toBeTruthy()
    expect(screen.getByTestId('tasks-popover').className).toContain('max-h-[min(60dvh,28rem)]')
    expect(screen.getByTestId('tasks-popover').className).toContain('flex-col')
    expect(screen.getByTestId('tasks-popover').className).toContain('z-[70]')
    expect(screen.getByTestId('tasks-popover').className).toContain('text-popover-foreground')
    expect(screen.getByTestId('tasks-popover').parentElement).toBe(document.body)
    expect(screen.getByTestId('tasks-popover-scroll').className).toContain('min-h-0')
    expect(screen.getByTestId('tasks-popover-scroll').className).toContain('max-h-[calc(min(60dvh,28rem)-2.25rem)]')
    expect(screen.getByTestId('tasks-popover-scroll').className).toContain('touch-pan-y')
    expect(screen.getByTestId('tasks-popover-item').querySelector('span:last-child')?.className).toContain('[overflow-wrap:anywhere]')
  })
})
