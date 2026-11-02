import type { SessionFsProvider } from '@github/copilot-sdk'
import type { EventEntry, RuntimeMetadataEntry } from '@agent-kernel/shared'

import type { ParsedHistory, SessionOperationMatch } from './log.js'

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
  /** Native SDK files are independent rows/chunks, never Session document snapshots. */
  nativeSessionFs?(sessionId: string): SessionFsProvider
  load(sessionId: string): Promise<PersistedSessionDocument | undefined>
  mutate(sessionId: string, mutation: SessionAuthorityMutation): Promise<PersistedSessionDocument | undefined>
  create(
    document: PersistedSessionDocument,
    mutationId?: string,
    options?: { fenceSessionId?: string },
  ): Promise<PersistedSessionDocument>
  requestDeletion(sessionId: string, mutationId?: string): Promise<boolean>
  delete(sessionId: string, mutationId?: string): Promise<void>
  listDeleting(limit?: number, afterSessionId?: string): Promise<readonly PersistedSessionDocument[]>
  loadDeleting(sessionId: string): Promise<PersistedSessionDocument | undefined>
  list(): Promise<readonly PersistedSessionDocument[]>
  findOperation(sessionId: string, operationId: string): Promise<SessionOperationMatch | undefined>
  findLatestRuntimeMetadata(sessionId: string, action: string): Promise<RuntimeMetadataEntry | undefined>
  readEventEntries(sessionId: string): Promise<readonly EventEntry[]>
  readHistory(sessionId: string): Promise<ParsedHistory>
}

export class SessionDeletingError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is being deleted`)
    this.name = 'SessionDeletingError'
  }
}
