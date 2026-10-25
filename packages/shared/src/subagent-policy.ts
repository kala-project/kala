export type SubAgentRole = 'research' | 'implementation' | 'test' | 'review'

export type SubAgentPolicyReasonCode =
  | 'role_template_applied'
  | 'role_unknown'
  | 'policy_max_turns_capped'
  | 'policy_max_turns_raised'
  | 'policy_timeout_capped'
  | 'policy_timeout_raised'
  | 'policy_allowed_tools_intersected'
  | 'policy_max_depth_exceeded'
  | 'policy_max_fanout_exceeded'

export type SubAgentPolicyInput = {
  role?: SubAgentRole
  /** User-facing description of why this child is being delegated. */
  intention?: string
  /** Backward-compatible alias retained for older agent calls and artifacts. */
  objective?: string
  allowedTools?: readonly string[]
  maxTurns?: number
  timeoutMs?: number
  expectedOutput?: string
}

export type SubAgentPolicy = {
  role?: SubAgentRole
  intention?: string
  objective?: string
  allowedTools?: readonly string[]
  maxTurns?: number
  idleTimeoutMs?: number
  toolIdleTimeoutMs?: number
  timeoutMs?: number
  gracePeriodMs?: number
  expectedOutput?: string
  /**
   * Depth cap the host is enforcing for this sub-agent call. `resolvedDepth`
   * is the depth of the *parent* session at the time of the call (0 = root
   * session). When `resolvedDepth >= maxDepth`, the host refuses to spawn a
   * child and records `policy_max_depth_exceeded` in `reasons`.
   */
  maxDepth?: number
  resolvedDepth?: number
  /**
   * Fan-out cap for concurrent sibling sub-agents under the same parent.
   * `concurrentSiblingCount` is the number of live sub-agents already
   * running under the parent when this call is dispatched.
   */
  maxFanOut?: number
  concurrentSiblingCount?: number
  reasons: readonly SubAgentPolicyReasonCode[]
}

export type SubAgentRoleTemplate = {
  role: SubAgentRole
  purpose: string
  defaultAllowedTools: readonly string[]
  defaultMaxTurns: number
  /** Legacy workload-sizing guidance, never an explicit caller-budget floor. */
  minimumMaxTurns: number
  maximumMaxTurns: number
  defaultIdleTimeoutMs: number
  defaultToolIdleTimeoutMs: number
  defaultTimeoutMs: number
  /** Legacy workload-sizing guidance, never an explicit caller-budget floor. */
  minimumTimeoutMs: number
  maximumTimeoutMs: number
  defaultGracePeriodMs: number
  defaultExpectedOutput: string
}

export const SUB_AGENT_ROLE_TEMPLATES: Readonly<Record<SubAgentRole, SubAgentRoleTemplate>> = {
  research: {
    role: 'research', purpose: 'Read files and return a concise report with references.',
    defaultAllowedTools: ['read_file', 'read_files', 'multi_grep', 'glob', 'ls', 'websearch', 'webfetch', 'todo_graph'],
    defaultMaxTurns: 180, minimumMaxTurns: 25, maximumMaxTurns: 360,
    defaultIdleTimeoutMs: 45 * 60_000, defaultToolIdleTimeoutMs: 120 * 60_000,
    defaultTimeoutMs: 4 * 60 * 60_000, minimumTimeoutMs: 30 * 60_000, maximumTimeoutMs: 8 * 60 * 60_000,
    defaultGracePeriodMs: 5 * 60_000,
    defaultExpectedOutput: 'Structured summary with file:line references.',
  },
  implementation: {
    role: 'implementation', purpose: 'Implement a bounded change in the shared workspace and verify it without reverting unrelated work.',
    defaultAllowedTools: ['read_file', 'read_files', 'multi_grep', 'glob', 'ls', 'write_file', 'replace_in_file', 'replace_many_in_file', 'apply_file_patch', 'shell', 'bash_output', 'kill_shell', 'todo_graph'],
    defaultMaxTurns: 240, minimumMaxTurns: 40, maximumMaxTurns: 480,
    defaultIdleTimeoutMs: 45 * 60_000, defaultToolIdleTimeoutMs: 120 * 60_000,
    defaultTimeoutMs: 6 * 60 * 60_000, minimumTimeoutMs: 60 * 60_000, maximumTimeoutMs: 12 * 60 * 60_000,
    defaultGracePeriodMs: 5 * 60_000,
    defaultExpectedOutput: 'Implemented files, verification evidence, and remaining risks.',
  },
  test: {
    role: 'test', purpose: 'Run focused tests and report failure causes.',
    defaultAllowedTools: ['read_file', 'read_files', 'multi_grep', 'glob', 'ls', 'shell', 'bash_output', 'kill_shell', 'todo_graph'],
    defaultMaxTurns: 200, minimumMaxTurns: 30, maximumMaxTurns: 400,
    defaultIdleTimeoutMs: 45 * 60_000, defaultToolIdleTimeoutMs: 120 * 60_000,
    defaultTimeoutMs: 5 * 60 * 60_000, minimumTimeoutMs: 45 * 60_000, maximumTimeoutMs: 10 * 60 * 60_000,
    defaultGracePeriodMs: 5 * 60_000,
    defaultExpectedOutput: 'Failing test names, first-failure reasons, and next actions.',
  },
  review: {
    role: 'review', purpose: 'Inspect the final diff and report risks before answer.',
    defaultAllowedTools: ['read_file', 'read_files', 'multi_grep', 'glob', 'ls', 'todo_graph'],
    defaultMaxTurns: 120, minimumMaxTurns: 20, maximumMaxTurns: 240,
    defaultIdleTimeoutMs: 30 * 60_000, defaultToolIdleTimeoutMs: 90 * 60_000,
    defaultTimeoutMs: 3 * 60 * 60_000, minimumTimeoutMs: 20 * 60_000, maximumTimeoutMs: 6 * 60 * 60_000,
    defaultGracePeriodMs: 3 * 60_000,
    defaultExpectedOutput: 'Ranked list of risks/regressions with file references.',
  },
}

export const DEFAULT_SUB_AGENT_POLICY = {
  defaultMaxTurns: 180, minimumMaxTurns: 20, maximumMaxTurns: 360,
  defaultIdleTimeoutMs: 45 * 60_000, defaultToolIdleTimeoutMs: 120 * 60_000,
  defaultTimeoutMs: 4 * 60 * 60_000, minimumTimeoutMs: 30 * 60_000, maximumTimeoutMs: 8 * 60 * 60_000,
  defaultGracePeriodMs: 5 * 60_000,
} as const

export function getSubAgentRoleTemplate(role: SubAgentRole | undefined): SubAgentRoleTemplate | undefined {
  return role ? SUB_AGENT_ROLE_TEMPLATES[role] : undefined
}

export function isSubAgentRole(value: unknown): value is SubAgentRole {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUB_AGENT_ROLE_TEMPLATES, value)
}

export type ResolveSubAgentPolicyInput = {
  input?: SubAgentPolicyInput
  parentTools?: readonly string[]
  /**
   * Depth of the parent session (0 = root session). When paired with
   * `maxDepth`, the resolver records `policy_max_depth_exceeded` when the
   * parent is already at the depth cap.
   */
  parentDepth?: number
  maxDepth?: number
  /**
   * Number of sub-agents currently running under the parent. When paired with
   * `maxFanOut`, the resolver records `policy_max_fanout_exceeded` when the
   * parent has already reached the cap.
   */
  concurrentSiblingCount?: number
  maxFanOut?: number
}

export function resolveSubAgentPolicy({
  input,
  parentTools,
  parentDepth,
  maxDepth,
  concurrentSiblingCount,
  maxFanOut,
}: ResolveSubAgentPolicyInput): SubAgentPolicy {
  const reasons: SubAgentPolicyReasonCode[] = []
  const template = input?.role ? SUB_AGENT_ROLE_TEMPLATES[input.role] : undefined
  const requestedRole = input?.role
  if (requestedRole && !template) {
    reasons.push('role_unknown')
  }
  if (template) {
    reasons.push('role_template_applied')
  }

  const templateAllowed = template?.defaultAllowedTools
  const explicitAllowed = input?.allowedTools
  let allowedTools: readonly string[] | undefined
  if (explicitAllowed && templateAllowed) {
    const templateSet = new Set(templateAllowed)
    allowedTools = explicitAllowed.filter((tool) => templateSet.has(tool))
    if (allowedTools.length !== explicitAllowed.length) reasons.push('policy_allowed_tools_intersected')
  } else {
    allowedTools = explicitAllowed ?? templateAllowed
  }
  if (allowedTools && parentTools && parentTools.length > 0) {
    const parentSet = new Set(parentTools)
    const beforeCount = allowedTools.length
    allowedTools = allowedTools.filter((tool) => parentSet.has(tool))
    if (allowedTools.length !== beforeCount && !reasons.includes('policy_allowed_tools_intersected')) {
      reasons.push('policy_allowed_tools_intersected')
    }
  }

  const bounds = template ?? DEFAULT_SUB_AGENT_POLICY
  let maxTurns = input?.maxTurns ?? bounds.defaultMaxTurns
  if (input?.maxTurns !== undefined && input.maxTurns > bounds.maximumMaxTurns) {
    maxTurns = bounds.maximumMaxTurns
    reasons.push('policy_max_turns_capped')
  }

  let timeoutMs = input?.timeoutMs ?? bounds.defaultTimeoutMs
  if (input?.timeoutMs !== undefined && input.timeoutMs > bounds.maximumTimeoutMs) {
    timeoutMs = bounds.maximumTimeoutMs
    reasons.push('policy_timeout_capped')
  }

  const idleTimeoutMs = bounds.defaultIdleTimeoutMs
  const toolIdleTimeoutMs = bounds.defaultToolIdleTimeoutMs
  // Caller-specified ceilings must not expand to a role floor or an extra
  // five-minute grace. Defaults retain their existing long-work behavior.
  const gracePeriodMs = input?.maxTurns !== undefined || input?.timeoutMs !== undefined
    ? 0
    : bounds.defaultGracePeriodMs
  const expectedOutput = input?.expectedOutput ?? template?.defaultExpectedOutput

  if (
    typeof parentDepth === 'number' &&
    typeof maxDepth === 'number' &&
    Number.isFinite(parentDepth) &&
    Number.isFinite(maxDepth) &&
    parentDepth >= maxDepth
  ) {
    reasons.push('policy_max_depth_exceeded')
  }
  if (
    typeof concurrentSiblingCount === 'number' &&
    typeof maxFanOut === 'number' &&
    Number.isFinite(concurrentSiblingCount) &&
    Number.isFinite(maxFanOut) &&
    concurrentSiblingCount >= maxFanOut
  ) {
    reasons.push('policy_max_fanout_exceeded')
  }

  const policy: SubAgentPolicy = {
    ...(input?.role ? { role: input.role } : {}),
    ...(input?.intention ? { intention: input.intention } : {}),
    ...(input?.objective ? { objective: input.objective } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    maxTurns,
    idleTimeoutMs,
    toolIdleTimeoutMs,
    timeoutMs,
    gracePeriodMs,
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(typeof maxDepth === 'number' && Number.isFinite(maxDepth) ? { maxDepth } : {}),
    ...(typeof parentDepth === 'number' && Number.isFinite(parentDepth) ? { resolvedDepth: parentDepth } : {}),
    ...(typeof maxFanOut === 'number' && Number.isFinite(maxFanOut) ? { maxFanOut } : {}),
    ...(typeof concurrentSiblingCount === 'number' && Number.isFinite(concurrentSiblingCount)
      ? { concurrentSiblingCount }
      : {}),
    reasons,
  }
  return policy
}
