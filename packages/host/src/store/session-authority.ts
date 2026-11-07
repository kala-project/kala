import type { SessionFsProvider } from '@github/copilot-sdk'
import type { EventEntry, RuntimeMetadataEntry } from '@agent-kernel/shared'

import type { ParsedHistory, SessionOperationMatch } from './log.js'
import type { NativePosixFileSystem } from './native-posix-fs.js'
import type { AgentBoardTransaction } from './agent-board-state.js'
import type { ChildCommandInbox } from './child-command-state.js'

export type PersistedSessionDocument = Record<string, unknown> & {
  sessionId: string
  state: { cursor: number }
}

export type SessionAuthorityMutation = {
  mutationId: string
  eventType: string
  entry?: EventEntry | RuntimeMetadataEntry
  /** Internal cross-Session fence used when child creation depends on a parent. */
  fenceSessionId?: string
  /** Internal deletion-state transitions are the only writes allowed after tombstoning. */
  allowDeletingSession?: boolean
  apply(current: PersistedSessionDocument | undefined): PersistedSessionDocument | undefined
}

/** Durable Session authority consumed by SessionStore, independent of its storage backend. */
export interface SessionAuthority {
  initialize(): Promise<void>
  agentBoardTransaction?: AgentBoardTransaction
  childCommandInbox?: ChildCommandInbox
  /** Internal cache epoch for the current live owner, never client routing authority.
   * Undefined means this replica has no writable cache. SQL fences remain mandatory.
   * Authorities without distributed ownership omit this hook. */
  currentOwnerCacheKey?(sessionId: string): string | undefined
  /** Native SDK files are independent rows/chunks, never Session document snapshots. */
  nativeSessionFs?(sessionId: string): SessionFsProvider
  /** Available only after explicit binary authority admission; never an empty-tree fallback. */
  nativePosixSessionFs?(sessionId: string): NativePosixFileSystem
  initializeEmptyNativePosixSession?(sessionId: string): Promise<void>
  load(sessionId: string): Promise<PersistedSessionDocument | undefined>
  mutate(sessionId: string, mutation: SessionAuthorityMutation): Promise<PersistedSessionDocument | undefined>
  create(
    document: PersistedSessionDocument,
    mutationId?: string,
    options?: { fenceSessionId?: string },
  ): Promise<PersistedSessionDocument>
  /** Atomically create a child and its first inbox command under independent parent/child fences. */
  createChildWithCommand?(
    document: PersistedSessionDocument,
    commandId: string,
    message: string,
    maxConcurrentChildren: number,
  ): Promise<PersistedSessionDocument>
  requestDeletion(sessionId: string, mutationId?: string): Promise<boolean>
  delete(sessionId: string, mutationId?: string): Promise<void>
  listDeleting(limit?: number, afterSessionId?: string): Promise<readonly PersistedSessionDocument[]>
  loadDeleting(sessionId: string): Promise<PersistedSessionDocument | undefined>
  list(sessionIds?: readonly string[]): Promise<readonly PersistedSessionDocument[]>
  /** Optional database-side projection for sidebar summaries; never load full transcripts on the hot path. */
  listSummaryDocuments?(sessionIds?: readonly string[]): Promise<readonly PersistedSessionDocument[]>
  findOperation(sessionId: string, operationId: string): Promise<SessionOperationMatch | undefined>
  findLatestRuntimeMetadata(sessionId: string, action: string): Promise<RuntimeMetadataEntry | undefined>
  readChildTurnEnds?(sessionId: string, commandId: string): Promise<readonly RuntimeMetadataEntry[]>
  /** Latest committed Copilot tool-call/result pair, fenced to the current child owner. */
  hasCommittedCopilotToolResult?(sessionId: string, callId: string): Promise<boolean>
  findCopilotToolRequest?(sessionId: string, callId: string): Promise<{ ownerGeneration: string; requestDigest: string } | undefined>
  readEventEntries(sessionId: string): Promise<readonly EventEntry[]>
  readHistory(sessionId: string): Promise<ParsedHistory>
}

export class SessionDeletingError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is being deleted`)
    this.name = 'SessionDeletingError'
  }
}
