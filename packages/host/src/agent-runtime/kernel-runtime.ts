import type { AgentEvent, ApprovalMode } from '@agent-kernel/kernel'
import {
  KERNEL_AGENT_RUNTIME_CAPABILITIES,
  kernelRuntimeCompactionPolicy,
  type AgentRuntimeDescriptor,
  type CompactStatusEvent,
} from '@agent-kernel/shared'

import type { LoopHandle } from '../loop-types.js'
import type { SessionRecord, SessionStore } from '../store/session.js'
import { findPersistedToolResult } from '../store/log.js'
import type { AgentRuntime, AgentRuntimeSendInput } from './types.js'
import { currentKernelCompactStatus } from '../extensions/compaction.js'

export class KernelAgentRuntime implements AgentRuntime {
  readonly id = 'kernel' as const

  constructor(private readonly loop: LoopHandle, private readonly store?: Pick<SessionStore, 'findPersistedKernelToolResult'>) {}

  descriptor(): AgentRuntimeDescriptor {
    return {
      id: this.id,
      label: 'Kala',
      description: 'Agent Kernel deterministic reducer and host loop',
      available: true,
      status: 'ready',
      capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
      compactionPolicy: kernelRuntimeCompactionPolicy(),
    }
  }

  currentCompactStatus(sessionId: string): CompactStatusEvent | undefined {
    return currentKernelCompactStatus(sessionId)
  }

  async toolResultPersisted(record: SessionRecord, callId: string): Promise<boolean> {
    if (this.store) return await this.store.findPersistedKernelToolResult(record.sessionId, callId)
    return await findPersistedToolResult(record.logPath, callId, this.id)
  }

  async send(record: SessionRecord, input: AgentRuntimeSendInput): Promise<void> {
    await this.loop.dispatch(record.sessionId, {
      kind: 'user_message',
      text: input.text,
      ...(input.content ? { content: input.content } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.queuedAt ? { queuedAt: input.queuedAt } : {}),
    }, input.model ? { model: input.model } : undefined)
  }

  async cancel(record: SessionRecord): Promise<void> {
    await this.loop.dispatch(record.sessionId, { kind: 'cancel' })
  }

  async approve(record: SessionRecord, callId: string): Promise<void> {
    await this.dispatch(record, { kind: 'user_approve', callId })
  }

  async reject(record: SessionRecord, callId: string, reason?: string): Promise<void> {
    await this.dispatch(record, { kind: 'user_reject', callId, ...(reason ? { reason } : {}) })
  }

  async setApprovalMode(record: SessionRecord, mode: ApprovalMode): Promise<void> {
    await this.dispatch(record, { kind: 'approval_mode_changed', mode })
  }

  async compact(record: SessionRecord): Promise<void> {
    await this.loop.compact(record.sessionId, {
      trigger: 'manual',
      continuation: 'stay_resting',
    })
  }

  async close(): Promise<void> {}

  private async dispatch(record: SessionRecord, event: AgentEvent): Promise<void> {
    await this.loop.dispatch(record.sessionId, event)
  }
}
