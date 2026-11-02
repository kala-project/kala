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

export function startExecutorReplicaFleet(options: Omit<ExecutorOptions, 'replicaId' | 'sharedExecution'> & {
  routeHint: string
  /** Undefined starts on the exclusive route and keeps discovering promotion. */
  replicaIds?: readonly string[]
  refreshReplicaIds?: () => Promise<readonly string[] | undefined>
  refreshIntervalMs?: number
}): ExecutorReplicaFleet {
  if (options.replicaIds && (options.replicaIds.length === 0 || options.replicaIds.some((id) => !REPLICA_ID.test(id)))) {
    throw new Error('Executor replica fleet requires valid replica ids')
  }
  const workspaceRoot = options.sandboxRoots?.[0] ?? process.cwd()
  const sharedExecution = createExecutorSharedExecution(
    options.receiptStorePath === false ? false : options.receiptStorePath ?? join(workspaceRoot, '.kala', 'execution-receipts.json'),
  )
  const handles = new Map<string, ExecutorHandle>()
  let closed = false
  let draining = false
  let parallel = options.replicaIds !== undefined
  let token = options.token
  let reconciling = false
  let permanentErrorResolver: ((error: PermanentError) => void) | undefined
  const permanentError = new Promise<PermanentError>((resolve) => { permanentErrorResolver = resolve })

  const attach = (replicaId: string): ExecutorHandle => {
    const { invite, token: _initialToken, ...connection } = options
    const handle = startExecutor({
      ...connection,
      ...(token ? { token } : invite ? { invite } : {}),
      ...(replicaId ? { replicaId } : {}),
      sharedExecution,
      onToken(nextToken) { token = nextToken; options.onToken?.(nextToken) },
    })
    handles.set(replicaId, handle)
    if (draining) handle.beginDrain()
    void handle.permanentError.then((error) => {
      if (closed || handles.get(replicaId) !== handle) return
      permanentErrorResolver?.(error)
      permanentErrorResolver = undefined
    })
    return handle
  }

  // The empty internal key denotes the exclusive Gateway route, never a replica ID.
  const initial = [...new Set(options.replicaIds ?? [''])].sort().map(attach)
  const disconnectMissing = async (desired: ReadonlySet<string>): Promise<void> => {
    for (const [replicaId, handle] of handles) {
      if (desired.has(replicaId)) continue
      handles.delete(replicaId)
      await handle.close()
    }
  }
  const reconcile = async (): Promise<void> => {
    if (closed || reconciling || !options.refreshReplicaIds) return
    reconciling = true
    try {
      let discovered: readonly string[] | undefined
      try {
        discovered = await options.refreshReplicaIds()
      } catch {
        // Membership cannot be revalidated. Disconnect every route and keep
        // polling; retaining an established socket could execute on a stale owner.
        await disconnectMissing(new Set())
        return
      }
      if (closed) return
      if (discovered?.some((id) => !REPLICA_ID.test(id)) || (discovered && new Set(discovered).size !== discovered.length)) {
        await disconnectMissing(new Set())
        return
      }
      if (discovered !== undefined) parallel = true
      // Once parallel membership has been observed, 404 must never downgrade to
      // an unscoped route. Before promotion it is the normal exclusive contract.
      const desired = new Set(discovered ?? (parallel ? [] : ['']))
      const exclusive = handles.get('')
      if (parallel && exclusive) {
        // A promotion racing first enrollment must not redeem one invite on
        // multiple replica sockets. Finish the existing welcome/token exchange.
        if (!token) return
        // Closing a socket aborts its local tools/terminals. Drain before replacing
        // the exclusive route, and reuse the same receipts across every new socket.
        exclusive.beginDrain()
        if (exclusive.activeToolCount() > 0 || exclusive.activeTerminalCount() > 0) return
      }
      await disconnectMissing(desired)
      if (closed) return
      for (const replicaId of [...desired].sort()) if (!handles.has(replicaId)) attach(replicaId)
    } finally {
      reconciling = false
    }
  }
  const timer = options.refreshReplicaIds
    ? setInterval(() => { void reconcile() }, options.refreshIntervalMs ?? 5_000)
    : undefined
  timer?.unref?.()

  return {
    ready: Promise.all(initial.map((handle) => handle.ready)).then(() => undefined),
    permanentError,
    replicaIds: () => [...handles.keys()].filter(Boolean).sort(),
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
