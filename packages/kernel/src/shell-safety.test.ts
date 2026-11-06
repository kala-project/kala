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

  it('requires explicit approval for valid obfuscated scripts even under allow_all', () => {
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
        ...createInitialState({ sessionId: 'shell-opaque', approvalMode: 'allow_all' }),
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
