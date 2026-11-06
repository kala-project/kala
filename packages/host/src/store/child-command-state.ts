export type ChildCommandKind = 'message' | 'stop'

export type ChildCommand = {
  commandId: string
  parentSessionId: string
  childSessionId: string
  kind: ChildCommandKind
  message?: string
  status: 'pending' | 'claimed' | 'completed'
  ownerGeneration?: string
  /** Transient claim result: a previous owner had already claimed this head. */
  reclaimed?: boolean
  /** Once set, takeover must reconcile the previous execution, not resend the command. */
  dispatchedAt?: string
  /** Original turn owner; never replaced on takeover. */
  dispatchedOwnerGeneration?: string
  outcome?: { ok: boolean; content: string }
  completedAt?: string
  timeoutMs?: number
  maxTurns?: number
}

export type ChildCompletionNotice = ChildCommand & { completedAt: string; sequence: string }

export type ChildCommandInbox = {
  /** Bounded discovery for the child-owner worker; claim still enforces the SQL fence. */
  pendingChildSessionIds(limit?: number, afterSessionId?: string): Promise<readonly string[]>
  hasStopBarrier(childSessionId: string): Promise<boolean>
  /** A dispatched message ahead of this Stop cannot be declared stopped without its durable turn terminal. */
  hasUnconfirmedMessageBeforeStop(childSessionId: string, stopCommandId: string): Promise<boolean>
  /** Child-owner-fenced timeout barrier; no parent owner lease is acquired. */
  enqueueTimedOutChildStop(childSessionId: string, stopCommandId: string, messageCommandId?: string): Promise<ChildCommand | undefined>
  enqueueChildCommand(
    parentSessionId: string,
    childSessionId: string,
    commandId: string,
    kind: ChildCommandKind,
    message?: string,
    maxConcurrentChildren?: number,
    budget?: { timeoutMs?: number; maxTurns?: number },
  ): Promise<ChildCommand>
  readActiveChildMessage(childSessionId: string): Promise<ChildCommand | undefined>
  claimChildCommand(childSessionId: string): Promise<ChildCommand | undefined>
  /** Out-of-band Stop is not blocked by a running or indeterminate message. */
  claimChildStop(childSessionId: string): Promise<ChildCommand | undefined>
  /** Strict recovery refuses an already-recorded dispatch rather than risking a second send. */
  markChildCommandDispatched(childSessionId: string, commandId: string, onlyIfUndispatched?: boolean): Promise<ChildCommand>
  completeChildCommand(
    childSessionId: string,
    commandId: string,
    outcome: { ok: boolean; content: string },
  ): Promise<ChildCommand>
  readChildCommands(parentSessionId: string, childSessionId: string): Promise<readonly ChildCommand[]>
  /** Read-only dashboard projection, never used to claim or dispatch. */
  readChildCommandsForDashboard(parentSessionId: string, childSessionId?: string): Promise<readonly ChildCommand[]>
  /** Finished initial commands are delivered by the parent owner, not the child owner. */
  pendingFinishedParentSessionIds(limit?: number, afterSessionId?: string): Promise<readonly string[]>
  readPendingChildCompletions(parentSessionId: string, limit?: number): Promise<readonly ChildCompletionNotice[]>
  acknowledgeChildCompletion(parentSessionId: string, childSessionId: string, commandId: string): Promise<void>
  /** Read-only room fanout: subscribers on any replica can observe confirmed initial completions. */
  readFinishedChildCompletions(
    parentSessionId: string,
    since?: { sequence: string },
    limit?: number,
  ): Promise<readonly ChildCompletionNotice[]>
}
