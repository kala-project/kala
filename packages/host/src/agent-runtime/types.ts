import type { AgentState, ApprovalMode, Message, MessageContent } from '@agent-kernel/kernel'
import type {
  AgentRuntimeDescriptor,
  AgentRuntimeId,
  CompactStatusEvent,
  ContextUsageSnapshot,
} from '@agent-kernel/shared'

import type { SessionRecord, SessionStore } from '../store/session.js'
import type { ToolDispatcher } from '../loop-types.js'
import type { MessageAttachmentStorage } from '../message-attachment-store.js'

export type AgentRuntimeBroadcast = {
  onState(record: SessionRecord, state: AgentState, contextSnapshot?: ContextUsageSnapshot): void
  onTokenDelta(sessionId: string, text: string): void
  onApprovalRequired(sessionId: string): void
  onError(sessionId: string, message: string): void
  onCompactStatus?(payload: CompactStatusEvent): void
}

export type AgentRuntimeContext = {
  store: SessionStore
  tools: ToolDispatcher
  /** Optional fail-closed owner check before sending the SDK's model request. */
  assertSessionEffectOwner?: (sessionId: string) => Promise<void>
  broadcast: AgentRuntimeBroadcast
  messageAttachments?: MessageAttachmentStorage
  publishLocalImages?: (sessionId: string, record: SessionRecord, message: Message) => Promise<Message>
}

export type AgentRuntimeSendInput = {
  text: string
  content?: readonly MessageContent[]
  model?: string
  operationId?: string
  queuedAt?: string
}

export interface AgentRuntime {
  readonly id: AgentRuntimeId
  descriptor(): AgentRuntimeDescriptor
  /** Used by a deployment initiated inside a Session; must only report durable Tool results. */
  toolResultPersisted(record: SessionRecord, callId: string): Promise<boolean>
  send(record: SessionRecord, input: AgentRuntimeSendInput): Promise<void>
  cancel(record: SessionRecord): Promise<void>
  approve(record: SessionRecord, callId: string): Promise<void>
  reject(record: SessionRecord, callId: string, reason?: string): Promise<void>
  setApprovalMode(record: SessionRecord, mode: ApprovalMode): Promise<void>
  setModel?(record: SessionRecord, model: string): Promise<void>
  compact(record: SessionRecord): Promise<void>
  currentCompactStatus?(sessionId: string): CompactStatusEvent | undefined
  confirmModelChange?(record: SessionRecord, from: string | undefined, to: string): Promise<void>
  delete?(record: SessionRecord): Promise<void>
  close(): Promise<void>
}

export class AgentRuntimeRegistry {
  private readonly runtimes = new Map<AgentRuntimeId, AgentRuntime>()

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.id, runtime)
  }

  get(id: AgentRuntimeId): AgentRuntime | undefined {
    return this.runtimes.get(id)
  }

  require(id: AgentRuntimeId): AgentRuntime {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error(`agent runtime is not registered: ${id}`)
    const descriptor = runtime.descriptor()
    if (!descriptor.available) {
      throw new Error(descriptor.reason ?? `agent runtime is unavailable: ${id}`)
    }
    return runtime
  }

  catalog(): AgentRuntimeDescriptor[] {
    return [...this.runtimes.values()].map((runtime) => runtime.descriptor())
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.close()))
  }
}
