import { SqliteScheduledTaskStore } from './sqlite-store.js'
import { ScheduledTaskStore } from './store.js'
import type { ScheduledTaskStorage } from './state-store.js'

export type ScheduledTaskStorageOptions =
  | { kind: 'legacy'; directory: string; now?: () => Date }
  | { kind: 'portable-sqlite'; databasePath: string; now?: () => Date }

/** Explicit backend selection; fresh Portable callers must pass the state.sqlite path. */
export function createScheduledTaskStorage(options: ScheduledTaskStorageOptions): ScheduledTaskStorage {
  if (options.kind === 'portable-sqlite') return new SqliteScheduledTaskStore(options.databasePath, options.now)
  return new ScheduledTaskStore(options.directory, options.now)
}
