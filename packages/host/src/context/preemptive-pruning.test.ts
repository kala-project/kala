import type { AgentConfig, Message } from '@agent-kernel/kernel'
import { describe, expect, it } from 'vitest'

import { createBuiltinExtensionRegistry } from '../extensions/builtin-registry.js'
import {
  PRUNED_TOOL_RESULT_PREFIX,
  buildPrunedToolResultStub,
  preemptivelyPruneToolResults,
  shouldPreemptivelyPrune,
} from './preemptive-pruning.js'

function makeTurnGroup(index: number, resultPayload: string, toolName = 'bash'): Message[] {
  const callId = `call-${index}`
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Running step ${index}` },
        { type: 'tool_call', callId, name: toolName, input: { command: `cmd-${index}` } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', callId, ok: true, content: resultPayload },
      ],
    },
  ]
}

const baseConfig: AgentConfig = {
  maxSteps: 25,
  contextLimit: 8_000,
  softThreshold: 0.65,
  hardThreshold: 0.90,
  tools: [],
  approvalPolicy: {},
}

describe('preemptive tool result pruning', () => {
  it('keeps Unicode code points intact and preserves the new spill pagination hint', () => {
    const body = `A${'😀'.repeat(500)}Z`
    const hint = "--- use `read_file { path: '/workspace/log.txt', offset: 0, limit: 1 }` to read more"
    const stub = buildPrunedToolResultStub(
      `${body}\n${hint}\n--- output truncated: 0 / 1 lines, 128 / 2000 bytes stored at overflow://call-1`,
      { callId: 'call-1', toolName: 'bash' },
    )
    expect(Buffer.from(stub, 'utf8').toString('utf8')).not.toContain('\uFFFD')
    expect(stub).toContain(hint)
    expect(stub).toContain('overflow://call-1')
  })

  it('does not prune when total tokens are below softThreshold', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Inspect repo' }] },
      ...makeTurnGroup(1, 'small output'),
    ]

    expect(shouldPreemptivelyPrune(messages, baseConfig, 8_000, { preserveRecentGroups: 0 })).toBe(false)
    const res = preemptivelyPruneToolResults(messages, baseConfig, 8_000, { preserveRecentGroups: 0 })
    expect(res.pruned).toBe(false)
    expect(res.messages).toBe(messages)
  })

  it('prunes older oversized tool_results while protecting recent turn groups and preserving tool_call pairing', () => {
    const hugeOutput1 = `FIRST_HEAD\n${'a'.repeat(8_000)}\nFIRST_TAIL\n\n--- output truncated: 400 / 1200 lines, 8000 / 24000 bytes stored at overflow://call-1\n--- use \`read_file { path: '/tmp/overflow/call-1.txt', offset: 200, limit: 200 }\` to read more`
    const hugeOutput2 = `SECOND_HEAD\n${'b'.repeat(8_000)}\nSECOND_TAIL`
    const recentHugeOutput = `RECENT_HEAD\n${'c'.repeat(6_000)}\nRECENT_TAIL`

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Start debugging' }] },
      ...makeTurnGroup(1, hugeOutput1, 'multi_grep'),
      ...makeTurnGroup(2, hugeOutput2, 'bash'),
      ...makeTurnGroup(3, 'short result 3'),
      ...makeTurnGroup(4, recentHugeOutput, 'read_file'),
    ]

    const res = preemptivelyPruneToolResults(messages, baseConfig, 6_000, {
      softRatio: 0.50,
      targetRatio: 0.30,
      preserveRecentGroups: 2,
      minPruneChars: 1_000,
    })

    expect(res.pruned).toBe(true)
    expect(res.prunedCount).toBe(2)
    expect(res.savedTokens).toBeGreaterThan(2_500)

    // Tool 1 & 2 (older than the 2 most-recent assistant groups) are pruned
    const toolMsg1 = res.messages[2]!
    const item1 = toolMsg1.content[0]!
    expect(item1.type).toBe('tool_result')
    if (item1.type === 'tool_result') {
      expect(item1.callId).toBe('call-1')
      expect(item1.content.startsWith(PRUNED_TOOL_RESULT_PREFIX)).toBe(true)
      expect(item1.content).toContain('tool=multi_grep')
      expect(item1.content).toContain('FIRST_HEAD')
      expect(item1.content).toContain('FIRST_TAIL')
      expect(item1.content).toContain('overflow://call-1')
      expect(item1.content).toContain('/tmp/overflow/call-1.txt')
    }

    // Tool 4 (within the last 2 protected assistant groups) is untouched!
    const toolMsg4 = res.messages[8]!
    const item4 = toolMsg4.content[0]!
    expect(item4.type).toBe('tool_result')
    if (item4.type === 'tool_result') {
      expect(item4.content).toBe(recentHugeOutput)
    }

    // Idempotent on second pass
    const secondPass = preemptivelyPruneToolResults(res.messages, baseConfig, 6_000, {
      softRatio: 0.50,
      targetRatio: 0.30,
      preserveRecentGroups: 2,
      minPruneChars: 1_000,
    })
    expect(secondPass.pruned).toBe(false)
    expect(secondPass.prunedCount).toBe(0)
  })

  it('calls durable compaction rather than returning an ephemeral pruning result at preflight', async () => {
    const registry = createBuiltinExtensionRegistry()
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Investigate build failure' }] },
      ...makeTurnGroup(1, `BUILD_LOG_1\n${'x'.repeat(16_000)}\nEND_1`, 'bash'),
      ...makeTurnGroup(2, `BUILD_LOG_2\n${'y'.repeat(16_000)}\nEND_2`, 'bash'),
      ...Array.from({ length: 6 }, (_, idx) => makeTurnGroup(idx + 3, `recent-${idx}`)).flat(),
    ]

    let compactCalled = false
    let committedMessages: readonly Message[] = messages
    const config: AgentConfig = {
      ...baseConfig,
      contextLimit: 12_000,
      softThreshold: 0.60,
      hardThreshold: 0.90,
    }

    const resultMessages = await registry.beforeModelCall({
      deps: {
        models: {
          get: () => 'test-model',
          set: () => {},
          contextWindow: () => 12_000,
        },
      } as never,
      sessionId: 'sess-prune-1',
      config,
      effect: { kind: 'call_llm', messages, tools: [] },
      messages,
      requiresCompaction: true,
      compact: async () => {
        compactCalled = true
        committedMessages = preemptivelyPruneToolResults(messages, config, 12_000).messages
        return true
      },
      messagesAfterCompaction: () => committedMessages,
    })

    expect(compactCalled).toBe(true)
    expect(resultMessages).toBe(committedMessages)
    const firstTool = resultMessages[2]!.content[0]!
    expect(firstTool.type).toBe('tool_result')
    if (firstTool.type === 'tool_result') {
      expect(firstTool.content.startsWith(PRUNED_TOOL_RESULT_PREFIX)).toBe(true)
    }
  })
})
