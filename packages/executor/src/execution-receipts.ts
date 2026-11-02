import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolResultAck } from '@agent-kernel/shared'

const MAX_RECEIPTS = 500
const RECEIPT_TTL_MS = 24 * 60 * 60_000

type CompletedReceipt = { completedAt: number; result: ToolResultAck }
type StartedReceipt = { startedAt: number; callId: string }
type Receipt = CompletedReceipt | StartedReceipt
type CommitWaiter = { generation: number; resolve(): void; reject(error: unknown): void }

export function unknownExecutionResult(callId: string): ToolResultAck {
  return {
    callId,
    ok: false,
    content: JSON.stringify({
      outcome: 'execution_unknown',
      callId,
      message: 'Executor has no confirmed durable completion for this started call. External effects may already have occurred; this is not proof of failure or rollback. Do not automatically retry. Reconcile the external target before authorizing another attempt.',
    }),
  }
}

function validReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  if ('result' in receipt) {
    const result = receipt.result as Partial<ToolResultAck> | null
    return typeof receipt.completedAt === 'number' && Number.isFinite(receipt.completedAt)
      && !!result && typeof result.callId === 'string' && typeof result.ok === 'boolean' && typeof result.content === 'string'
  }
  return typeof receipt.startedAt === 'number' && Number.isFinite(receipt.startedAt)
    && typeof receipt.callId === 'string' && receipt.callId.length > 0
}

export class ExecutionReceiptStore {
  private readonly receipts = new Map<string, Receipt>()
  private readonly committingCompletions = new Set<string>()
  private generation = 0
  private durableGeneration = 0
  private drainPromise: Promise<void> | null = null
  private drainScheduled = false
  private readonly waiters: CommitWaiter[] = []

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid execution receipt journal')
    // Validate everything first: corruption must not discard replay barriers.
    const entries = Object.entries(parsed)
    for (const [, receipt] of entries) {
      if (!validReceipt(receipt)) throw new Error('invalid execution receipt journal entry')
    }
    for (const [key, receipt] of entries) this.receipts.set(key, receipt as Receipt)
    this.prune()
  }

  get(callId: string): ToolResultAck | undefined {
    this.prune()
    const receipt = this.receipts.get(callId)
    return receipt && ('result' in receipt ? receipt.result : unknownExecutionResult(receipt.callId))
  }

  begin(key: string, callId: string): Promise<void> {
    this.prune()
    if (this.receipts.has(key)) return Promise.reject(new Error('execution identity already recorded'))
    const unresolved = [...this.receipts].filter(([id, receipt]) => !('result' in receipt) || this.committingCompletions.has(id)).length
    if (unresolved >= MAX_RECEIPTS) return Promise.reject(new Error('unresolved execution journal is full; reconciliation is required'))
    const receipt = { startedAt: Date.now(), callId }
    this.receipts.set(key, receipt)
    this.prune()
    return this.commit().catch((error: unknown) => {
      // No runner entered when admission failed. Do not strand capacity or let
      // a later successful snapshot turn this failed admission into uncertainty.
      if (this.receipts.get(key) === receipt) this.receipts.delete(key)
      throw error
    })
  }

  set(callId: string, result: ToolResultAck): Promise<void> {
    // Refresh insertion order so capacity pruning retains recently repeated IDs.
    const previous = this.receipts.get(callId)
    if (previous && !('result' in previous)) this.committingCompletions.add(callId)
    const receipt = { completedAt: Date.now(), result }
    this.receipts.delete(callId)
    this.receipts.set(callId, receipt)
    this.prune()
    return this.commit().then(() => {
      this.committingCompletions.delete(callId)
      this.prune()
    }, (error: unknown) => {
      // A failed completion commit must preserve uncertainty in memory too.
      if (previous && !('result' in previous) && this.receipts.get(callId) === receipt) this.receipts.set(callId, previous)
      this.committingCompletions.delete(callId)
      throw error
    })
  }

  private commit(): Promise<void> {
    const generation = ++this.generation
    const committed = new Promise<void>((resolve, reject) => {
      this.waiters.push({ generation, resolve, reject })
    })
    this.scheduleDrain()
    return committed
  }

  async flush(): Promise<void> {
    while (this.drainScheduled || this.drainPromise !== null || this.durableGeneration < this.generation) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.drainPromise !== null) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.drainPromise = this.drain()
        .catch(() => undefined)
        .finally(() => {
          this.drainPromise = null
          if (this.durableGeneration < this.generation && this.waiters.length > 0) this.scheduleDrain()
        })
    })
  }

  private async drain(): Promise<void> {
    while (this.durableGeneration < this.generation) {
      const targetGeneration = this.generation
      try {
        await this.persist(targetGeneration)
        this.durableGeneration = targetGeneration
        this.settleWaiters(targetGeneration)
      } catch (error) {
        this.rejectWaiters(targetGeneration, error)
        // The failed generation has no remaining caller to acknowledge. Advance
        // the barrier; a later set() creates a fresh generation and retries the
        // complete in-memory snapshot without running concurrent writers.
        this.durableGeneration = targetGeneration
        return
      }
    }
  }

  private async persist(generation: number): Promise<void> {
    const parent = dirname(this.path)
    await mkdir(parent, { recursive: true })
    const temp = `${this.path}.tmp-${process.pid}-${generation}`
    try {
      const file = await open(temp, 'w', 0o600)
      try {
        await file.writeFile(JSON.stringify(Object.fromEntries(this.receipts)), 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temp, this.path)
      // POSIX directory fsync makes the rename durable; unsupported on Windows.
      if (process.platform !== 'win32') {
        const directory = await open(parent, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } finally {
      await unlink(temp).catch(() => undefined)
    }
  }

  private settleWaiters(generation: number): void {
    const ready = this.waiters.filter((waiter) => waiter.generation <= generation)
    for (const waiter of ready) waiter.resolve()
    this.removeWaitersThrough(generation)
  }

  private rejectWaiters(generation: number, error: unknown): void {
    const failed = this.waiters.filter((waiter) => waiter.generation <= generation)
    for (const waiter of failed) waiter.reject(error)
    this.removeWaitersThrough(generation)
  }

  private removeWaitersThrough(generation: number): void {
    let count = 0
    while (count < this.waiters.length && this.waiters[count]!.generation <= generation) count++
    this.waiters.splice(0, count)
  }

  private prune(): void {
    const cutoff = Date.now() - RECEIPT_TTL_MS
    for (const [id, receipt] of this.receipts) {
      if ('result' in receipt && !this.committingCompletions.has(id) && receipt.completedAt < cutoff) this.receipts.delete(id)
    }
    while (this.receipts.size > MAX_RECEIPTS) {
      const oldest = [...this.receipts].find(([id, receipt]) => 'result' in receipt && !this.committingCompletions.has(id))?.[0]
      if (oldest === undefined) break
      this.receipts.delete(oldest)
    }
  }
}
