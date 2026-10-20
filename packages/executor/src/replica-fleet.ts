import { join } from 'node:path'

import { createExecutorSharedExecution, startExecutor, type ExecutorHandle, type ExecutorOptions, type PermanentError } from './client.js'

const REPLICA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export async function discoverExecutorReplicas(options: {
  host: string
  invite?: string
  routeHint?: string
  fetch?: typeof globalThis.fetch
}): Promise<readonly string[] | undefined> {
  if (!options.invite && !options.routeHint) return undefined
  const request = options.fetch ?? globalThis.fetch
  const endpoint = new URL('/.well-known/kala/executor-replicas', options.host)
  if (endpoint.protocol === 'ws:') endpoint.protocol = 'http:'
  else if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:'
  const response = await request(endpoint, {
    headers: {
      ...(options.invite ? { 'x-kala-executor-invite': options.invite } : {}),
      ...(options.routeHint ? { 'x-kala-executor-route': options.routeHint } : {}),
    },
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Executor replica discovery failed with HTTP ${response.status}`)
  const body = await response.json() as { replicas?: unknown }
  if (!Array.isArray(body.replicas)
    || body.replicas.some((id) => typeof id !== 'string' || !REPLICA_ID.test(id))
    || new Set(body.replicas).size !== body.replicas.length) {
    throw new Error('Executor replica discovery returned an invalid membership')
  }
  return [...body.replicas].sort()
}

export type ExecutorReplicaFleet = {
  readonly ready: Promise<void>
  readonly permanentError: Promise<PermanentError>
  readonly replicaIds: () => readonly string[]
  readonly connected: () => boolean
  readonly activeToolCount: () => number
  readonly activeTerminalCount: () => number
  readonly draining: () => boolean
  beginDrain(): void
  resume(): void
  close(): Promise<void>
}

export function startExecutorReplicaFleet(options: Omit<ExecutorOptions, 'invite' | 'replicaId' | 'sharedExecution'> & {
  token: string
  routeHint: string
  replicaIds: readonly string[]
  refreshReplicaIds?: () => Promise<readonly string[] | undefined>
  refreshIntervalMs?: number
}): ExecutorReplicaFleet {
  if (options.replicaIds.length === 0 || options.replicaIds.some((id) => !REPLICA_ID.test(id))) {
    throw new Error('Executor replica fleet requires valid replica ids')
  }
  const workspaceRoot = options.sandboxRoots?.[0] ?? process.cwd()
  const sharedExecution = createExecutorSharedExecution(
    options.receiptStorePath === false ? false : options.receiptStorePath ?? join(workspaceRoot, '.kala', 'execution-receipts.json'),
  )
  const handles = new Map<string, ExecutorHandle>()
  let closed = false
  let draining = false
  let permanentErrorResolver: ((error: PermanentError) => void) | undefined
  const permanentError = new Promise<PermanentError>((resolve) => { permanentErrorResolver = resolve })

  const attach = (replicaId: string): ExecutorHandle => {
    const handle = startExecutor({ ...options, replicaId, sharedExecution })
    handles.set(replicaId, handle)
    if (draining) handle.beginDrain()
    void handle.permanentError.then((error) => {
      if (closed || handles.get(replicaId) !== handle) return
      permanentErrorResolver?.(error)
      permanentErrorResolver = undefined
    })
    return handle
  }

  const initial = [...new Set(options.replicaIds)].sort().map(attach)
  const disconnectMissing = async (desired: ReadonlySet<string>): Promise<void> => {
    for (const [replicaId, handle] of handles) {
      if (desired.has(replicaId)) continue
      handles.delete(replicaId)
      await handle.close()
    }
  }
  const reconcile = async (): Promise<void> => {
    if (closed || !options.refreshReplicaIds) return
    let discovered: readonly string[] | undefined
    try {
      discovered = await options.refreshReplicaIds()
    } catch {
      // Membership cannot be revalidated. Disconnect every route and keep
      // polling; retaining an established socket could execute on a stale owner.
      await disconnectMissing(new Set())
      return
    }
    if (!discovered || discovered.some((id) => !REPLICA_ID.test(id))) {
      await disconnectMissing(new Set())
      return
    }
    const desired = new Set(discovered)
    await disconnectMissing(desired)
    for (const replicaId of [...desired].sort()) if (!handles.has(replicaId)) attach(replicaId)
  }
  const timer = options.refreshReplicaIds
    ? setInterval(() => { void reconcile() }, options.refreshIntervalMs ?? 5_000)
    : undefined
  timer?.unref?.()

  return {
    ready: Promise.all(initial.map((handle) => handle.ready)).then(() => undefined),
    permanentError,
    replicaIds: () => [...handles.keys()].sort(),
    connected: () => handles.size > 0 && [...handles.values()].every((handle) => handle.socket.connected),
    activeToolCount: () => [...handles.values()].reduce((sum, handle) => sum + handle.activeToolCount(), 0),
    activeTerminalCount: () => [...handles.values()].reduce((sum, handle) => sum + handle.activeTerminalCount(), 0),
    draining: () => draining,
    beginDrain() { draining = true; for (const handle of handles.values()) handle.beginDrain() },
    resume() { draining = false; for (const handle of handles.values()) handle.resume() },
    async close() {
      if (closed) return
      closed = true
      if (timer) clearInterval(timer)
      await Promise.allSettled([...handles.values()].map((handle) => handle.close()))
      handles.clear()
      await sharedExecution.receiptStore?.flush()
    },
  }
}
