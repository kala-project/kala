import { createHash } from 'node:crypto'
import { open, readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { HostLoopDeps } from '../loop-types.js'
import { writeJsonFile } from '../tenant-runtime/atomic-json-file.js'
import {
  consolidateMemory, getOrCreateLearningMetrics, type LearningNudgeMetrics,
} from './memory-consolidation.js'

type Job = { status: 'pending' | 'attempted' | 'completed'; fingerprint: string; error?: string }
const active = new Set<string>()
const queued = new Map<string, Set<string>>()

function eligible(metrics: LearningNudgeMetrics): boolean {
  return !metrics.alreadySavedInTurn && (
    metrics.toolCallsInTurn >= 8 ||
    (metrics.failedToolCallsInTurn >= 2 && metrics.recoveredFromFailure) ||
    metrics.nudgedInTurn ||
    metrics.turnsSinceLastNudge >= 10
  )
}

function jobKey(deps: HostLoopDeps, sessionId: string): { path: string; fingerprint: string } | undefined {
  const record = deps.store.get(sessionId)
  if (!record || record.state.messages.length < 8 ||
    !['idle', 'done', 'error'].includes(record.state.status)) return undefined
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([sessionId, record.state.messages.slice(-40)])).digest('hex')
  return { path: `${record.logPath}.learning-${fingerprint}.json`, fingerprint }
}

async function load(path: string): Promise<Job | undefined> {
  try {
    const job = JSON.parse(await readFile(path, 'utf8')) as Job
    if (!['pending', 'attempted', 'completed'].includes(job.status) ||
      typeof job.fingerprint !== 'string') throw new Error('invalid background learning checkpoint')
    return job
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function start(deps: HostLoopDeps, sessionId: string, path: string): void {
  if (active.has(sessionId)) {
    let pending = queued.get(sessionId)
    if (!pending) {
      pending = new Set()
      queued.set(sessionId, pending)
    }
    pending.add(path)
    return
  }
  active.add(sessionId)
  setImmediate(() => {
    void (async () => {
      try {
        const job = await load(path)
        if (job?.status !== 'pending' || deps.assertSessionEffectOwner ||
          deps.store.get(sessionId)?.workspaceId ||
          !['idle', 'done', 'error'].includes(deps.store.get(sessionId)?.state.status ?? '')) return
        if (jobKey(deps, sessionId)?.path !== path) {
          await writeJsonFile(path, { ...job, status: 'completed', error: 'transcript changed before extraction' } satisfies Job)
          return
        }
        // Mark before effects. Replaying a crashed attempt could duplicate a
        // memory write; an interrupted attempt remains explicitly unresolved.
        await writeJsonFile(path, { ...job, status: 'attempted' } satisfies Job)
        const outcome = await consolidateMemory(deps, sessionId)
        // Session teardown may remove this checkpoint while extraction is in
        // flight. Do not recreate it (or the removed log directory) afterward.
        if ((await load(path))?.status !== 'attempted') return
        await writeJsonFile(path, {
          ...job, status: 'completed', ...(outcome.error ? { error: outcome.error } : {}),
        } satisfies Job)
      } catch (error) {
        process.emitWarning(`background learning failed for ${sessionId}: ${String(error)}`, {
          code: 'KALA_BACKGROUND_LEARNING',
        })
      } finally {
        active.delete(sessionId)
        const pending = queued.get(sessionId)
        const next = pending?.values().next().value
        if (next && pending) {
          pending.delete(next)
          if (pending.size === 0) queued.delete(sessionId)
          start(deps, sessionId, next)
        }
      }
    })()
  })
}

function startShared(deps: HostLoopDeps, sessionId: string, fingerprint: string): void {
  const jobs = deps.backgroundLearningJobs
  if (!jobs || !deps.requireMemoryEffectBarrier) return
  if (active.has(sessionId)) {
    let pending = queued.get(sessionId)
    if (!pending) {
      pending = new Set()
      queued.set(sessionId, pending)
    }
    pending.add(fingerprint)
    return
  }
  active.add(sessionId)
  setImmediate(() => {
    void (async () => {
      try {
        if (!await jobs.claim(sessionId, fingerprint)) return
        if (jobKey(deps, sessionId)?.fingerprint !== fingerprint ||
          !deps.store.get(sessionId)?.workspaceId) {
          await jobs.complete(sessionId, fingerprint, 'transcript changed before extraction')
          return
        }
        const outcome = await consolidateMemory(deps, sessionId)
        await jobs.complete(sessionId, fingerprint, outcome.error)
      } catch (error) {
        // An attempted PG checkpoint is not retried. The owner and final
        // Executor effect barriers must decide whether any write may proceed.
        process.emitWarning(`shared-owner background learning failed for ${sessionId}: ${String(error)}`, {
          code: 'KALA_BACKGROUND_LEARNING',
        })
      } finally {
        active.delete(sessionId)
        const pending = queued.get(sessionId)
        const next = pending?.values().next().value
        if (next && pending) {
          pending.delete(next)
          if (pending.size === 0) queued.delete(sessionId)
          startShared(deps, sessionId, next)
        }
      }
    })()
  })
}

/** Durable, at-most-once local or PostgreSQL-claimed background extraction. */
export async function scheduleBackgroundLearning(
  deps: HostLoopDeps,
  sessionId: string,
  metrics: LearningNudgeMetrics,
): Promise<void> {
  if (!eligible(metrics)) return
  const key = jobKey(deps, sessionId)
  if (!key) return
  const { path, fingerprint } = key
  if (deps.assertSessionEffectOwner && deps.requireMemoryEffectBarrier
    && deps.backgroundLearningJobs && deps.store.get(sessionId)?.workspaceId) {
    await deps.backgroundLearningJobs.enqueue(sessionId, fingerprint)
    startShared(deps, sessionId, fingerprint)
    return
  }
  if (deps.assertSessionEffectOwner || deps.store.get(sessionId)?.workspaceId) return
  try {
    const file = await open(path, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ status: 'pending', fingerprint } satisfies Job))
      await file.sync()
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  start(deps, sessionId, path)
}

/** Revisit pending work when the session is next loaded after a restart. */
export async function resumeBackgroundLearning(deps: HostLoopDeps, sessionId: string): Promise<void> {
  if (deps.assertSessionEffectOwner && deps.requireMemoryEffectBarrier
    && deps.backgroundLearningJobs && deps.store.get(sessionId)?.workspaceId) {
    for (const fingerprint of await deps.backgroundLearningJobs.pending(sessionId)) {
      startShared(deps, sessionId, fingerprint)
    }
    return
  }
  if (deps.assertSessionEffectOwner || deps.store.get(sessionId)?.workspaceId) return
  const record = deps.store.get(sessionId)
  if (!record) return
  const prefix = `${basename(record.logPath)}.learning-`
  let names: string[]
  try { names = await readdir(dirname(record.logPath)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^([a-f0-9]{64})\.json$/.test(name.slice(prefix.length))) continue
    const path = join(dirname(record.logPath), name)
    if ((await load(path))?.status === 'pending') start(deps, sessionId, path)
  }
}

/** Restore the periodic cadence without persisting tool inputs or model messages. */
export async function restoreLearningCadence(deps: HostLoopDeps, sessionId: string): Promise<void> {
  if (deps.assertSessionEffectOwner) return
  const record = deps.store.get(sessionId)
  if (!record) return
  try {
    const raw = JSON.parse(await readFile(`${record.logPath}.learning-nudge.json`, 'utf8')) as {
      turnsSinceLastNudge?: unknown
    }
    if (Number.isSafeInteger(raw.turnsSinceLastNudge) &&
      (raw.turnsSinceLastNudge as number) >= 0) {
      getOrCreateLearningMetrics(sessionId).turnsSinceLastNudge = raw.turnsSinceLastNudge as number
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function persistLearningCadence(deps: HostLoopDeps, sessionId: string): Promise<void> {
  if (deps.assertSessionEffectOwner) return
  const record = deps.store.get(sessionId)
  if (record) {
    await writeJsonFile(`${record.logPath}.learning-nudge.json`, {
      turnsSinceLastNudge: getOrCreateLearningMetrics(sessionId).turnsSinceLastNudge,
    })
  }
}

export async function removeLearningCheckpoints(logPath: string): Promise<void> {
  const prefix = `${basename(logPath)}.learning-`
  let names: string[]
  try { names = await readdir(dirname(logPath)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(names.filter((name) =>
    name.startsWith(prefix) && (
      name.slice(prefix.length) === 'nudge.json' ||
      /^[a-f0-9]{64}\.json$/.test(name.slice(prefix.length))
    ),
  ).map(async (name) => await rm(join(dirname(logPath), name), { force: true })))
}
