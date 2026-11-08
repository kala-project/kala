import { describe, expect, it } from 'vitest'
import { formatToolFailureForAgent } from './tool-feedback.js'

describe('model-facing tool failure feedback', () => {
  it.each([
    ['ENOENT', 'required target was not found', 'correct its path or ID'],
    ['ESTALE', 'revision no longer matches', 'do not disable revision protection'],
    ['EACCES', 'restrictions blocked', 'Do not widen the sandbox'],
    ['EINVAL', 'rejected an argument', 'correct the request'],
  ])('explains %s without requiring the model to know the code', (code, happened, next) => {
    const content = `ERROR: ${code}: original reason`
    const result = formatToolFailureForAgent({ content })
    expect(result).toContain(`What happened: `)
    expect(result).toContain(happened)
    expect(result).toContain('Next step: ')
    expect(result).toContain(next)
    expect(result.endsWith(content)).toBe(true)
  })

  it.each([
    ['apply_file_patch', 'a batch error is not a rollback', 'Do not replay the entire patch'],
    ['read_files', 'Preserved successful sections', 'details are missing or truncated'],
    ['multi_grep', 'not evidence of no matches', 'failed or omitted items'],
    ['custom_batch', 'Completion of unreported items', 'Do not assume rollback'],
  ])('describes partial outcomes conservatively for %s even with no item details', (toolName, state, next) => {
    const result = formatToolFailureForAgent({ content: 'EPARTIAL', toolName })
    expect(result).toContain(state)
    expect(result).toContain(next)
    expect(result).not.toContain('All items failed')
    expect(result.endsWith('EPARTIAL')).toBe(true)
  })

  it('uses structured unknown outcome instead of assuming execution failed or retryable means safe', () => {
    const result = formatToolFailureForAgent({
      content: 'transport unavailable',
      failure: { code: 'custom_transport', category: 'infrastructure', outcome: 'indeterminate', retryable: true, responsibility: 'system' },
    })
    expect(result).toContain('side effects are unknown')
    expect(result).toContain('Do not launch a duplicate')
    expect(result).not.toContain('safe to retry')
  })

  it.each([
    [403, 'rejected access', 'Do not bypass'],
    [404, 'not found', 'Verify the URL'],
    [429, 'rate-limited', 'Back off'],
  ])('gives status-specific guidance for HTTP %s', (status, happened, next) => {
    const result = formatToolFailureForAgent({ content: `ERROR: EHTTP: fetch returned HTTP ${status}` })
    expect(result).toContain(happened)
    expect(result).toContain(next)
  })

  it('does not turn denied or cancelled work into an instruction to retry', () => {
    expect(formatToolFailureForAgent({ content: 'operator refused', denied: true })).toContain('Do not execute the denied operation through another tool')
    const cancelled = formatToolFailureForAgent({ content: 'ERROR: ECANCELED: applied receipt follows' })
    expect(cancelled).toContain('does not roll back earlier effects')
    expect(cancelled).toContain('Do not restart automatically')
  })

  it('shows actionable unknown diagnostics directly without generic failure guidance', () => {
    for (const input of [{ content: 'custom diagnostic quoting EPARTIAL: as data' }, { content: '', failure: { code: 'toString', category: 'execution', outcome: 'failed', retryable: false, responsibility: 'system' } } as const]) {
      const result = formatToolFailureForAgent(input)
      expect(result).not.toContain('What happened:')
      expect(result).not.toContain('Next step:')
      expect(result).not.toContain('Details:')
      expect(result).not.toContain('The batch was not fully successful')
      expect(result).not.toContain('undefined')
      if (input.content) expect(result).toBe(input.content)
      else expect(result).toBe('Tool failed (toString); no diagnostic details were returned.')
    }
    expect(formatToolFailureForAgent({ content: 'Update the Executor for this workspace to save Session attachments.' }))
      .toBe('Update the Executor for this workspace to save Session attachments.')
  })
})
