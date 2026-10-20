import { KalaStateStore } from './store/state-store.js'
import type { PostgresTenantStateStore } from './tenant-runtime/postgres-state.js'

export type MemoDocument = { content: string; revision: number; updatedAt: string }

export interface MemoStorage {
  readMemo(owner: string): Promise<MemoDocument> | MemoDocument
  writeMemo(owner: string, input: { content: string; expectedRevision?: number }): Promise<MemoDocument> | MemoDocument
}

export class MemoStore {
  private readonly state: MemoStorage

  constructor(root: string | MemoStorage) {
    this.state = typeof root === 'string'
      ? new KalaStateStore(root, { legacyMemoDirectory: root })
      : root
  }

  async read(owner: string): Promise<MemoDocument> {
    return await this.state.readMemo(owner)
  }

  async write(owner: string, input: { content: string; expectedRevision?: number }): Promise<MemoDocument> {
    return await this.state.writeMemo(owner, input)
  }
}

/** PostgreSQL-backed MemoStore bound to one trusted tenant namespace. */
export class PostgresMemoStore extends MemoStore {
  constructor(state: PostgresTenantStateStore) {
    super(state)
  }
}
