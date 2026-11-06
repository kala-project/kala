import {
  analyzeShellCommand,
  formatShellSafetyBlock,
  type ShellSafetyReport,
  type ApprovalMode,
  type CallToolEffect,
} from '@agent-kernel/kernel'
import type { SessionRecord } from '../store/session.js'

export { analyzeShellCommand, formatShellSafetyBlock, splitShellSegments } from '@agent-kernel/kernel'
export type { ParsedSegment, ShellSafetyFinding, ShellSafetyReport, ShellSafetyRisk } from '@agent-kernel/kernel'

export function isShellToolName(name: string): boolean {
  return name === 'shell' || name === 'bash'
}

export function isHeadlessSubAgentSession(record: Pick<SessionRecord, 'parentSessionId' | 'delegationDepth'>): boolean {
  return record.parentSessionId !== undefined || (record.delegationDepth ?? 0) > 0
}

export function evaluateShellApprovalDecision(
  mode: ApprovalMode,
  schemaRequiresApproval: boolean,
  command: string,
  options?: {
    isSubAgent?: boolean
    autoApproveSafeReadonly?: boolean
  },
): {
  decision: 'dispatch' | 'ask' | 'reject'
  report: ShellSafetyReport
  rejectionMessage?: string
} {
  const report = analyzeShellCommand(command)

  if (report.risk === 'blocked') {
    return {
      decision: 'reject',
      report,
      rejectionMessage: formatShellSafetyBlock(report, { isSubAgent: options?.isSubAgent }),
    }
  }

  if (report.risk === 'high_risk') {
    if (mode === 'deny') {
      return {
        decision: 'reject',
        report,
        rejectionMessage: 'rejected: approval mode is "deny"',
      }
    }
    if (options?.isSubAgent) {
      return {
        decision: 'reject',
        report,
        rejectionMessage: formatShellSafetyBlock(report, { isSubAgent: true }),
      }
    }
    return {
      decision: 'ask',
      report,
    }
  }

  if (mode === 'allow_all') {
    return { decision: 'dispatch', report }
  }
  if (mode === 'ask') {
    return { decision: 'ask', report }
  }
  if (mode === 'deny') {
    return schemaRequiresApproval
      ? { decision: 'reject', report, rejectionMessage: 'rejected: approval mode is "deny"' }
      : { decision: 'dispatch', report }
  }
  if (options?.autoApproveSafeReadonly && report.risk === 'safe') {
    return { decision: 'dispatch', report }
  }
  return {
    decision: schemaRequiresApproval ? 'ask' : 'dispatch',
    report,
  }
}

export function guardShellToolDispatch(
  record: SessionRecord | undefined,
  effect: Pick<CallToolEffect, 'callId' | 'name' | 'input'>,
): string | null {
  if (!isShellToolName(effect.name)) return null
  const command = typeof effect.input?.command === 'string' ? effect.input.command : ''
  const report = analyzeShellCommand(command)
  if (report.risk === 'blocked') {
    return formatShellSafetyBlock(report, {
      isSubAgent: record ? isHeadlessSubAgentSession(record) : false,
    })
  }
  if (report.risk === 'high_risk') {
    const isSubAgent = record ? isHeadlessSubAgentSession(record) : false
    if (isSubAgent || !record?.state.pendingCalls.some((call) =>
      call.callId === effect.callId
      && call.name === effect.name
      && call.status === 'dispatched'
      && call.explicitlyApproved === true
      && call.input.command === command
    )) {
      return formatShellSafetyBlock(report, { isSubAgent })
    }
  }
  return null
}
