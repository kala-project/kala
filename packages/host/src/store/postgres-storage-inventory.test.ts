import { describe, expect, it, vi } from 'vitest'
import { PostgresStorageInventory } from './postgres-storage-inventory.js'

describe('PostgresStorageInventory', () => {
  it('combines PostgreSQL and committed object bytes without crossing session trees', async () => {
    const inventory = new PostgresStorageInventory({
      storageEntries: vi.fn(async () => [
        { sessionId: 'parent', category: 'jsonl' as const, bytes: 42, files: 2 },
        { sessionId: 'parent', category: 'session-artifacts' as const, bytes: 90, files: 1 },
        { sessionId: 'child', parentSessionId: 'parent', category: 'context' as const, bytes: 25, files: 1 },
        { sessionId: 'other', category: 'snapshot' as const, bytes: 100, files: 1 },
      ]),
    })
    await inventory.reconcile()
    expect(inventory.getCachedTree('parent')).toMatchObject({
      directBytes: 132, treeBytes: 157, descendantCount: 1,
    })
    expect(inventory.getCachedDescendants('parent').map((entry) => entry.sessionId)).toEqual(['child'])
    expect(inventory.getCachedGlobal()).toMatchObject({ totalBytes: 257, totalFiles: 5 })
    expect(inventory.getCachedLargestTrees().map((entry) => entry.sessionId)).toEqual(['parent', 'other'])
  })

  it('retains the last measured data and marks it stale after invalidation', async () => {
    const inventory = new PostgresStorageInventory({
      storageEntries: vi.fn(async () => [{ sessionId: 'parent', category: 'snapshot' as const, bytes: 10, files: 1 }]),
    })
    await inventory.reconcile()
    inventory.invalidate()
    expect(inventory.getCachedGlobal().state.stale).toBe(true)
    expect(inventory.getCachedTree('parent')?.directBytes).toBe(10)
  })
})
