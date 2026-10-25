/**
 * Live view of the executor's background-shell registry.
 *
 * Reconciles three sources into a single `Map<taskId, LiveBackgroundTask>`:
 *
 *  1. `bg:list` (RPC on mount / workspace change) — reset baseline.
 *  2. `server:control_update` (push) — appends output deltas, updates status.
 *  3. `bg:output` (on selection / push gaps / running-tail cadence) — closes
 *     any gap between the tail we already hold and whatever the executor has now.
 *
 * When there's no socket or no workspace attached, the hook returns an empty
 * map — the panel's fallback (timeline-derived tasks) takes over from there.
 */

import { randomId } from '../../lib/random-id.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  BgKillResult,
  BgOutputResult,
  ControlUpdate,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
} from '@agent-kernel/shared'

import type { DashboardSocket } from '../../session.js'
import { dashboardConnectionManager, workspaceSubscriptionChannels } from '../../session.js'

export type LiveBackgroundTask = BackgroundTaskSummary & {
  /** Tail of stdout+stderr held on the client (may be less than bytesLogged when the ring buffer wrapped). */
  output: string
  /** Byte offset within `bytesLogged` where the next append/poll should start. */
  nextOffset: number
  /** True while a kill RPC is in flight, so the UI can disable the button. */
  killing: boolean
}

type Params = {
  socket: DashboardSocket | null
  workspaceId: string | undefined
  sessionId: string | null
  selectedTaskId: string | null
  /** Running-tail refresh delay for the selected task. Injectable for tests. */
  pollIntervalMs?: number
}

const DEFAULT_POLL_MS = 1500

export type UseBackgroundTasksResult = {
  tasks: readonly LiveBackgroundTask[]
  error: string | null
  killTask: (taskId: string) => Promise<BgKillResult | null>
}

export function useBackgroundTasks({
  socket,
  workspaceId,
  sessionId,
  selectedTaskId,
  pollIntervalMs = DEFAULT_POLL_MS,
}: Params): UseBackgroundTasksResult {
  const [tasks, setTasks] = useState<ReadonlyMap<string, LiveBackgroundTask>>(
    () => new Map(),
  )
  const [error, setError] = useState<string | null>(null)
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  const setTask = useCallback(
    (taskId: string, update: (prev: LiveBackgroundTask | undefined) => LiveBackgroundTask | null) => {
      setTasks((prev) => {
        const next = new Map(prev)
        const updated = update(next.get(taskId))
        if (updated === null) {
          next.delete(taskId)
        } else {
          next.set(taskId, updated)
        }
        return next
      })
    },
    [],
  )

  useEffect(() => {
    if (!socket || !workspaceId || !sessionId) {
      setTasks(new Map())
      setError(null)
      return
    }

    let cancelled = false
    setError(null)

    const isManagedSocket = typeof socket.on === 'function'
      && typeof socket.off === 'function'
      && 'io' in socket
    const manager = isManagedSocket ? dashboardConnectionManager(socket) : null
    let channels: ReturnType<typeof workspaceSubscriptionChannels>
    try { channels = workspaceSubscriptionChannels(socket, workspaceId, sessionId) }
    catch (error) { setError(error instanceof Error ? error.message : 'Workspace connection is not ready.'); return }
    const releases = channels.map((channel) => manager?.acquire(channel))

    const loadTasks = async (): Promise<void> => {
      if (manager) {
        const active = await Promise.all(channels.map((channel) => manager.waitUntilActive(channel)))
        if (cancelled) return
        if (!active.every(Boolean)) {
          setError('Unable to subscribe to this workspace session.')
          return
        }
      }
      socket.emit(
        'bg:list',
        { requestId: requestId(), workspaceId, sessionId },
        (result) => {
          if (cancelled) return
          if (result.error || !result.tasks) {
            setError(result.error ?? 'Unable to load background shells.')
            return
          }
          setError(null)
          setTasks((prev) => {
            const next = new Map<string, LiveBackgroundTask>()
            for (const summary of result.tasks) {
              const existing = prev.get(summary.taskId)
              next.set(summary.taskId, {
                ...summary,
                output: existing?.output ?? '',
                nextOffset: existing?.nextOffset ?? 0,
                killing: existing?.killing ?? false,
              })
            }
            return next
          })
        },
      )
    }

    void loadTasks()
    const onConnect = (): void => { void loadTasks() }
    socket.on('connect', onConnect)

    const onUpdate = (payload: ServerBgTaskUpdated): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId) return
      setTask(payload.task.taskId, (prev) => {
        const base: LiveBackgroundTask = prev ?? {
          ...payload.task,
          output: '',
          nextOffset: 0,
          killing: false,
        }
        const merged: LiveBackgroundTask = {
          ...base,
          ...payload.task,
          killing: base.killing && payload.task.status === 'running',
        }
        if (payload.delta) {
          const expectedOffset = base.nextOffset
          if (payload.delta.fromOffset === expectedOffset) {
            merged.output = base.output + payload.delta.content
            merged.nextOffset =
              payload.delta.fromOffset + payload.delta.content.length
          } else if (payload.delta.fromOffset < expectedOffset) {
            // Overlap or duplicate: skip the already-seen prefix.
            const overlap = expectedOffset - payload.delta.fromOffset
            const remainder = payload.delta.content.slice(overlap)
            merged.output = base.output + remainder
            merged.nextOffset = expectedOffset + remainder.length
          } else {
            // Gap: we missed some bytes. Keep what we have and rely on the
            // selection-driven poll below to refetch on demand.
            merged.output = base.output
            merged.nextOffset = base.nextOffset
          }
        }
        return merged
      })
    }

    const onEvicted = (payload: ServerBgTaskEvicted): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId) return
      setTask(payload.taskId, () => null)
    }

    const onControlUpdate = (payload: ControlUpdate): void => {
      if (payload.kind === 'bg_task_updated') onUpdate(payload)
      if (payload.kind === 'bg_task_evicted') onEvicted(payload)
    }

    socket.on('server:control_update', onControlUpdate)

    return () => {
      cancelled = true
      releases.forEach((release) => release?.())
      socket.off('connect', onConnect)
      socket.off('server:control_update', onControlUpdate)
    }
  }, [socket, workspaceId, sessionId, setTask])

  // Push events fill in most updates. Fetch the selected task once on
  // selection, then keep a delayed tail refresh only while it is running or
  // while the local offset is behind the advertised log length.
  useEffect(() => {
    if (!socket || !workspaceId || !sessionId || !selectedTaskId) return
    let disposed = false
    let timer: number | undefined

    const tick = (): void => {
      const current = tasksRef.current.get(selectedTaskId)
      const offset = current?.nextOffset ?? 0
      socket.emit(
        'bg:output',
        { requestId: requestId(), workspaceId, sessionId, taskId: selectedTaskId, offset },
        (result: BgOutputResult) => {
          if (disposed) return
          if (result.error) {
            setError(result.error)
            return
          }
          setError(null)
          setTask(selectedTaskId, (prev) => {
            if (!prev) return null
            const nextOutput =
              result.content.length > 0 ? prev.output + result.content : prev.output
            return {
              ...prev,
              output: nextOutput,
              nextOffset: result.nextOffset,
              status: result.status,
              bytesTruncated: result.bytesTruncated,
              killing: prev.killing && result.status === 'running',
            }
          })
          const shouldContinue = result.status === 'running' || result.nextOffset < (current?.bytesLogged ?? result.nextOffset)
          if (shouldContinue) timer = window.setTimeout(tick, pollIntervalMs)
        },
      )
    }

    tick()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [socket, workspaceId, sessionId, selectedTaskId, pollIntervalMs, setTask])

  const killTask = useCallback(
    async (taskId: string): Promise<BgKillResult | null> => {
      if (!socket || !workspaceId || !sessionId) return null
      setTask(taskId, (prev) => (prev ? { ...prev, killing: true } : prev ?? null))
      return await new Promise<BgKillResult | null>((resolve) => {
        socket.emit(
          'bg:kill',
          { requestId: requestId(), workspaceId, sessionId, taskId },
          (result: BgKillResult) => {
            if (!result.killed) {
              setTask(taskId, (prev) => (prev ? { ...prev, killing: false } : prev ?? null))
              if (result.error) setError(result.error)
            } else {
              setError(null)
            }
            resolve(result)
          },
        )
      })
    },
    [socket, workspaceId, sessionId, setTask],
  )

  const list = useMemo(() => {
    return [...tasks.values()].sort((a, b) => {
      // Running tasks first, then most recently ended.
      if (a.status === 'running' && b.status !== 'running') return -1
      if (a.status !== 'running' && b.status === 'running') return 1
      const at = a.endedAt ?? a.startedAt
      const bt = b.endedAt ?? b.startedAt
      return bt.localeCompare(at)
    })
  }, [tasks])

  return { tasks: list, error, killTask }
}

export function statusLabel(status: BackgroundTaskStatus): string {
  return status
}

function requestId(): string {
  return randomId()
}
