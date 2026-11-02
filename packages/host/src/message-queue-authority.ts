import type { QueuedUserMessage } from './connection/dashboard-ns.js'
import type { PersistedMessageQueueState } from './message-queue-store.js'

// Keep both queue implementations on the same runtime error identity until the
// PostgreSQL store is moved to this contract by its owner.
export { QueueClaimFencedError, QueueItemClaimedError } from './postgres-message-queue.js'

export type MessageQueueClaim = {
  sessionId: string
  item: QueuedUserMessage
  ownerId: string
  generation: bigint
  expiresAt: Date
}

export type MessageQueueMutation = {
  state: PersistedMessageQueueState
  changed: boolean
}

export type MessageQueueClaimResult = {
  claim?: MessageQueueClaim
  state: PersistedMessageQueueState
  executionUnknown?: boolean
}

/** Storage-neutral queue operations used by Host's durable dispatch flow. */
export interface MessageQueueAuthority {
  initialize(): Promise<void>
  load(sessionId: string): Promise<PersistedMessageQueueState>
  loadOrInitialize(
    sessionId: string,
    legacyLoader: () => Promise<PersistedMessageQueueState>,
  ): Promise<PersistedMessageQueueState>
  enqueue(
    sessionId: string,
    item: QueuedUserMessage,
    priority: 'front' | 'back',
  ): Promise<MessageQueueMutation>
  reorder(sessionId: string, id: string, beforeId?: string): Promise<MessageQueueMutation>
  update(sessionId: string, id: string, replacement: QueuedUserMessage): Promise<MessageQueueMutation>
  delete(sessionId: string, id: string): Promise<MessageQueueMutation>
  stop(sessionId: string): Promise<MessageQueueMutation>
  claimHead(sessionId: string, ownerId: string, ttlMs: number): Promise<MessageQueueClaimResult>
  confirmClaim(claim: MessageQueueClaim): Promise<boolean>
  completeClaim(claim: MessageQueueClaim): Promise<MessageQueueMutation>
  persistShellResult(
    claim: MessageQueueClaim,
    shell: NonNullable<QueuedUserMessage['shell']>,
  ): Promise<MessageQueueMutation>
  renewClaim(claim: MessageQueueClaim, ttlMs: number): Promise<MessageQueueClaim>
  releaseClaim(claim: MessageQueueClaim): Promise<boolean>
  markExecutionUnknown?(claim: MessageQueueClaim): Promise<MessageQueueMutation>
}
