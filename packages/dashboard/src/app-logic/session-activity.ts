import type { AgentState, PendingToolCall } from '@agent-kernel/kernel'
import { deriveSessionState, type SessionDerivedState } from '@agent-kernel/shared'

import type { SessionActivityStatus } from '../features/explorer/Explorer.js'

/**
 * One selected-session presentation projection shared by the title, Sidebar,
 * wake lock, Composer gating, and intervention notifications. Live state is
 * accepted only when it belongs to the current selection; otherwise the Host
 * summary is the only safe projection during hydration.
 */
export type SelectedSessionActivity = {
  derived: SessionDerivedState
  status: SessionActivityStatus | undefined
  indicatorStatus: SessionActivityStatus | undefined
  usesLiveProjection: boolean
}

export function deriveSelectedSessionActivity({
  selectedSessionId,
  hydratedSessionId,
  summaryStatus,
  liveStatus,
  pendingCalls,
  streamingActive,
  awaitingAck,
  compactRunning,
}: {
  selectedSessionId: string | null
  hydratedSessionId: string | null
  summaryStatus: AgentState['status'] | undefined
  liveStatus: AgentState['status'] | undefined
  pendingCalls?: readonly Pick<PendingToolCall, 'status'>[]
  streamingActive: boolean
  awaitingAck: boolean
  compactRunning: boolean
}): SelectedSessionActivity {
  const usesLiveProjection = selectedSessionId !== null && hydratedSessionId === selectedSessionId
  const status = usesLiveProjection ? liveStatus : summaryStatus
  const liveSignals = usesLiveProjection
    ? {
        pendingCalls,
        streamingActive,
        awaitingAck,
        compactRunning,
      }
    : {}
  // Operation feedback is not an Agent lifecycle transition.
  const derived = deriveSessionState({ status, ...liveSignals })
  const activityStatus: SessionActivityStatus | undefined =
    derived.activity === 'failed'
      ? 'error'
      : derived.isRunning && (streamingActive || awaitingAck || compactRunning) && usesLiveProjection
        ? 'loading'
        : status

  return {
    derived,
    status: activityStatus,
    indicatorStatus: activityStatus === undefined
      ? undefined
      : derived.isRunning
        ? 'loading'
        : activityStatus,
    usesLiveProjection,
  }
}

export function isRunningSessionActivity(status: SessionActivityStatus | undefined): boolean {
  return deriveSessionState({ status }).isRunning
}

export function coarseStatusForIndicator(status: SessionActivityStatus | undefined): SessionActivityStatus | undefined {
  if (status === undefined) return undefined
  return isRunningSessionActivity(status) ? 'loading' : status
}
