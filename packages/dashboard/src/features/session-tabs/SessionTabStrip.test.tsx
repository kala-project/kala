import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@agent-kernel/shared'

import { PREF_HIDE_SUB_AGENT_SESSIONS } from '../../lib/prefs.js'
import { SessionTabStrip } from './SessionTabStrip.js'

const parent: SessionSummary = { sessionId: 'parent', createdAt: '2026-01-01T00:00:00Z', eventCount: 1, label: 'Parent' }
const child: SessionSummary = { ...parent, sessionId: 'child', parentSessionId: 'parent', label: 'Child' }
const callbacks = { onSelect() {}, onClose() {}, onPin() {}, onReorder() {} }

describe('SessionTabStrip', () => {
  beforeEach(() => localStorage.clear())

  it('uses spacing instead of vertical border dividers', () => {
    render(<SessionTabStrip sessions={[parent]} openIds={['parent']} pinned={[]} active="parent" {...callbacks} />)

    const strip = screen.getByTestId('session-tab-strip')
    expect(strip.querySelector('[data-radix-scroll-area-viewport] .gap-px')).toBeTruthy()
    expect(strip.querySelector('button')?.className).not.toContain('border-r')
  })

  it('hides child tabs by default but keeps the active child reachable', () => {
    const { rerender } = render(<SessionTabStrip sessions={[parent, child]} openIds={['parent', 'child']} pinned={[]} active="parent" {...callbacks} />)
    expect(screen.getByTestId('session-tab-strip').querySelectorAll('button')).toHaveLength(1)

    rerender(<SessionTabStrip sessions={[parent, child]} openIds={['parent', 'child']} pinned={[]} active="child" {...callbacks} />)
    expect(screen.getByTestId('session-tab-strip').querySelectorAll('button')).toHaveLength(2)

    localStorage.setItem(PREF_HIDE_SUB_AGENT_SESSIONS, '0')
    fireEvent(window, new StorageEvent('storage', { key: PREF_HIDE_SUB_AGENT_SESSIONS, newValue: '0' }))
    rerender(<SessionTabStrip sessions={[parent, child]} openIds={['parent', 'child']} pinned={[]} active="parent" {...callbacks} />)
    expect(screen.getByTestId('session-tab-strip').querySelectorAll('button')).toHaveLength(2)
  })
})
