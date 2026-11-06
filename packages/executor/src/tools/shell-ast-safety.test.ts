import { describe, expect, it } from 'vitest'
import { analyzeShellCommand as analyzeKernelShellCommand } from '@agent-kernel/kernel'

import { bashTool } from './bash.js'
import { analyzeShellCommand } from './shell-ast-safety.js'

describe('Executor shell admission', () => {
  const context = {
    sessionId: 'direct-invocation',
    callId: 'direct-shell',
    sandbox: { roots: [] },
    signal: new AbortController().signal,
  } as Parameters<typeof bashTool.run>[1]

  it('uses the kernel classifier and rejects obfuscated commands without Host proof before spawning', async () => {
    expect(analyzeShellCommand).toBe(analyzeKernelShellCommand)
    for (const command of [
      'bash -c "$(printf git) reset --hard HEAD"',
      'bash <(printf "git reset --hard HEAD")',
      "$'g'it reset --hard HEAD",
      'f(){ git reset --hard HEAD; }; f',
      'node -e \'require("child_process").execSync("git reset --hard HEAD")\'',
    ]) {
      expect(analyzeShellCommand(command).risk, command).toBe('high_risk')
      await expect(bashTool.run({ command }, context)).rejects.toThrow(/requires verified Host approval/)
    }
  })

  it('does not allow approval context to override a blocked parser failure', async () => {
    await expect(bashTool.run(
      { command: 'echo "$(git reset --hard' },
      { ...context, shellApprovalVerified: true },
    )).rejects.toThrow(/shell\.parse\.incomplete/)
  })
})
