import { describe, expect, it } from 'vitest'

import {
  getSubAgentRoleTemplate,
  isSubAgentRole,
  resolveSubAgentPolicy,
  SUB_AGENT_ROLE_TEMPLATES,
} from '@agent-kernel/shared/enhancement'

describe('resolveSubAgentPolicy', () => {
  it('applies aggressive no-role defaults when input is undefined', () => {
    const policy = resolveSubAgentPolicy({})
    expect(policy.reasons).toEqual([])
    expect(policy.role).toBeUndefined()
    expect(policy.allowedTools).toBeUndefined()
    expect(policy.maxTurns).toBe(180)
    expect(policy.idleTimeoutMs).toBe(45 * 60_000)
    expect(policy.toolIdleTimeoutMs).toBe(120 * 60_000)
    expect(policy.timeoutMs).toBe(4 * 60 * 60_000)
    expect(policy.gracePeriodMs).toBe(5 * 60_000)
  })

  it('retains explicit intention independently from the legacy objective alias', () => {
    const policy = resolveSubAgentPolicy({ input: { intention: 'Inspect the runtime projection.', objective: 'legacy objective' } })
    expect(policy.intention).toBe('Inspect the runtime projection.')
    expect(policy.objective).toBe('legacy objective')
  })

  it('applies the research role template as defaults', () => {
    const policy = resolveSubAgentPolicy({ input: { role: 'research' } })
    expect(policy.role).toBe('research')
    expect(policy.reasons).toContain('role_template_applied')
    expect(policy.allowedTools).toEqual(SUB_AGENT_ROLE_TEMPLATES.research.defaultAllowedTools)
    expect(policy.maxTurns).toBe(SUB_AGENT_ROLE_TEMPLATES.research.defaultMaxTurns)
    expect(policy.timeoutMs).toBe(SUB_AGENT_ROLE_TEMPLATES.research.defaultTimeoutMs)
    expect(policy.expectedOutput).toBe(SUB_AGENT_ROLE_TEMPLATES.research.defaultExpectedOutput)
  })

  it('caps caller-supplied maxTurns and timeoutMs at the template maximum', () => {
    const policy = resolveSubAgentPolicy({
      input: {
        role: 'review',
        maxTurns: 999,
        timeoutMs: 24 * 60 * 60_000,
      },
    })

    expect(policy.maxTurns).toBe(SUB_AGENT_ROLE_TEMPLATES.review.maximumMaxTurns)
    expect(policy.timeoutMs).toBe(SUB_AGENT_ROLE_TEMPLATES.review.maximumTimeoutMs)
    expect(policy.reasons).toContain('policy_max_turns_capped')
    expect(policy.reasons).toContain('policy_timeout_capped')
  })

  it('intersects explicit allowedTools with template defaults', () => {
    const policy = resolveSubAgentPolicy({
      input: {
        role: 'research',
        allowedTools: ['read_file', 'shell', 'unknown_tool'],
      },
    })
    expect(policy.allowedTools).toEqual(['read_file'])
    expect(policy.reasons).toContain('policy_allowed_tools_intersected')
  })

  it('intersects allowedTools with parent-available tools', () => {
    const policy = resolveSubAgentPolicy({
      input: { role: 'test' },
      parentTools: ['read_file', 'ls'],
    })
    expect(policy.allowedTools).toEqual(['read_file', 'ls'])
    expect(policy.reasons).toContain('policy_allowed_tools_intersected')
  })

  it('gives the implementation role controlled file mutation tools', () => {
    const policy = resolveSubAgentPolicy({
      input: { role: 'implementation' },
      parentTools: ['read_file', 'write_file', 'replace_in_file', 'replace_many_in_file', 'apply_file_patch', 'shell', 'agent'],
    })
    expect(policy.allowedTools).toEqual(expect.arrayContaining(['read_file', 'write_file', 'replace_in_file', 'replace_many_in_file', 'apply_file_patch', 'shell']))
    expect(policy.allowedTools).not.toContain('agent')
  })

  it('marks unknown roles', () => {
    const policy = resolveSubAgentPolicy({
      input: { role: 'unknown' as unknown as 'research' },
    })
    expect(policy.reasons).toContain('role_unknown')
    expect(policy.reasons).not.toContain('role_template_applied')
  })

  it('preserves small explicit caller ceilings without adding a default cancellation grace', () => {
    const policy = resolveSubAgentPolicy({
      input: { role: 'test', maxTurns: 5, timeoutMs: 30_000 },
    })
    expect(policy.maxTurns).toBe(5)
    expect(policy.timeoutMs).toBe(30_000)
    expect(policy.gracePeriodMs).toBe(0)
    expect(policy.reasons).not.toContain('policy_max_turns_raised')
    expect(policy.reasons).not.toContain('policy_timeout_raised')
  })

  it('records depth cap when parent depth reaches max depth', () => {
    const policy = resolveSubAgentPolicy({ parentDepth: 3, maxDepth: 3 })
    expect(policy.resolvedDepth).toBe(3)
    expect(policy.maxDepth).toBe(3)
    expect(policy.reasons).toContain('policy_max_depth_exceeded')
  })

  it('leaves depth reason clean under the cap', () => {
    const policy = resolveSubAgentPolicy({ parentDepth: 1, maxDepth: 3 })
    expect(policy.resolvedDepth).toBe(1)
    expect(policy.maxDepth).toBe(3)
    expect(policy.reasons).not.toContain('policy_max_depth_exceeded')
  })

  it('records fan-out cap when concurrent siblings reach max fan-out', () => {
    const policy = resolveSubAgentPolicy({ concurrentSiblingCount: 4, maxFanOut: 4 })
    expect(policy.concurrentSiblingCount).toBe(4)
    expect(policy.maxFanOut).toBe(4)
    expect(policy.reasons).toContain('policy_max_fanout_exceeded')
  })

  it('leaves fan-out reason clean under the cap', () => {
    const policy = resolveSubAgentPolicy({ concurrentSiblingCount: 1, maxFanOut: 4 })
    expect(policy.concurrentSiblingCount).toBe(1)
    expect(policy.maxFanOut).toBe(4)
    expect(policy.reasons).not.toContain('policy_max_fanout_exceeded')
  })
})

describe('SubAgent role registry', () => {
  it('exposes deterministic templates for each role', () => {
    for (const role of ['research', 'implementation', 'test', 'review'] as const) {
      const template = getSubAgentRoleTemplate(role)
      expect(template).toBeDefined()
      expect(template?.role).toBe(role)
      expect(template?.defaultAllowedTools.length).toBeGreaterThan(0)
      expect(template?.defaultAllowedTools).toContain('todo_graph')
      expect(template?.defaultAllowedTools).not.toContain('todowrite')
    }
  })

  it('rejects non-role strings', () => {
    expect(isSubAgentRole('research')).toBe(true)
    expect(isSubAgentRole('build')).toBe(false)
    expect(isSubAgentRole(42)).toBe(false)
  })
})
