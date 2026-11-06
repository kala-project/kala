import type { PostgresSessionAuthority } from './postgres-session-authority.js'
import {
  STORAGE_CATEGORIES,
  type CachedGlobalStorage,
  type CachedSessionTreeStorage,
  type StorageCategory,
  type StorageCategoryStats,
} from './storage-inventory.js'

type Entry = {
  sessionId: string
  parentSessionId?: string
  runtime?: string
  categories: Partial<Record<StorageCategory, StorageCategoryStats>>
}

function sum(categories: Partial<Record<StorageCategory, StorageCategoryStats>>): number {
  return Object.values(categories).reduce((total, entry) => total + entry.bytes, 0)
}

/** Read-only logical byte inventory; filesystem quarantine is never available for PostgreSQL. */
export class PostgresStorageInventory {
  private entries = new Map<string, Entry>()
  private measuredAt: string | null = null
  private generation = 0
  private pending?: Promise<CachedGlobalStorage>

  constructor(private readonly authority: Pick<PostgresSessionAuthority, 'storageEntries'>) {}

  invalidate(): void {
    this.measuredAt = null
  }

  close(): void {}

  reconcile(): Promise<CachedGlobalStorage> {
    if (this.pending) return this.pending
    const pending = this.measure()
    this.pending = pending
    const clearPending = () => { if (this.pending === pending) this.pending = undefined }
    void pending.then(clearPending, clearPending)
    return pending
  }

  private async measure(): Promise<CachedGlobalStorage> {
    const rows = await this.authority.storageEntries()
    const next = new Map<string, Entry>()
    for (const row of rows) {
      let entry = next.get(row.sessionId)
      if (!entry) {
        entry = {
          sessionId: row.sessionId,
          parentSessionId: row.parentSessionId,
          runtime: row.runtime,
          categories: {},
        }
        next.set(row.sessionId, entry)
      }
      entry.categories[row.category] = { bytes: row.bytes, files: row.files }
    }
    this.entries = next
    this.measuredAt = new Date().toISOString()
    this.generation++
    return this.getCachedGlobal()
  }

  getCachedTree(sessionId: string): CachedSessionTreeStorage | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    const treeCategories: Partial<Record<StorageCategory, StorageCategoryStats>> = {}
    const visited = new Set<string>()
    const pending = [sessionId]
    while (pending.length) {
      const current = pending.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      const categories = this.entries.get(current)?.categories ?? {}
      for (const [category, stats] of Object.entries(categories) as [StorageCategory, StorageCategoryStats][]) {
        const previous = treeCategories[category]
        treeCategories[category] = {
          bytes: (previous?.bytes ?? 0) + stats.bytes,
          files: (previous?.files ?? 0) + stats.files,
        }
      }
      for (const child of this.entries.values()) {
        if (child.parentSessionId === current && !visited.has(child.sessionId)) pending.push(child.sessionId)
      }
    }
    return {
      ...entry,
      directBytes: sum(entry.categories),
      treeBytes: sum(treeCategories),
      descendantCount: visited.size - 1,
      treeCategories,
    }
  }

  getCachedDescendants(sessionId: string): readonly CachedSessionTreeStorage[] {
    const descendants: CachedSessionTreeStorage[] = []
    const visited = new Set([sessionId])
    const pending = [sessionId]
    while (pending.length) {
      const current = pending.pop()!
      for (const child of this.entries.values()) {
        if (child.parentSessionId !== current || visited.has(child.sessionId)) continue
        visited.add(child.sessionId)
        pending.push(child.sessionId)
        const tree = this.getCachedTree(child.sessionId)
        if (tree) descendants.push(tree)
      }
    }
    return descendants.sort((a, b) => b.treeBytes - a.treeBytes || a.sessionId.localeCompare(b.sessionId))
  }

  getCachedLargestTrees(limit = 20): readonly CachedSessionTreeStorage[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('storage tree limit must be a non-negative integer')
    return [...this.entries.values()]
      .filter((entry) => !entry.parentSessionId || !this.entries.has(entry.parentSessionId))
      .map((entry) => this.getCachedTree(entry.sessionId)!)
      .sort((a, b) => b.treeBytes - a.treeBytes || a.sessionId.localeCompare(b.sessionId))
      .slice(0, limit)
  }

  getCachedGlobal(): CachedGlobalStorage {
    const categories = Object.fromEntries(STORAGE_CATEGORIES.map((category) => [category, { bytes: 0, files: 0 }])) as Record<StorageCategory, { bytes: number; files: number }>
    for (const entry of this.entries.values()) {
      for (const [category, stats] of Object.entries(entry.categories) as [StorageCategory, StorageCategoryStats][]) {
        categories[category].bytes += stats.bytes
        categories[category].files += stats.files
      }
    }
    return {
      totalBytes: sum(categories),
      totalFiles: Object.values(categories).reduce((total, stats) => total + stats.files, 0),
      categories,
      orphanCandidates: [],
      state: {
        source: 'postgres',
        measuredAt: this.measuredAt,
        generation: this.generation,
        stale: this.measuredAt === null,
        scan: { status: 'idle' },
      },
    }
  }
}
