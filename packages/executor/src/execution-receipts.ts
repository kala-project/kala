import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { ExecutionCancelAck, ExecutionCancelRequest, ExecutionReceiptQuery, ExecutionReceiptQueryResult, ToolCallMessage, ToolResultAck } from '@agent-kernel/shared'
import type { ArenaProcessGroup } from './tools/arena-process-groups.js'

const MAX_RECEIPTS = 500
const ARCHIVE_RESERVE_BYTES = 32 * 1024
const DEFAULT_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024
const RECEIPT_TTL_MS = 24 * 60 * 60_000
const isArenaReceiptKey = (key: string) =>
  /^arena-(probe|status|diff|init|apply|cleanup)-[A-Z0-9]+$/u.test(key.slice(key.lastIndexOf(':') + 1))
const isLearningEffectReceiptKey = (key: string) =>
  /^(skill-file-[0-9A-HJKMNP-TV-Z]{26}|memory-file-[a-f0-9]{64})$/u.test(key.slice(key.lastIndexOf(':') + 1))
const isPinnedEffectReceiptKey = (key: string) => isArenaReceiptKey(key) || isLearningEffectReceiptKey(key)
export const learningReceiptArchivePath = (journalPath: string, key: string): string =>
  join(`${journalPath}.learning-archive`, `${createHash('sha256').update(key).digest('hex')}.json`)
export const learningReceiptIndexPath = (journalPath: string, key: string): string =>
  join(`${journalPath}.learning-index`, `${createHash('sha256').update(key).digest('hex')}.json`)
type ArchiveIndexEntry = { key: string; archiveDigest: string; retired?: {
  incidentId: string; requestDigest: string; ownerGeneration: string
} }
const validIndexEntry = (value: unknown): value is ArchiveIndexEntry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const retired = entry.retired
  const validRetired = retired === undefined || (!!retired && typeof retired === 'object'
    && !Array.isArray(retired) && Object.keys(retired).length === 3
    && typeof (retired as Record<string, unknown>).incidentId === 'string'
    && ((retired as Record<string, unknown>).incidentId as string).length > 0
    && typeof (retired as Record<string, unknown>).requestDigest === 'string'
    && /^[a-f0-9]{64}$/u.test((retired as Record<string, unknown>).requestDigest as string)
    && typeof (retired as Record<string, unknown>).ownerGeneration === 'string'
    && /^[1-9]\d*$/u.test((retired as Record<string, unknown>).ownerGeneration as string))
  return validRetired && Object.keys(entry).length === (retired ? 3 : 2) && typeof entry.key === 'string'
    && isLearningEffectReceiptKey(entry.key)
    && typeof entry.archiveDigest === 'string' && /^[a-f0-9]{64}$/u.test(entry.archiveDigest)
}
const isArchiveAnchor = (value: unknown): value is { version: 1; count: number } =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && (value as Record<string, unknown>).version === 1
  && Number.isSafeInteger((value as Record<string, unknown>).count)
  && ((value as Record<string, unknown>).count as number) >= 0
  && Object.keys(value).length === 2
const INDEX_KEY = '__learningArchiveIndex'

/** No plaintext memory content, key, workspace path or Skill body enters the journal. */
export type LearningEffectTarget = {
  tool: 'skill_file' | 'memory'
  implementation?: 'builtin-v2'
  action: 'create' | 'replace' | 'delete' | 'write'
  pathDigest: string
  contentDigest?: string
  expectedRevision?: string
}
type EffectProof = { requestDigest?: string; ownerGeneration?: string; processGroups?: ArenaProcessGroup[];
  executorProcess?: ArenaProcessGroup; target?: LearningEffectTarget; cancelRequestedAt?: number; stopCommandId?: string }
type CompletedReceipt = EffectProof & { completedAt: number; result: ToolResultAck; neverAdmitted?: true }
type StartedReceipt = EffectProof & { startedAt: number; callId: string }
type Receipt = CompletedReceipt | StartedReceipt
type CommitWaiter = { generation: number; resolve(): void; reject(error: unknown): void }
const archiveDigest = (key: string, receipt: Receipt) =>
  createHash('sha256').update(JSON.stringify({ key, receipt })).digest('hex')
const isArchivePointer = (value: unknown): value is { archiveDigest: string } =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 1 && 'archiveDigest' in value
  && typeof value.archiveDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.archiveDigest)

export function executionRequestDigest(call: ToolCallMessage): string {
  const request = [call.sessionId, call.callId, call.name, call.input, call.cwd ?? null, call.origin ?? null]
  const canonical = JSON.stringify(request, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value)
  return createHash('sha256').update(canonical).digest('hex')
}

export function conflictingExecutionResult(callId: string): ToolResultAck {
  return {
    callId,
    ok: false,
    failure: { code: 'execution_conflict', category: 'precondition', outcome: 'blocked', retryable: false, responsibility: 'system' },
    content: JSON.stringify({
      outcome: 'execution_conflict',
      callId,
      message: 'This execution identity is already bound to a different request. The replacement request was not started. Do not automatically retry with a new identity; reconcile the original operation first.',
    }),
  }
}

export function unknownExecutionResult(callId: string): ToolResultAck {
  return {
    callId,
    ok: false,
    failure: { code: 'execution_unknown', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system' },
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
  if (receipt.target !== undefined && (!receipt.target || typeof receipt.target !== 'object'
    || Array.isArray(receipt.target) || !validLearningTarget(receipt.target))) return false
  if (receipt.executorProcess !== undefined && (!receipt.executorProcess || typeof receipt.executorProcess !== 'object'
    || !Number.isSafeInteger((receipt.executorProcess as ArenaProcessGroup).pgid)
    || (receipt.executorProcess as ArenaProcessGroup).pgid <= 0
    || !/^\d+$/u.test((receipt.executorProcess as ArenaProcessGroup).leaderStartTicks)
    || !/^[a-f0-9-]{36}$/u.test((receipt.executorProcess as ArenaProcessGroup).bootId)
    || !/^pid:\[\d+\]$/u.test((receipt.executorProcess as ArenaProcessGroup).pidNamespace))) return false
  if (receipt.processGroups !== undefined && (!Array.isArray(receipt.processGroups)
    || receipt.processGroups.length > 256 || !receipt.processGroups.every((group: unknown) =>
      !!group && typeof group === 'object'
      && Number.isSafeInteger((group as ArenaProcessGroup).pgid) && (group as ArenaProcessGroup).pgid > 0
      && typeof (group as ArenaProcessGroup).leaderStartTicks === 'string'
      && /^\d+$/u.test((group as ArenaProcessGroup).leaderStartTicks)
      && typeof (group as ArenaProcessGroup).bootId === 'string'
      && /^[a-f0-9-]{36}$/u.test((group as ArenaProcessGroup).bootId)
      && typeof (group as ArenaProcessGroup).pidNamespace === 'string'
      && /^pid:\[\d+\]$/u.test((group as ArenaProcessGroup).pidNamespace)))) return false
  if (receipt.requestDigest !== undefined && (typeof receipt.requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.requestDigest))) return false
  if (receipt.ownerGeneration !== undefined && (typeof receipt.ownerGeneration !== 'string' || !/^[1-9]\d*$/u.test(receipt.ownerGeneration))) return false
  if (receipt.cancelRequestedAt !== undefined && (typeof receipt.cancelRequestedAt !== 'number' || !Number.isFinite(receipt.cancelRequestedAt)
    || typeof receipt.stopCommandId !== 'string' || !receipt.stopCommandId)) return false
  if ('result' in receipt) {
    const result = receipt.result as Partial<ToolResultAck> | null
    if (receipt.neverAdmitted !== undefined && (receipt.neverAdmitted !== true
      || receipt.executorProcess !== undefined || receipt.processGroups !== undefined
      || !receipt.requestDigest || !receipt.ownerGeneration
      || result?.ok !== false || !['arena_not_admitted', 'learning_not_admitted'].includes(result.failure?.code ?? ''))) return false
    return typeof receipt.completedAt === 'number' && Number.isFinite(receipt.completedAt)
      && !!result && typeof result.callId === 'string' && typeof result.ok === 'boolean' && typeof result.content === 'string'
  }
  return typeof receipt.startedAt === 'number' && Number.isFinite(receipt.startedAt)
    && typeof receipt.callId === 'string' && receipt.callId.length > 0
}

function validLearningTarget(value: unknown): value is LearningEffectTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  if (Object.keys(target).some((key) =>
    !['tool', 'implementation', 'action', 'pathDigest', 'contentDigest', 'expectedRevision'].includes(key))) return false
  if (target.implementation !== undefined && target.implementation !== 'builtin-v2') return false
  if ((target.tool === 'skill_file'
    ? !['create', 'replace', 'delete'].includes(String(target.action))
    : target.tool === 'memory'
      ? !['write', 'delete'].includes(String(target.action))
      : true) || typeof target.pathDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(target.pathDigest)) return false
  for (const digest of [target.contentDigest, target.expectedRevision]) {
    if (digest !== undefined && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) return false
  }
  return target.action === 'delete' ? target.contentDigest === undefined
    : typeof target.contentDigest === 'string'
}

export class ExecutionReceiptStore {
  private readonly receipts = new Map<string, Receipt>()
  private readonly archived = new Set<string>()
  private readonly archiveIndex = new Map<string, ArchiveIndexEntry>()
  private readonly retired = new Set<string>()
  private readonly activeKeys = new Set<string>()
  private readonly pendingArchiveKeys = new Set<string>()
  private readonly deferredArchiveKeys = new Set<string>()
  private archiveBytes = 0
  private readonly archiveMaxBytes: number
  private readonly committingCompletions = new Set<string>()
  private generation = 0
  private durableGeneration = 0
  private drainPromise: Promise<void> | null = null
  private drainScheduled = false
  private readonly waiters: CommitWaiter[] = []

  constructor(private readonly path: string, options?: { archiveMaxBytes?: number }) {
    const configured = options?.archiveMaxBytes ?? Number(process.env.KALA_LEARNING_ARCHIVE_MAX_BYTES ?? DEFAULT_ARCHIVE_MAX_BYTES)
    if (!Number.isSafeInteger(configured) || configured < 64 * 1024) {
      throw new Error('KALA_LEARNING_ARCHIVE_MAX_BYTES must be an integer >= 65536')
    }
    this.archiveMaxBytes = configured
  }

  archiveHealth(): { indexed: number; retired: number; activeBytes: number;
    maxBytes: number; atCapacity: boolean } {
    const awaitingSpace = [...this.pendingArchiveKeys].some((key) => {
      const receipt = this.receipts.get(key)
      return !!receipt && 'result' in receipt && !this.archiveIndex.has(key)
    })
    return {
      indexed: this.archiveIndex.size, retired: this.retired.size, activeBytes: this.archiveBytes,
      maxBytes: this.archiveMaxBytes,
      atCapacity: awaitingSpace || this.archiveBytes + ARCHIVE_RESERVE_BYTES > this.archiveMaxBytes,
    }
  }

  inspectRetirement(key: string): { requestDigest: string; ownerGeneration: string } | null {
    const retired = this.archiveIndex.get(key)?.retired
    return retired ? { requestDigest: retired.requestDigest, ownerGeneration: retired.ownerGeneration } : null
  }

  async verifyOfflineRetirement(key: string, coldDirectory: string): Promise<void> {
    const index = this.archiveIndex.get(key)
    if (!index?.retired || !isAbsolute(coldDirectory)) throw new Error('not a retired learning receipt')
    const destination = join(coldDirectory, `${createHash('sha256').update(key).digest('hex')}.json`)
    const info = await lstat(destination)
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()
      || createHash('sha256').update(await readFile(destination)).digest('hex') !== index.archiveDigest) {
      throw new Error('offline learning receipt does not match the durable index')
    }
  }

  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        for (const directory of [`${this.path}.learning-archive`, `${this.path}.learning-index`]) {
          try {
            if ((await readdir(directory)).length > 0) {
              throw new Error('original receipt journal missing while learning archive exists')
            }
          } catch (archiveError) {
            if ((archiveError as NodeJS.ErrnoException).code !== 'ENOENT') throw archiveError
          }
        }
        return
      }
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid execution receipt journal')
    // Validate everything first: corruption must not discard replay barriers.
    const snapshot = parsed as Record<string, unknown>
    const anchor = snapshot[INDEX_KEY]
    if (anchor !== undefined && !isArchiveAnchor(anchor)) throw new Error('invalid learning archive anchor')
    const entries = Object.entries(snapshot).filter(([key]) => key !== INDEX_KEY)
    for (const [key, receipt] of entries) {
      if (!validReceipt(receipt) && !(isLearningEffectReceiptKey(key) && isArchivePointer(receipt))) {
        throw new Error('invalid execution receipt journal entry')
      }
    }
    for (const [key, receipt] of entries) {
      if (!isArchivePointer(receipt)) {
        this.receipts.set(key, receipt as Receipt)
        this.activeKeys.add(key)
        if (isLearningEffectReceiptKey(key) && 'result' in (receipt as Receipt)) this.pendingArchiveKeys.add(key)
      }
    }
    let indexNames: string[]
    try { indexNames = await readdir(`${this.path}.learning-index`) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      indexNames = []
    }
    for (const name of indexNames) {
      if (/^[a-f0-9]{64}\.json\.tmp-\d+-\d+$/u.test(name)) continue
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw new Error('invalid learning archive index')
      const index = JSON.parse(await readFile(join(`${this.path}.learning-index`, name), 'utf8')) as unknown
      if (!validIndexEntry(index) || learningReceiptIndexPath(this.path, index.key) !==
        join(`${this.path}.learning-index`, name)) throw new Error('invalid learning archive index entry')
      this.archiveIndex.set(index.key, index)
    }
    if (isArchiveAnchor(anchor) && anchor.count > this.archiveIndex.size) {
      throw new Error('learning archive index lost entries')
    }
    let names: string[]
    try { names = await readdir(`${this.path}.learning-archive`) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      names = []
    }
    for (const name of names) {
      if (/^[a-f0-9]{64}\.json\.tmp-\d+-\d+$/u.test(name)) continue
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw new Error('invalid learning receipt archive')
      const archiveText = await readFile(join(`${this.path}.learning-archive`, name), 'utf8')
      const { key, receipt } = JSON.parse(archiveText) as {
        key: string; receipt: Receipt
      }
      if (typeof key !== 'string' || !isLearningEffectReceiptKey(key) || !receipt
        || !validReceipt(receipt) || !('result' in receipt)
        || learningReceiptArchivePath(this.path, key) !== join(`${this.path}.learning-archive`, name)) {
        throw new Error('invalid learning receipt archive entry')
      }
      const previous = this.receipts.get(key)
      const pointer = snapshot[key]
      const index = this.archiveIndex.get(key)
      this.archiveBytes += Buffer.byteLength(archiveText)
      if (!index && pointer === undefined && !previous) {
        throw new Error('unindexed learning archive without journal evidence')
      }
      if (!index && receipt.neverAdmitted && (!previous || !('result' in previous)
        || JSON.stringify(previous) !== JSON.stringify(receipt))) {
        throw new Error('negative learning archive conflicts with original journal')
      }
      if (index && index.archiveDigest !== archiveDigest(key, receipt)) {
        throw new Error('learning archive index digest mismatch')
      }
      if (isArchivePointer(pointer) && pointer.archiveDigest !== archiveDigest(key, receipt)) {
        throw new Error('learning receipt archive digest mismatch')
      }
      if (previous && (previous.requestDigest !== receipt.requestDigest
        || previous.ownerGeneration !== receipt.ownerGeneration
        || ('result' in previous && JSON.stringify(previous) !== JSON.stringify(receipt))
        || (!('result' in previous) && previous.callId !== receipt.result.callId))) {
        throw new Error('conflicting learning receipt archive and journal')
      }
      if (receipt.neverAdmitted && previous
        && (!('result' in previous) || JSON.stringify(previous) !== JSON.stringify(receipt))) {
        throw new Error('negative learning archive conflicts with original journal')
      }
      this.receipts.set(key, receipt)
      this.archived.add(key)
      if (index?.retired) {
        this.retired.add(key)
        this.receipts.delete(key)
        this.activeKeys.delete(key)
        continue
      }
      if (index) {
        this.activeKeys.delete(key)
        this.pendingArchiveKeys.delete(key)
      } else {
        this.pendingArchiveKeys.add(key)
      }
    }
    if (entries.some(([key, receipt]) => isArchivePointer(receipt) && !this.archived.has(key))) {
      throw new Error('learning receipt archive entry missing')
    }
    if ([...this.archiveIndex.keys()].some((key) => !this.archived.has(key)
      && !this.archiveIndex.get(key)?.retired)) {
      throw new Error('indexed learning archive entry missing')
    }
    for (const [key, index] of this.archiveIndex) {
      if (index.retired) {
        this.retired.add(key)
        this.archived.add(key)
        this.receipts.delete(key)
        this.activeKeys.delete(key)
      }
    }
    this.prune()
    if (entries.some(([key, receipt]) => isLearningEffectReceiptKey(key)
      && ('result' in (receipt as Receipt) || isArchivePointer(receipt)))
      || this.archiveIndex.size !== (isArchiveAnchor(anchor) ? anchor.count : 0)) {
      await this.commit()
    }
  }

  async query(query: ExecutionReceiptQuery): Promise<ExecutionReceiptQueryResult> {
    if (!query || typeof query.sessionId !== 'string' || !query.sessionId
      || typeof query.callId !== 'string' || !query.callId
      || typeof query.requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(query.requestDigest)
      || typeof query.ownerGeneration !== 'string' || !/^[1-9]\d*$/u.test(query.ownerGeneration)) {
      return { status: 'unavailable' }
    }
    // Read the journal, not the process cache: a completion in memory is not
    // evidence until committed, and a missing/replaced journal cannot prove absence.
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    } catch {
      return { status: 'unavailable' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'unavailable' }
    const snapshot = parsed as Record<string, unknown>
    const anchor = snapshot[INDEX_KEY]
    if (!isArchiveAnchor(anchor)) return { status: 'unavailable' }
    const entries = Object.entries(snapshot).filter(([id]) => id !== INDEX_KEY)
    if (entries.some(([id, receipt]) =>
      !validReceipt(receipt) && !(isLearningEffectReceiptKey(id) && isArchivePointer(receipt)))) {
      return { status: 'unavailable' }
    }
    const key = `${query.sessionId}:${query.callId}`
    const stored = snapshot[key]
    let receipt = isArchivePointer(stored) ? undefined : stored as Receipt | undefined
    if (isLearningEffectReceiptKey(key)) {
      let indexed = this.archiveIndex.get(key)
      try {
        const diskIndex: unknown = JSON.parse(await readFile(learningReceiptIndexPath(this.path, key), 'utf8'))
        if (!validIndexEntry(diskIndex) || diskIndex.key !== key
          || (indexed && JSON.stringify(indexed) !== JSON.stringify(diskIndex))) return { status: 'unavailable' }
        indexed = diskIndex
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || indexed) return { status: 'unavailable' }
      }
      if (indexed?.retired) return { status: 'unavailable' }
      try {
        const archived = JSON.parse(await readFile(learningReceiptArchivePath(this.path, key), 'utf8')) as {
          key: string; receipt: Receipt
        }
        if (archived.key !== key || !validReceipt(archived.receipt) || !('result' in archived.receipt)
          || (indexed && indexed.archiveDigest !== archiveDigest(key, archived.receipt))
          || (isArchivePointer(stored) && stored.archiveDigest !== archiveDigest(key, archived.receipt))
          || (!indexed && stored === undefined)
          || (archived.receipt.neverAdmitted && !indexed
            && (!receipt || !('result' in receipt)
              || JSON.stringify(receipt) !== JSON.stringify(archived.receipt)))
          || (archived.receipt.neverAdmitted && receipt
            && JSON.stringify(receipt) !== JSON.stringify(archived.receipt))
          || (receipt && (receipt.requestDigest !== archived.receipt.requestDigest
            || receipt.ownerGeneration !== archived.receipt.ownerGeneration
            || ('result' in receipt && JSON.stringify(receipt) !== JSON.stringify(archived.receipt))))) {
          return { status: 'unavailable' }
        }
        receipt = archived.receipt
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
          || isArchivePointer(stored) || indexed) return { status: 'unavailable' }
      }
    }
    if (!receipt) return { status: 'absent_with_valid_journal' }
    if (receipt.ownerGeneration === undefined || receipt.requestDigest === undefined) return { status: 'unavailable' }
    if (receipt.ownerGeneration !== query.ownerGeneration || receipt.requestDigest !== query.requestDigest
      || ('result' in receipt ? receipt.result.callId : receipt.callId) !== query.callId) return { status: 'conflict' }
    if (!('result' in receipt)) return { status: 'started_unknown' }
    if (receipt.neverAdmitted && isLearningEffectReceiptKey(key)) return { status: 'denied' }
    if (!isPinnedEffectReceiptKey(key) && receipt.completedAt < Date.now() - RECEIPT_TTL_MS) return { status: 'unavailable' }
    return { status: 'completed', result: receipt.result }
  }

  async requestCancellation(request: ExecutionCancelRequest): Promise<ExecutionCancelAck> {
    if (typeof request?.stopCommandId !== 'string' || !request.stopCommandId) return { status: 'unavailable' }
    const observed = await this.query(request)
    if (observed.status !== 'started_unknown') return observed
    const key = `${request.sessionId}:${request.callId}`
    const receipt = this.receipts.get(key)
    if (!receipt || 'result' in receipt || receipt.ownerGeneration !== request.ownerGeneration
      || receipt.requestDigest !== request.requestDigest || receipt.callId !== request.callId
      || this.committingCompletions.has(key)) return { status: 'started_unknown' }
    if (receipt.stopCommandId && receipt.stopCommandId !== request.stopCommandId) return { status: 'conflict' }
    if (!receipt.cancelRequestedAt) {
      const marked = { ...receipt, stopCommandId: request.stopCommandId, cancelRequestedAt: Date.now() }
      this.receipts.set(key, marked)
      try {
        await this.commit()
      } catch {
        if (this.receipts.get(key) === marked) this.receipts.set(key, receipt)
        return { status: 'unavailable' }
      }
    }
    const after = await this.query(request)
    if (after.status !== 'started_unknown') return after
    try {
      const disk = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, Receipt>
      const persisted = disk[key]
      return persisted && !('result' in persisted) && validReceipt(persisted)
        && persisted.stopCommandId === request.stopCommandId
        ? { status: 'cancel_requested' } : { status: 'started_unknown' }
    } catch { return { status: 'unavailable' } }
  }

  get(callId: string, requestDigest?: string, requestCallId?: string): ToolResultAck | undefined {
    this.prune()
    if (this.retired.has(callId)) return unknownExecutionResult(requestCallId ?? callId.slice(callId.lastIndexOf(':') + 1))
    const receipt = this.receipts.get(callId)
    if (receipt && requestDigest !== undefined) {
      const replyCallId = requestCallId ?? ('result' in receipt ? receipt.result.callId : receipt.callId)
      if (receipt.requestDigest === undefined) {
        return {
          ...unknownExecutionResult(replyCallId),
          content: JSON.stringify({
            outcome: 'execution_unknown',
            callId: replyCallId,
            message: 'This legacy execution receipt has no request digest, so the request cannot be reconciled safely. External effects may already have occurred. Do not automatically retry; reconcile the external target first.',
          }),
        }
      }
      if (receipt.requestDigest !== requestDigest) return conflictingExecutionResult(replyCallId)
    }
    return receipt && ('result' in receipt ? receipt.result : unknownExecutionResult(receipt.callId))
  }

  inspectArena(key: string): {
    state: 'absent' | 'started' | 'completed' | 'denied'; ownerGeneration?: string; requestDigest?: string; result?: ToolResultAck
    processGroups?: ArenaProcessGroup[]; executorProcess?: ArenaProcessGroup; target?: LearningEffectTarget
  } {
    this.prune()
    if (this.retired.has(key)) return { state: 'started' }
    const receipt = this.receipts.get(key)
    if (!receipt) return { state: 'absent' }
    if (this.committingCompletions.has(key)) return {
      state: 'started',
      ...(receipt.ownerGeneration ? { ownerGeneration: receipt.ownerGeneration } : {}),
      ...(receipt.requestDigest ? { requestDigest: receipt.requestDigest } : {}),
      ...(receipt.processGroups ? { processGroups: receipt.processGroups } : {}),
      ...(receipt.executorProcess ? { executorProcess: receipt.executorProcess } : {}),
      ...(receipt.target ? { target: receipt.target } : {}),
    }
    return {
      state: 'result' in receipt ? (receipt.neverAdmitted ? 'denied' : 'completed') : 'started',
      ...(receipt.ownerGeneration ? { ownerGeneration: receipt.ownerGeneration } : {}),
      ...(receipt.requestDigest ? { requestDigest: receipt.requestDigest } : {}),
      ...(receipt.processGroups ? { processGroups: receipt.processGroups } : {}),
      ...(receipt.executorProcess ? { executorProcess: receipt.executorProcess } : {}),
      ...(receipt.target ? { target: receipt.target } : {}),
      ...('result' in receipt ? { result: receipt.result } : {}),
    }
  }

  /** Durable negative admission, only while this identity has never acquired a started intent. */
  async denyArena(key: string, callId: string, requestDigest: string, ownerGeneration: string): Promise<ToolResultAck> {
    if (!isArenaReceiptKey(key) || !/^[1-9]\d*$/u.test(ownerGeneration) || !/^[a-f0-9]{64}$/u.test(requestDigest)) {
      throw new Error('invalid Arena negative admission identity')
    }
    const previous = this.receipts.get(key)
    if (previous) return this.get(key, requestDigest, callId) ?? unknownExecutionResult(callId)
    const result: ToolResultAck = {
      callId, ok: false, content: 'ERROR: EACCES: independent Arena keeper is unavailable; no action admitted',
      failure: { code: 'arena_not_admitted', category: 'precondition', outcome: 'blocked', retryable: false, responsibility: 'workspace' },
    }
    const receipt: CompletedReceipt = {
      completedAt: Date.now(), result, requestDigest, ownerGeneration, neverAdmitted: true,
    }
    this.receipts.set(key, receipt)
    this.activeKeys.add(key)
    try { await this.commit() } catch (error) {
      if (this.receipts.get(key) === receipt) {
        this.receipts.delete(key)
        this.activeKeys.delete(key)
      }
      throw error
    }
    return result
  }

  /** Persist an exact negative admission before acknowledging a rejected learning mutation. */
  async denyLearning(key: string, callId: string, requestDigest: string, ownerGeneration: string): Promise<ToolResultAck> {
    if (!isLearningEffectReceiptKey(key) || !/^[1-9]\d*$/u.test(ownerGeneration)
      || !/^[a-f0-9]{64}$/u.test(requestDigest)) throw new Error('invalid learning negative admission identity')
    const previous = this.receipts.get(key)
    if (previous || this.archiveIndex.has(key)) return this.get(key, requestDigest, callId) ?? unknownExecutionResult(callId)
    this.prune()
    const unresolved = [...this.activeKeys].filter((id) => {
      const receipt = this.receipts.get(id)!
      return !('result' in receipt) || this.committingCompletions.has(id)
        || (isPinnedEffectReceiptKey(id) && !this.archived.has(id))
    }).length
    if (unresolved >= MAX_RECEIPTS) throw new Error('unresolved execution journal is full')
    const result: ToolResultAck = {
      callId, ok: false, content: 'ERROR: EACCES: learning mutation was not admitted; no tool ran',
      failure: { code: 'learning_not_admitted', category: 'precondition', outcome: 'blocked',
        retryable: false, responsibility: 'workspace' },
    }
    const receipt: CompletedReceipt = { completedAt: Date.now(), result, requestDigest, ownerGeneration, neverAdmitted: true }
    this.receipts.set(key, receipt)
    this.activeKeys.add(key)
    this.pendingArchiveKeys.add(key)
    this.deferredArchiveKeys.add(key)
    try { await this.commit() } catch (error) {
      if (this.receipts.get(key) === receipt) {
        this.receipts.delete(key)
        this.activeKeys.delete(key)
        this.pendingArchiveKeys.delete(key)
      }
      this.deferredArchiveKeys.delete(key)
      throw error
    }
    this.deferredArchiveKeys.delete(key)
    await this.commit()
    return result
  }

  begin(key: string, callId: string, requestDigest?: string, ownerGeneration?: string,
    executorProcess?: ArenaProcessGroup, target?: LearningEffectTarget): Promise<void> {
    if (ownerGeneration !== undefined && (typeof ownerGeneration !== 'string' || !/^[1-9]\d*$/u.test(ownerGeneration))) {
      return Promise.reject(new Error('invalid execution owner generation'))
    }
    if (target && (!isLearningEffectReceiptKey(key) || !validLearningTarget(target)
      || !requestDigest || !ownerGeneration || !executorProcess)) {
      return Promise.reject(new Error('invalid learning effect admission evidence'))
    }
    this.prune()
    if (this.receipts.has(key) || this.archiveIndex.has(key)) return Promise.reject(new Error('execution identity already recorded'))
    if (isLearningEffectReceiptKey(key) && this.archiveHealth().atCapacity
      && requestDigest && ownerGeneration) {
      return this.denyLearning(key, callId, requestDigest, ownerGeneration).then(() => {
        throw new Error('learning archive at configured capacity; durable never-admitted receipt persisted')
      })
    }
    const unresolved = [...this.activeKeys].filter((id) => {
      const receipt = this.receipts.get(id)!
      return !('result' in receipt) || this.committingCompletions.has(id)
        || (isPinnedEffectReceiptKey(id) && !this.archived.has(id))
    }).length
    if (unresolved >= MAX_RECEIPTS) return Promise.reject(new Error('unresolved execution journal is full; reconciliation is required'))
    const receipt = { startedAt: Date.now(), callId, ...(requestDigest ? { requestDigest } : {}),
      ...(ownerGeneration !== undefined ? { ownerGeneration } : {}),
      ...(executorProcess ? { executorProcess } : {}), ...(target ? { target } : {}) }
    this.receipts.set(key, receipt)
    this.activeKeys.add(key)
    this.prune()
    return this.commit().catch((error: unknown) => {
      // No runner entered when admission failed. Do not strand capacity or let
      // a later successful snapshot turn this failed admission into uncertainty.
      if (this.receipts.get(key) === receipt) {
        this.receipts.delete(key)
        this.activeKeys.delete(key)
      }
      throw error
    })
  }

  async recordProcessGroup(key: string, group: ArenaProcessGroup): Promise<void> {
    const previous = this.receipts.get(key)
    if (!previous || 'result' in previous || (previous.processGroups?.length ?? 0) >= 256) {
      throw new Error('Arena process journal missing or full; Git was not started')
    }
    const updated = { ...previous, processGroups: [...previous.processGroups ?? [], group] }
    this.receipts.set(key, updated)
    try { await this.commit() } catch (error) {
      if (this.receipts.get(key) === updated) this.receipts.set(key, previous)
      throw error
    }
  }

  set(callId: string, result: ToolResultAck): Promise<void> {
    if (this.archived.has(callId)) return Promise.reject(new Error('archived learning execution identity is immutable'))
    // Refresh insertion order so capacity pruning retains recently repeated IDs.
    const previous = this.receipts.get(callId)
    if (previous && !('result' in previous)) this.committingCompletions.add(callId)
    const receipt = { completedAt: Date.now(), result, ...(previous?.requestDigest ? { requestDigest: previous.requestDigest } : {}), ...(previous?.ownerGeneration !== undefined ? { ownerGeneration: previous.ownerGeneration } : {}), ...(previous?.processGroups ? { processGroups: previous.processGroups } : {}), ...(previous?.executorProcess ? { executorProcess: previous.executorProcess } : {}), ...(previous?.target ? { target: previous.target } : {}), ...(previous?.cancelRequestedAt ? { cancelRequestedAt: previous.cancelRequestedAt, stopCommandId: previous.stopCommandId } : {}) }
    this.receipts.delete(callId)
    this.receipts.set(callId, receipt)
    this.activeKeys.add(callId)
    if (isLearningEffectReceiptKey(callId)) this.pendingArchiveKeys.add(callId)
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

  /** Offline only: the caller must independently verify a matching PG finalization and stopped Executor. */
  async retireFinalizedLearning(key: string, requestDigest: string, ownerGeneration: string,
    coldDirectory: string, incidentId: string): Promise<void> {
    if (!isLearningEffectReceiptKey(key) || !isAbsolute(coldDirectory) || !incidentId
      || !/^[a-f0-9]{64}$/u.test(requestDigest) || !/^[1-9]\d*$/u.test(ownerGeneration)) {
      throw new Error('invalid offline learning retirement request')
    }
    const index = this.archiveIndex.get(key)
    const receipt = this.receipts.get(key)
    if (!index || (!index.retired && (!receipt || !('result' in receipt)
      || receipt.requestDigest !== requestDigest || receipt.ownerGeneration !== ownerGeneration))
      || (index.retired && (index.retired.requestDigest !== requestDigest
        || index.retired.ownerGeneration !== ownerGeneration))) {
      throw new Error('original completed learning receipt is not available for retirement')
    }
    const source = learningReceiptArchivePath(this.path, key)
    let original: string | undefined
    try { original = await readFile(source, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !index.retired) throw error
    }
    if (original && createHash('sha256').update(original).digest('hex') !== index.archiveDigest) {
      throw new Error('original learning archive changed')
    }
    const coldInfo = await lstat(coldDirectory)
    if (!coldInfo.isDirectory() || (coldInfo.mode & 0o077) !== 0 || coldInfo.uid !== process.getuid?.()) {
      throw new Error('offline archive destination must be an owner-only directory')
    }
    const destination = join(coldDirectory, `${createHash('sha256').update(key).digest('hex')}.json`)
    if (original && !index.retired) {
      try { await copyFile(source, destination, constants.COPYFILE_EXCL) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
          || await readFile(destination, 'utf8') !== original) throw error
      }
    }
    const coldStat = await lstat(destination)
    if (!coldStat.isFile() || (coldStat.mode & 0o077) !== 0 || coldStat.uid !== process.getuid?.()) {
      throw new Error('offline learning archive must be an owner-only regular file')
    }
    const coldOriginal = await readFile(destination, 'utf8')
    if (createHash('sha256').update(coldOriginal).digest('hex') !== index.archiveDigest) {
      throw new Error('offline learning archive does not match the verified index')
    }
    const coldFile = await open(destination, 'r')
    try { await coldFile.sync() } finally { await coldFile.close() }
    const coldDir = await open(coldDirectory, 'r')
    try { await coldDir.sync() } finally { await coldDir.close() }
    if (!index.retired) {
      const updated: ArchiveIndexEntry = {
        ...index, retired: { incidentId, requestDigest, ownerGeneration },
      }
      const indexPath = learningReceiptIndexPath(this.path, key)
      const temp = `${indexPath}.tmp-${process.pid}-${this.generation + 1}`
      try {
        const file = await open(temp, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(updated), 'utf8'); await file.sync() }
        finally { await file.close() }
        await rename(temp, indexPath)
        const directory = await open(dirname(indexPath), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally { await unlink(temp).catch(() => undefined) }
      this.archiveIndex.set(key, updated)
      this.retired.add(key)
      this.receipts.delete(key)
    }
    if (original) {
      await unlink(source)
      this.archiveBytes -= Buffer.byteLength(original)
      const directory = await open(dirname(source), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
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
    for (const key of this.pendingArchiveKeys) {
      const receipt = this.receipts.get(key)
      if (!receipt || !('result' in receipt) || this.archiveIndex.has(key)
        || this.deferredArchiveKeys.has(key)) continue
      const path = learningReceiptArchivePath(this.path, key)
      const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      if (created && process.platform !== 'win32') {
        const directoryParent = await open(dirname(dirname(path)), 'r')
        try { await directoryParent.sync() } finally { await directoryParent.close() }
      }
      const tempArchive = `${path}.tmp-${process.pid}-${generation}`
      const serialized = JSON.stringify({ key, receipt })
      if (this.archiveBytes + Buffer.byteLength(serialized) > this.archiveMaxBytes) continue
      try {
        const file = await open(tempArchive, 'wx', 0o600)
        try {
          await file.writeFile(serialized, 'utf8')
          await file.sync()
        } finally { await file.close() }
        try { await link(tempArchive, path) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
            || await readFile(path, 'utf8') !== serialized) throw error
        }
        const directory = await open(dirname(path), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally { await unlink(tempArchive).catch(() => undefined) }
      const index: ArchiveIndexEntry = { key, archiveDigest: archiveDigest(key, receipt) }
      const indexPath = learningReceiptIndexPath(this.path, key)
      const createdIndex = await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 })
      if (createdIndex && process.platform !== 'win32') {
        const directoryParent = await open(dirname(dirname(indexPath)), 'r')
        try { await directoryParent.sync() } finally { await directoryParent.close() }
      }
      const tempIndex = `${indexPath}.tmp-${process.pid}-${generation}`
      const serializedIndex = JSON.stringify(index)
      try {
        const file = await open(tempIndex, 'wx', 0o600)
        try { await file.writeFile(serializedIndex, 'utf8'); await file.sync() }
        finally { await file.close() }
        try { await link(tempIndex, indexPath) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
            || await readFile(indexPath, 'utf8') !== serializedIndex) throw error
        }
        const directory = await open(dirname(indexPath), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally { await unlink(tempIndex).catch(() => undefined) }
      this.archiveIndex.set(key, index)
      this.archiveBytes += Buffer.byteLength(serialized)
      this.archived.add(key)
      this.activeKeys.delete(key)
      this.pendingArchiveKeys.delete(key)
    }
    const temp = `${this.path}.tmp-${process.pid}-${generation}`
    try {
      const file = await open(temp, 'w', 0o600)
      try {
        await file.writeFile(JSON.stringify({
          [INDEX_KEY]: { version: 1, count: this.archiveIndex.size },
          ...Object.fromEntries([...this.activeKeys].map((key) => [key, this.receipts.get(key)])),
        }), 'utf8')
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
    for (const id of this.activeKeys) {
      const receipt = this.receipts.get(id)!
      if ('result' in receipt && !isPinnedEffectReceiptKey(id) && !this.committingCompletions.has(id)
        && receipt.completedAt < cutoff) {
        this.receipts.delete(id)
        this.activeKeys.delete(id)
      }
    }
    let resident = this.activeKeys.size
    while (resident > MAX_RECEIPTS) {
      const oldest = [...this.activeKeys].find((id) => 'result' in this.receipts.get(id)!
        && !isPinnedEffectReceiptKey(id) && !this.committingCompletions.has(id))
      if (oldest === undefined) break
      this.receipts.delete(oldest)
      this.activeKeys.delete(oldest)
      resident--
    }
  }
}
