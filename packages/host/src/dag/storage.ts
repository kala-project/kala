import type {
  DagDecision,
  DagGraphPatch,
  DagNode,
  DagRun,
  DagToolActivity,
} from '@agent-kernel/shared'

export type Awaitable<T> = T | Promise<T>

/** A claimed node carries the monotonically increasing fence for its lease. */
export type ClaimedDagNode = DagNode & { leaseGeneration: number }

/**
 * Structural DAG persistence contract. Local SQLite implementations may return
 * synchronously; runtime callers await every result so Private Cloud can use PG.
 */
export interface DagStorage {
  createRun(parentSessionId: string, objective: string, operationId: string, now?: string): Awaitable<DagRun>
  runForSession(parentSessionId: string): Awaitable<DagRun | undefined>
  runsForSession(parentSessionId: string): Awaitable<readonly DagRun[]>
  activeParentSessionIds(): Awaitable<readonly string[]>
  getRun(runId: string): Awaitable<DagRun | undefined>
  installGraph(runId: string, patch: DagGraphPatch, operationId: string, now?: string): Awaitable<DagRun>
  replaceGraph(runId: string, patch: DagGraphPatch, operationId: string, now?: string): Awaitable<DagRun>
  expandNode(runId: string, nodeId: string, workerId: string, patch: DagGraphPatch, operationId: string, now?: string, leaseGeneration?: number): Awaitable<DagRun>
  claimReadyNodes(runId: string, workerId: string, limit: number, leaseMs: number, now?: Date): Awaitable<readonly ClaimedDagNode[]>
  attachChildSession(runId: string, nodeId: string, workerId: string, childSessionId: string, now?: string, leaseGeneration?: number): Awaitable<void>
  updateNodeProgress(runId: string, nodeId: string, workerId: string, progress: string, now?: string, leaseGeneration?: number): Awaitable<DagRun>
  renewLease(runId: string, nodeId: string, workerId: string, leaseMs: number, now?: Date, leaseGeneration?: number): Awaitable<void>
  completeNode(
    runId: string,
    nodeId: string,
    workerId: string,
    outcome: ({ status: 'succeeded'; result: string } | { status: 'failed' | 'cancelled'; error: string }) & { toolActivity?: readonly DagToolActivity[] },
    operationId: string,
    now?: string,
    leaseGeneration?: number,
  ): Awaitable<DagRun>
  createDecision(input: Omit<DagDecision, 'status' | 'createdAt'> & { workerId: string; createdAt?: string; leaseGeneration?: number }): Awaitable<DagDecision>
  answerDecision(runId: string, decisionId: string, answer: string, operationId: string, now?: string): Awaitable<DagRun>
  latestAnsweredDecision(runId: string, nodeId: string): Awaitable<DagDecision | undefined>
}
