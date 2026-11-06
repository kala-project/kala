import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Message, ToolCallContent, ToolResultContent } from '@agent-kernel/kernel'

import { SubAgentCard } from './SubAgentCard.js'
import { ChatPanel } from './ChatPanel.js'
import type { ToolCallGroup } from './grouping.js'
import type { DashboardSocket } from '../../session.js'

function makeCall(callId: string, input: Record<string, unknown> = {}): ToolCallContent {
  return {
    type: 'tool_call',
    callId,
    name: 'agent',
    input,
  }
}

function makeGroup(
  calls: ToolCallContent[],
  results: Array<[string, ToolResultContent]> = [],
): ToolCallGroup {
  return {
    kind: 'tool_call_group',
    toolName: 'agent',
    mixed: false,
    calls,
    results: new Map(results),
    firstCallId: calls[0]!.callId,
  }
}

describe('SubAgentCard', () => {
  it('renders the pending state before any envelope arrives', () => {
    const group = makeGroup([makeCall('c1', { prompt: 'find the bug', agent_type: 'Explore' })])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Pending')
    expect(screen.getAllByText('Explore').length).toBeGreaterThan(0)
    expect(screen.getAllByText('find the bug').length).toBeGreaterThan(0)
    const row = screen.getByTestId('sub-agent-row-c1')
    expect(row.className).toContain('rounded-xl')
    expect(row.className).toContain('border')
    expect(row.className).not.toContain('ak-subagent-card-surface')
    // Beam is only drawn when a child session is actively running.
    expect(screen.queryByTestId('border-beam')).toBeNull()
  })

  it('shows explicit intention first without leaking a large prompt into the card summary', () => {
    const largePrompt = `/workspace/private/file.ts\n${'implementation detail '.repeat(30)}`
    const group = makeGroup([makeCall('c-intent', {
      prompt: largePrompt,
      intention: 'Explain the user-visible session behavior.',
      objective: 'legacy objective must not win',
      _intent: 'tool intention must not win',
    })])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    const row = screen.getByTestId('sub-agent-row-c-intent')
    expect(row.textContent).toContain('Explain the user-visible session behavior.')
    expect(row.textContent).not.toContain('/workspace/private/file.ts')
    expect(screen.queryByTestId('sub-agent-task-c-intent')).toBeNull()
    fireEvent.click(screen.getByTestId('sub-agent-toggle-c-intent'))
    expect(screen.queryByTestId('sub-agent-task-c-intent')).toBeNull()
    fireEvent.click(screen.getByTestId('sub-agent-toggle-c-intent'))
    expect(screen.queryByTestId('sub-agent-task-c-intent')).toBeNull()
  })

  it('reveals the full intention only when the header is actually truncated', () => {
    let resize: ResizeObserverCallback = () => {}
    vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    try {
      render(
        <SubAgentCard
          parentSessionId="parent-1"
          socket={null}
          group={makeGroup([makeCall('c-truncated', {
            prompt: 'structured child prompt',
            intention: 'Inspect every clipboard surface across browser and desktop layouts.',
          })])}
          approvalByCallId={new Map()}
        />,
      )
      const header = screen.getByTestId('sub-agent-header-intention-c-truncated')
      Object.defineProperties(header, {
        clientWidth: { configurable: true, value: 120 },
        scrollWidth: { configurable: true, value: 420 },
      })
      act(() => resize([], {} as ResizeObserver))
      fireEvent.click(screen.getByTestId('sub-agent-toggle-c-truncated'))
      const task = screen.getByTestId('sub-agent-task-c-truncated')
      expect(task.textContent).toContain('Inspect every clipboard surface across browser and desktop layouts.')
      expect(task.textContent).not.toContain('Fresh context')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses a generic historical fallback instead of exposing a path or giant prompt', () => {
    const group = makeGroup([makeCall('c-legacy', { prompt: '/workspace/private/very-secret-plan.md', agent_type: 'review' })])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const row = screen.getByTestId('sub-agent-row-c-legacy')
    expect(row.textContent).toContain('Delegated review task')
    expect(row.textContent).not.toContain('/workspace/private')
  })

  it('uses status styling without a decorative border beam while the sub-agent is running', async () => {
    const call = makeCall('c1', { prompt: 'search', agent_type: 'Explore' })
    const group = makeGroup([call])
    const socket = makeControlledSocket()
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket.socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    expect(screen.queryByTestId('border-beam')).toBeNull()

    act(() => {
      socket.emitStarted({
        parentSessionId: 'parent-1',
        parentCallId: 'c1',
        childSessionId: 'child-1',
        agentType: 'Explore',
        prompt: 'search',
        startedAt: new Date().toISOString(),
      })
    })
    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c1').getAttribute('data-sub-agent-status')).toBe('running'))
    const runningRow = screen.getByTestId('sub-agent-row-c1')
    expect(screen.queryByTestId('border-beam')).toBeNull()
    expect(runningRow.className).not.toContain('border-l-2')
    expect(runningRow.className).not.toContain('border-l-sky')
    expect(screen.getByTestId('sub-agent-status-badge').textContent).toContain('Running')
    expect(screen.getByTestId('sub-agent-role-c1').classList.contains('ak-thinking-text')).toBe(true)
    expect(runningRow.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByTestId('sub-agent-running-icon').classList.contains('motion-safe:animate-spin')).toBe(true)
    expect(runningRow.textContent).not.toContain('Child session is starting')
    expect(socket.emit.mock.calls.some(([event]) => event === 'client:subscribe_channels')).toBe(false)

    fireEvent.click(screen.getByTestId('sub-agent-toggle-c1'))
    await waitFor(() => expect(socket.emit.mock.calls.some(([event]) => event === 'client:subscribe_channels')).toBe(true))
    fireEvent.click(screen.getByTestId('sub-agent-toggle-c1'))
    await waitFor(() => expect(socket.emit.mock.calls.some(([event]) => event === 'client:unsubscribe_channels')).toBe(true))

    act(() => {
      socket.emitFinished({
        parentSessionId: 'parent-1',
        parentCallId: 'c1',
        childSessionId: 'child-1',
        status: 'completed',
        turns: 1,
        durationMs: 500,
        finishedAt: new Date().toISOString(),
      })
    })
    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c1').getAttribute('data-sub-agent-status')).toBe('completed'))
    expect(screen.queryByTestId('sub-agent-running-icon')).toBeNull()
  })

  it('renders the completed state from a parsed envelope', () => {
    const call = makeCall('c1', { prompt: 'summarize', agent_type: 'Explore' })
    const envelope = [
      '<sub_agent',
      '  session_id="child-9"',
      '  agent_type="Explore"',
      '  status="completed"',
      '  turns="4"',
      '  duration_ms="12000"',
      '>',
      '<result>',
      'done',
      '</result>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      isError: false,
    }
    const group = makeGroup([call], [['c1', result]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Completed')
    expect(badge.textContent).toContain('4 turns')
    expect(badge.textContent).not.toContain('12s')
    const duration = screen.getByTestId('sub-agent-duration-c1')
    expect(duration.textContent).toContain('12s')
    expect(duration.querySelector('[data-testid="sub-agent-duration-icon"]')).toBeTruthy()
    expect(duration.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const row = screen.getByTestId('sub-agent-row-c1')
    expect(row.getAttribute('data-sub-agent-status')).toBe('completed')
    fireEvent.click(screen.getByTestId('sub-agent-toggle-c1'))
    expect(screen.getByText('done')).toBeTruthy()
  })

  it('keeps a completed sub-agent in its dedicated collapsed UI in dots mode', () => {
    const call = makeCall('c-dot', { prompt: 'inspect', agent_type: 'Explore' })
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c-dot',
      content: [
        '<sub_agent',
        '  session_id="child-dot"',
        '  agent_type="Explore"',
        '  status="completed"',
        '  turns="2"',
        '  duration_ms="100"',
        '>',
        '<result>done</result>',
        '</sub_agent>',
      ].join('\n'),
      isError: false,
    }
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={makeGroup([call], [['c-dot', result]])}
        approvalByCallId={new Map()}
        toolCardMode="dots"
      />,
    )

    expect(screen.queryByTestId('sub-agent-dot-c-dot')).toBeNull()
    expect(screen.getByTestId('sub-agent-row-c-dot').className).toContain('ak-sub-agent-card')
    expect(screen.getByTestId('sub-agent-status-badge').textContent).toContain('Completed')
    expect(screen.queryByText('done')).toBeNull()
    fireEvent.click(screen.getByTestId('sub-agent-toggle-c-dot'))
    expect(screen.getByText('done')).toBeTruthy()
  })

  it('renders the failed state and shows the error body', () => {
    const call = makeCall('c1', { prompt: 'noop' })
    const envelope = [
      '<sub_agent',
      '  session_id="depth-exceeded"',
      '  status="failed"',
      '  turns="0"',
      '  duration_ms="42"',
      '>',
      '<error>',
      'agent depth exceeded',
      '</error>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      isError: true,
    }
    const group = makeGroup([call], [['c1', result]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Failed')
    expect(screen.getByText(/agent depth exceeded/)).toBeTruthy()
    const row = screen.getByTestId('sub-agent-row-c1')
    expect(row.getAttribute('data-sub-agent-status')).toBe('failed')
  })

  it('renders the cancelled state from a parsed envelope', () => {
    const call = makeCall('c1', { prompt: 'noop' })
    const envelope = [
      '<sub_agent',
      '  session_id="child-cancelled"',
      '  status="cancelled"',
      '  turns="2"',
      '  duration_ms="300"',
      '>',
      '<error>',
      'interrupted by user',
      '</error>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      isError: true,
    }
    const group = makeGroup([call], [['c1', result]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Cancelled')
    expect(screen.getByText(/interrupted by user/)).toBeTruthy()
    const row = screen.getByTestId('sub-agent-row-c1')
    expect(row.getAttribute('data-sub-agent-status')).toBe('cancelled')
  })

  it('emits client:interrupt_sub_agent for a running child', async () => {
    const call = makeCall('c1', { prompt: 'search', agent_type: 'Explore' })
    const group = makeGroup([call])
    const socket = makeControlledSocket()
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket.socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    act(() => {
      socket.emitStarted({
        parentSessionId: 'parent-1',
        parentCallId: 'c1',
        childSessionId: 'child-1',
        agentType: 'Explore',
        prompt: 'search',
        startedAt: new Date().toISOString(),
      })
    })

    await waitFor(() => expect(screen.getByTestId('sub-agent-interrupt-c1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sub-agent-interrupt-c1'))

    expect(socket.emit).toHaveBeenCalledWith('client:interrupt_sub_agent', {
      operationId: expect.any(String),
      parentSessionId: 'parent-1',
      parentCallId: 'c1',
      childSessionId: 'child-1',
    })
  })

  it('falls back to pending when the tool_result content is a legacy pre-envelope string', () => {
    const call = makeCall('c1', { prompt: 'noop' })
    const legacy: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: 'plain child response text, no envelope',
      isError: false,
    }
    const group = makeGroup([call], [['c1', legacy]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Pending')
  })

  it('renders replayed child messages when subscribe replies immediately', async () => {
    const call = makeCall('c1', { prompt: 'summarize', agent_type: 'Explore' })
    const envelope = [
      '<sub_agent',
      '  session_id="child-9"',
      '  agent_type="Explore"',
      '  status="completed"',
      '  turns="1"',
      '  duration_ms="120"',
      '>',
      '<result>',
      'done',
      '</result>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      ok: true,
    }
    const group = makeGroup([call], [['c1', result]])
    const socket = makeImmediateReadySocket('child-9', [
      { role: 'user', content: [{ type: 'text', text: 'child prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'child answer visible with $$a^2$$' }] },
    ])

    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    fireEvent.click(screen.getByTestId('sub-agent-toggle-c1'))
    await waitFor(() => expect(screen.getByText(/child answer visible/)).toBeTruthy())
    const nestedMarkdown = screen.getAllByTestId('nested-markdown')
    expect(nestedMarkdown).toHaveLength(2)
    expect(nestedMarkdown.some((entry) => entry.querySelector('.katex'))).toBe(true)
    expect(screen.getByTestId('sub-agent-transcript-frame-c1').getAttribute('data-layout')).toBe('content')
    expect(screen.getByTestId('sub-agent-transcript-frame-c1').querySelector('[data-radix-scroll-area-viewport]')).toBeTruthy()
    expect(screen.getByTestId('nested-transcript').getAttribute('data-virtualized')).toBe('false')
  })

  it('recovers a running child session from sub_agent:list after refresh', async () => {
    const call = makeCall('c-live', { prompt: 'summarize', agent_type: 'Explore' })
    const group = makeGroup([call])
    const socket = makeRecoveringSocket({
      parentSessionId: 'parent-1',
      parentCallId: 'c-live',
      childSessionId: 'child-live',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'child prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'child is still working' }] },
      ],
    })

    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c-live').getAttribute('data-sub-agent-status')).toBe('running'))
    expect(screen.queryByTestId('sub-agent-transcript-frame-c-live')).toBeNull()
    fireEvent.click(screen.getByTestId('sub-agent-toggle-c-live'))
    await waitFor(() => expect(screen.getByText(/child is still working/)).toBeTruthy())
    expect(screen.getByTestId('sub-agent-transcript-frame-c-live').getAttribute('data-layout')).toBe('content')
    expect(screen.getByTestId('nested-transcript').getAttribute('data-virtualized')).toBe('false')
  })

  it('distinguishes queued next-turn steering, processing, and unconfirmed UNKNOWN from completion', () => {
    const socket = makeControlledSocket()
    render(<SubAgentCard parentSessionId="parent-1" socket={socket.socket}
      group={makeGroup([makeCall('initial', { prompt: 'work' })])} approvalByCallId={new Map()} />)
    const listCall = socket.emit.mock.calls.find(([event]) => event === 'sub_agent:list')
    const acknowledge = listCall?.[2] as ((result: unknown) => void) | undefined
    expect(acknowledge).toBeTypeOf('function')
    const report = (commandState?: 'queued' | 'processing' | 'unknown', status: 'running' | 'completed' = 'running') => {
      act(() => acknowledge!({
        requestId: 'recover', parentSessionId: 'parent-1', children: [{
          childSessionId: 'child-1', parentCallId: 'initial', status,
          startedAt: new Date().toISOString(),
          ...(commandState ? { commandState, pendingCommandCount: 1 } : {}),
        }],
      }))
    }
    report('queued')
    expect(screen.getByTestId('sub-agent-command-state-initial').textContent).toContain('Queued for next turn')
    expect(screen.getByTestId('sub-agent-row-initial').getAttribute('data-sub-agent-status')).toBe('running')
    report('processing')
    expect(screen.getByTestId('sub-agent-command-state-initial').textContent).toContain('Processing next turn')
    expect(screen.getByTestId('sub-agent-command-state-initial').textContent).toContain('1 pending')
    act(() => acknowledge!({ requestId: 'recover', parentSessionId: 'parent-1', children: [],
      error: 'PostgreSQL owner lookup unavailable' }))
    expect(screen.getByTestId('sub-agent-command-state-initial').textContent).toContain('UNKNOWN')
    report('unknown')
    expect(screen.getByTestId('sub-agent-command-state-initial').textContent).toContain('UNKNOWN')
    expect(screen.getByTestId('sub-agent-row-initial').getAttribute('data-sub-agent-status')).toBe('running')
    act(() => socket.emitFinished({
      parentSessionId: 'parent-1', parentCallId: 'initial', childSessionId: 'child-1',
      status: 'completed', turns: 1, durationMs: 100, finishedAt: new Date().toISOString(),
    }))
    expect(screen.getByTestId('sub-agent-row-initial').getAttribute('data-sub-agent-status')).toBe('running')
    report(undefined, 'completed')
    expect(screen.queryByTestId('sub-agent-command-state-initial')).toBeNull()
    expect(screen.getByTestId('sub-agent-row-initial').getAttribute('data-sub-agent-status')).toBe('completed')
  })

  it('recovers a cancelled child with its durable reason and metrics', async () => {
    const socket = makeRecoveringSocket({
      parentSessionId: 'parent-1',
      parentCallId: 'c-cancelled-refresh',
      childSessionId: 'child-cancelled-refresh',
      status: 'cancelled',
      turns: 3,
      durationMs: 4200,
      error: 'stopped by operator',
      messages: [],
    })

    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket}
        group={makeGroup([makeCall('c-cancelled-refresh', { intention: 'Inspect cancellation recovery.' })])}
        approvalByCallId={new Map()}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c-cancelled-refresh').getAttribute('data-sub-agent-status')).toBe('cancelled'))
    expect(screen.getByTestId('sub-agent-status-badge').textContent).toContain('Cancelled')
    expect(screen.getByText(/3 turns/)).toBeTruthy()
    expect(screen.getByText(/stopped by operator/)).toBeTruthy()
  })

  it('renders a live partial timeout as failed instead of completed', async () => {
    const socket = makeControlledSocket()
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket.socket}
        group={makeGroup([makeCall('c-partial-timeout', { intention: 'Inspect timeout handling.' })])}
        approvalByCallId={new Map()}
      />,
    )
    act(() => {
      socket.emitStarted({
        parentSessionId: 'parent-1',
        parentCallId: 'c-partial-timeout',
        childSessionId: 'child-partial-timeout',
        prompt: 'inspect',
        startedAt: new Date().toISOString(),
      })
      socket.emitFinished({
        parentSessionId: 'parent-1',
        parentCallId: 'c-partial-timeout',
        childSessionId: 'child-partial-timeout',
        status: 'timed_out_with_partial_result',
        error: 'ordinary-idle timeout',
        turns: 2,
        durationMs: 5000,
        finishedAt: new Date().toISOString(),
      })
    })

    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c-partial-timeout').getAttribute('data-sub-agent-status')).toBe('failed'))
    expect(screen.getByTestId('sub-agent-status-badge').textContent).toContain('Failed')
    expect(screen.getByText(/ordinary-idle timeout/)).toBeTruthy()
  })

  it('keeps a long running transcript virtualized in a compact content-sized viewport', async () => {
    const messages: Message[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `child execution detail ${index + 1}` }],
    }))
    const socket = makeRecoveringSocket({
      parentSessionId: 'parent-1',
      parentCallId: 'c-compact-live',
      childSessionId: 'child-compact-live',
      messages,
    })

    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket}
        group={makeGroup([makeCall('c-compact-live', {
          intention: 'Inspect the compact live transcript.',
          agent_type: 'Explore',
          model: 'claude-sonnet',
        })])}
        approvalByCallId={new Map()}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c-compact-live').getAttribute('data-sub-agent-status')).toBe('running'))
    expect(screen.queryByTestId('sub-agent-transcript-frame-c-compact-live')).toBeNull()
    fireEvent.click(screen.getByTestId('sub-agent-toggle-c-compact-live'))
    const frame = await screen.findByTestId('sub-agent-transcript-frame-c-compact-live')
    expect(frame.getAttribute('data-layout')).toBe('viewport')
    expect(frame.style.height).toBe('256px')
    expect(frame.className).toContain('max-h-[min(20rem,55dvh)]')
    expect(frame.className).not.toContain('h-[min(28rem,55dvh)]')
    expect(screen.getByTestId('nested-transcript').getAttribute('data-virtualized')).toBe('true')
    expect(screen.getByTestId('sub-agent-toggle-c-compact-live').textContent).toContain('Inspect the compact live transcript.')
    fireEvent.click(screen.getByLabelText('Execution details'))
    expect(screen.getByText('claude-sonnet')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-interrupt-c-compact-live')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-status-badge').textContent).toContain('Running')
  })

  it('surfaces a resolved policy artifact inline on the expanded row', async () => {
    const artifact = {
      schemaVersion: 1,
      parentSessionId: 'parent-1',
      parentCallId: 'c1',
      childSessionId: 'child-9',
      createdAt: new Date().toISOString(),
      policy: {
        role: 'research',
        objective: 'summarize the repo layout',
        allowedTools: ['read', 'grep'],
        maxTurns: 12,
        timeoutMs: 90_000,
        expectedOutput: 'Structured summary with file:line references.',
        reasons: ['role_template_applied', 'policy_allowed_tools_intersected'],
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          path: 'subagent-policies/parent-1/c1.json',
          mediaType: 'application/json',
          body: artifact,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const call = makeCall('c1', { prompt: 'summarize', agent_type: 'Explore', role: 'research' })
      const group = makeGroup([call])
      render(
        <SubAgentCard
          parentSessionId="parent-1"
          socket={null}
          group={group}
          approvalByCallId={new Map()}
        />,
      )
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/artifacts/content?path=subagent-policies%2Fparent-1%2Fc1.json',
          { cache: 'no-store' },
        ),
      )
      const details = screen.getByTestId('sub-agent-details-c1') as HTMLDetailsElement
      expect(details.open).toBe(false)
      fireEvent.click(screen.getByLabelText('Execution details'))
      expect(details.open).toBe(true)
      const panel = await screen.findByTestId('sub-agent-policy-c1')
      expect(details.textContent).toContain('research')
      expect(details.textContent).toContain('read, grep')
      expect(details.textContent).toContain('12')
      expect(details.textContent).toContain('90s')
      expect(panel.textContent).toContain('summarize the repo layout')
      expect(panel.textContent).toContain('role_template_applied')
      expect(panel.textContent).toContain('policy_allowed_tools_intersected')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not request a policy artifact when no role was requested', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const call = makeCall('c2', { prompt: 'noop' })
      const group = makeGroup([call])
      render(
        <SubAgentCard
          parentSessionId="parent-1"
          socket={null}
          group={group}
          approvalByCallId={new Map()}
        />,
      )
      expect(fetchMock).not.toHaveBeenCalled()
      expect(screen.queryByTestId('sub-agent-policy-c2')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders depth and fan-out chips when the policy artifact carries them', async () => {
    const artifact = {
      schemaVersion: 1,
      parentSessionId: 'parent-1',
      parentCallId: 'c3',
      createdAt: new Date().toISOString(),
      policy: {
        role: 'research',
        allowedTools: ['read'],
        maxDepth: 3,
        resolvedDepth: 2,
        maxFanOut: 4,
        concurrentSiblingCount: 1,
        reasons: ['role_template_applied'],
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          path: 'subagent-policies/parent-1/c3.json',
          mediaType: 'application/json',
          body: artifact,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const call = makeCall('c3', { prompt: 'summarize', agent_type: 'Explore', role: 'research' })
      const group = makeGroup([call])
      render(
        <SubAgentCard
          parentSessionId="parent-1"
          socket={null}
          group={group}
          approvalByCallId={new Map()}
        />,
      )
      fireEvent.click(screen.getByLabelText('Execution details'))
      await screen.findByTestId('sub-agent-policy-c3')
      const details = screen.getByTestId('sub-agent-details-c3')
      expect(details.textContent).toContain('depth')
      expect(details.textContent).toContain('2/3')
      expect(details.textContent).toContain('fan-out')
      expect(details.textContent).toContain('1/4')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ChatPanel sub-agent dispatch', () => {
  it('routes the `agent` tool_call group through SubAgentCard when parentSessionId is set', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'c1',
            name: 'agent',
            input: { prompt: 'go look at things', agent_type: 'Explore' },
          },
        ],
      },
    ]
    render(<ChatPanel messages={messages} parentSessionId="parent-1" socket={null} />)
    expect(screen.getByTestId('sub-agent-row-c1')).toBeTruthy()
    expect(screen.queryByTestId('tool-call-group-c1')).toBeNull()
  })

  it('falls back to the generic ToolCallGroupBlock when no parentSessionId is passed', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'c1',
            name: 'agent',
            input: { prompt: 'go look' },
          },
        ],
      },
    ]
    render(<ChatPanel messages={messages} />)
    expect(screen.queryByTestId('sub-agent-row-c1')).toBeNull()
    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
  })

  it('uses one grouped activity container when a single assistant message spawns multiple sub-agents', () => {
    const group = makeGroup([
      makeCall('c1', { prompt: 'search A', intention: 'Find the source of behavior A.', agent_type: 'Explore' }),
      makeCall('c2', { prompt: 'search B', intention: 'Find the source of behavior B.', agent_type: 'Explore' }),
      makeCall('c3', { prompt: 'search C', intention: 'Find the source of behavior C.', agent_type: 'Explore' }),
    ])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const grouped = screen.getByTestId(`sub-agent-group-${group.firstCallId}`)
    const groupList = screen.getByTestId(`sub-agent-group-list-${group.firstCallId}`)
    expect(grouped.className).not.toContain('border')
    expect(groupList.className).toContain('rounded-xl')
    expect(groupList.className).toContain('border')
    expect(groupList.className).toContain('divide-y')
    expect(groupList.className).not.toContain('border-l')
    expect(groupList.className).not.toContain('grid')
    expect(grouped.textContent).toContain('Subagents')
    expect(screen.getByTestId('sub-agent-row-c1')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-row-c2')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-row-c3')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-toggle-c1')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-toggle-c2')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-toggle-c3')).toBeTruthy()
    expect(screen.getAllByTestId('sub-agent-status-badge')[0].className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('sub-agent-toggle-c1').textContent).toContain('Find the source of behavior A.')

    fireEvent.click(screen.getByTestId('sub-agent-toggle-c1'))
    expect(screen.getByTestId('sub-agent-row-c1').className).not.toContain('border-l')
    expect(screen.getByTestId('sub-agent-toggle-c2')).toBeTruthy()
  })

  it('keeps completed grouped sub-agents as readable task rows in dots mode', () => {
    const calls = [
      makeCall('c1', { intention: 'Review the API behavior.', agent_type: 'Review' }),
      makeCall('c2', { intention: 'Inspect the release assets.', agent_type: 'Explore' }),
    ]
    const results: Array<[string, ToolResultContent]> = calls.map((call, index) => [
      call.callId,
      {
        type: 'tool_result',
        callId: call.callId,
        ok: true,
        content: `<sub_agent session_id="child-${index}" agent_type="${call.input.agent_type}" status="completed" turns="2" duration_ms="1000"><result>Done.</result></sub_agent>`,
      },
    ])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={makeGroup(calls, results)}
        approvalByCallId={new Map()}
        toolCardMode="dots"
      />,
    )

    expect(screen.queryByTestId('sub-agent-dot-c1')).toBeNull()
    expect(screen.queryByTestId('sub-agent-dot-c2')).toBeNull()
    expect(screen.getByTestId('sub-agent-toggle-c1').textContent).toContain('Review the API behavior.')
    expect(screen.getByTestId('sub-agent-toggle-c2').textContent).toContain('Inspect the release assets.')
  })

  it('keeps grouped children collapsed when one starts running until the user expands it', async () => {
    const socket = makeControlledSocket()
    const group = makeGroup([
      makeCall('c-running', { prompt: 'large internal prompt', intention: 'Trace the live child lifecycle.' }),
      makeCall('c-waiting', { prompt: 'other prompt', intention: 'Review the resulting lifecycle state.' }),
    ])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket.socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    act(() => socket.emitStarted({
      parentSessionId: 'parent-1',
      parentCallId: 'c-running',
      childSessionId: 'child-running',
      intention: 'Trace the live child lifecycle.',
      prompt: 'large internal prompt',
      startedAt: new Date().toISOString(),
    }))

    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c-running').getAttribute('data-sub-agent-status')).toBe('running'))
    expect(screen.getByTestId('sub-agent-toggle-c-running').textContent).toContain('Trace the live child lifecycle.')
    expect(screen.getByTestId('sub-agent-row-c-running').className).not.toContain('border-l-primary')
  })

  it('keeps single-agent groups in the stacked list layout (no matrix)', () => {
    const group = makeGroup([makeCall('c1', { prompt: 'search' })])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    expect(screen.queryByTestId(`sub-agent-group-${group.firstCallId}`)).toBeNull()
    expect(screen.getByTestId('sub-agent-row-c1')).toBeTruthy()
  })

  it('groups adjacent Copilot-style sub-agent calls projected as separate messages', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [makeCall('c1', { prompt: 'search A', agent_type: 'Explore' })] },
      { role: 'assistant', content: [makeCall('c2', { prompt: 'search B', agent_type: 'Research' })] },
      { role: 'assistant', content: [makeCall('c3', { prompt: 'search C', agent_type: 'Review' })] },
    ]

    render(<ChatPanel messages={messages} parentSessionId="parent-1" socket={null} />)

    expect(screen.getByTestId('sub-agent-group-c1')).toBeTruthy()
    expect(screen.getAllByText('Subagents')).toHaveLength(1)
    expect(screen.getByTestId('sub-agent-row-c1')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-row-c2')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-row-c3')).toBeTruthy()
  })
})

function makeControlledSocket(): {
  socket: DashboardSocket
  emit: ReturnType<typeof vi.fn>
  emitStarted: (payload: Record<string, unknown>) => void
  emitFinished: (payload: Record<string, unknown>) => void
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emit = vi.fn(function emit() {
    return socket
  })
  const socket = {
    connected: true,
    on(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return this
    },
    off(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    emit,
  } as unknown as DashboardSocket
  return {
    socket,
    emit,
    emitStarted(payload) {
      for (const listener of listeners.get('server:control_update') ?? []) {
        listener({ kind: 'sub_agent_started', ...payload })
      }
    },
    emitFinished(payload) {
      for (const listener of listeners.get('server:control_update') ?? []) {
        listener({ kind: 'sub_agent_finished', ...payload })
      }
    },
  }
}

function makeImmediateReadySocket(childSessionId: string, messages: Message[]): DashboardSocket {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  return {
    connected: true,
    on(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return this
    },
    off(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    emit(event: string, payload: { channels?: string[]; generation?: number }, ack?: (payload: unknown) => void) {
      if (event === 'client:subscribe_channels' && payload.channels?.includes(`session:${childSessionId}`)) {
        for (const listener of listeners.get('session:ready') ?? []) {
          listener({
            sessionId: childSessionId,
            config: { tools: [], systemPrompt: '' },
            state: {
              sessionId: childSessionId,
              messages,
              pendingCalls: [],
              status: 'idle',
              usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
              cursor: messages.length,
              memory: [],
              approvalMode: 'auto',
            },
          })
        }
        ack?.({
          requestId: 'subscribe-child',
          generation: payload.generation,
          accepted: [`session:${childSessionId}`],
          rejected: [],
          cursors: { [`session:${childSessionId}`]: messages.length },
        })
      }
      return this
    },
  } as unknown as DashboardSocket
}

function makeRecoveringSocket(input: {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  messages: Message[]
  status?: 'running' | 'completed' | 'failed' | 'cancelled'
  turns?: number
  durationMs?: number
  error?: string
}): DashboardSocket {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  return {
    connected: true,
    on(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return this
    },
    off(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    emit(event: string, payload: { parentSessionId?: string; channels?: string[]; generation?: number }, ack?: (payload: unknown) => void) {
      if (event === 'sub_agent:list' && payload.parentSessionId === input.parentSessionId && ack) {
        ack({
          requestId: 'recover',
          parentSessionId: input.parentSessionId,
          children: [
            {
              childSessionId: input.childSessionId,
              parentCallId: input.parentCallId,
              agentType: 'Explore',
              status: input.status ?? 'running',
              startedAt: new Date().toISOString(),
              ...(input.status && input.status !== 'running' ? { finishedAt: new Date().toISOString() } : {}),
              ...(input.turns !== undefined ? { turns: input.turns } : {}),
              ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
              ...(input.error !== undefined ? { error: input.error } : {}),
            },
          ],
        })
      }
      if (event === 'client:subscribe_channels' && payload.channels?.includes(`session:${input.childSessionId}`)) {
        for (const listener of listeners.get('session:ready') ?? []) {
          listener({
            sessionId: input.childSessionId,
            config: { tools: [], systemPrompt: '' },
            state: {
              sessionId: input.childSessionId,
              messages: input.messages,
              pendingCalls: [],
              status: 'thinking',
              usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
              cursor: input.messages.length,
              memory: [],
              approvalMode: 'auto',
            },
          })
        }
        ack?.({
          requestId: 'subscribe-child',
          generation: payload.generation,
          accepted: [`session:${input.childSessionId}`],
          rejected: [],
          cursors: { [`session:${input.childSessionId}`]: input.messages.length },
        })
      }
      return this
    },
  } as unknown as DashboardSocket
}
