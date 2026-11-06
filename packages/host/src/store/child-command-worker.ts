import { createHash } from 'node:crypto'

import type { AgentRuntimeRegistry } from '../agent-runtime/types.js'
import type { HostLoopDeps } from '../loop-types.js'
import type { SubAgentFinishedPayload } from '../loop-types.js'
import type { ExecutorLookup } from '../connection/executor.js'
import { messageOperationFingerprint } from '../message-operation-fingerprint.js'
import { RuntimeResourceOwnershipFencedError } from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import type { SessionStore } from './session.js'
import type { ChildCommand, ChildCommandInbox } from './child-command-state.js'
import { consumeNextChildCommand, consumeNextChildStop } from './child-command-consumer.js'

export type ChildCommandWorkerDeps = {
  inbox: ChildCommandInbox
  store: SessionStore
  runtimes: AgentRuntimeRegistry
  assertOwner(sessionId: string): Promise<unknown>
  executors?: Pick<ExecutorLookup, 'cancelExecution' | 'queryExecutionReceipt'>
  modelPolicy?: HostLoopDeps['modelPolicy']
  onChildFinished?(payload: SubAgentFinishedPayload): void
  listLocalParentRooms?(): readonly string[]
}

export async function stopChildTurn(
  deps: ChildCommandWorkerDeps,
  command: ChildCommand,
): Promise<{ ok: boolean; content: string }> {
  try {
    await deps.assertOwner(command.childSessionId)
    const record = await deps.store.load(command.childSessionId, { recoverDangling: false })
    if (record.parentSessionId !== command.parentSessionId) return { ok: false, content: 'UNKNOWN: child parent changed' }
    const pending = record.state.pendingCalls.filter((call) => call.status === 'dispatched')
    const requests = await Promise.all(pending.map(async (call) => ({
      callId: call.callId,
      provenance: await deps.store.findCopilotToolRequest(command.childSessionId, call.callId),
    })))
    let runtimeAcknowledged = false
    try {
      runtimeAcknowledged = await deps.runtimes.require(record.agentRuntime).cancelForChildStop?.(record) === true
    } catch { /* Still attempt each authenticated Executor cancellation below. */ }
    let toolsConfirmed = true
    for (const { callId, provenance } of requests) {
      if (!provenance || !deps.executors) {
        toolsConfirmed = false
        continue
      }
      const request = { sessionId: command.childSessionId, callId, stopCommandId: command.commandId, ...provenance }
      const ack = await deps.executors.cancelExecution(request)
      if (ack.status === 'completed') {
        if (ack.result.failure?.outcome === 'indeterminate') toolsConfirmed = false
        continue
      }
      if (ack.status !== 'cancel_requested') {
        toolsConfirmed = false
        continue
      }
      // The ACK proves only that the cancellation intent reached the durable
      // Executor journal. Await a separate durable terminal receipt.
      let completed = false
      for (let attempt = 0; attempt < 5; attempt++) {
        const receipt = await deps.executors.queryExecutionReceipt(request)
        if (receipt.status === 'completed') {
          completed = receipt.result.failure?.outcome !== 'indeterminate'
          break
        }
        if (receipt.status !== 'started_unknown') break
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
      if (!completed) toolsConfirmed = false
    }
    const messageUnconfirmed = await deps.inbox.hasUnconfirmedMessageBeforeStop(command.childSessionId, command.commandId)
    await deps.assertOwner(command.childSessionId)
    return runtimeAcknowledged && toolsConfirmed && !messageUnconfirmed
      ? { ok: true, content: 'Stop acknowledged by the child runtime and all outstanding Executor calls reached durable terminal receipts. Earlier effects may already have occurred.' }
      : { ok: false, content: 'UNKNOWN: Stop was requested but the SDK/model abort or at least one remote Executor effect could not be confirmed. The message head remains blocked; do not retry effects.' }
  } catch {
    return { ok: false, content: 'UNKNOWN: child owner or cancellation authority unavailable; the message head remains blocked.' }
  }
}

/** Reconcile the SDK/Kernel turn, not an Executor call: a tool receipt alone
 * cannot prove that the model turn and its terminal projection were committed. */
export async function reconcileChildTurn(
  deps: ChildCommandWorkerDeps,
  command: ChildCommand,
): Promise<{ ok: boolean; content: string } | undefined> {
  await deps.assertOwner(command.childSessionId)
  const record = await deps.store.load(command.childSessionId, { recoverDangling: false })
  if (record.parentSessionId !== command.parentSessionId || command.kind !== 'message' || !command.message) return undefined
  const operation = await deps.store.findOperation(command.childSessionId, command.commandId)
  if (record.agentRuntime === 'copilot') {
    if (operation?.kind !== 'runtime_metadata' || operation.action !== 'copilot.user_message'
      || operation.requestFingerprint !== messageOperationFingerprint(command.message)) return undefined
    const idle = await deps.store.findLatestRuntimeMetadata(command.childSessionId, 'copilot.session_idle')
    if (idle?.payload.childCommandId !== command.commandId || record.state.status !== 'done'
      || record.state.pendingCalls.length !== 0) return undefined
  } else if (record.agentRuntime === 'kernel') {
    if (operation?.kind !== 'event' || operation.event.text !== command.message) return undefined
    const events = await deps.store.readEventEntries(command.childSessionId)
    const latestUser = events.filter((entry) => entry.event.kind === 'user_message').at(-1)
    if (latestUser?.event.kind !== 'user_message' || latestUser.event.operationId !== command.commandId
      || events.some((entry) => entry.seq > latestUser.seq && entry.event.kind === 'cancel')
      || record.state.status !== 'done' || record.state.pendingCalls.length !== 0) return undefined
  } else return undefined
  await deps.assertOwner(command.childSessionId)
  return { ok: true, content: `Child turn ${command.commandId} completed durably; read_agent to inspect the response.` }
}

export function startChildCommandWorker(deps: ChildCommandWorkerDeps, intervalMs = 500): () => Promise<void> {
  const maxConcurrentDispatches = 32
  const active = new Map<string, { command: ChildCommand; task: Promise<void> }>()
  const dispatching = new Map<string, Promise<void>>()
  const uncertainClaims = new Set<string>()
  let closed = false
  let scanning = false
  let scanTask: Promise<void> | undefined
  let cursor = ''
  let completionCursor = ''
  const roomCursors = new Map<string, { sequence: string }>()
  const activeRooms = new Set<string>()
  const emitted = new Set<string>()
  const broadcastCompletion = async (notice: ChildCommand & { completedAt: string }): Promise<void> => {
    const key = `${notice.parentSessionId}\0${notice.childSessionId}\0${notice.commandId}`
    if (emitted.has(key)) return
    if (deps.listLocalParentRooms && !deps.listLocalParentRooms().includes(notice.parentSessionId)) return
    if (deps.listLocalParentRooms) activeRooms.add(notice.parentSessionId)
    const record = await deps.store.load(notice.childSessionId, { recoverDangling: false })
    if (record.parentSessionId !== notice.parentSessionId || record.parentCallId !== notice.commandId
      || !notice.outcome?.ok) return
    const startedAt = Date.parse(record.subAgentStartedAt ?? '')
    const finishedAt = Date.parse(notice.completedAt)
    const turns = await deps.store.countCompletedChildModelTurns(notice.childSessionId, notice.commandId)
    deps.onChildFinished?.({
      parentSessionId: notice.parentSessionId, parentCallId: notice.commandId, childSessionId: notice.childSessionId,
      status: 'completed', turns,
      durationMs: Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : 0,
      finishedAt: notice.completedAt,
    })
    emitted.add(key)
    if (emitted.size > 1024) emitted.delete(emitted.values().next().value!)
  }
  const notifyParents = async (): Promise<void> => {
    if (!deps.onChildFinished) return
    const parents = await deps.inbox.pendingFinishedParentSessionIds(128, completionCursor)
    completionCursor = parents.length === 128 ? parents[parents.length - 1]! : ''
    for (const parentSessionId of parents) {
      if (closed) return
      try {
        await deps.assertOwner(parentSessionId)
        const notices = await deps.inbox.readPendingChildCompletions(parentSessionId)
        for (const notice of notices) {
          if (closed) return
          await deps.assertOwner(parentSessionId)
          await broadcastCompletion(notice)
          await deps.inbox.acknowledgeChildCompletion(parentSessionId, notice.childSessionId, notice.commandId)
        }
      } catch {
        // A different replica owns the parent, or delivery failed. Keep the
        // durable notice for a parent owner to retry (duplicates are safe).
      }
    }
  }
  const notifyLocalRooms = async (): Promise<void> => {
    if (!deps.listLocalParentRooms || !deps.onChildFinished) return
    const rooms = new Set(deps.listLocalParentRooms())
    for (const parentSessionId of activeRooms) {
      if (!rooms.has(parentSessionId)) {
        roomCursors.delete(parentSessionId)
        for (const key of emitted) {
          if (key.startsWith(`${parentSessionId}\0`)) emitted.delete(key)
        }
      }
    }
    activeRooms.clear()
    for (const parentSessionId of rooms) activeRooms.add(parentSessionId)
    for (const parentSessionId of rooms) {
      if (closed) return
      try {
        const notices = await deps.inbox.readFinishedChildCompletions(parentSessionId, roomCursors.get(parentSessionId))
        for (const notice of notices) {
          if (closed) return
          await broadcastCompletion(notice)
          roomCursors.set(parentSessionId, { sequence: notice.sequence })
        }
      } catch {
        // A read or callback failure keeps the per-room cursor at the last
        // delivered event so a later poll can retry without replaying tools.
      }
    }
  }
  const processChild = async (childSessionId: string): Promise<void> => {
    const tracked = active.get(childSessionId)?.command
    if (tracked) return
    let claimedCommand: ChildCommand | undefined
    let command: ChildCommand | undefined
    let needsDispatchRecovery = false
    const dispatch = async (claimed: ChildCommand): Promise<void> => {
      if (closed) throw new Error('Child worker stopped before runtime dispatch')
      if (await deps.inbox.hasStopBarrier(childSessionId)) throw new Error('Stop barrier installed before child dispatch')
      if (claimed.kind !== 'message' || !claimed.message) throw new Error('Remote Stop requires a fenced cancellation acknowledgement')
      await deps.assertOwner(childSessionId)
      const record = await deps.store.load(childSessionId, { recoverDangling: false })
      if (record.parentSessionId !== claimed.parentSessionId) throw new Error('Child command parent mismatch')
      if (record.state.status !== 'idle' && record.state.status !== 'done') {
        throw new Error('Child is not resting; dispatched command remains UNKNOWN without a safe run transition')
      }
      const model = record.preferences?.selectedModel
      if (model && deps.modelPolicy) {
        if (!record.organizationId) throw new Error('Child model policy requires tenant attribution')
        await deps.modelPolicy.assertCanUseModel({
          organizationId: record.organizationId, sessionId: childSessionId, model,
          ...(record.principal ? { principal: record.principal } : {}),
        })
      }
      if (await deps.inbox.hasStopBarrier(childSessionId)) {
        throw new Error('Stop barrier installed while preparing child runtime dispatch')
      }
      await deps.assertOwner(childSessionId)
      if (closed) throw new Error('Child worker stopped before runtime send')
      await deps.runtimes.require(record.agentRuntime).send(record, {
        text: claimed.message, operationId: claimed.commandId,
        ...(model ? { model } : {}),
      })
    }
    try {
      command = await consumeNextChildCommand(deps.inbox, childSessionId, dispatch,
        async (claimed) => reconcileChildTurn(deps, claimed),
        (claimed) => {
          claimedCommand = claimed
          if (claimed.reclaimed && !claimed.dispatchedAt) {
            needsDispatchRecovery = true
            throw new Error('Reclaimed undispatched child head requires proof before dispatch')
          }
        }, () => { needsDispatchRecovery = true })
    } catch {
      // The runtime may have finished while the terminal inbox transaction
      // failed (or its commit ACK was lost). Never dispatch this claim again.
      command = claimedCommand
      if (!command) uncertainClaims.add(childSessionId)
    }
    if (!command && uncertainClaims.has(childSessionId)) {
      try {
        const head = await deps.inbox.readActiveChildMessage(childSessionId)
        if (head?.status === 'claimed') command = head
        else uncertainClaims.delete(childSessionId)
      } catch { /* Retry discovery on the next scan. */ }
    }
    if (!command || command.status === 'completed') return
    let recoverUndispatched = needsDispatchRecovery || (!claimedCommand && uncertainClaims.has(childSessionId))
    uncertainClaims.delete(childSessionId)
    // Same-owner claims are deliberately not returned twice. Keep observing
    // this command locally, while takeover reclaims it through SQL.
    let persisted = false
    let ownerLost = false
    const task = (async () => {
      let provenOutcome: { ok: boolean; content: string } | undefined
      while (!closed) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
        try {
          if (recoverUndispatched) {
            await deps.assertOwner(childSessionId)
            const head = await deps.inbox.readActiveChildMessage(childSessionId)
            if (!head || head.commandId !== command.commandId || head.kind !== 'message'
              || head.parentSessionId !== command.parentSessionId || head.message !== command.message
              || head.status !== 'claimed' || head.ownerGeneration !== command.ownerGeneration) {
              ownerLost = true
              return
            }
            if (head.dispatchedAt || !head.ownerGeneration) {
              recoverUndispatched = false
            } else if (await deps.inbox.hasStopBarrier(childSessionId)
              || await deps.store.findOperation(childSessionId, command.commandId)) {
              recoverUndispatched = false
            } else {
              // The fenced SQL row still has no dispatch marker and there is
              // no durable SDK/Kernel operation. A strict compare-before-mark
              // prevents a concurrent or lost-ACK dispatch from being sent twice.
              const marked = await deps.inbox.markChildCommandDispatched(childSessionId, command.commandId, true)
              recoverUndispatched = false
              await dispatch(marked)
            }
          }
          provenOutcome ??= await reconcileChildTurn(deps, command)
          if (!provenOutcome) continue
          await deps.inbox.completeChildCommand(childSessionId, command.commandId, provenOutcome)
          persisted = true
          return
        } catch (error) {
          // A transient SQL error cannot discard this same-owner claim.
          // Fencing still guards every completion; a new owner reconciles it.
          if (error instanceof RuntimeResourceOwnershipFencedError) {
            ownerLost = true
            return
          }
          try { await deps.assertOwner(childSessionId) } catch {
            ownerLost = true
            return
          }
        }
      }
    })()
    active.set(childSessionId, { command, task })
    void task.finally(() => {
      active.delete(childSessionId)
      if (!closed && !persisted && !ownerLost) uncertainClaims.add(childSessionId)
    })
  }
  const processStop = async (childSessionId: string): Promise<void> => {
    await consumeNextChildStop(deps.inbox, childSessionId, async (command) => stopChildTurn(deps, command))
  }
  const checkTimeout = async (childSessionId: string): Promise<void> => {
    await deps.assertOwner(childSessionId)
    if (await deps.inbox.hasStopBarrier(childSessionId)) return
    const record = await deps.store.load(childSessionId, { recoverDangling: false })
    if (!record.parentSessionId || !record.parentCallId || record.state.status === 'done') return
    const command = await deps.inbox.readActiveChildMessage(childSessionId)
    if (!command || command.parentSessionId !== record.parentSessionId) return
    const initial = command.commandId === record.parentCallId
    const started = Date.parse(initial ? record.subAgentStartedAt ?? '' : command.dispatchedAt ?? '')
    const timeoutMs = command.timeoutMs ?? (initial ? record.subAgentTimeoutMs : undefined)
    const maxTurns = command.maxTurns ?? (initial ? record.subAgentMaxTurns : undefined)
    const expired = Number.isFinite(started) && Number.isSafeInteger(timeoutMs)
      && timeoutMs! > 0 && Date.now() - started >= timeoutMs!
    const turnsExceeded = Number.isSafeInteger(maxTurns) && maxTurns! > 0
      && await deps.store.countCompletedChildModelTurns(childSessionId, command.commandId) >= maxTurns!
    if (expired || turnsExceeded) {
      const stopCommandId = `timeout-${createHash('sha256')
        .update(`${childSessionId}\0${command.commandId}`).digest('hex').slice(0, 32)}`
      await deps.inbox.enqueueTimedOutChildStop(childSessionId, stopCommandId, command.commandId)
    }
  }
  const scan = async (): Promise<void> => {
    if (closed || scanning) return
    scanning = true
    try {
      const ids = await deps.inbox.pendingChildSessionIds(128, cursor)
      cursor = ids.length === 128 ? ids[ids.length - 1]! : ''
      for (const id of ids) {
        if (closed) continue
        try {
          await checkTimeout(id)
          await processStop(id)
          if (!active.has(id) && !dispatching.has(id) && dispatching.size < maxConcurrentDispatches
            && !await deps.inbox.hasStopBarrier(id)) {
            const task = processChild(id).catch(() => undefined).finally(() => { dispatching.delete(id) })
            dispatching.set(id, task)
          }
        } catch {
          // Fenced/non-owner replicas cannot claim; the current owner will.
        }
      }
      await notifyParents()
      await notifyLocalRooms()
    } finally { scanning = false }
  }
  const schedule = () => {
    if (!closed && !scanTask) {
      scanTask = scan().catch(() => undefined).finally(() => { scanTask = undefined })
    }
  }
  const timer = setInterval(schedule, intervalMs)
  timer.unref()
  schedule()
  return async () => {
    closed = true
    clearInterval(timer)
    if (scanTask) await scanTask
    await Promise.allSettled([...active.values()].map(({ task }) => task))
    // A runtime send can remain suspended in an SDK/model turn indefinitely.
    // Do not wait for it on shutdown or treat its absence as a terminal receipt.
  }
}
