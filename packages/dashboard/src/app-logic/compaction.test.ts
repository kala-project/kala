import { describe, expect, it } from 'vitest'
import { COPILOT_RUNTIME_COMPACTION_POLICY, kernelRuntimeCompactionPolicy } from '@agent-kernel/shared'

import {
  compactFailureMessage,
  compactFeedbackStatus,
  compactReasonMessage,
  hasCompactableContent,
  isCompactTerminalEvent,
  isCompactionSuccess,
  shouldShowQueuedAutoCompact,
} from './compaction.js'

describe('hasCompactableContent', () => {
  it('is false for null / only a leading system message', () => {
    expect(hasCompactableContent(null)).toBe(false)
    expect(hasCompactableContent({ messages: [{ role: 'system' }] } as never)).toBe(false)
  })
  it('is true when there is any non-system-leading message', () => {
    expect(hasCompactableContent({ messages: [{ role: 'system' }, { role: 'user' }] } as never)).toBe(true)
    expect(hasCompactableContent({ messages: [{ role: 'user' }] } as never)).toBe(true)
  })
})

describe('Copilot compact feedback', () => {
  const running = { kind: 'running' as const, startedAt: 1, tokensBefore: 1200 }
  const error = { kind: 'error' as const, message: 'SDK resume failed' }
  const remote = { kind: 'running' as const, sessionId: 's', attemptId: 'new', trigger: 'manual' as const,
    startedAt: new Date().toISOString(), tokensBefore: 1200, authority: 'runtime' as const, scope: { kind: 'root' as const } }
  const marker = (attemptId: string, phase: 'running' | 'error') => ({
    kind: 'compact_progress' as const, attemptId, phase, trigger: 'manual' as const,
    tokensBefore: 1200, startedAt: remote.startedAt,
  })

  it('shows local progress before a server marker and ignores older attempts', () => {
    expect(compactFeedbackStatus(running, 'copilot', null, [])).toEqual(running)
    expect(compactFeedbackStatus(running, 'copilot', remote, [marker('old', 'running')])).toEqual(running)
    expect(compactFeedbackStatus(running, 'copilot', remote, [marker('new', 'running')])).toEqual({ kind: 'idle' })
  })

  it('shows pre-projection errors and lets the persisted error replace the transient row', () => {
    expect(compactFeedbackStatus(error, 'copilot', { ...remote, kind: 'error', message: error.message, endedAt: remote.startedAt }, [])).toEqual(error)
    expect(compactFeedbackStatus(error, 'copilot', { ...remote, kind: 'error', message: error.message, endedAt: remote.startedAt }, [marker('new', 'error')])).toEqual({ kind: 'idle' })
    expect(compactFeedbackStatus(error, 'kernel', remote, [marker('new', 'error')])).toEqual(error)
  })
})

describe('compaction event predicates', () => {
  it('detects terminal + success events', () => {
    expect(isCompactTerminalEvent('messages_replaced')).toBe(true)
    expect(isCompactTerminalEvent('event:appended')).toBe(false)
    expect(isCompactionSuccess({ kind: 'messages_replaced', reason: 'compaction' })).toBe(true)
    expect(isCompactionSuccess({ kind: 'messages_replaced', reason: 'other' })).toBe(false)
  })

  describe('auto-compaction queue visibility', () => {
    it('only predicts queued compaction for safe-boundary policies', () => {
      const kernel = kernelRuntimeCompactionPolicy()
      expect(shouldShowQueuedAutoCompact(kernel, true, true)).toBe(true)
      expect(shouldShowQueuedAutoCompact(COPILOT_RUNTIME_COMPACTION_POLICY, true, true)).toBe(false)
      expect(shouldShowQueuedAutoCompact(kernel, false, true)).toBe(false)
      expect(shouldShowQueuedAutoCompact(kernel, true, false)).toBe(false)
    })
  })
})

describe('compaction failure messaging', () => {
  it('maps known reason codes to friendly text', () => {
    expect(compactReasonMessage('summary_too_short')).toMatch(/too short/i)
    expect(compactReasonMessage('circuit_breaker_open')).toMatch(/paused/i)
  })
  it('humanizes unknown reason codes', () => {
    expect(compactReasonMessage('some_new_reason')).toBe('some new reason')
  })
  it('compactFailureMessage uses the reason or a default', () => {
    expect(compactFailureMessage({ kind: 'x', reason: 'empty' })).toMatch(/nothing to compact/i)
    expect(compactFailureMessage({ kind: 'x' })).toBe('Compaction failed.')
  })
})
