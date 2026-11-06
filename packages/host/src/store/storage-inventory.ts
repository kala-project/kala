import { mkdirSync } from 'node:fs'
import { open, readdir, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const STORAGE_CATEGORIES = [
  'jsonl',
  'snapshot',
  'summary',
  'context',
  'session-artifacts',
  'orphan-artifacts',
  'backup',
  'corrupt',
  'other',
] as const

export const STORAGE_INVENTORY_PERSISTENCE_INTERVAL_MS = 600_000

export type StorageCategory = typeof STORAGE_CATEGORIES[number]

export type StorageCategoryStats = {
  readonly bytes: number
  readonly files: number
}

export type StorageInventoryScanState =
  | { readonly status: 'idle' }
  | { readonly status: 'scanning'; readonly startedAt: string }
  | { readonly status: 'failed'; readonly startedAt: string; readonly failedAt: string; readonly error: string }

export type StorageInventoryState = {
  readonly source?: 'postgres'
  readonly measuredAt: string | null
  readonly generation: number
  readonly stale: boolean
  readonly scan: StorageInventoryScanState
}

export type CachedSessionStorage = {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly runtime?: string
  readonly directBytes: number
  readonly categories: Readonly<Partial<Record<StorageCategory, StorageCategoryStats>>>
}

export type CachedSessionTreeStorage = CachedSessionStorage & {
  readonly treeBytes: number
  readonly descendantCount: number
  readonly treeCategories: Readonly<Partial<Record<StorageCategory, StorageCategoryStats>>>
}

export type StorageOrphanCandidate = {
  readonly id: string
  readonly category: 'orphan-artifacts' | 'snapshot' | 'summary' | 'context' | 'corrupt'
  readonly bytes: number
  readonly files: number
}

export type CachedGlobalStorage = {
  readonly totalBytes: number
  readonly totalFiles: number
  readonly categories: Readonly<Record<StorageCategory, StorageCategoryStats>>
  readonly orphanCandidates: readonly StorageOrphanCandidate[]
  readonly state: StorageInventoryState
}

export type StorageInventoryOptions = {
  readonly indexPath?: string
  readonly persistenceIntervalMs?: number
  readonly yieldEvery?: number
  readonly now?: () => Date
}

type MutableStats = { bytes: number; files: number }
type MutableCategories = Partial<Record<StorageCategory, MutableStats>>
type SessionEntry = {
  sessionId: string
  parentSessionId?: string
  runtime?: string
  categories: MutableCategories
}
type InventorySnapshot = {
  measuredAt: string | null
  generation: number
  sessions: Map<string, SessionEntry>
  global: Record<StorageCategory, MutableStats>
  orphans: StorageOrphanCandidate[]
}
type Header = { sessionId: string; parentSessionId?: string; runtime?: string }
type RootFile = { name: string; bytes: number }

const EMPTY_STATS = (): MutableStats => ({ bytes: 0, files: 0 })

export class StorageInventory {
  private readonly sessionsDir: string
  private readonly indexPath: string
  private readonly persistenceIntervalMs: number
  private readonly yieldEvery: number
  private readonly now: () => Date
  private readonly database: DatabaseSync
  private snapshot: InventorySnapshot
  private scan: StorageInventoryScanState = { status: 'idle' }
  private dirty = false
  private persistTimer?: NodeJS.Timeout
  private reconcilePromise?: Promise<CachedGlobalStorage>
  private readonly scanDeltas = new Map<string, Partial<Record<StorageCategory, number>>>()
  private invalidationGeneration = 0
  private closed = false

  constructor(sessionsDir: string, options: StorageInventoryOptions = {}) {
    this.sessionsDir = resolve(sessionsDir)
    this.indexPath = resolve(options.indexPath ?? join(dirname(sessionsDir), 'storage-inventory.sqlite'))
    this.persistenceIntervalMs = options.persistenceIntervalMs ?? STORAGE_INVENTORY_PERSISTENCE_INTERVAL_MS
    this.yieldEvery = Math.max(1, options.yieldEvery ?? 128)
    this.now = options.now ?? (() => new Date())
    this.database = openInventoryDatabase(this.indexPath)
    this.snapshot = loadSnapshot(this.database)
  }

  getCachedSession(sessionId: string): CachedSessionStorage | undefined {
    const entry = this.snapshot.sessions.get(sessionId)
    return entry ? toCachedSession(entry) : undefined
  }

  getCachedTree(sessionId: string): CachedSessionTreeStorage | undefined {
    const entry = this.snapshot.sessions.get(sessionId)
    if (!entry) return undefined
    const aggregate = cloneCategories(entry.categories)
    let descendantCount = 0
    const visited = new Set([sessionId])
    const pending = [sessionId]
    while (pending.length > 0) {
      const parent = pending.pop()
      if (!parent) continue
      for (const child of this.snapshot.sessions.values()) {
        if (child.parentSessionId !== parent || visited.has(child.sessionId)) continue
        visited.add(child.sessionId)
        pending.push(child.sessionId)
        descendantCount += 1
        mergeCategories(aggregate, child.categories)
      }
    }
    const direct = toCachedSession(entry)
    return {
      ...direct,
      treeBytes: categoryBytes(aggregate),
      descendantCount,
      treeCategories: freezeCategories(aggregate),
    }
  }

  getCachedDescendants(sessionId: string): readonly CachedSessionTreeStorage[] {
    const descendants: CachedSessionTreeStorage[] = []
    const visited = new Set([sessionId])
    const pending = [sessionId]
    while (pending.length > 0) {
      const parent = pending.pop()
      if (!parent) continue
      for (const entry of this.snapshot.sessions.values()) {
        if (entry.parentSessionId !== parent || visited.has(entry.sessionId)) continue
        visited.add(entry.sessionId)
        pending.push(entry.sessionId)
        const tree = this.getCachedTree(entry.sessionId)
        if (tree) descendants.push(tree)
      }
    }
    return descendants.sort((left, right) => right.treeBytes - left.treeBytes || left.sessionId.localeCompare(right.sessionId))
  }

  getCachedLargestTrees(limit = 20): readonly CachedSessionTreeStorage[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('storage tree limit must be a non-negative integer')
    return [...this.snapshot.sessions.values()]
      .filter((entry) => !entry.parentSessionId || !this.snapshot.sessions.has(entry.parentSessionId))
      .map((entry) => this.getCachedTree(entry.sessionId))
      .filter((entry): entry is CachedSessionTreeStorage => entry !== undefined)
      .sort((left, right) => right.treeBytes - left.treeBytes || left.sessionId.localeCompare(right.sessionId))
      .slice(0, limit)
  }

  getCachedGlobal(): CachedGlobalStorage {
    const categories = freezeCompleteCategories(this.snapshot.global)
    return {
      totalBytes: Object.values(categories).reduce((total, value) => total + value.bytes, 0),
      totalFiles: Object.values(categories).reduce((total, value) => total + value.files, 0),
      categories,
      orphanCandidates: this.snapshot.orphans.map((candidate) => ({ ...candidate })),
      state: {
        measuredAt: this.snapshot.measuredAt,
        generation: this.snapshot.generation,
        stale: this.snapshot.measuredAt === null || this.scan.status !== 'idle',
        scan: { ...this.scan },
      },
    }
  }

  invalidate(): void {
    // close() persists a stale marker before releasing SQLite. Late advisory
    // notifications from already-admitted shutdown work therefore need no
    // further database mutation.
    if (this.closed) return
    this.invalidationGeneration += 1
    if (this.snapshot.measuredAt === null) return
    this.snapshot.measuredAt = null
    this.snapshot.generation += 1
    this.dirty = true
    this.schedulePersistence()
  }

  markDirty(sessionId: string, category: StorageCategory, delta: number): void {
    this.assertOpen()
    if (!Number.isSafeInteger(delta)) throw new TypeError('storage byte delta must be a safe integer')
    if (delta === 0) return
    let entry = this.snapshot.sessions.get(sessionId)
    if (!entry) {
      entry = { sessionId, categories: {} }
      this.snapshot.sessions.set(sessionId, entry)
    }
    const appliedDelta = adjustBytes(entry.categories, category, delta)
    this.snapshot.global[category].bytes = nonNegative(this.snapshot.global[category].bytes + appliedDelta)
    if (this.scan.status === 'scanning') {
      const pending = this.scanDeltas.get(sessionId) ?? {}
      pending[category] = (pending[category] ?? 0) + appliedDelta
      this.scanDeltas.set(sessionId, pending)
    }
    this.snapshot.generation += 1
    this.dirty = true
    this.schedulePersistence()
  }

  reconcile(): Promise<CachedGlobalStorage> {
    this.assertOpen()
    if (this.reconcilePromise) return this.reconcilePromise
    const startedAt = this.now().toISOString()
    const invalidationGeneration = this.invalidationGeneration
    this.scanDeltas.clear()
    this.scan = { status: 'scanning', startedAt }
    const promise = this.scanFilesystem()
      .then((next) => {
        for (const [sessionId, categories] of this.scanDeltas) {
          let entry = next.sessions.get(sessionId)
          if (!entry) {
            entry = { sessionId, categories: {} }
            next.sessions.set(sessionId, entry)
          }
          for (const category of STORAGE_CATEGORIES) {
            const delta = categories[category]
            if (!delta) continue
            const applied = adjustBytes(entry.categories, category, delta)
            next.global[category].bytes = nonNegative(next.global[category].bytes + applied)
          }
        }
        if (this.invalidationGeneration !== invalidationGeneration) next.measuredAt = null
        this.scanDeltas.clear()
        this.snapshot = next
        this.scan = { status: 'idle' }
        this.dirty = true
        this.schedulePersistence()
        return this.getCachedGlobal()
      })
      .catch((error: unknown) => {
        this.scanDeltas.clear()
        this.scan = {
          status: 'failed',
          startedAt,
          failedAt: this.now().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
        throw error
      })
      .finally(() => {
        if (this.reconcilePromise === promise) this.reconcilePromise = undefined
      })
    this.reconcilePromise = promise
    return promise
  }

  flush(): void {
    this.assertOpen()
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    if (!this.dirty) return
    persistSnapshot(this.database, this.snapshot)
    this.dirty = false
  }

  close(): void {
    if (this.closed) return
    if (this.snapshot.measuredAt !== null) {
      this.snapshot.measuredAt = null
      this.snapshot.generation += 1
      this.dirty = true
    }
    this.flush()
    this.database.close()
    this.closed = true
  }

  private async scanFilesystem(): Promise<InventorySnapshot> {
    const sessions = new Map<string, SessionEntry>()
    const global = emptyGlobal()
    const orphans: StorageOrphanCandidate[] = []
    const rootFiles: RootFile[] = []
    const validSlugs = new Map<string, string>()
    const occupiedSlugs = new Set<string>()
    let operations = 0
    const tick = async (): Promise<void> => {
      operations += 1
      if (operations % this.yieldEvery === 0) {
        await new Promise<void>((resolveTick) => setImmediate(resolveTick))
      }
    }

    let names: string[]
    try {
      names = await readdir(this.sessionsDir)
    } catch (error) {
      if (isMissing(error)) names = []
      else throw error
    }

    for (const name of names) {
      const path = join(this.sessionsDir, name)
      if (this.isIndexFile(path)) continue
      const stats = await lstat(path)
      await tick()
      if (stats.isSymbolicLink()) continue
      if (stats.isFile()) rootFiles.push({ name, bytes: stats.size })
    }

    for (const file of rootFiles) {
      if (!file.name.endsWith('.jsonl')) continue
      const path = join(this.sessionsDir, file.name)
      const slug = file.name.slice(0, -'.jsonl'.length)
      occupiedSlugs.add(slug)
      try {
        const header = await readHeaderLine(path)
        validSlugs.set(slug, header.sessionId)
        const entry = sessions.get(header.sessionId) ?? { sessionId: header.sessionId, categories: {} }
        entry.parentSessionId = header.parentSessionId
        entry.runtime = header.runtime
        sessions.set(header.sessionId, entry)
        addFile(entry.categories, 'jsonl', file.bytes)
        addFile(global, 'jsonl', file.bytes)
      } catch {
        addFile(global, 'corrupt', file.bytes)
        orphans.push({ id: file.name.slice(0, -'.jsonl'.length), category: 'corrupt', bytes: file.bytes, files: 1 })
      }
      await tick()
    }

    for (const file of rootFiles) {
      if (file.name.endsWith('.jsonl')) continue
      const sidecar = classifySidecar(file.name)
      if (sidecar) {
        const sessionId = validSlugs.get(sidecar.slug)
        addFile(global, sidecar.category, file.bytes)
        if (sessionId) addFile(sessions.get(sessionId)?.categories, sidecar.category, file.bytes)
        else orphans.push({ id: sidecar.slug, category: sidecar.category, bytes: file.bytes, files: 1 })
        continue
      }
      const category: StorageCategory = isBackup(file.name) ? 'backup' : 'other'
      addFile(global, category, file.bytes)
    }

    const artifactsPath = join(this.sessionsDir, 'artifacts')
    if (names.includes('artifacts')) {
      const artifactStats = await lstat(artifactsPath)
      if (!artifactStats.isSymbolicLink() && artifactStats.isDirectory()) {
        const slugs = await readdir(artifactsPath)
        for (const slug of slugs) {
          const slugPath = join(artifactsPath, slug)
          const slugStats = await lstat(slugPath)
          await tick()
          if (slugStats.isSymbolicLink()) continue
          const sessionId = validSlugs.get(slug)
          const category: StorageCategory = occupiedSlugs.has(slug) ? 'session-artifacts' : 'orphan-artifacts'
          const totals = await walkFiles(slugPath, this.indexPath, tick)
          mergeStat(global[category], totals)
          if (sessionId) mergeStatForCategory(sessions.get(sessionId)?.categories, category, totals)
          else if (!occupiedSlugs.has(slug) && totals.files > 0) {
            orphans.push({ id: slug, category: 'orphan-artifacts', bytes: totals.bytes, files: totals.files })
          }
        }
      }
    }

    for (const name of names) {
      if (name === 'artifacts') continue
      const path = join(this.sessionsDir, name)
      if (this.isIndexFile(path)) continue
      const stats = await lstat(path)
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue
      const category: StorageCategory = isBackup(name) ? 'backup' : 'other'
      const totals = await walkFiles(path, this.indexPath, tick)
      mergeStat(global[category], totals)
    }

    orphans.sort((left, right) => left.id.localeCompare(right.id) || left.category.localeCompare(right.category))
    return {
      measuredAt: this.now().toISOString(),
      generation: this.snapshot.generation + 1,
      sessions,
      global,
      orphans,
    }
  }

  private isIndexFile(path: string): boolean {
    const resolved = resolve(path)
    return resolved === this.indexPath || resolved === `${this.indexPath}-wal` || resolved === `${this.indexPath}-shm`
  }

  private schedulePersistence(): void {
    if (this.persistTimer || this.persistenceIntervalMs < 0) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      if (!this.closed) this.flush()
    }, this.persistenceIntervalMs)
    this.persistTimer.unref()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('storage inventory is closed')
  }
}

function openInventoryDatabase(path: string): DatabaseSync {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS inventory_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      measured_at TEXT,
      generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_sessions (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      runtime TEXT,
      categories_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_categories (
      category TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL,
      files INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_orphans (
      candidate_id TEXT NOT NULL,
      category TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      files INTEGER NOT NULL,
      PRIMARY KEY (candidate_id, category)
    );
  `)
  return database
}

function loadSnapshot(database: DatabaseSync): InventorySnapshot {
  const meta = database.prepare('SELECT measured_at, generation FROM inventory_meta WHERE id = 1').get() as
    | { measured_at: string | null; generation: number }
    | undefined
  const sessions = new Map<string, SessionEntry>()
  const rows = database.prepare(`
    SELECT session_id, parent_session_id, runtime, categories_json FROM inventory_sessions
  `).all() as Array<{ session_id: string; parent_session_id: string | null; runtime: string | null; categories_json: string }>
  for (const row of rows) {
    sessions.set(row.session_id, {
      sessionId: row.session_id,
      ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
      ...(row.runtime ? { runtime: row.runtime } : {}),
      categories: parseCategories(row.categories_json),
    })
  }
  const global = emptyGlobal()
  const categoryRows = database.prepare('SELECT category, bytes, files FROM inventory_categories').all() as
    Array<{ category: string; bytes: number; files: number }>
  for (const row of categoryRows) {
    if (isStorageCategory(row.category)) global[row.category] = { bytes: row.bytes, files: row.files }
  }
  const orphanRows = database.prepare(`
    SELECT candidate_id, category, bytes, files FROM inventory_orphans ORDER BY candidate_id, category
  `).all() as Array<{ candidate_id: string; category: StorageOrphanCandidate['category']; bytes: number; files: number }>
  return {
    measuredAt: meta?.measured_at ?? null,
    generation: meta?.generation ?? 0,
    sessions,
    global,
    orphans: orphanRows.map((row) => ({
      id: row.candidate_id,
      category: row.category,
      bytes: row.bytes,
      files: row.files,
    })),
  }
}

function persistSnapshot(database: DatabaseSync, snapshot: InventorySnapshot): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare(`
      INSERT INTO inventory_meta (id, measured_at, generation) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET measured_at = excluded.measured_at, generation = excluded.generation
    `).run(snapshot.measuredAt, snapshot.generation)
    database.exec('DELETE FROM inventory_sessions; DELETE FROM inventory_categories; DELETE FROM inventory_orphans;')
    const insertSession = database.prepare(`
      INSERT INTO inventory_sessions (session_id, parent_session_id, runtime, categories_json) VALUES (?, ?, ?, ?)
    `)
    for (const entry of snapshot.sessions.values()) {
      insertSession.run(entry.sessionId, entry.parentSessionId ?? null, entry.runtime ?? null, JSON.stringify(entry.categories))
    }
    const insertCategory = database.prepare(`
      INSERT INTO inventory_categories (category, bytes, files) VALUES (?, ?, ?)
    `)
    for (const category of STORAGE_CATEGORIES) {
      const value = snapshot.global[category]
      insertCategory.run(category, value.bytes, value.files)
    }
    const insertOrphan = database.prepare(`
      INSERT INTO inventory_orphans (candidate_id, category, bytes, files) VALUES (?, ?, ?, ?)
    `)
    for (const orphan of snapshot.orphans) {
      insertOrphan.run(orphan.id, orphan.category, orphan.bytes, orphan.files)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function readHeaderLine(path: string): Promise<Header> {
  const handle = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let offset = 0
    const maxBytes = 1024 * 1024
    while (offset < maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes - offset))
      const result = await handle.read(buffer, 0, buffer.length, offset)
      if (result.bytesRead === 0) break
      const content = buffer.subarray(0, result.bytesRead)
      const newline = content.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(content.subarray(0, newline))
        break
      }
      chunks.push(content)
      offset += result.bytesRead
    }
    const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
    const parsed: unknown = JSON.parse(line)
    if (!isRecord(parsed) || parsed.kind !== 'header' || typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
      throw new Error('invalid session header')
    }
    return {
      sessionId: parsed.sessionId,
      ...(typeof parsed.parentSessionId === 'string' && parsed.parentSessionId
        ? { parentSessionId: parsed.parentSessionId }
        : {}),
      ...(typeof parsed.agentRuntime === 'string' && parsed.agentRuntime
        ? { runtime: parsed.agentRuntime }
        : {}),
    }
  } finally {
    await handle.close()
  }
}

async function walkFiles(
  root: string,
  indexPath: string,
  tick: () => Promise<void>,
): Promise<MutableStats> {
  const totals = EMPTY_STATS()
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    const names = await readdir(directory)
    for (const name of names) {
      const path = join(directory, name)
      const resolved = resolve(path)
      if (resolved === indexPath || resolved === `${indexPath}-wal` || resolved === `${indexPath}-shm`) continue
      const stats = await lstat(path)
      await tick()
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) pending.push(path)
      else if (stats.isFile()) {
        totals.bytes += stats.size
        totals.files += 1
      }
    }
  }
  return totals
}

function classifySidecar(name: string): { category: 'snapshot' | 'summary' | 'context'; slug: string } | undefined {
  if (name.endsWith('.jsonl.summary.json')) {
    return { category: 'summary', slug: name.slice(0, -'.jsonl.summary.json'.length) }
  }
  if (name.endsWith('.jsonl.context.json')) {
    return { category: 'context', slug: name.slice(0, -'.jsonl.context.json'.length) }
  }
  if (name.endsWith('.snapshot.json')) {
    return { category: 'snapshot', slug: name.slice(0, -'.snapshot.json'.length) }
  }
  return undefined
}

function isBackup(name: string): boolean {
  return name.endsWith('.bak') || name.endsWith('.backup') || name.endsWith('~')
}

function emptyGlobal(): Record<StorageCategory, MutableStats> {
  return Object.fromEntries(STORAGE_CATEGORIES.map((category) => [category, EMPTY_STATS()])) as
    Record<StorageCategory, MutableStats>
}

function addFile(categories: MutableCategories | undefined, category: StorageCategory, bytes: number): void {
  if (!categories) return
  const stats = categories[category] ?? (categories[category] = EMPTY_STATS())
  stats.bytes += bytes
  stats.files += 1
}

function adjustBytes(categories: MutableCategories, category: StorageCategory, delta: number): number {
  const stats = categories[category] ?? (categories[category] = EMPTY_STATS())
  const previous = stats.bytes
  stats.bytes = nonNegative(previous + delta)
  return stats.bytes - previous
}

function mergeStat(target: MutableStats, source: MutableStats): void {
  target.bytes += source.bytes
  target.files += source.files
}

function mergeStatForCategory(categories: MutableCategories | undefined, category: StorageCategory, source: MutableStats): void {
  if (!categories) return
  const target = categories[category] ?? (categories[category] = EMPTY_STATS())
  mergeStat(target, source)
}

function mergeCategories(target: MutableCategories, source: MutableCategories): void {
  for (const category of STORAGE_CATEGORIES) {
    const value = source[category]
    if (value) mergeStatForCategory(target, category, value)
  }
}

function cloneCategories(categories: MutableCategories): MutableCategories {
  return Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, { ...value }])) as MutableCategories
}

function freezeCategories(categories: MutableCategories): Partial<Record<StorageCategory, StorageCategoryStats>> {
  return Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, { ...value }]))
}

function freezeCompleteCategories(
  categories: Record<StorageCategory, MutableStats>,
): Record<StorageCategory, StorageCategoryStats> {
  return Object.fromEntries(STORAGE_CATEGORIES.map((category) => [category, { ...categories[category] }])) as
    Record<StorageCategory, StorageCategoryStats>
}

function categoryBytes(categories: MutableCategories): number {
  return Object.values(categories).reduce((total, value) => total + value.bytes, 0)
}

function toCachedSession(entry: SessionEntry): CachedSessionStorage {
  return {
    sessionId: entry.sessionId,
    ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    directBytes: categoryBytes(entry.categories),
    categories: freezeCategories(entry.categories),
  }
}

function parseCategories(value: string): MutableCategories {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) return {}
  const categories: MutableCategories = {}
  for (const category of STORAGE_CATEGORIES) {
    const candidate = parsed[category]
    if (isRecord(candidate) && typeof candidate.bytes === 'number' && typeof candidate.files === 'number') {
      categories[category] = { bytes: candidate.bytes, files: candidate.files }
    }
  }
  return categories
}

function isStorageCategory(value: string): value is StorageCategory {
  return (STORAGE_CATEGORIES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function nonNegative(value: number): number {
  return Math.max(0, value)
}
