import { startExecutor, type ExecutorHandle } from '@agent-kernel/executor'
import { PRIVATE_CLOUD_DEPLOYMENT } from '@agent-kernel/shared'
import { join } from 'node:path'
import type { HostServer, HostServerOptions } from '../server.js'
import { ExecutorIdentityStore, type ExecutorIdentityStorage } from '../store/executor-identity.js'
import { startHostServer } from '../server.js'
import type { TenantRuntimeUnit, TenantRuntimeUnitId, TenantRuntimeUnitState } from './unit.js'

export type LoopbackHostRuntimeUnit = TenantRuntimeUnit & {
  readonly server: HostServer
  readonly executor?: ExecutorHandle
}

/**
 * Platform composition: one complete Host runtime is mounted behind
 * a private loopback listener and exposed as one TenantRuntimeUnit. This keeps
 * all mature Agent behavior intact while the outer multi-tenant Host owns only
 * routing and lifecycle. Later extraction can lift immutable/static services
 * out without changing the Unit contract.
 */
export async function startLoopbackHostRuntimeUnit(
  id: TenantRuntimeUnitId,
  options: Omit<HostServerOptions, 'port' | 'httpServer'> & {
    workspaceDir?: string
    executorIdentityStorePath?: string
    executorIdentityStore?: ExecutorIdentityStorage
    closeResource?: () => Promise<void>
  },
): Promise<LoopbackHostRuntimeUnit> {
  let state: TenantRuntimeUnitState = 'loading'
  const { workspaceDir, executorIdentityStorePath, executorIdentityStore: injectedIdentityStore, closeResource, ...serverOptions } = options
  let server: HostServer | undefined
  let executor: ExecutorHandle | undefined
  try {
    const executorIdentityStore = injectedIdentityStore ?? (executorIdentityStorePath ? new ExecutorIdentityStore(executorIdentityStorePath) : undefined)
    await executorIdentityStore?.load()
    const workspaceId = `${id}-workspace`
    const executorToken = workspaceDir && executorIdentityStore ? await executorIdentityStore.provisionWorkspace(workspaceId, 'Workspace') : undefined
    server = await startHostServer({
      ...serverOptions,
      ...(executorIdentityStore ? { executorIdentityStore } : {}),
      port: 0,
      listenHost: '127.0.0.1',
      deployment: options.deployment ?? PRIVATE_CLOUD_DEPLOYMENT,
    })
    executor = workspaceDir ? startExecutor({
      host: `http://127.0.0.1:${server.port}`,
      workspaceId,
      workspaceName: 'Workspace',
      sandboxRoots: [workspaceDir],
      // Platform loopback execution still performs real filesystem mutations. Keep
      // durable scoped receipts so Unit/Host restart cannot execute them twice.
      receiptStorePath: join(workspaceDir, '.kala', 'execution-receipts.json'),
      ...(executorToken ? { token: executorToken } : {}),
    }) : undefined
    if (executor) {
      await executor.ready
      const deadline = Date.now() + 10_000
      while (!server.executorsSnapshot().some((attached) => attached.workspaceId === executor!.workspaceId)) {
        if (Date.now() >= deadline) throw new Error(`TenantRuntimeUnit ${id} executor announcement timed out`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  } catch (error) {
    executor?.close()
    await server?.close().catch(() => undefined)
    await closeResource?.().catch(() => undefined)
    throw error
  }
  state = 'ready'
  let closed = false
  return {
    id,
    get state() { return state },
    origin: `http://127.0.0.1:${server.port}`,
    server,
    ...(executor ? { executor } : {}),
    purgeOrganizationSessions: async (params) => await server.store.purgeOrganizationSessions(params),
    async drain() {
      if (closed || state === 'draining') return
      state = 'draining'
      server.loop.beginDrain('checkpoint')
      const sessions = server.store.list()
      await Promise.all(sessions.map(async (session) => {
        const snapshot = server.loop.drainSnapshot(session.sessionId)
        if (!snapshot.safe) await server.loop.waitForCheckpoint(session.sessionId)
      }))
    },
    async close() {
      if (closed) return
      closed = true
      state = 'draining'
      executor?.close()
      try {
        await server.close()
      } finally {
        try {
          await closeResource?.()
        } finally {
          state = 'closed'
        }
      }
    },
  }
}
