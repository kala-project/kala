import { createHash } from 'node:crypto'

import type { ScheduledTaskStorage } from './store.js'
import type { OccurrenceReceipt, ScheduledRun, ScheduledTaskSnapshot } from './types.js'

export type ScheduledTaskExecutor = {
  validate(task: ScheduledTaskSnapshot): Promise<void>
  receipt(run: ScheduledRun, task: ScheduledTaskSnapshot): Promise<OccurrenceReceipt>
  enqueueSession(input: { sessionId: string; prompt: string; operationId: string; task: ScheduledTaskSnapshot }): Promise<void>
  createWorkspaceSession(input: { sessionId: string; task: ScheduledTaskSnapshot; operationId: string }): Promise<void>
}

export class UnitScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private tickPromise: Promise<void> | undefined
  private stopped = true

  constructor(
    readonly store: ScheduledTaskStorage,
    private readonly executor: ScheduledTaskExecutor,
    private readonly options: { unitId: string; pollMs?: number; catchupLimit?: number; reportError?(error: unknown): void } ,
  ) {}

  async start(): Promise<void> {
    await this.store.start(this.options.unitId)
    try {
      this.stopped = false
      await this.recoverClaims()
      await this.tick()
    } catch (error) {
      this.stopped = true
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      await this.store.close()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.tickPromise
    await this.store.close()
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickPromise) return await this.tickPromise
    this.tickPromise = this.runTick()
      .catch((error) => this.reportError(error))
      .finally(() => {
        this.tickPromise = undefined
        if (!this.stopped) this.timer = setTimeout(() => { void this.tick() }, this.options.pollMs ?? 1000)
      })
    await this.tickPromise
  }

  private async runTick(): Promise<void> {
    const due = await this.store.due(this.options.catchupLimit ?? 10)
    for (const task of due) {
      if (this.stopped || !task.nextRunAt) break
      const run = await this.store.claim(task.id, task.nextRunAt)
      if (run?.status === 'claimed') await this.execute(run)
    }
  }

  private async recoverClaims(): Promise<void> {
    for (const run of await this.store.claimedRuns()) {
      const task = run.task
      try {
        await this.executor.validate(task)
      } catch (error) {
        await this.store.finish(run.occurrenceId, 'failed', { error: redact(error) })
        continue
      }
      let receipt: OccurrenceReceipt
      try {
        receipt = await this.executor.receipt(run, task)
      } catch {
        receipt = 'unknown'
      }
      const sessionId = task.target.kind === 'session' ? task.target.sessionId : occurrenceSessionId(run.occurrenceId)
      if (receipt === 'committed') await this.store.finish(run.occurrenceId, 'enqueued', { sessionId })
      else if (receipt === 'absent') await this.execute(run)
      else await this.store.finish(run.occurrenceId, 'needs_review', { sessionId, error: 'operation receipt unavailable; occurrence was not replayed' })
    }
  }

  private async execute(run: ScheduledRun): Promise<void> {
    const task = run.task
    try {
      await this.executor.validate(task)
    } catch (error) {
      await this.store.finish(run.occurrenceId, 'failed', { error: redact(error) })
      return
    }
    const sessionId = task.target.kind === 'session' ? task.target.sessionId : occurrenceSessionId(run.occurrenceId)
    try {
      if (task.target.kind === 'session') {
        await this.executor.enqueueSession({ sessionId, prompt: task.prompt, operationId: run.operationId, task })
      } else {
        await this.executor.createWorkspaceSession({ sessionId, task, operationId: run.operationId })
      }
      await this.store.finish(run.occurrenceId, 'enqueued', { sessionId })
    } catch (error) {
      // Admission may have been persisted before the failure. Do not declare an
      // uncertain side effect safely failed or issue a new operation identity.
      let receipt: OccurrenceReceipt = 'unknown'
      try { receipt = await this.executor.receipt(run, task) } catch { /* receipt unavailable */ }
      await this.store.finish(run.occurrenceId, receipt === 'committed' ? 'enqueued' : 'needs_review', {
        sessionId,
        ...(receipt === 'committed' ? {} : { error: `delivery outcome uncertain: ${redact(error)}` }),
      })
    }
  }

  private reportError(error: unknown): void {
    if (this.options.reportError) this.options.reportError(error)
    else process.emitWarning(`scheduled task poll failed: ${redact(error)}`, { code: 'KALA_SCHEDULED_TASK_POLL' })
  }
}

export function occurrenceSessionId(occurrenceId: string): string {
  return `scheduled_${createHash('sha256').update(occurrenceId).digest('hex').slice(0, 32)}`
}

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
}
