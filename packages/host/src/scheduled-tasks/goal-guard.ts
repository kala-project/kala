export class ScheduledGoalConflictError extends Error {
  constructor() {
    super('scheduled task conflicts with a target Session Goal: complete the Goal first; no scheduled prompt was enqueued')
    this.name = 'ScheduledGoalConflictError'
  }
}

export function assertNoResumableGoal(record: { goal?: { status: string; completionSource?: string } }): void {
  const goal = record.goal
  if (goal?.status === 'active' || goal?.status === 'paused'
    || (goal?.status === 'completed' && goal.completionSource === 'model')) {
    throw new ScheduledGoalConflictError()
  }
}
