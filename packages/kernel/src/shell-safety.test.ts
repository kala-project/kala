import { describe, expect, it } from 'vitest'

import { createConfig, createInitialState, step } from './index.js'
import { analyzeShellCommand } from './shell-safety.js'

describe('kernel shell safety reducer', () => {
  const config = createConfig({
    tools: [{
      name: 'bash',
      description: 'Run shell',
      inputSchema: { type: 'object' },
      requiresApproval: false,
      executionKind: 'executor',
      executionHandler: 'bash',
    }],
  })

  it('honors allow_all for opaque commands without weakening blocked shell checks', () => {
    const command = 'python3 -m unittest discover -v && python3 -m py_compile server.py test_server.py'
    const state = {
      ...createInitialState({ sessionId: 'python-validation' }),
      approvalMode: 'allow_all' as const,
      status: 'thinking' as const,
    }
    expect(analyzeShellCommand(command).risk).toBe('high_risk')
    const result = step(state, {
      kind: 'llm_response',
      message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'validate', name: 'bash', input: { command } }] },
    }, config)
    expect(result.next.status).toBe('executing_tools')
    expect(result.effects).toEqual([expect.objectContaining({ kind: 'call_tool', callId: 'validate' })])

    for (const highRisk of [
      'python3 -c "print(1)"',
      'python3 -m unittest discover -s /tmp',
      'python3 -m py_compile ../server.py',
      'python3 -m py_compile server.py && git push --force origin main',
    ]) {
      expect(analyzeShellCommand(highRisk).requiresExplicitApproval, highRisk).toBe(true)
      const approval = step({ ...state, approvalMode: 'auto' }, {
        kind: 'llm_response',
        message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'auto', name: 'bash', input: { command: highRisk } }] },
      }, config)
      expect(approval.next.status, highRisk).toBe('awaiting_approval')
    }
    expect(analyzeShellCommand('rm -rf /').risk).toBe('blocked')
  })

  it('requires explicit approval for valid obfuscated scripts in auto mode', () => {
    for (const command of [
      'bash -c "$(printf git) reset --hard HEAD"',
      'bash <(printf "git reset --hard HEAD")',
      "alias safe='git reset --hard HEAD'; safe",
      'f(){ git reset --hard HEAD; }; f',
      'if true; then git reset --hard HEAD; fi',
      'source ./script.sh',
      'node -e \'require("child_process").execSync("git reset --hard HEAD")\'',
      "$'g'it reset --hard HEAD",
      '$COMMAND --hard HEAD',
      '$(printf git) reset --hard HEAD',
      '{ git reset --hard HEAD; }',
      'git -c alias.cleanup="!git reset --hard HEAD" cleanup',
      'git cleanup',
      'env --split-string=\'bash -c "git reset --hard HEAD"\'',
      "printf 'ignored\\n' | xargs -I{} bash -c 'git reset --hard HEAD'",
      'busybox sh -c "git reset --hard HEAD"',
      'git diff --ext-diff',
      'echo exploit | tee /etc/cron.d/example',
      "sed -e 'w /etc/cron.d/example' file.txt",
      'rg --pre "bash -c echo" pattern .',
    ]) {
      expect(analyzeShellCommand(command).risk, command).toBe('high_risk')
      const state = {
        ...createInitialState({ sessionId: 'shell-opaque' }),
        status: 'thinking' as const,
      }
      const result = step(state, {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_call',
            callId: 'opaque',
            name: 'bash',
            input: { command },
          }],
        },
      }, config)
      expect(result.next.status, command).toBe('awaiting_approval')
      expect(result.effects, command).toEqual([expect.objectContaining({ kind: 'request_approval', callId: 'opaque' })])
    }
  })
})
