import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { writeJsonFile } from '../tenant-runtime/atomic-json-file.js'
import { ScheduledTaskStateStore, type ScheduledTaskState } from './state-store.js'

export type { ScheduledTaskStorage } from './state-store.js'

/** Legacy JSON state plus lifetime SQLite lease. Its on-disk behavior is intentionally unchanged. */
export class ScheduledTaskStore extends ScheduledTaskStateStore {
  private readonly statePath: string
  private readonly leasePath: string
  private mutation = Promise.resolve()
  private lease: DatabaseSync | undefined
  private closing = false

  constructor(private readonly directory: string, now: () => Date = () => new Date()) {
    super(now)
    this.statePath = join(directory, 'state.json')
    this.leasePath = join(directory, 'lease.sqlite')
  }

  async start(unitId: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    let lease: DatabaseSync | undefined
    try {
      lease = new DatabaseSync(this.leasePath)
      // This database is used only as an OS-backed lifetime lease. In rollback
      // journal mode BEGIN EXCLUSIVE prevents another connection from acquiring
      // the lease, and SQLite releases it when this connection closes or dies.
      lease.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE')
      this.lease = lease
    } catch (error) {
      try { lease?.close() } catch { /* Preserve the acquisition error. */ }
      if (isSqliteBusy(error)) throw new Error(`scheduled task writer lease is already held for Unit ${unitId}; another local writer may still be running`)
      throw error
    }
    try {
      // Parse eagerly so corrupt state prevents the Unit from becoming ready.
      await this.readState()
    } catch (error) {
      this.releaseLease()
      throw error
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await this.mutation
    this.releaseLease()
  }

  protected async mutateState<T>(operation: (state: ScheduledTaskState) => T): Promise<T> {
    if (this.closing) throw new Error('scheduled task store is closing')
    const result = this.mutation.then(async () => {
      const state = await this.readState()
      const value = operation(state)
      state.revision += 1
      await writeJsonFile(this.statePath, state)
      return value
    })
    this.mutation = result.then(() => undefined, () => undefined)
    return await result
  }

  protected async readState(): Promise<ScheduledTaskState> {
    let raw: string
    try { raw = await readFile(this.statePath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, revision: 0, tasks: [], runs: [] }
      throw error
    }
    const state = JSON.parse(raw) as ScheduledTaskState
    if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) throw new Error('invalid scheduled task state')
    return state
  }

  private releaseLease(): void {
    const lease = this.lease
    this.lease = undefined
    lease?.close()
  }
}

function isSqliteBusy(error: unknown): boolean {
  const sqlite = error as { errcode?: unknown; errstr?: unknown }
  return sqlite?.errcode === 5 || sqlite?.errstr === 'database is locked'
}
