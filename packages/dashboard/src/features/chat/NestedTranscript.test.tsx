import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Message } from '@agent-kernel/kernel'

import { NestedTranscript, nestedTranscriptRowCount } from './NestedTranscript.js'

describe('NestedTranscript', () => {
  it('counts collapsed tool calls by displayed rows instead of raw messages', () => {
    const calls: Message[] = Array.from({ length: 12 }, (_, index) => [
      { role: 'assistant', content: [{ type: 'tool_call', callId: `call-${index}`, name: 'read', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: `call-${index}`, ok: true, content: 'ok' }] },
    ] as Message[]).flat()
    expect(nestedTranscriptRowCount([
      { role: 'user', content: [{ type: 'text', text: 'inspect the files' }] },
      ...calls,
    ])).toBe(2)
  })

  it('collapses mixed tool activity split across nested messages', () => {
    render(
      <NestedTranscript
        messages={[
          { role: 'user', content: [{ type: 'text', text: 'do many edits' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c1', name: 'bash', input: { command: 'pwd' }, intent: 'Inspect the working directory.' }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'ok' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c2', name: 'edit', input: { path: '/repo/a.md' } }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c2', ok: false, content: 'missing' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c3', name: 'read', input: { path: '/repo/b.md' } }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c3', ok: true, content: 'file' }] },
        ] satisfies Message[]}
      />,
    )

    expect(screen.getByTestId('nested-tool-group-c1')).toBeTruthy()
    expect(screen.getByText('Tool activity')).toBeTruthy()
    expect(screen.getByText('3 ops')).toBeTruthy()
    expect(screen.getByText(/bash 1, edit 1, read 1/)).toBeTruthy()
    expect(screen.queryByText('Tool')).toBeNull()
    expect(screen.queryByText(/path=\/repo\/a\.md/)).toBeNull()

    const toggle = screen.getByTestId('nested-tool-group-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.parentElement?.className).toContain('border')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    expect(screen.getByText('Inspect the working directory.')).toBeTruthy()
    expect(screen.getByText(/\/repo\/a\.md/)).toBeTruthy()
    expect(screen.getByText(/\/repo\/b\.md/)).toBeTruthy()
    expect(screen.getByTestId('nested-tool-intention-c1').className).toContain('font-sans')
    expect(screen.getByTestId('nested-tool-detail-c1').querySelector('span')?.className).toContain('font-mono')

    fireEvent.click(screen.getByTestId('nested-tool-detail-c2').querySelector('button')!)
    expect(screen.getByText((content) => content.includes('"path": "/repo/a.md"'))).toBeTruthy()
    expect(screen.getByText('missing')).toBeTruthy()
  })

  it('shows complete tool inputs and multi-line results on demand', () => {
    const fullResult = `first line\n${'complete output '.repeat(30)}`
    render(
      <NestedTranscript
        messages={[
          {
            role: 'assistant',
            content: [{
              type: 'tool_call',
              callId: 'complete-call',
              name: 'bash',
              input: { command: 'printf complete', timeout: 120 },
            }],
          },
          {
            role: 'tool',
            content: [{
              type: 'tool_result',
              callId: 'complete-call',
              ok: true,
              content: fullResult,
            }],
          },
        ] satisfies Message[]}
      />,
    )

    expect(screen.queryByText(fullResult)).toBeNull()
    const detail = screen.getByTestId('nested-tool-detail-complete-call')
    fireEvent.click(detail.querySelector('button')!)
    expect(screen.getByText((content) => content.includes('"command": "printf complete"'))).toBeTruthy()
    expect(detail.querySelectorAll('pre')[1]?.textContent).toBe(fullResult)
  })

  it('renders Markdown, diagrams as code, and fenced source inside a child transcript', () => {
    render(
      <NestedTranscript
        messages={[{
          role: 'assistant',
          content: [{ type: 'text', text: 'Architecture:\n\n```mermaid\ngraph TD\nA-->B\n```\n\nImplementation:\n```typescript\nconst x = 1\n```' }],
        }] satisfies Message[]}
      />,
    )

    expect(screen.getByText('Architecture:')).toBeTruthy()
    expect(screen.getByText(/graph TD/)).toBeTruthy()
    expect(screen.getByText(/const x = 1/)).toBeTruthy()
    expect(screen.getAllByTestId('nested-markdown')).toHaveLength(1)
  })

  it('renders user and thinking Markdown inside a child transcript', () => {
    render(
      <NestedTranscript
        messages={[
          { role: 'user', content: [{ type: 'text', text: '**User emphasis**' }] },
          { role: 'assistant', content: [{ type: 'thinking', text: '## Reasoning\n\n- first\n- second' }] },
        ] satisfies Message[]}
      />,
    )

    expect(screen.getByText('User emphasis').tagName).toBe('STRONG')
    expect(screen.getByText('Prompt')).toBeTruthy()
    expect(screen.queryByText('Assistant')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Reasoning' })).toBeTruthy()
    expect(screen.getByTestId('nested-thinking-markdown').querySelectorAll('li')).toHaveLength(2)
  })

  it('normalizes separated apostrophes only in nested Thinking display', () => {
    render(<NestedTranscript messages={[{ role: 'assistant', content: [
      { type: 'thinking', text: 'I’ m investigating John’s report.' },
    ] }] satisfies Message[]} />)
    expect(screen.getByTestId('nested-thinking-markdown').textContent).toContain("I'm investigating John’s report.")
  })

  it('preserves delegated prompt line breaks and bounds long prompt height', () => {
    const tail = 'PROMPT-TAIL'
    render(
      <NestedTranscript
        messages={[{
          role: 'user',
          content: [{ type: 'text', text: `First instruction\nSecond instruction\n${'detail '.repeat(300)}${tail}` }],
        }] satisfies Message[]}
      />,
    )

    const prompt = screen.getByTestId('nested-markdown')
    expect(prompt.getAttribute('data-preserve-whitespace')).toBe('true')
    expect(prompt.className).toContain('[&_p]:whitespace-pre-wrap')
    expect(screen.queryByText(new RegExp(tail))).toBeNull()
    fireEvent.click(screen.getByTestId('nested-markdown-toggle'))
    expect(screen.getByText(new RegExp(tail))).toBeTruthy()
  })

  it('allows a long final response to be revealed in full', () => {
    const tail = 'COMPLETE-TAIL-MARKER'
    render(
      <NestedTranscript
        messages={[{
          role: 'assistant',
          content: [{ type: 'text', text: `${'a'.repeat(12_100)}${tail}` }],
        }] satisfies Message[]}
      />,
    )

    expect(screen.queryByText(new RegExp(tail))).toBeNull()
    fireEvent.click(screen.getByTestId('nested-markdown-toggle'))
    expect(screen.getByText(new RegExp(tail))).toBeTruthy()
  })

  it('does not collapse nested tool activity across assistant text', () => {
    render(
      <NestedTranscript
        messages={[
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c1', name: 'bash', input: { command: 'pwd' } }],
          },
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'ok' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'checking next' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'c2', name: 'edit', input: { path: '/repo/a.md' } }],
          },
        ] satisfies Message[]}
      />,
    )

    expect(screen.queryByText('Tool activity')).toBeNull()
    expect(screen.getByText('checking next')).toBeTruthy()
    expect(screen.getByText(/pwd/)).toBeTruthy()
    expect(screen.getByText(/\/repo\/a\.md/)).toBeTruthy()
  })
})
