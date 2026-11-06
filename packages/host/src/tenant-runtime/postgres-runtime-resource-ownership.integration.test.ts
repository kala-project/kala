import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Server } from 'socket.io'

import { grantPostgresArenaOperator, migratePostgres } from '../postgres-migrations.js'
import type { ArtifactObjectStore } from '../artifacts/object-store.js'
import { PostgresObjectMetadataLog } from '../artifacts/postgres-object-metadata.js'
import { PostgresObjectCapacityLedger } from '../artifacts/postgres-object-capacity.js'
import { PostgresSessionAuthority, SessionDeletingError } from '../store/postgres-session-authority.js'
import { consumeNextChildCommand, consumeNextChildStop } from '../store/child-command-consumer.js'
import { reconcileChildTurn, startChildCommandWorker, stopChildTurn } from '../store/child-command-worker.js'
import { messageOperationFingerprint } from '../message-operation-fingerprint.js'
import { createPostgresHotStateStore, type HotStateSqlExecutor } from './postgres-hot-state.js'
import {
  createPostgresRuntimeResourceOwnershipStore,
  RuntimeResourceOwnershipFencedError,
  RuntimeResourceOwnershipHeldError,
  RuntimeWorkspaceEffectActiveError,
  RuntimeUnitReplicaMembershipFencedError,
  type PostgresRuntimeResourceOwnershipStore,
  type RuntimeResourceOwnership,
  type RuntimeResourceScope,
} from './postgres-runtime-resource-ownership.js'
import { parseTenantRuntimeUnitId } from './unit.js'
import { RuntimeResourceOwnershipManager } from './runtime-resource-ownership.js'
import { RuntimeSessionOwnership } from './runtime-session-ownership.js'
import { runWorktreeArenaTool, WORKTREE_ARENA_METADATA_ACTION } from '../extensions/worktree-arena.js'
import type { HostLoopDeps } from '../loop-types.js'
import { createExecutorRegistry } from '../connection/executor.js'
import { assertArenaKeeper } from '../../../executor/src/arena-keeper.js'
import { ExecutionReceiptStore, executionRequestDigest } from '../../../executor/src/execution-receipts.js'
import { assertGroupStopped } from '../../../executor/src/tools/arena-process-groups.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgresRuntimeResourceOwnershipStore isolated PostgreSQL integration', () => {
  const project = `kala-resource-owner-${randomUUID()}`
  const container = `${project}-postgres`
  const volume = `${project}-data`
  const databaseName = `kala_resource_owner_${randomUUID().replaceAll('-', '')}`
  const password = `test-${randomUUID()}`
  let connectionString = ''
  let first: PostgresRuntimeResourceOwnershipStore
  let second: PostgresRuntimeResourceOwnershipStore

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', container,
      '--label', `dev.kala.test.project=${project}`,
      '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      '--env', `POSTGRES_PASSWORD=${password}`,
      '--env', `POSTGRES_DB=${databaseName}`,
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker(
      'inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container,
    )
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`
    first = createPostgresRuntimeResourceOwnershipStore({ connectionString, applicationName: `${project}-a` })
    second = createPostgresRuntimeResourceOwnershipStore({ connectionString, applicationName: `${project}-b` })
    await eventually(async () => { await first.database.query('SELECT 1') }, 30_000)
    await migratePostgres({ connectionString })
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled([first?.close(), second?.close()])
    await docker('rm', '--force', container).catch(() => undefined)
    await docker('volume', 'rm', volume).catch(() => undefined)
  }, 30_000)

  it('registers two replicas for one Unit and lets each own a different Session', async () => {
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const organizationId = randomUUID()
    const [replicaA, replicaB] = await Promise.all([
      first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://replica-a.example',
      }, 5_000),
      second.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://replica-b.example',
      }, 5_000),
    ])

    const renewedA = await first.renewReplica(replicaA, 8_000)
    const replicas = await second.lookupLiveReplicas({ organizationId, unitId })
    expect(replicas).toHaveLength(2)
    expect(replicas.map((replica) => replica.replicaId)).toEqual(expect.arrayContaining([replicaA.replicaId, replicaB.replicaId]))
    expect(renewedA.expiresAt.getTime()).toBeGreaterThan(replicaA.expiresAt.getTime())

    const sessionA = resource(organizationId, unitId, 'session')
    const sessionB = resource(organizationId, unitId, 'session')
    const [ownerA, ownerB] = await Promise.all([
      first.acquireResourceOwner(sessionA, renewedA, randomUUID(), 5_000),
      second.acquireResourceOwner(sessionB, replicaB, randomUUID(), 5_000),
    ])
    await expect(second.acquireResourceOwner(sessionA, replicaB, randomUUID(), 5_000))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipHeldError)
    await expect(first.lookupResourceOwner(sessionA)).resolves.toMatchObject({
      replicaId: ownerA.replicaId, origin: renewedA.origin, generation: 1n,
    })
    await expect(first.lookupResourceOwner(sessionB)).resolves.toMatchObject({
      replicaId: ownerB.replicaId, origin: replicaB.origin, generation: 1n,
    })
    await expect(first.lookupResourceOwner({ ...sessionA, organizationId: randomUUID() })).resolves.toBeUndefined()
  })

  it('claims a real Git common directory across workspace aliases, Sessions and tenants until final cleanup', async () => {
    const root = mkdtempSync(join(process.cwd(), 'pg-arena-repository-'))
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root })
      const alias = `${root}-alias`
      symlinkSync(root, alias)
      try {
        const common = (at: string) => execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          { cwd: at, encoding: 'utf8' }).trim()
        const identity = (at: string) => {
          const entry = statSync(common(at), { bigint: true })
          return `git-common-inode:${entry.dev}:${entry.ino}`
        }
        expect(identity(root)).toBe(identity(alias))
        const ownerOf = async (store: PostgresRuntimeResourceOwnershipStore, organizationId: string) => {
          const unitId = parseTenantRuntimeUnitId(randomUUID())
          const replica = await store.registerReplica({
            organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
            origin: `https://${randomUUID()}.example`,
          }, 8_000)
          return await store.acquireResourceOwner(resource(organizationId, unitId, 'session'), replica, randomUUID(), 8_000)
        }
        const ownerA = await ownerOf(first, randomUUID())
        const ownerB = await ownerOf(second, randomUUID())
        await first.claimArenaRepository(ownerA, identity(root), 'arenaA')
        await first.registerWorkspaceEffect(ownerA, 'mutationA', 'workspaceA', identity(root), 'arenaA')
        await expect(second.claimArenaRepository(ownerB, identity(alias), 'arenaB'))
          .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
        await first.completeWorkspaceEffect(ownerA, 'mutationA')
        await expect(second.claimArenaRepository(ownerB, identity(alias), 'arenaB'))
          .rejects.toBeInstanceOf(RuntimeResourceOwnershipHeldError)
        await first.registerWorkspaceEffect(ownerA, 'cleanupA', 'workspaceA', identity(root), 'arenaA')
        await first.releaseArenaRepository(ownerA, identity(root), 'arenaA', 'cleanupA')
        await first.completeWorkspaceEffect(ownerA, 'cleanupA')
        await second.claimArenaRepository(ownerB, identity(alias), 'arenaB')
        await second.registerWorkspaceEffect(ownerB, 'mutationB', 'workspaceB', identity(alias), 'arenaB')
        await second.completeWorkspaceEffect(ownerB, 'mutationB')
        await second.registerWorkspaceEffect(ownerB, 'cleanupB', 'workspaceB', identity(alias), 'arenaB')
        await second.releaseArenaRepository(ownerB, identity(alias), 'arenaB', 'cleanupB')
        await second.completeWorkspaceEffect(ownerB, 'cleanupB')
        const competing = await Promise.allSettled([
          first.claimArenaRepository(ownerA, identity(root), 'arenaA2'),
          second.claimArenaRepository(ownerB, identity(alias), 'arenaB2'),
        ])
        expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(competing.filter((result) => result.status === 'rejected'))
          .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'RUNTIME_RESOURCE_OWNERSHIP_HELD' }) })])
        const winner = competing[0]?.status === 'fulfilled'
          ? { store: first, lease: ownerA, arena: 'arenaA2', workspace: 'workspaceA' }
          : { store: second, lease: ownerB, arena: 'arenaB2', workspace: 'workspaceB' }
        await winner.store.registerWorkspaceEffect(winner.lease, 'cleanup-race', winner.workspace, identity(root), winner.arena)
        await winner.store.releaseArenaRepository(winner.lease, identity(root), winner.arena, 'cleanup-race')
        await winner.store.completeWorkspaceEffect(winner.lease, 'cleanup-race')
      } finally { rmSync(alias, { force: true }) }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps UNKNOWN while a real Git worktree child survives Executor SIGKILL and PG restart', async () => {
    const root = mkdtempSync(join(process.cwd(), 'arena-executor-crash-'))
    const keeperRoot = mkdtempSync(join(process.cwd(), 'arena-keeper-'))
    const keeperFile = join(keeperRoot, 'keeper.json')
    const receipts = join(root, 'receipts.json')
    const operatorSecretPath = join(root, 'operator-url')
    const http = createServer()
    const io = new Server(http)
    const children: ChildProcess[] = []
    let pausedGitPid: number | undefined, pausedPgid: number | undefined
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      writeFileSync(join(root, 'a.txt'), 'base\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: root })
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root })
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
      const address = http.address()
      if (!address || typeof address === 'string') throw new Error('test HTTP server did not bind')
      const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
      const a = await first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://crash-a.example',
      }, 30_000)
      const b = await second.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://crash-b.example',
      }, 30_000)
      const scope = resource(organizationId, unitId, 'session')
      const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 500)
      const workspaceId = `crash-${randomUUID()}`
      const repositoryIdentity = `git-common-inode:${statSync(join(root, '.git'), { bigint: true }).dev}:${statSync(join(root, '.git'), { bigint: true }).ino}`
      const operatorId = `arena_operator_${organizationId.replaceAll('-', '')}`
      const operatorPassword = `test-${randomUUID()}`
      await first.database.query(`CREATE ROLE "${operatorId}" LOGIN PASSWORD '${operatorPassword.replaceAll("'", "''")}'`)
      await grantPostgresArenaOperator({ connectionString, operatorRole: operatorId, organizationId })
      const updateOperatorUrl = () => {
        const url = new URL(connectionString)
        url.username = operatorId
        url.password = operatorPassword
        writeFileSync(operatorSecretPath, url.href, { mode: 0o600 })
      }
      updateOperatorUrl()
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      const authority = createPostgresHotStateStore({ connectionString })
      const session = new PostgresSessionAuthority(authority, organizationId, { schemaManagement: 'external' })
      await session.create({ sessionId: scope.resourceId, state: { cursor: 0 }, config: {} })
      const persistArenaState = async (target: PostgresSessionAuthority, status: 'initializing' | 'active') =>
        await target.mutate(scope.resourceId, {
          mutationId: randomUUID(), eventType: `runtime.metadata.${WORKTREE_ARENA_METADATA_ACTION}`,
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: scope.resourceId,
            action: WORKTREE_ARENA_METADATA_ACTION,
            payload: { arena: { arenaId: 'crash', repoRoot: status === 'active' ? root : '',
              ...(status === 'active' ? { repositoryIdentity } : {}), baseRef: 'HEAD',
              baseSha: status === 'active' ? baseSha : '', status,
              candidates: status === 'active' ? [{ id: 'one', branch: 'kala-arena/crash/one',
                worktreePath: join(root, '.kala-arena', 'crash', 'one'), status: 'active', label: 'one' }]
                : [{ id: 'one', branch: 'kala-arena/crash/one', worktreePath: '', status: 'pending', label: 'one' }] } } },
          apply(current) { if (!current) throw new Error('test Session not found'); return current },
        })
      await persistArenaState(session, 'initializing')
      await authority.close()
      const callId = 'arena-init-CRASH'
      await first.claimArenaRepository(owner, repositoryIdentity, 'crash')
      await first.registerWorkspaceEffect(owner, callId, workspaceId, repositoryIdentity, 'crash')
      const registry = createExecutorRegistry(io, {
        workspaceIdFor: () => workspaceId,
        approvedArenaReadParent: () => true,
        assertSessionEffectOwner: async () => ({ ownerGeneration: String(owner.generation) }),
      }, 12_000, undefined, 100)
      io.of('/executor').on('connection', (socket) => {
        socket.on('executor:announce', (announcement) => registry.attach(socket, announcement))
        socket.on('disconnect', () => registry.detach(socket))
      })
      const helper = join(process.cwd(), 'src', 'tenant-runtime', 'arena-executor-crash-helper.mjs')
      await execFileAsync('pnpm', ['--dir', '../executor', 'build'], { cwd: process.cwd() })
      const startKeeper = () => {
        const child = spawn(process.execPath, [
          join(process.cwd(), '..', 'executor', 'dist', 'bin', 'kala-executor.js'),
          'arena-keeper', keeperFile,
        ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
        children.push(child)
        return child
      }
      let keeper = startKeeper()
      await eventually(async () => {
        if (!existsSync(keeperFile)) throw new Error('independent Arena keeper did not register')
        await assertArenaKeeper(keeperFile)
      }, 8_000)
      const start = (executorId: string) => {
        const child = spawn(process.execPath, ['--import', 'tsx', helper], {
          cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env, ARENA_TEST_HOST: `http://127.0.0.1:${address.port}`,
            ARENA_TEST_WORKSPACE: workspaceId, ARENA_TEST_EXECUTOR: executorId,
            ARENA_TEST_ROOT: root, ARENA_TEST_RECEIPTS: receipts,
            ARENA_TEST_KEEPER: keeperFile,
            KALA_ARENA_TEST_PAUSE_GIT: 'worktree-add',
          },
        })
        children.push(child)
        return child
      }
      const firstExecutor = start(`first-${randomUUID()}`)
      await eventually(async () => {
        if (registry.snapshot().length < 1) throw new Error('first Executor not connected')
      }, 8_000)
      const running = registry.callTool(scope.resourceId, {
        kind: 'call_tool', callId, name: 'arena_git_init',
        input: {
          ownerGeneration: String(owner.generation), parentCallId: 'approved',
          arenaId: 'crash', baseRef: 'HEAD', candidates: ['one'], repositoryIdentity,
        },
      })
      await eventually(async () => {
        const journal = JSON.parse(readFileSync(receipts, 'utf8')) as Record<string, {
          processGroups?: Array<{ pgid: number; leaderStartTicks: string }>
        }>
        const groups = journal[`${scope.resourceId}:${callId}`]?.processGroups ?? []
        for (const name of readdirSync('/proc')) {
          if (!/^\d+$/u.test(name)) continue
          try {
            const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
            const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)
            const command = readFileSync(`/proc/${name}/cmdline`, 'utf8')
            const group = groups.find((entry) => entry.pgid === Number(fields[2]))
            if (group && fields[0] === 'T' && command.includes('worktree\0add\0')) {
              pausedGitPid = Number(name)
              pausedPgid = group.pgid
              break
            }
          } catch { /* Process exited during inspection. */ }
        }
        if (!pausedGitPid) throw new Error('real Git worktree child has not paused in its recorded group')
      }, 8_000)
      const caFile = join(keeperRoot, 'isolated-ca.pem')
      const configFile = join(keeperRoot, 'external-executor.json')
      writeFileSync(caFile, 'isolated CA fixture\n', { mode: 0o600 })
      writeFileSync(configFile, JSON.stringify({
        version: 1, host: 'https://isolated-runtime.example', arenaKeeperIdentityFile: keeperFile,
      }), { mode: 0o600 })
      const preflight = async () => await execFileAsync(process.execPath, [
        join(process.cwd(), '..', '..', 'deploy', 'private-cloud', 'check-arena-executor-readiness.mjs'),
        configFile, root, receipts, caFile, operatorSecretPath,
      ], { cwd: process.cwd(), env: { ...process.env, KALA_ARENA_ACCEPTANCE_DOCKER: 'sudo' } })
      await expect(preflight()).resolves.toMatchObject({
        stdout: expect.stringContaining('"oldComposeOwnsExecutor":false'),
      })
      const { stdout: images } = await docker('image', 'ls', '--format', '{{.ID}} {{.Repository}}')
      const imageId = images.split('\n').find((entry) => entry.endsWith(' node'))?.split(' ')[0]
      if (!imageId) throw new Error('Locally cached Node image required for host PID-namespace operator test')
      const { stdout: image } = await docker('image', 'inspect', imageId, '--format', '{{.Id}}')
      const inspectFromKeeper = () => execFileAsync('sg', [
        'docker', '-c', `sh ../../deploy/private-cloud/run-arena-operator.sh inspect ${organizationId} ${unitId} ${scope.resourceId}`,
      ], { cwd: process.cwd(), env: {
        ...process.env, KALA_ARENA_EXECUTOR_PID_ANCHOR: 'host',
        KALA_ARENA_KEEPER_IDENTITY_FILE: keeperFile,
        KALA_ARENA_EXPECTED_PID_NAMESPACE: readlinkSync('/proc/self/ns/pid'),
        KALA_ARENA_OPERATOR_IMAGE: image.trim(),
        KALA_ARENA_OPERATOR_NETWORK: 'host',
        KALA_ARENA_WORKSPACE_HOST: root,
        KALA_ARENA_OPERATOR_URL_FILE: operatorSecretPath,
        KALA_ARENA_OPERATOR_ID: operatorId,
      } })
      await expect(inspectFromKeeper()).resolves.toMatchObject({
        stdout: expect.stringContaining(callId),
      })
      firstExecutor.kill('SIGKILL')
      await once(firstExecutor, 'exit')
      keeper.kill('SIGKILL')
      await once(keeper, 'exit')
      await expect(preflight()).rejects.toThrow()
      await expect(inspectFromKeeper()).rejects.toThrow('keeper is unavailable')
      expect(readFileSync(`/proc/${pausedGitPid}/stat`, 'utf8')).toContain(' T ')
      expect(existsSync(join(root, '.kala-arena', 'crash', 'one', 'a.txt'))).toBe(false)
      const reconcile = async (operatorIdentity = operatorId, mode?: '--repair-init') => await execFileAsync(process.execPath, [
        '--import', 'tsx', join(process.cwd(), 'bin', 'arena-effect-reconcile.ts'),
        organizationId, unitId, scope.resourceId, callId, root, receipts,
        'incident-fixture', `verify-stopped:${callId}`, ...(mode ? [mode] : []),
      ], { cwd: process.cwd(), env: { ...process.env,
        KALA_ARENA_RECONCILE_OPERATOR_URL_FILE: operatorSecretPath, KALA_ARENA_OPERATOR_ID: operatorIdentity } })
      await expect(reconcile()).rejects.toThrow(/still contains a live process/u)
      await expect(reconcile(operatorId, '--repair-init')).rejects.toThrow(/still contains a live process/u)
      expect(await first.inspectWorkspaceEffects(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ effectId: callId }),
      ]))
      await docker('restart', container)
      const { stdout: restartedPort } = await docker('inspect', '--format',
        '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container)
      connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${restartedPort.trim()}/${databaseName}`
      updateOperatorUrl()
      await Promise.allSettled([first.close(), second.close()])
      first = createPostgresRuntimeResourceOwnershipStore({ connectionString, applicationName: `${project}-a-restarted` })
      second = createPostgresRuntimeResourceOwnershipStore({ connectionString, applicationName: `${project}-b-restarted` })
      await eventually(async () => {
        await first.database.query('SELECT 1')
        await second.database.query('SELECT 1')
      }, 8_000)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await expect(second.acquireResourceOwner(scope, b, randomUUID(), 8_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      keeper = startKeeper()
      await eventually(async () => {
        const recorded = JSON.parse(readFileSync(keeperFile, 'utf8')) as { pgid: number }
        if (recorded.pgid !== keeper.pid) throw new Error('new independent keeper not registered yet')
        await assertArenaKeeper(keeperFile)
      }, 8_000)
      await expect(preflight()).resolves.toMatchObject({
        stdout: expect.stringContaining('"independentKeeper":true'),
      })
      process.kill(pausedGitPid!, 'SIGCONT')
      await eventually(async () => {
        if (!existsSync(join(root, '.kala-arena', 'crash', 'one', 'a.txt'))) {
          throw new Error('orphaned Git child has not completed its final worktree file effect')
        }
      }, 8_000)
      const secondExecutor = start(`second-${randomUUID()}`)
      await eventually(async () => {
        if (registry.snapshot().length < 1 || (await registry.inspectArenaReceipt(scope.resourceId, callId)).state !== 'started') {
          throw new Error('second Executor has not loaded UNKNOWN receipt')
        }
      }, 8_000)
      expect(await registry.inspectArenaReceipt(scope.resourceId, callId)).toMatchObject({
        state: 'started', ownerGeneration: String(owner.generation),
        processGroups: expect.arrayContaining([expect.objectContaining({ pgid: pausedPgid })]),
      })
      await expect(running).resolves.toMatchObject({ ok: false })
      await expect(second.acquireResourceOwner(scope, b, randomUUID(), 8_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      await eventually(async () => {
        try {
          const stats = readFileSync(`/proc/${pausedGitPid}/stat`, 'utf8')
          if (!stats.includes(' Z ')) throw new Error('Git child has not yet exited')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }, 8_000)
      await expect(reconcile()).rejects.toThrow()
      expect(await second.inspectWorkspaceEffects(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ effectId: callId }),
      ]))
      const recoveredHot = createPostgresHotStateStore({ connectionString })
      const recoveredSession = new PostgresSessionAuthority(recoveredHot, organizationId, { schemaManagement: 'external' })
      chmodSync(operatorSecretPath, 0o644)
      try { await expect(reconcile()).rejects.toThrow(/without group\/other access/u) }
      finally { chmodSync(operatorSecretPath, 0o600) }
      await expect(reconcile('forged-operator')).rejects.toThrow(/Authenticated PostgreSQL LOGIN/u)
      expect(await second.inspectWorkspaceEffects(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ effectId: callId }),
      ]))
      await expect(first.reconcileArenaEffect({
        scope, effectId: callId, generation: owner.generation + 1n, workspaceId,
        repositoryIdentity, operatorId, incidentId: 'wrong-generation', evidence: { checked: true }, arenaState: {},
      })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      const operatorDb = createPostgresRuntimeResourceOwnershipStore({
        connectionString: readFileSync(operatorSecretPath, 'utf8'),
      })
      try {
        await expect(operatorDb.reconcileArenaEffect({
          scope, effectId: callId, generation: owner.generation, workspaceId, repositoryIdentity,
          operatorId, incidentId: 'stale-state', evidence: { action: 'init' }, arenaState: { status: 'initializing' },
        })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
        await expect(operatorDb.reconcileArenaEffect({
          scope: { ...scope, organizationId: randomUUID() }, effectId: callId,
          generation: owner.generation, workspaceId, repositoryIdentity,
          operatorId, incidentId: 'wrong-tenant', evidence: { action: 'init' }, arenaState: {},
        })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      } finally { await operatorDb.close() }
      expect(await second.inspectWorkspaceEffects(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ effectId: callId }),
      ]))
      await expect(reconcile(operatorId, '--repair-init'))
        .resolves.toMatchObject({ stdout: expect.stringContaining('"effectStillUnknown":true') })
      expect(await recoveredSession.findLatestRuntimeMetadata(scope.resourceId, WORKTREE_ARENA_METADATA_ACTION))
        .toMatchObject({ payload: { arena: { status: 'active', repoRoot: root, repositoryIdentity } } })
      const replay = await recoveredSession.readHistory(scope.resourceId)
      expect(replay.runtimeMetadata.at(-1)).toMatchObject({ payload: { arena: { status: 'active' } } })
      await recoveredHot.close()
      expect(await second.inspectWorkspaceEffects(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ effectId: callId }),
      ]))
      const repairs = await second.database.query(`SELECT operator_id, incident_id
        FROM tenant_runtime_arena_state_repairs WHERE effect_id = $1`, [callId])
      expect(repairs.rows).toEqual([expect.objectContaining({ operator_id: operatorId, incident_id: 'incident-fixture' })])
      expect(await reconcile()).toMatchObject({ stdout: expect.stringContaining(`"reconciled":"${callId}"`) })
      expect(await second.inspectWorkspaceEffects(scope)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ effectId: callId }),
      ]))
      const audit = await second.database.query(`SELECT operator_id, incident_id, evidence
        FROM tenant_runtime_arena_reconciliations WHERE effect_id = $1`, [callId])
      expect(audit.rows).toEqual([expect.objectContaining({
        operator_id: operatorId, incident_id: 'incident-fixture',
        evidence: expect.objectContaining({ repositoryIdentity, action: 'init' }),
      })])
      const recoveredReplica = await second.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://crash-b-recovered.example',
      }, 10_000)
      await expect(second.acquireResourceOwner(scope, recoveredReplica, randomUUID(), 8_000)).resolves.toMatchObject({
        generation: owner.generation + 1n,
      })
      secondExecutor.kill('SIGKILL')
      await once(secondExecutor, 'exit')
    } finally {
      if (pausedPgid) { try { process.kill(-pausedPgid, 'SIGKILL') } catch {} }
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await new Promise<void>((resolve) => io.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
      rmSync(keeperRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps unresolved workspace effects across expiry, release attempts and replica loss until confirmed exit', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://effect-a.example',
    }, 5_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://effect-b.example',
    }, 5_000)
    const scope = resource(organizationId, unitId, 'session')
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 100)
    const effectId = randomUUID()
    await first.registerWorkspaceEffect(owner, effectId)
    await expect(first.registerWorkspaceEffect(owner, effectId)).rejects.toMatchObject({ code: '23505' })
    await expect(first.releaseResourceOwner(owner)).rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
    await first.releaseReplica(a)
    await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000))
      .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000))
      .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
    await expect(second.completeWorkspaceEffect({ ...owner, ownerToken: randomUUID() }, effectId))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await first.completeWorkspaceEffect(owner, effectId)
    const successor = await second.acquireResourceOwner(scope, b, randomUUID(), 5_000)
    expect(successor.generation).toBe(owner.generation + 1n)
    await expect(first.registerWorkspaceEffect(owner, randomUUID()))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
  })

  it('serializes competing registration, release and takeover on the owner row across replicas', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://race-a.example',
    }, 5_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://race-b.example',
    }, 5_000)
    const scope = resource(organizationId, unitId, 'session')
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 5_000)
    const effectId = randomUUID()
    const lock = await first.database.connect()
    try {
      await lock.query('BEGIN')
      await lock.query(`SELECT 1 FROM tenant_runtime_resource_ownerships
        WHERE organization_id = $1 AND unit_id = $2 AND resource_type = $3 AND resource_id = $4 FOR UPDATE`,
      [scope.organizationId, scope.unitId, scope.resourceType, scope.resourceId])
      const registering = second.registerWorkspaceEffect(owner, effectId)
      const releasing = first.releaseResourceOwner(owner)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await lock.query('COMMIT')
      const results = await Promise.allSettled([registering, releasing])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      if (results[0]?.status === 'fulfilled') {
        expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'RUNTIME_WORKSPACE_EFFECT_ACTIVE' } })
        await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000))
          .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
        await second.completeWorkspaceEffect(owner, effectId)
        await first.releaseResourceOwner(owner)
      } else {
        expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'RUNTIME_RESOURCE_OWNERSHIP_FENCED' } })
      }
      const successor = await second.acquireResourceOwner(scope, b, randomUUID(), 5_000)
      expect(successor.generation).toBe(owner.generation + 1n)
      await expect(first.registerWorkspaceEffect(owner, randomUUID()))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined)
      lock.release()
    }
  })

  it('fences G1 registration racing G2 takeover after membership loss', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://takeover-a.example',
    }, 5_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://takeover-b.example',
    }, 5_000)
    const scope = resource(organizationId, unitId, 'session')
    const old = await first.acquireResourceOwner(scope, a, randomUUID(), 5_000)
    await first.releaseReplica(a)
    const [registration, takeover] = await Promise.allSettled([
      first.registerWorkspaceEffect(old, randomUUID()),
      second.acquireResourceOwner(scope, b, randomUUID(), 5_000),
    ])
    expect(registration).toMatchObject({ status: 'rejected', reason: { code: 'RUNTIME_RESOURCE_OWNERSHIP_FENCED' } })
    expect(takeover).toMatchObject({ status: 'fulfilled', value: { generation: old.generation + 1n } })
  })

  it('serializes independent Sessions sharing one Executor workspace across replicas', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://shared-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://shared-b.example',
    }, 8_000)
    const owners = await Promise.all([
      first.acquireResourceOwner(resource(organizationId, unitId, 'session'), a, randomUUID(), 8_000),
      second.acquireResourceOwner(resource(organizationId, unitId, 'session'), b, randomUUID(), 8_000),
    ])
    const workspaceId = randomUUID()
    const ids = [randomUUID(), randomUUID()]
    const attempts = await Promise.allSettled([
      first.registerWorkspaceEffect(owners[0]!, ids[0]!, workspaceId),
      second.registerWorkspaceEffect(owners[1]!, ids[1]!, workspaceId),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected'))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: '23505' }) })])
    const winner = attempts[0]?.status === 'fulfilled' ? 0 : 1
    await [first, second][winner]!.completeWorkspaceEffect(owners[winner]!, ids[winner]!)
    await [first, second][1 - winner]!.registerWorkspaceEffect(owners[1 - winner]!, ids[1 - winner]!, workspaceId)
    expect((await first.database.query('SELECT count(*)::integer AS n FROM tenant_runtime_active_workspace_effects WHERE workspace_id = $1', [workspaceId])).rows)
      .toEqual([{ n: 1 }])
    await [first, second][1 - winner]!.completeWorkspaceEffect(owners[1 - winner]!, ids[1 - winner]!)
  })

  it('audits a never-dispatched Arena refusal while fencing concurrent dispatch and G2 takeover', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 8_000)
    const workspaceId = `no-dispatch-${randomUUID()}`
    const rejectedId = 'arena-probe-NEVERADMITTED'
    await first.registerWorkspaceEffect(owner, rejectedId, workspaceId, undefined, undefined, true)
    const refused = await first.completeNeverDispatchedWorkspaceEffect(owner, rejectedId, workspaceId, 'host_pre_dispatch_rejection')
    expect(refused).toBeUndefined()
    const audit = await second.database.query<{ generation: string; reason: string }>(
      'SELECT generation, reason FROM tenant_runtime_arena_non_admissions WHERE organization_id = $1 AND resource_id = $2 AND effect_id = $3',
      [organizationId, scope.resourceId, rejectedId])
    expect(audit.rows).toEqual([{ generation: String(owner.generation), reason: 'host_pre_dispatch_rejection' }])
    await expect(second.beginWorkspaceEffectDispatch(owner, rejectedId))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)

    const racedId = 'arena-probe-RACED'
    await first.registerWorkspaceEffect(owner, racedId, workspaceId, undefined, undefined, true)
    const [dispatch, refusal] = await Promise.allSettled([
      second.beginWorkspaceEffectDispatch(owner, racedId),
      first.completeNeverDispatchedWorkspaceEffect(owner, racedId, workspaceId, 'host_pre_dispatch_rejection'),
    ])
    expect([dispatch.status, refusal.status].sort()).toEqual(['fulfilled', 'rejected'])
    if (dispatch.status === 'fulfilled') {
      await first.releaseReplica(a)
      await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      await first.completeWorkspaceEffect(owner, racedId)
    } else {
      expect((refusal as PromiseFulfilledResult<void>).value).toBeUndefined()
      await first.releaseReplica(a)
    }
    const successor = await second.acquireResourceOwner(scope, b, randomUUID(), 5_000)
    expect(successor.generation).toBe(owner.generation + 1n)
    await expect(first.beginWorkspaceEffectDispatch(owner, racedId))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
  })

  it('atomically prepares init claim/effect, rolls back a failed insert, and audits both prepared crash windows', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://init-crash-a.example',
    }, 20_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://init-crash-b.example',
    }, 20_000)
    const scope = resource(organizationId, unitId, 'session')
    const otherScope = resource(organizationId, unitId, 'session')
    const hot = createPostgresHotStateStore({ connectionString })
    const authority = new PostgresSessionAuthority(hot, organizationId, { schemaManagement: 'external' })
    await authority.create({ sessionId: scope.resourceId, state: { cursor: 0 }, config: {} })
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 3_000)
    const other = await second.acquireResourceOwner(otherScope, b, randomUUID(), 10_000)
    const identity = `git-common-inode:41:${Date.now()}11`
    const occupiedIdentity = `git-common-inode:41:${Date.now()}12`
    const occupiedWorkspace = `init-conflict-${randomUUID()}`
    await second.claimArenaRepository(other, occupiedIdentity, 'occupied')
    await second.registerWorkspaceEffect(other, 'arena-status-OCCUPIED', occupiedWorkspace,
      occupiedIdentity, 'occupied')
    const failedId = 'arena-init-ROLLBACK'
    await expect(first.prepareArenaInitEffect(owner, failedId, occupiedWorkspace, identity, 'fresh'))
      .rejects.toMatchObject({ code: '23505' })
    expect((await first.database.query('SELECT 1 FROM tenant_runtime_arena_repository_claims WHERE repository_identity=$1',
      [identity])).rowCount).toBe(0)
    expect(await first.inspectWorkspaceEffects(scope)).toEqual([])
    await second.completeWorkspaceEffect(other, 'arena-status-OCCUPIED')
    const workspaceId = `init-atomic-${randomUUID()}`
    const initId = 'arena-init-NOINTENT'
    await first.prepareArenaInitEffect(owner, initId, workspaceId, identity, 'first')
    expect(await second.inspectWorkspaceEffects(scope)).toEqual([
      expect.objectContaining({ effectId: initId, repositoryIdentity: identity }),
    ])
    const role = `arena_operator_${organizationId.replaceAll('-', '')}`
    const password = `test-${randomUUID()}`
    await first.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
    await grantPostgresArenaOperator({ connectionString, operatorRole: role, organizationId })
    const url = new URL(connectionString)
    url.username = role; url.password = password
    const secretDir = mkdtempSync(join(process.cwd(), 'arena-init-atomic-'))
    const secret = join(secretDir, 'operator-url')
    writeFileSync(secret, url.href, { mode: 0o600 })
    const operator = createPostgresRuntimeResourceOwnershipStore({ connectionString: url.href })
    const run = (effectId: string) => execFileAsync(process.execPath, [
      '--import', 'tsx', join(process.cwd(), 'bin', 'arena-effect-reconcile.ts'),
      organizationId, unitId, scope.resourceId, effectId, '-', '-', 'init-crash-incident',
      `verify-stopped:${effectId}`, '--prepared',
    ], { cwd: process.cwd(), env: { ...process.env, KALA_ARENA_RECONCILE_OPERATOR_URL_FILE: secret,
      KALA_ARENA_OPERATOR_ID: role, KALA_ARENA_EXPECTED_PID_NAMESPACE: readlinkSync('/proc/self/ns/pid') } })
    try {
      await new Promise((done) => setTimeout(done, 3_100))
      await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      await expect(operator.reconcileArenaOffline({
        scope, effectId: initId, generation: owner.generation, workspaceId,
        operatorId: role, incidentId: 'wrong-routine', arenaState: null, mode: 'prepared',
        evidence: { action: 'prepared', dispatchStarted: false },
      })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await run(initId)).toMatchObject({ stdout: expect.stringContaining('"never_dispatched"') })
      expect(await first.inspectWorkspaceEffects(scope)).toEqual([])
      expect((await first.database.query('SELECT 1 FROM tenant_runtime_arena_repository_claims WHERE repository_identity=$1',
        [identity])).rowCount).toBe(0)
      const successor = await second.acquireResourceOwner(scope, b, randomUUID(), 3_000)
      const secondId = 'arena-init-INTENTSAVED'
      await second.prepareArenaInitEffect(successor, secondId, workspaceId, identity, 'second')
      await authority.mutate(scope.resourceId, {
        mutationId: randomUUID(), eventType: 'runtime.metadata.worktree_arena.state',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: scope.resourceId,
          action: WORKTREE_ARENA_METADATA_ACTION, payload: { arena: {
            arenaId: 'second', repoRoot: '', baseRef: 'HEAD', baseSha: '',
            status: 'initializing', candidates: [{ id: 'one', branch: 'kala-arena/second/one',
              worktreePath: '', status: 'pending' }],
          } } },
        apply(current) { if (!current) throw new Error('test Session not found'); return current },
      })
      await new Promise((done) => setTimeout(done, 3_100))
      await expect(run(secondId)).resolves.toMatchObject({ stdout: expect.stringContaining('"never_dispatched"') })
      expect(await operator.readArenaAuthorityState(scope)).toBeNull()
      const audit = await first.database.query<{ evidence: { claimReleased: string; priorArenaRestored: boolean } }>(
        'SELECT evidence FROM tenant_runtime_arena_reconciliations WHERE resource_id=$1 ORDER BY reconciled_at',
        [scope.resourceId])
      expect(audit.rows).toEqual([
        { evidence: expect.objectContaining({ claimReleased: 'first', priorArenaRestored: false }) },
        { evidence: expect.objectContaining({ claimReleased: 'second', priorArenaRestored: true }) },
      ])
      const recovered = await first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://init-crash-recovered.example',
      }, 10_000)
      const third = await first.acquireResourceOwner(scope, recovered, randomUUID(), 500)
      expect(third.generation).toBe(successor.generation + 1n)
      await first.prepareArenaInitEffect(third, 'arena-init-AFTERRESET', workspaceId, identity, 'third')
      await new Promise((done) => setTimeout(done, 550))
      await expect(run('arena-init-AFTERRESET'))
        .resolves.toMatchObject({ stdout: expect.stringContaining('"never_dispatched"') })
      expect(await operator.readArenaAuthorityState(scope)).toBeNull()
    } finally { await operator.close(); await authority.close(); rmSync(secretDir, { recursive: true, force: true }) }
  }, 30_000)

  it('commits final cleanup claim/effect atomically and restricts legacy missing-claim reconciliation', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://cleanup-a.example',
    }, 15_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://cleanup-b.example',
    }, 15_000)
    const scope = resource(organizationId, unitId, 'session')
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 10_000)
    const identity = `git-common-inode:41:${Date.now()}21`
    await first.claimArenaRepository(owner, identity, 'atomic')
    const effectId = 'arena-cleanup-ATOMIC'
    await first.registerWorkspaceEffect(owner, effectId, `cleanup-${randomUUID()}`, identity, 'atomic')
    await expect(first.completeArenaCleanupEffect(owner, effectId, identity, 'wrong'))
      .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    expect(await second.inspectWorkspaceEffects(scope)).toEqual([
      expect.objectContaining({ effectId, repositoryIdentity: identity }),
    ])
    expect((await second.database.query('SELECT arena_id FROM tenant_runtime_arena_repository_claims WHERE repository_identity=$1',
      [identity])).rows).toEqual([{ arena_id: 'atomic' }])
    await first.completeArenaCleanupEffect(owner, effectId, identity, 'atomic')
    expect(await second.inspectWorkspaceEffects(scope)).toEqual([])
    expect((await second.database.query('SELECT 1 FROM tenant_runtime_arena_repository_claims WHERE repository_identity=$1',
      [identity])).rowCount).toBe(0)
    await first.releaseReplica(a)
    expect((await second.acquireResourceOwner(scope, b, randomUUID(), 5_000)).generation).toBe(owner.generation + 1n)

    const recovered = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
      origin: 'https://cleanup-legacy.example',
    }, 15_000)
    const legacy = resource(organizationId, unitId, 'session')
    const hot = createPostgresHotStateStore({ connectionString })
    const authority = new PostgresSessionAuthority(hot, organizationId, { schemaManagement: 'external' })
    await authority.create({ sessionId: legacy.resourceId, state: { cursor: 0 }, config: {} })
    const oldOwner = await first.acquireResourceOwner(legacy, recovered, randomUUID(), 600)
    const oldIdentity = `git-common-inode:41:${Date.now()}22`
    const oldArena = 'legacy', oldId = 'arena-cleanup-LEGACY', oldWorkspace = `cleanup-${randomUUID()}`
    const state = { arenaId: oldArena, status: 'cleaned', repoRoot: '/verified-root',
      repositoryIdentity: oldIdentity, baseSha: 'a'.repeat(40), candidates: [] }
    await first.claimArenaRepository(oldOwner, oldIdentity, oldArena)
    await first.registerWorkspaceEffect(oldOwner, oldId, oldWorkspace, oldIdentity, oldArena)
    await authority.mutate(legacy.resourceId, {
      mutationId: randomUUID(), eventType: 'runtime.metadata.worktree_arena.state',
      entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: legacy.resourceId,
        action: WORKTREE_ARENA_METADATA_ACTION, payload: { arena: state } },
      apply(current) { if (!current) throw new Error('test Session not found'); return current },
    })
    await first.releaseArenaRepository(oldOwner, oldIdentity, oldArena, oldId)
    expect((await second.database.query('SELECT 1 FROM tenant_runtime_arena_repository_claims WHERE repository_identity=$1',
      [oldIdentity])).rowCount).toBe(0)
    const otherScope = resource(organizationId, unitId, 'session')
    const otherOwner = await second.acquireResourceOwner(otherScope, b, randomUUID(), 5_000)
    await expect(second.claimArenaRepository(otherOwner, oldIdentity, 'stolen'))
      .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
    const role = `arena_operator_${organizationId.replaceAll('-', '')}`
    const password = `test-${randomUUID()}`
    await first.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
    await grantPostgresArenaOperator({ connectionString, operatorRole: role, organizationId })
    const url = new URL(connectionString)
    url.username = role; url.password = password
    const operator = createPostgresRuntimeResourceOwnershipStore({ connectionString: url.href })
    try {
      await new Promise((done) => setTimeout(done, 650))
      await expect(second.acquireResourceOwner(legacy, b, randomUUID(), 5_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      expect(await operator.inspectOperatorArenaClaim(legacy, oldIdentity)).toBeNull()
      const input = {
        scope: legacy, effectId: oldId, generation: oldOwner.generation, workspaceId: oldWorkspace,
        repositoryIdentity: oldIdentity, operatorId: role, incidentId: 'legacy-crash',
        arenaState: state, releaseClaimArenaId: oldArena,
      }
      await expect(operator.reconcileArenaEffect({ ...input, evidence: { action: 'cleanup' } }))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(operator.reconcileArenaEffect({
        ...input, scope: { ...legacy, organizationId: randomUUID() },
        evidence: { action: 'cleanup', claimMissing: true },
      })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await operator.reconcileArenaEffect({ ...input,
        evidence: { action: 'cleanup', claimMissing: true, processReview: 'isolated-fixture' } })
      expect(await second.inspectWorkspaceEffects(legacy)).toEqual([])
      const audit = await second.database.query<{ incident_id: string; evidence: { claimMissing: boolean } }>(
        'SELECT incident_id, evidence FROM tenant_runtime_arena_reconciliations WHERE effect_id=$1', [oldId])
      expect(audit.rows).toEqual([{ incident_id: 'legacy-crash',
        evidence: expect.objectContaining({ claimMissing: true }) }])
      expect((await second.acquireResourceOwner(legacy, b, randomUUID(), 5_000)).generation)
        .toBe(oldOwner.generation + 1n)
    } finally { await operator.close(); await authority.close() }
  }, 20_000)

  it('lets only the tenant operator audit a crashed prepared row; dispatched UNKNOWN remains fenced across replicas', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://prepared-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://prepared-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const authority = new PostgresSessionAuthority(createPostgresHotStateStore({ connectionString }),
      organizationId, { schemaManagement: 'external' })
    await authority.create({ sessionId: scope.resourceId, state: { cursor: 0 }, config: {} })
    await authority.close()
    const role = `arena_operator_${organizationId.replaceAll('-', '')}`
    const password = `test-${randomUUID()}`
    await first.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
    await grantPostgresArenaOperator({ connectionString, operatorRole: role, organizationId })
    const url = new URL(connectionString)
    url.username = role; url.password = password
    const operator = createPostgresRuntimeResourceOwnershipStore({ connectionString: url.href })
    const secretDir = mkdtempSync(join(process.cwd(), 'arena-offline-operator-'))
    const secret = join(secretDir, 'operator-url')
    writeFileSync(secret, url.href, { mode: 0o600 })
    const callId = 'arena-probe-PREPAREDCRASH', workspaceId = `prepared-${randomUUID()}`
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 350)
    try {
      await first.registerWorkspaceEffect(owner, callId, workspaceId, undefined, undefined, true)
      expect(await operator.inspectOperatorArenaDispatch(scope, callId)).toEqual({ started: false, digest: null })
      await expect(operator.inspectOperatorArenaDispatch({ ...scope, organizationId: randomUUID() }, callId))
        .rejects.toMatchObject({ code: 'P0001' })
      await new Promise((resolve) => setTimeout(resolve, 450))
      await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      const run = async (effect: string, mode: string, root = '-', journal = '-') =>
        await execFileAsync('pnpm', ['exec', 'tsx', 'bin/arena-effect-reconcile.ts',
          organizationId, unitId, scope.resourceId, effect, root, journal, 'incident-crash',
          `verify-stopped:${effect}`, mode], {
          cwd: process.cwd(), env: { ...process.env,
            KALA_ARENA_RECONCILE_OPERATOR_URL_FILE: secret, KALA_ARENA_OPERATOR_ID: role,
            KALA_ARENA_EXPECTED_PID_NAMESPACE: readlinkSync('/proc/self/ns/pid') },
        })
      const [release, takeover] = await Promise.allSettled([
        run(callId, '--prepared'), second.acquireResourceOwner(scope, b, randomUUID(), 5_000),
      ])
      if (release.status === 'rejected') throw release.reason
      if (takeover.status === 'rejected') {
        expect(takeover.reason).toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      }
      const successor = takeover.status === 'fulfilled' ? takeover.value
        : await second.acquireResourceOwner(scope, b, randomUUID(), 5_000)
      expect(successor.generation).toBe(owner.generation + 1n)
      const audit = await first.database.query<{ incident_id: string; evidence: { dispatchStarted: boolean } }>(
        'SELECT incident_id, evidence FROM tenant_runtime_arena_reconciliations WHERE organization_id=$1 AND resource_id=$2 AND effect_id=$3',
        [organizationId, scope.resourceId, callId])
      expect(audit.rows).toEqual([{ incident_id: 'incident-crash',
        evidence: expect.objectContaining({ dispatchStarted: false }) }])
      await expect(run(callId, '--prepared')).rejects.toThrow('Exact Arena effect not found')
      const started = 'arena-probe-LOSTACK'
      await second.registerWorkspaceEffect(successor, started, workspaceId, undefined, undefined, true)
      await second.beginWorkspaceEffectDispatch(successor, started, 'b'.repeat(64))
      await new Promise((resolve) => setTimeout(resolve, 5_100))
      await expect(first.acquireResourceOwner(scope, a, randomUUID(), 5_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      expect(await operator.inspectOperatorArenaDispatch(scope, started)).toEqual({
        started: true, digest: 'b'.repeat(64),
      })
      await expect(run(started, '--prepared')).rejects.toThrow('No persistent never-dispatched proof')
      await expect(run(started, '--probe', secretDir, join(secretDir, 'missing-receipt')))
        .rejects.toThrow()
      const recovered = await first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://prepared-recovered.example',
      }, 10_000)
      await expect(first.acquireResourceOwner(scope, recovered, randomUUID(), 5_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      // Remove only this isolated test fixture's unknown row so later repository-claim tests remain independent.
      await second.completeWorkspaceEffect(successor, started)
    } finally { await operator.close(); rmSync(secretDir, { recursive: true, force: true }) }
  }, 30_000)

  it('reconciles an original remote probe receipt after lost Socket.IO ACK but fences a live orphaned Git probe', async () => {
    const root = mkdtempSync(join(process.cwd(), 'arena-remote-probe-'))
    const keeperDir = mkdtempSync(join(process.cwd(), 'arena-remote-keeper-'))
    const keeperFile = join(keeperDir, 'keeper.json')
    const journal = join(root, 'original-receipts.json')
    const secret = join(keeperDir, 'operator-url')
    const server = createServer()
    const io = new Server(server)
    const children: ChildProcess[] = []
    let survivingWorker: number | undefined
    try {
      execFileSync('git', ['init', '-q', root])
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No isolated Socket.IO listener')
      const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
      const a = await first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://remote-probe-a.example',
      }, 30_000)
      const b = await second.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://remote-probe-b.example',
      }, 30_000)
      const scope = resource(organizationId, unitId, 'session')
      const authority = new PostgresSessionAuthority(createPostgresHotStateStore({ connectionString }),
        organizationId, { schemaManagement: 'external' })
      await authority.create({ sessionId: scope.resourceId, state: { cursor: 0 }, config: {} })
      await authority.close()
      const role = `arena_operator_${organizationId.replaceAll('-', '')}`
      const password = `test-${randomUUID()}`
      await first.database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
      await grantPostgresArenaOperator({ connectionString, operatorRole: role, organizationId })
      const url = new URL(connectionString)
      url.username = role; url.password = password
      writeFileSync(secret, url.href, { mode: 0o600 })
      const workspaceId = `remote-${randomUUID()}`
      let owner = await first.acquireResourceOwner(scope, a, randomUUID(), 30_000)
      let lostAckCallId = 'arena-probe-REMOTEACK'
      let droppedAck: unknown
      const registry = createExecutorRegistry(io, {
        workspaceIdFor: () => workspaceId,
        approvedArenaReadParent: (_session, parent) => parent === 'approved',
        assertSessionEffectOwner: async () => ({ ownerGeneration: String(owner.generation) }),
        beginArenaDispatch: async (_session, generation, callId, digest) => {
          expect(generation).toBe(String(owner.generation))
          await first.beginWorkspaceEffectDispatch(owner, callId, digest)
        },
      }, 4_000, undefined, 0)
      io.of('/executor').on('connection', (socket) => {
        const emit = socket.emit.bind(socket) as (...args: unknown[]) => boolean
        socket.emit = ((event: string, ...args: unknown[]) => {
          if (event === 'tool:call'
            && (args[0] as { callId?: string } | undefined)?.callId === lostAckCallId) {
            args[args.length - 1] = (reply: unknown) => { droppedAck = reply }
          }
          return emit(event, ...args)
        }) as typeof socket.emit
        socket.on('executor:announce', (announcement) => registry.attach(socket, announcement))
        socket.on('disconnect', () => registry.detach(socket))
      })
      const keeper = spawn(process.execPath, [
        '--import', 'tsx', join(process.cwd(), '..', 'executor', 'bin', 'kala-executor.ts'),
        'arena-keeper', keeperFile,
      ], { cwd: process.cwd(), stdio: 'ignore' })
      children.push(keeper)
      await eventually(async () => { await assertArenaKeeper(keeperFile) }, 8_000)
      const start = (pause?: string) => {
        const child = spawn(process.execPath, ['--import', 'tsx',
          join(process.cwd(), 'src', 'tenant-runtime', 'arena-executor-crash-helper.mjs')], {
          cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ARENA_TEST_HOST: `http://127.0.0.1:${address.port}`,
            ARENA_TEST_WORKSPACE: workspaceId, ARENA_TEST_EXECUTOR: `remote-${randomUUID()}`,
            ARENA_TEST_ROOT: root, ARENA_TEST_RECEIPTS: journal, ARENA_TEST_KEEPER: keeperFile,
            ...(pause ? { KALA_ARENA_TEST_PAUSE_GIT: pause } : {}) },
        })
        children.push(child)
        return child
      }
      let executor = start()
      await eventually(async () => {
        if (registry.snapshot().length !== 1) throw new Error('Remote Executor is not connected')
      }, 8_000)
      const call = (callId: string) => ({
        kind: 'call_tool' as const, callId, name: 'arena_git_probe',
        input: { parentCallId: 'approved', ownerGeneration: String(owner.generation) }, cwd: root,
      })
      const completeId = lostAckCallId
      const complete = call(completeId)
      owner = await first.renewResourceOwner(owner, 6_000)
      const completeDigest = executionRequestDigest({
        sessionId: scope.resourceId, callId: completeId, name: complete.name, input: complete.input,
        cwd: root, origin: 'host',
      })
      await first.registerWorkspaceEffect(owner, completeId, workspaceId, undefined, undefined, true)
      const unanswered = registry.callTool(scope.resourceId, complete)
      const receipts = new ExecutionReceiptStore(journal)
      await eventually(async () => {
        const proof = await receipts.query({
          sessionId: scope.resourceId, callId: completeId,
          requestDigest: completeDigest, ownerGeneration: String(owner.generation),
        })
        if (proof.status !== 'completed' || !proof.result.ok || !droppedAck) {
          throw new Error('Original remote completion not durable before Host ACK loss')
        }
      }, 8_000)
      expect((droppedAck as { ok: boolean }).ok).toBe(true)
      const completed = await receipts.query({
        sessionId: scope.resourceId, callId: completeId,
        requestDigest: completeDigest, ownerGeneration: String(owner.generation),
      })
      expect(completed).toMatchObject({ status: 'completed', result: { ok: true } })
      executor.kill('SIGKILL')
      await once(executor, 'exit')
      await expect(unanswered).resolves.toMatchObject({ ok: false })
      expect(await registry.inspectArenaReceipt(scope.resourceId, completeId)).toEqual({ state: 'unavailable' })
      await new Promise((done) => setTimeout(done, 6_100))
      await expect(second.acquireResourceOwner(scope, b, randomUUID(), 8_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      const operator = createPostgresRuntimeResourceOwnershipStore({ connectionString: url.href })
      try {
        expect(await operator.inspectOperatorArenaDispatch(scope, completeId)).toEqual({
          started: true, digest: completeDigest,
        })
        await expect(operator.reconcileArenaOffline({
          scope, effectId: completeId, generation: owner.generation, workspaceId,
          operatorId: role, incidentId: 'wrong-digest', mode: 'probe', arenaState: null,
          evidence: { action: 'probe', receiptState: 'completed', receiptGeneration: String(owner.generation),
            finalEffectStopped: true, executorStopped: true, gitGroupsStopped: true,
            requestDigest: 'a'.repeat(64), journalSha256: 'a'.repeat(64) },
        })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      } finally { await operator.close() }
      await assertArenaKeeper(keeperFile)
      const run = (callId: string) => execFileAsync(process.execPath, [
        '--import', 'tsx', join(process.cwd(), 'bin', 'arena-effect-reconcile.ts'),
        organizationId, unitId, scope.resourceId, callId, root, journal, 'remote-ack-incident',
        `verify-stopped:${callId}`, '--probe',
      ], { cwd: process.cwd(), env: { ...process.env,
        KALA_ARENA_RECONCILE_OPERATOR_URL_FILE: secret, KALA_ARENA_OPERATOR_ID: role,
        KALA_ARENA_EXPECTED_PID_NAMESPACE: readlinkSync('/proc/self/ns/pid') } })
      expect(await run(completeId)).toMatchObject({ stdout: expect.stringContaining('"durable_probe_receipt"') })
      const audit = await second.database.query<{ evidence: { requestDigest: string; receiptState: string } }>(
        'SELECT evidence FROM tenant_runtime_arena_reconciliations WHERE effect_id=$1', [completeId])
      expect(audit.rows).toEqual([{ evidence: expect.objectContaining({
        requestDigest: completeDigest, receiptState: 'completed',
      }) }])
      owner = await second.acquireResourceOwner(scope, b, randomUUID(), 30_000)
      lostAckCallId = ''
      executor = start('probe-rev-parse')
      await eventually(async () => {
        if (registry.snapshot().length !== 1) throw new Error('Restarted Executor is not connected')
      }, 8_000)
      const unknownId = 'arena-probe-ORPHANED'
      owner = await second.renewResourceOwner(owner, 6_000)
      await second.registerWorkspaceEffect(owner, unknownId, workspaceId, undefined, undefined, true)
      const orphan = registry.callTool(scope.resourceId, call(unknownId))
      await eventually(async () => {
        const raw = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, {
          processGroups?: Array<{ pgid: number }>
        }>
        const group = raw[`${scope.resourceId}:${unknownId}`]?.processGroups?.[0]
        if (!group) throw new Error('Real Git group not durably recorded')
        const observed: string[] = []
        for (const name of readdirSync('/proc')) {
          if (!/^\d+$/u.test(name)) continue
          try {
            const fields = readFileSync(`/proc/${name}/stat`, 'utf8').split(') ')[1]!.split(/\s+/u)
            if (Number(fields[2]) !== group.pgid) continue
            const command = readFileSync(`/proc/${name}/cmdline`, 'utf8')
            observed.push(`${name}:${fields[0]}:${command.slice(0, 120)}`)
            if (fields[0] === 'T' && command.includes('arena-git-worker.mjs')) {
              survivingWorker = Number(name)
              break
            }
          } catch { /* Process exited during inspection. */ }
        }
        if (!survivingWorker) throw new Error(`Recorded Git worker is not paused before launch: ${observed.join(';')}; group=${group.pgid}`)
      }, 8_000)
      executor.kill('SIGKILL')
      await once(executor, 'exit')
      expect(readFileSync(`/proc/${survivingWorker}/stat`, 'utf8')).toContain(' T ')
      await expect(orphan).resolves.toMatchObject({ ok: false })
      await new Promise((done) => setTimeout(done, 6_100))
      const startedDigest = executionRequestDigest({
        sessionId: scope.resourceId, callId: unknownId, name: 'arena_git_probe',
        input: { parentCallId: 'approved', ownerGeneration: String(owner.generation) },
        cwd: root, origin: 'host',
      })
      expect(await receipts.query({
        sessionId: scope.resourceId, callId: unknownId, requestDigest: startedDigest,
        ownerGeneration: String(owner.generation),
      })).toMatchObject({ status: 'started_unknown' })
      await expect(run(unknownId)).rejects.toThrow('no exact durable final receipt')
      await expect(first.acquireResourceOwner(scope, a, randomUUID(), 5_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      expect((await second.database.query('SELECT count(*)::integer AS n FROM tenant_runtime_arena_reconciliations WHERE effect_id=$1',
        [unknownId])).rows).toEqual([{ n: 0 }])
      // The named worker is still capable of launching Git; stop it before test-only fixture teardown.
      process.kill(survivingWorker, 'SIGKILL')
      await receipts.load()
      const groups = receipts.inspectArena(`${scope.resourceId}:${unknownId}`).processGroups
      if (!groups?.length) throw new Error('Original probe group identity disappeared')
      for (const group of groups) await eventually(async () => { await assertGroupStopped(group) }, 8_000)
      await second.completeWorkspaceEffect(owner, unknownId)
    } finally {
      if (survivingWorker) { try { process.kill(survivingWorker, 'SIGKILL') } catch {} }
      for (const child of children.reverse()) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          await once(child, 'exit')
        }
      }
      await new Promise<void>((done) => io.close(() => done()))
      if (server.listening) await new Promise<void>((done) => server.close(() => done()))
      rmSync(root, { recursive: true, force: true })
      rmSync(keeperDir, { recursive: true, force: true })
    }
  }, 55_000)

  it('releases an Arena probe only when the matching PG-prepared refusal audit commits', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 8_000)
    const workspaceId = `no-executor-${randomUUID()}`
    const deps = {
      requireArenaEffectBarrier: true,
      store: {
        get: () => ({ workspaceId, state: { pendingCalls: [
          { callId: 'approved', name: 'worktree_arena', status: 'dispatched', input: { action: 'status' } },
        ] } }),
        findLatestRuntimeMetadata: async () => ({ payload: { arena: {
          arenaId: 'existing', repoRoot: '/workspace', repositoryIdentity: 'git-common-inode:41:72',
          baseRef: 'HEAD', baseSha: 'a'.repeat(40), status: 'active', candidates: [],
        } } }),
      },
      assertSessionEffectOwner: async () => ({ ownerGeneration: String(owner.generation) }),
      claimArenaRepository: async () => { throw new Error('pre-dispatch probe must not claim a repository') },
      registerArenaEffect: async (_id: string, generation: string, effectId: string, workspace: string) => {
        expect(generation).toBe(String(owner.generation))
        await first.registerWorkspaceEffect(owner, effectId, workspace, undefined, undefined, true)
        return async () => await first.completeWorkspaceEffect(owner, effectId)
      },
      releaseNeverDispatchedArenaEffect: async (_id: string, generation: string, effectId: string, workspace: string) => {
        expect(generation).toBe(String(owner.generation))
        await first.completeNeverDispatchedWorkspaceEffect(owner, effectId, workspace, 'host_pre_dispatch_rejection')
      },
      tools: {
        async callTool() {
          return { ok: false, content: 'Executor disconnected before dispatch',
            failure: { code: 'arena_pre_dispatch_rejected', category: 'precondition',
              outcome: 'blocked', retryable: false, responsibility: 'system' } }
        },
        cancelPending() {},
      },
    } as unknown as HostLoopDeps
    const refused = await runWorktreeArenaTool(deps, scope.resourceId, {
      kind: 'call_tool', callId: 'approved', name: 'worktree_arena', input: { action: 'status' },
    })
    expect(refused.ok).toBe(false)
    expect(refused.content).toContain('audited PG never-admitted proof')
    expect(await second.inspectWorkspaceEffects(scope)).toEqual([])
    const audit = await second.database.query('SELECT effect_id, generation FROM tenant_runtime_arena_non_admissions WHERE resource_id=$1',
      [scope.resourceId])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({ generation: String(owner.generation) })
    await first.releaseReplica(a)
    await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000)).resolves.toBeDefined()
  })

  it('resolves a lost probe ACK only from a generation- and digest-matched read-only remote receipt', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-b.example',
    }, 8_000)
    let blockedScope!: RuntimeResourceScope, completedScope!: RuntimeResourceScope
    let blockedOwner!: RuntimeResourceOwnership
    for (const matched of [true, false]) {
      const scope = resource(organizationId, unitId, 'session')
      if (matched) completedScope = scope
      else blockedScope = scope
      const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 8_000)
      if (!matched) blockedOwner = owner
      const repositoryIdentity = `git-common-inode:41:${Date.now()}${matched ? '8' : '9'}`
      const arena = {
        arenaId: 'existing', repoRoot: '/workspace', repositoryIdentity, baseRef: 'HEAD', baseSha: 'a'.repeat(40),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'active', candidates: [],
      }
      const deps = {
        requireArenaEffectBarrier: true,
        store: {
          get: () => ({ workspaceId: `probe-ack-${scope.resourceId}`, state: { pendingCalls: [
            { callId: 'parent', name: 'worktree_arena', status: 'dispatched', input: { action: 'status' } },
          ] } }),
          findLatestRuntimeMetadata: async () => ({ payload: { arena } }),
        },
        assertSessionEffectOwner: async () => ({ ownerGeneration: String(owner.generation) }),
        claimArenaRepository: async () => await first.claimArenaRepository(owner, repositoryIdentity, 'existing'),
        registerArenaEffect: async (_id: string, generation: string, effectId: string, workspaceId: string) => {
          expect(generation).toBe(String(owner.generation))
          await first.registerWorkspaceEffect(owner, effectId, workspaceId,
            effectId.startsWith('arena-probe-') ? undefined : repositoryIdentity,
            effectId.startsWith('arena-probe-') ? undefined : 'existing')
          return async () => await first.completeWorkspaceEffect(owner, effectId)
        },
        tools: {
          async callTool(_session: string, effect: { name: string }) {
            return effect.name === 'arena_git_probe'
              ? { ok: false, content: 'remote acknowledgement lost' }
              : { ok: true, content: JSON.stringify({ finalEffectStopped: true, candidates: [] }) }
          },
          async inspectArenaReceipt(_session: string, id: string) {
            const effect = captured.get(id)
            if (!effect || !matched) return { state: 'unavailable' as const }
            return { state: 'completed' as const, ownerGeneration: String(owner.generation),
              requestDigest: executionRequestDigest({
                sessionId: scope.resourceId, callId: id, name: effect.name, input: effect.input,
                ...(effect.cwd ? { cwd: effect.cwd } : {}), origin: 'host',
              }),
              result: { callId: id, ok: true,
                content: JSON.stringify({ finalEffectStopped: true, repoRoot: '/workspace', repositoryIdentity }) },
            }
          },
          cancelPending() {},
        },
      } as unknown as HostLoopDeps
      const captured = new Map<string, { name: string; input: Record<string, unknown>; cwd?: string }>()
      const originalCall = deps.tools.callTool.bind(deps.tools)
      deps.tools.callTool = async (session, effect, turnId) => {
        captured.set(effect.callId, effect)
        return originalCall(session, effect, turnId)
      }
      const result = await runWorktreeArenaTool(deps, scope.resourceId, {
        kind: 'call_tool', callId: 'parent', name: 'worktree_arena', input: { action: 'status' },
      })
      expect(result.ok, result.content).toBe(matched)
      const effects = await second.inspectWorkspaceEffects(scope)
      expect(effects.length).toBe(matched ? 0 : 1)
    }
    await first.releaseReplica(a)
    await expect(second.acquireResourceOwner(blockedScope, b, randomUUID(), 5_000))
      .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
    await expect(second.acquireResourceOwner(completedScope, b, randomUUID(), 5_000)).resolves.toBeDefined()
    const [unresolved] = await first.inspectWorkspaceEffects(blockedScope)
    if (!unresolved) throw new Error('test fixture lost its deliberately UNKNOWN probe')
    await first.completeWorkspaceEffect(blockedOwner, unresolved.effectId)
  })

  it('registers a named status effect before dispatch and holds G2 until its stopped receipt', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://arena-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 8_000)
    let admitted!: () => void, finish!: () => void
    const started = new Promise<void>((resolve) => { admitted = resolve })
    const stopped = new Promise<void>((resolve) => { finish = resolve })
    const callId = randomUUID()
    const repositoryIdentity = `git-common-inode:41:${Date.now()}`
    const arena = {
      arenaId: 'existing', repoRoot: '/workspace', repositoryIdentity, baseRef: 'HEAD', baseSha: 'a'.repeat(40),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'active',
      candidates: [],
    }
    const deps = {
      requireArenaEffectBarrier: true,
      store: {
        get: () => ({ workspaceId: 'pg-status-workspace', state: { pendingCalls: [{ callId, name: 'worktree_arena', status: 'dispatched', input: { action: 'status' } }] } }),
        findLatestRuntimeMetadata: async () => ({ payload: { arena } }),
      },
      assertSessionEffectOwner: async () => {
        if (!(await first.lookupResourceOwner(scope))) throw new Error('owner lost')
        return { ownerGeneration: String(owner.generation) }
      },
      claimArenaRepository: async () => {
        await first.claimArenaRepository(owner, repositoryIdentity, 'existing')
      },
      registerArenaEffect: async (_sessionId: string, generation: string, id: string) => {
        expect(generation).toBe(String(owner.generation))
        await first.registerWorkspaceEffect(owner, id, 'pg-status-workspace',
          id.startsWith('arena-probe-') ? undefined : repositoryIdentity,
          id.startsWith('arena-probe-') ? undefined : 'existing')
        return async () => await first.completeWorkspaceEffect(owner, id)
      },
      tools: {
        async callTool(_sessionId: string, effect: { name: string; callId: string; input: Record<string, unknown> }) {
          if (effect.name === 'arena_git_probe') return { ok: true, content: JSON.stringify({
            finalEffectStopped: true, repoRoot: '/workspace', repositoryIdentity,
          }) }
          expect(effect.name).toBe('arena_git_status')
          expect(effect.input.ownerGeneration).toBe(String(owner.generation))
          const registered = await second.database.query(`SELECT effect_id FROM tenant_runtime_active_workspace_effects
            WHERE organization_id = $1 AND resource_id = $2`, [organizationId, scope.resourceId])
          expect(registered.rows).toEqual([{ effect_id: effect.callId }])
          admitted()
          await stopped
          return { ok: true, content: JSON.stringify({ finalEffectStopped: true, candidates: [] }) }
        },
        cancelPending() {},
      },
    } as unknown as HostLoopDeps
    const call = { kind: 'call_tool' as const, callId, name: 'worktree_arena', input: { action: 'status' } }
    const running = runWorktreeArenaTool(deps, scope.resourceId, call)
    await started
    await first.releaseReplica(a)
    await expect(second.acquireResourceOwner(scope, b, randomUUID(), 5_000))
      .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
    finish()
    await running
    const successor = await second.acquireResourceOwner(scope, b, randomUUID(), 5_000)
    expect(successor.generation).toBe(owner.generation + 1n)
    const unknownDeps = {
      ...deps,
      assertSessionEffectOwner: async () => ({ ownerGeneration: String(successor.generation) }),
      claimArenaRepository: async () => await second.claimArenaRepository(successor, repositoryIdentity, 'existing'),
      registerArenaEffect: async (_sessionId: string, generation: string, id: string) => {
        expect(generation).toBe(String(successor.generation))
        await second.registerWorkspaceEffect(successor, id, 'pg-status-workspace',
          id.startsWith('arena-probe-') ? undefined : repositoryIdentity,
          id.startsWith('arena-probe-') ? undefined : 'existing')
        return async () => await second.completeWorkspaceEffect(successor, id)
      },
      tools: {
        async callTool(_sessionId: string, effect: { name: string }) {
          if (effect.name === 'arena_git_probe') return { ok: true, content: JSON.stringify({
            finalEffectStopped: true, repoRoot: '/workspace', repositoryIdentity,
          }) }
          return {
            ok: false, content: 'Executor acknowledgement lost',
            failure: { code: 'execution_unknown', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system' },
          }
        },
        cancelPending() {},
      },
    } as HostLoopDeps
    const unknown = await runWorktreeArenaTool(unknownDeps, scope.resourceId, call)
    expect(unknown.ok).toBe(false)
    expect(unknown.content).toContain('unresolved final effect')
    await expect(second.releaseResourceOwner(successor)).rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
  })

  it('holds a new owner through admitted init until durable state and a final receipt, and retains an unknown effect', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://init-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://init-b.example',
    }, 8_000)
    for (const known of [true, false]) {
      const scope = resource(organizationId, unitId, 'session')
      const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 100)
      const repositoryIdentity = `git-common-inode:44:${known ? 1 : 2}`
      const arenaId = `pg${randomUUID().replaceAll('-', '').slice(0, 10)}`
      const input = { action: 'init', arena_id: arenaId, candidates: ['one'] }
      const parentCallId = randomUUID()
      let metadata: { payload: { arena: Record<string, unknown> } } | undefined
      let resume!: () => void, admitted!: () => void
      const stopped = new Promise<void>((resolve) => { resume = resolve })
      const started = new Promise<void>((resolve) => { admitted = resolve })
      const deps = {
        requireArenaEffectBarrier: true,
        store: {
          get: () => ({ workspaceId: `pg-init-${scope.resourceId}`, state: { pendingCalls: [
            { callId: parentCallId, name: 'worktree_arena', status: 'dispatched', input },
          ] } }),
          findLatestRuntimeMetadata: async () => metadata,
          appendRuntimeMetadata: async (_id: string, entry: { payload: { arena: Record<string, unknown> } }) => {
            metadata = entry
          },
        },
        assertSessionEffectOwner: async () => ({ ownerGeneration: String(owner.generation) }),
        claimArenaRepository: async () => await first.claimArenaRepository(owner, repositoryIdentity, arenaId),
        prepareArenaInitEffect: async (_id: string, generation: string, effectId: string, workspaceId: string) => {
          expect(generation).toBe(String(owner.generation))
          await first.prepareArenaInitEffect(owner, effectId, workspaceId, repositoryIdentity, arenaId)
          return async () => {
            expect(metadata?.payload.arena.status).toBe('active')
            await first.completeWorkspaceEffect(owner, effectId)
          }
        },
        registerArenaEffect: async (_id: string, generation: string, effectId: string, workspaceId: string) => {
          expect(generation).toBe(String(owner.generation))
          await first.registerWorkspaceEffect(owner, effectId, workspaceId,
            effectId.startsWith('arena-probe-') ? undefined : repositoryIdentity,
            effectId.startsWith('arena-probe-') ? undefined : arenaId)
          return async () => {
            if (!effectId.startsWith('arena-probe-')) expect(metadata?.payload.arena.status).toBe('active')
            await first.completeWorkspaceEffect(owner, effectId)
          }
        },
        tools: {
          async callTool(_id: string, effect: { name: string; callId: string; input: Record<string, unknown> }) {
            if (effect.name === 'arena_git_probe') return { ok: true, content: JSON.stringify({
              finalEffectStopped: true, repoRoot: '/workspace', repositoryIdentity,
            }) }
            expect(effect.name).toBe('arena_git_init')
            expect(effect.input.ownerGeneration).toBe(String(owner.generation))
            expect(metadata?.payload.arena.status).toBe('initializing')
            expect((await second.database.query('SELECT effect_id FROM tenant_runtime_active_workspace_effects WHERE resource_id = $1',
              [scope.resourceId])).rows).toEqual([{ effect_id: effect.callId }])
            admitted()
            await stopped
            return known ? {
              ok: true, content: JSON.stringify({
                finalEffectStopped: true, arenaId, repoRoot: '/workspace', baseSha: 'a'.repeat(40),
                candidates: [{ id: 'one', branch: `kala-arena/${arenaId}/one`,
                  worktreePath: `/workspace/.kala-arena/${arenaId}/one` }],
              }),
            } : {
              ok: false, content: 'Executor receipt lost',
              failure: { code: 'execution_unknown', category: 'infrastructure', outcome: 'indeterminate', retryable: false, responsibility: 'system' },
            }
          },
          cancelPending() {},
        },
      } as unknown as HostLoopDeps
      const running = runWorktreeArenaTool(deps, scope.resourceId, {
        kind: 'call_tool', callId: parentCallId, name: 'worktree_arena', input,
      })
      await started
      await new Promise((resolve) => setTimeout(resolve, 150))
      await expect(second.acquireResourceOwner(scope, b, randomUUID(), 8_000))
        .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      resume()
      const outcome = await running
      expect(outcome.ok).toBe(known)
      if (known) {
        expect(metadata?.payload.arena.status).toBe('active')
        expect((await second.acquireResourceOwner(scope, b, randomUUID(), 8_000)).generation).toBe(owner.generation + 1n)
      } else {
        expect(metadata?.payload.arena.status).toBe('initializing')
        expect(await second.inspectWorkspaceEffects(scope)).toEqual([
          expect.objectContaining({
            effectId: expect.stringMatching(/^arena-init-/), generation: owner.generation,
            repositoryIdentity, workspaceId: `pg-init-${scope.resourceId}`,
          }),
        ])
        await expect(second.acquireResourceOwner(scope, b, randomUUID(), 8_000))
          .rejects.toBeInstanceOf(RuntimeWorkspaceEffectActiveError)
      }
    }
  })

  it('executes named diff only after parent approval and completes an unsupported-file receipt without releasing uncertainty', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const a = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://diff-a.example',
    }, 8_000)
    const b = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://diff-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const owner = await first.acquireResourceOwner(scope, a, randomUUID(), 8_000)
    const callId = randomUUID()
    const repositoryIdentity = `git-common-inode:42:${Date.now()}`
    const candidate = {
      id: 'one', label: 'One', branch: 'kala-arena/existing/one',
      worktreePath: '/workspace/.kala-arena/existing/one', status: 'active',
    }
    const arena = {
      arenaId: 'existing', repoRoot: '/workspace', repositoryIdentity, baseRef: 'HEAD', baseSha: 'a'.repeat(40),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'active',
      candidates: [candidate],
    }
    const input = { action: 'diff', candidate_id: 'one', stat_only: true }
    let response: Record<string, unknown> = {
      finalEffectStopped: true, candidates: [{ ...candidate, stat: '1 file changed' }],
    }
    let dispatches = 0
    const deps = {
      requireArenaEffectBarrier: true,
      store: {
        get: () => ({ workspaceId: 'pg-diff-workspace', state: { pendingCalls: [{ callId, name: 'worktree_arena', status: 'dispatched', input }] } }),
        findLatestRuntimeMetadata: async () => ({ payload: { arena } }),
      },
      assertSessionEffectOwner: async () => ({ ownerGeneration: String(owner.generation) }),
      claimArenaRepository: async () => await first.claimArenaRepository(owner, repositoryIdentity, 'existing'),
      registerArenaEffect: async (_sessionId: string, generation: string, id: string) => {
        expect(generation).toBe(String(owner.generation))
        await first.registerWorkspaceEffect(owner, id, 'pg-diff-workspace',
          id.startsWith('arena-probe-') ? undefined : repositoryIdentity,
          id.startsWith('arena-probe-') ? undefined : 'existing')
        return async () => await first.completeWorkspaceEffect(owner, id)
      },
      tools: {
        async callTool(_sessionId: string, effect: { name: string; callId: string; input: Record<string, unknown> }) {
          if (effect.name === 'arena_git_probe') return { ok: true, content: JSON.stringify({
            finalEffectStopped: true, repoRoot: '/workspace', repositoryIdentity,
          }) }
          expect(effect.name).toBe('arena_git_diff')
          expect(effect.input.statOnly).toBe(true)
          expect(effect.input.candidates).toHaveLength(1)
          expect((await second.database.query('SELECT effect_id FROM tenant_runtime_active_workspace_effects WHERE organization_id = $1 AND resource_id = $2',
            [organizationId, scope.resourceId])).rows).toEqual([{ effect_id: effect.callId }])
          dispatches++
          return { ok: true, content: JSON.stringify(response) }
        },
        cancelPending() {},
      },
    } as unknown as HostLoopDeps
    const call = { kind: 'call_tool' as const, callId, name: 'worktree_arena', input }
    const initBlocked = await runWorktreeArenaTool(deps, scope.resourceId, {
      ...call, input: { action: 'init', candidates: ['one'] },
    })
    expect(initBlocked).toMatchObject({ ok: false, content: expect.stringContaining('No command was dispatched') })
    expect(dispatches).toBe(0)
    const normal = await runWorktreeArenaTool(deps, scope.resourceId, call)
    expect(normal).toMatchObject({ ok: true, content: expect.stringContaining('1 file changed') })
    response = { finalEffectStopped: true, error: 'Arena diff cannot include untracked files without changing the index' }
    const unsupported = await runWorktreeArenaTool(deps, scope.resourceId, call)
    expect(unsupported).toMatchObject({ ok: false, content: expect.stringContaining('untracked files') })
    expect(dispatches).toBe(2)
    await first.releaseResourceOwner(owner)
    expect((await second.acquireResourceOwner(scope, b, randomUUID(), 5_000)).generation).toBe(owner.generation + 1n)
  })

  it('manages two independent owner leases on one Unit and rejects a released writer in PG', async () => {
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const organizationId = randomUUID()
    const [replicaA, replicaB] = await Promise.all([
      first.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://managed-a.example',
      }, 9_000),
      second.registerReplica({
        organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://managed-b.example',
      }, 9_000),
    ])
    const managers = [new RuntimeResourceOwnershipManager(first), new RuntimeResourceOwnershipManager(second)]
    const scopeA = resource(organizationId, unitId, 'session')
    const scopeB = resource(organizationId, unitId, 'session')
    const lost = async () => { throw new Error('unexpected owner lease loss') }
    try {
      const [ownerA, ownerB] = await Promise.all([
        managers[0]!.acquire(scopeA, replicaA, lost),
        managers[1]!.acquire(scopeB, replicaB, lost),
      ])
      expect(ownerA.activeLease()?.replicaId).toBe(replicaA.replicaId)
      expect(ownerB.activeLease()?.replicaId).toBe(replicaB.replicaId)
      const staleLease = ownerA.activeLease()!
      await ownerA.release()
      expect(ownerA.activeLease()).toBeUndefined()
      const successor = await managers[1]!.acquire(scopeA, replicaB, lost)
      const transaction = await first.database.connect()
      try {
        await transaction.query('BEGIN')
        await expect(first.assertResourceOwner(transaction, staleLease))
          .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
        await transaction.query('ROLLBACK')
      } finally { transaction.release() }
      expect(successor.activeLease()?.generation).toBe(2n)
    } finally {
      await Promise.allSettled(managers.map(async (manager) => await manager.releaseAll()))
    }
  })

  it('delivers child commands across replica owners and reclaims only after generation transfer', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), commandId = randomUUID()
    const memberA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://inbox-a.example',
    }, 60_000)
    const memberB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://inbox-b.example',
    }, 60_000)
    const parentScope = { organizationId, unitId, resourceType: 'session' as const, resourceId: parentId }
    const childScope = { ...parentScope, resourceId: childId }
    const parentOwner = await first.acquireResourceOwner(parentScope, memberA, randomUUID(), 60_000)
    const initialChildOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `${project}-inbox-a` })
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: `${project}-inbox-b` })
    const authority = (hot: typeof hotA, owner: typeof parentOwner) => new PostgresSessionAuthority(hot, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => owner,
    })
    try {
      const parent = authority(hotA, parentOwner)
      const initialChild = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner : initialChildOwner,
      })
      await parent.create({ sessionId: parentId, config: { maxAgentFanOut: 1 }, state: { cursor: 0 } })
      const toolCallId = randomUUID()
      for (const [index, action] of ['copilot.tool_call', 'copilot.tool_result', 'copilot.tool_call'].entries()) {
        await parent.mutate(parentId, {
          mutationId: `${toolCallId}:${index}`,
          eventType: action,
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: parentId,
            action, payload: { callId: toolCallId } },
          apply(current) { return current && { ...current, state: { cursor: current.state.cursor + 1 } } },
        })
        expect(await parent.hasCommittedCopilotToolResult(parentId, toolCallId)).toBe(index === 1)
      }
      await parent.mutate(parentId, {
        mutationId: `${toolCallId}:3`, eventType: 'copilot.tool_result',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: parentId,
          action: 'copilot.tool_result', payload: { callId: toolCallId } },
        apply(current) { return current && { ...current, state: { cursor: current.state.cursor + 1 } } },
      })
      expect(await parent.hasCommittedCopilotToolResult(parentId, toolCallId)).toBe(true)
      await initialChild.create({ sessionId: childId, parentSessionId: parentId, state: { cursor: 0 } }, undefined, {
        fenceSessionId: parentId,
      })
      await first.releaseResourceOwner(initialChildOwner)
      const childOwnerB = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const childB = authority(hotB, childOwnerB)
      const queued = await parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'steer', 1)
      expect(queued.status).toBe('pending')
      await expect(parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'steer', 1)).resolves.toEqual(queued)
      await expect(parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'different', 1))
        .rejects.toThrow('idempotency key conflicts')
      await expect(childB.enqueueChildCommand(parentId, childId, randomUUID(), 'stop'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(parent.enqueueChildCommand(randomUUID(), childId, randomUUID(), 'stop'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect((await parent.readChildCommands(parentId, childId)).map((command) => command.commandId)).toEqual([commandId])
      await expect(childB.readChildCommands(parentId, childId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      const claimed = await childB.claimChildCommand(childId)
      expect(claimed).toMatchObject({ commandId, status: 'claimed', ownerGeneration: childOwnerB.generation.toString() })
      const marked = await childB.markChildCommandDispatched(childId, commandId)
      expect(marked.dispatchedAt).toBeTruthy()
      await expect(childB.markChildCommandDispatched(childId, commandId)).resolves.toEqual(marked)
      const pendingId = randomUUID()
      await parent.enqueueChildCommand(parentId, childId, pendingId, 'stop')
      await expect(childB.claimChildCommand(childId)).resolves.toBeUndefined()
      await expect(initialChild.claimChildCommand(childId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await first.releaseResourceOwner(parentOwner)
      const parentOwnerB = await second.acquireResourceOwner(parentScope, memberB, randomUUID(), 60_000)
      const parentB = authority(hotB, parentOwnerB)
      await expect(parent.hasCommittedCopilotToolResult(parentId, toolCallId))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await parentB.hasCommittedCopilotToolResult(parentId, toolCallId)).toBe(true)
      await expect(parent.enqueueChildCommand(parentId, childId, randomUUID(), 'stop'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect((await parentB.readChildCommands(parentId, childId))[0]?.status).toBe('claimed')
      await second.releaseResourceOwner(childOwnerB)
      const successorOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
      const restarted = authority(hotA, successorOwner)
      expect((await parentB.readChildCommandsForDashboard(parentId, childId))[0]?.ownerGeneration)
        .toBeUndefined()
      await expect(childB.completeChildCommand(childId, commandId, { ok: true, content: 'old' }))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(childB.markChildCommandDispatched(childId, commandId))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await restarted.claimChildCommand(childId)).toMatchObject({
        commandId, status: 'claimed', ownerGeneration: successorOwner.generation.toString(), dispatchedAt: marked.dispatchedAt,
      })
      expect((await parentB.readChildCommandsForDashboard(parentId, childId))[0]?.ownerGeneration)
        .toBe(successorOwner.generation.toString())
      expect(await restarted.completeChildCommand(childId, commandId, { ok: true, content: 'delivered' }))
        .toMatchObject({ status: 'completed', outcome: { ok: true, content: 'delivered' } })
      const afterRestart = authority(hotA, successorOwner)
      await expect(afterRestart.claimChildCommand(childId)).resolves.toBeUndefined()
      const resumedPending = await afterRestart.claimChildStop(childId)
      expect(resumedPending).toMatchObject({ commandId: pendingId, status: 'claimed' })
      expect(resumedPending?.dispatchedAt).toBeUndefined()
      await afterRestart.completeChildCommand(childId, pendingId, { ok: true, content: 'stopped' })
      await expect(afterRestart.claimChildCommand(childId)).resolves.toBeUndefined()
      expect((await parentB.readChildCommands(parentId, childId))[0]?.outcome?.content).toBe('delivered')
      const extraIds = [randomUUID(), randomUUID()]
      await Promise.all(extraIds.map((id) => parentB.enqueueChildCommand(parentId, childId, id, 'stop')))
      const [firstClaim, duplicate] = await Promise.all([
        restarted.claimChildStop(childId), afterRestart.claimChildStop(childId),
      ])
      expect([firstClaim, duplicate].filter(Boolean)).toHaveLength(1)
      const firstId = firstClaim?.commandId ?? duplicate!.commandId
      await restarted.completeChildCommand(childId, firstId, { ok: true, content: 'stopped' })
      const secondClaim = await afterRestart.claimChildStop(childId)
      expect(secondClaim?.commandId).toBe(extraIds.find((id) => id !== firstId))
      await afterRestart.completeChildCommand(childId, secondClaim!.commandId, { ok: true, content: 'stopped' })
      await restarted.mutate(childId, {
        mutationId: randomUUID(), eventType: 'session.done',
        apply(current) { return current && { ...current, state: { ...current.state, status: 'done' } } },
      })
      {
      const childId = randomUUID()
      const childScope = { ...parentScope, resourceId: childId }
      const successorOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
      const creator = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : successorOwner,
      })
      await creator.create({ sessionId: childId, parentSessionId: parentId, parentCallId: randomUUID(),
        state: { cursor: 0, status: 'idle' } }, undefined, { fenceSessionId: parentId })
      const afterRestart = authority(hotA, successorOwner)
      const abandonedId = randomUUID()
      await parentB.enqueueChildCommand(parentId, childId, abandonedId, 'message', 'before transfer', 1,
        { timeoutMs: 2_000, maxTurns: 3 })
      await expect(parentB.enqueueChildCommand(parentId, childId, abandonedId, 'message', 'before transfer', 1,
        { timeoutMs: 2_001, maxTurns: 3 })).rejects.toThrow('idempotency key conflicts')
      await afterRestart.markChildCommandDispatched(childId, (await afterRestart.claimChildCommand(childId))!.commandId)
      expect(await afterRestart.readActiveChildMessage(childId)).toMatchObject({
        commandId: abandonedId, timeoutMs: 2_000, maxTurns: 3,
      })
      await first.releaseResourceOwner(successorOwner)
      const finalOwner = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const finalReplica = authority(hotB, finalOwner)
      const attempted: string[] = []
      const uncertain = await consumeNextChildCommand(finalReplica, childId, async (command) => {
        attempted.push(command.commandId)
      }, async () => undefined)
      expect(attempted).toEqual([])
      expect(uncertain).toMatchObject({ commandId: abandonedId, status: 'claimed', dispatchedAt: expect.any(String) })
      await expect(afterRestart.readActiveChildMessage(childId))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await finalReplica.readActiveChildMessage(childId)).toMatchObject({
        commandId: abandonedId, timeoutMs: 2_000, maxTurns: 3,
      })
      const siblingId = randomUUID()
      const siblingOwner = await second.acquireResourceOwner({ ...childScope, resourceId: siblingId }, memberB, randomUUID(), 60_000)
      const sibling = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : siblingOwner,
      })
      await sibling.create({ sessionId: siblingId, parentSessionId: parentId, state: { cursor: 0 } }, undefined, {
        fenceSessionId: parentId,
      })
      const siblingCommand = randomUUID()
      await expect(parentB.enqueueChildCommand(parentId, siblingId, siblingCommand, 'message', 'blocked', 128))
        .rejects.toThrow('agent fan-out exceeded')
      const freshId = randomUUID()
      await parentB.enqueueChildCommand(parentId, childId, freshId, 'stop')
      expect(await finalReplica.hasUnconfirmedMessageBeforeStop(childId, freshId)).toBe(true)
      await expect(consumeNextChildCommand(finalReplica, childId, async () => {
        throw new Error('must not dispatch behind an uncertain turn')
      }, async () => undefined)).resolves.toBeUndefined()
      const remoteCallId = randomUUID()
      const requestDigest = 'a'.repeat(64)
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'copilot.tool_call',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
          action: 'copilot.tool_call', payload: { callId: remoteCallId, ownerGeneration: marked.dispatchedOwnerGeneration, requestDigest } },
        apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1 } } },
      })
      const cancelExecution = vi.fn(async () => ({ status: 'unavailable' as const }))
      const delivered = await consumeNextChildStop(finalReplica, childId, async (command) => {
        attempted.push(command.commandId)
        return stopChildTurn({
          inbox: finalReplica,
          store: {
            load: async () => ({ parentSessionId: parentId, agentRuntime: 'copilot',
              state: { status: 'executing_tools', pendingCalls: [{ callId: remoteCallId, status: 'dispatched' }] } }),
            findCopilotToolRequest: (id: string, callId: string) => finalReplica.findCopilotToolRequest(id, callId),
          } as never,
          runtimes: { require: () => ({ cancelForChildStop: async () => false }) } as never,
          executors: { cancelExecution, queryExecutionReceipt: async () => ({ status: 'unavailable' }) } as never,
          assertOwner: async () => await hotB.database.transaction(async (transaction) => {
            await second.assertResourceOwner(transaction, finalOwner)
          }),
        }, command)
      })
      expect(delivered).toMatchObject({ commandId: freshId, status: 'completed',
        outcome: { ok: false, content: expect.stringContaining('UNKNOWN') } })
      expect(cancelExecution).toHaveBeenCalledWith({
        sessionId: childId, callId: remoteCallId, stopCommandId: freshId,
        ownerGeneration: marked.dispatchedOwnerGeneration, requestDigest,
      })
      expect(attempted).toEqual([freshId])
      expect((await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === abandonedId)?.status)
        .toBe('claimed')
      await finalReplica.completeChildCommand(childId, abandonedId, {
        ok: false, content: 'external effects reconciled by an operator',
      })
      expect(await finalReplica.hasUnconfirmedMessageBeforeStop(childId, freshId)).toBe(false)
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'session.done',
        apply(current) { return current && { ...current, state: { ...current.state, status: 'done' } } },
      })
      const competingId = randomUUID()
      const competingOwner = await second.acquireResourceOwner({ ...childScope, resourceId: competingId }, memberB, randomUUID(), 60_000)
      const competing = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : competingOwner,
      })
      await competing.create({ sessionId: competingId, parentSessionId: parentId, state: { cursor: 0 } }, undefined, {
        fenceSessionId: parentId,
      })
      const competingCommand = randomUUID()
      const secondClientParent = authority(hotA, parentOwnerB)
      const racing = await Promise.allSettled([
        parentB.enqueueChildCommand(parentId, siblingId, siblingCommand, 'message', 'first', 1),
        secondClientParent.enqueueChildCommand(parentId, competingId, competingCommand, 'message', 'second', 1),
      ])
      expect(racing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(racing.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const admitted = racing[0]?.status === 'fulfilled'
        ? { authority: sibling, id: siblingId, commandId: siblingCommand, message: 'first' }
        : { authority: competing, id: competingId, commandId: competingCommand, message: 'second' }
      await expect(parentB.enqueueChildCommand(parentId, admitted.id, admitted.commandId, 'message', admitted.message, 0))
        .resolves.toMatchObject({ status: 'pending', childSessionId: admitted.id })
      expect((await admitted.authority.claimChildCommand(admitted.id))?.commandId).toBe(admitted.commandId)
      const batched = await parentB.readChildCommandsForDashboard(parentId)
      expect(batched.some((command) => command.childSessionId === admitted.id
        && command.commandId === admitted.commandId && command.status === 'claimed')).toBe(true)
      expect(batched.some((command) => command.childSessionId === childId && command.kind === 'stop')).toBe(true)
      expect(await parentB.readChildCommandsForDashboard(randomUUID())).toEqual([])
      await admitted.authority.completeChildCommand(admitted.id, admitted.commandId, { ok: true, content: 'done' })
      await expect(consumeNextChildCommand(finalReplica, childId, async () => {
        throw new Error('unexpected replay')
      }, async () => undefined)).resolves.toBeUndefined()
      await finalReplica.requestDeletion(childId)
      await finalReplica.delete(childId)
      }
      {
      const childId = randomUUID()
      const childScope = { ...parentScope, resourceId: childId }
      const finalOwner = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const creator = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwnerB : finalOwner,
      })
      await creator.create({ sessionId: childId, parentSessionId: parentId, parentCallId: randomUUID(),
        state: { cursor: 0, status: 'idle' } }, undefined, { fenceSessionId: parentId })
      const finalReplica = authority(hotB, finalOwner)
      const failedId = randomUUID()
      await parentB.enqueueChildCommand(parentId, childId, failedId, 'message', 'unknown effect', 1)
      await expect(consumeNextChildCommand(finalReplica, childId, async () => {
        throw new Error('executor acknowledgement lost')
      }, async () => undefined)).rejects.toThrow('executor acknowledgement lost')
      expect((await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === failedId)?.outcome)
        .toBeUndefined()
      expect((await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === failedId))
        .toMatchObject({ status: 'claimed', dispatchedAt: expect.any(String) })
      const failedCommand = (await parentB.readChildCommands(parentId, childId)).find((command) => command.commandId === failedId)!
      const reconcile = () => reconcileChildTurn({
        inbox: finalReplica,
        store: {
          load: async () => {
            const document = (await finalReplica.load(childId))!
            return { ...document, agentRuntime: 'copilot', state: {
              ...document.state, status: document.state.status ?? 'thinking', pendingCalls: [],
            } }
          },
          findOperation: (id: string, operationId: string) => finalReplica.findOperation(id, operationId),
          findLatestRuntimeMetadata: (id: string, action: string) => finalReplica.findLatestRuntimeMetadata(id, action),
        } as never,
        runtimes: {} as never,
        assertOwner: async () => {
          await hotB.database.transaction(async (transaction) => {
            await second.assertResourceOwner(transaction, finalOwner)
          })
        },
      }, failedCommand)
      await expect(reconcile()).resolves.toBeUndefined()
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'copilot.user_message',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
          action: 'copilot.user_message', payload: { operationId: failedId, text: 'unknown effect',
            requestFingerprint: messageOperationFingerprint('unknown effect') } },
        apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'thinking' } } },
      })
      await expect(reconcile()).resolves.toBeUndefined()
      await finalReplica.mutate(childId, {
        mutationId: randomUUID(), eventType: 'copilot.session_idle',
        entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
          action: 'copilot.session_idle', payload: { childCommandId: failedId } },
        apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'done' } } },
      })
      await expect(reconcile()).resolves.toMatchObject({ ok: true, content: expect.stringContaining(failedId) })
      await finalReplica.completeChildCommand(childId, failedId, (await reconcile())!)
      await finalReplica.requestDeletion(childId)
      await finalReplica.delete(childId)
      const remaining = await hotA.database.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM tenant_session_child_commands WHERE tenant_id = $1 AND child_session_id = $2',
        [organizationId, childId],
      )
      expect(remaining.rows[0]?.count).toBe('0')
      }
    } finally {
      await Promise.allSettled([hotA.close(), hotB.close()])
    }
  })

  it('orders parent enqueue and child completion locks without deadlocking either replica', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), commandId = randomUUID()
    const memberA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://enqueue.example',
    }, 60_000)
    const memberB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://complete.example',
    }, 60_000)
    const parentOwner = await first.acquireResourceOwner({
      organizationId, unitId, resourceType: 'session', resourceId: parentId,
    }, memberA, randomUUID(), 60_000)
    const childOwner = await second.acquireResourceOwner({
      organizationId, unitId, resourceType: 'session', resourceId: childId,
    }, memberB, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `board-parent-${parentId.slice(0, 8)}` })
    const childApplication = `board-child-${childId.slice(0, 8)}`
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: childApplication })
    const parent = new PostgresSessionAuthority(hotA, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => parentOwner,
    })
    const child = new PostgresSessionAuthority(hotB, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => childOwner,
    })
    let releaseParent!: () => void
    const parentMayProceed = new Promise<void>((resolve) => { releaseParent = resolve })
    let parentLocked!: () => void
    const parentHasLock = new Promise<void>((resolve) => { parentLocked = resolve })
    let enqueue: Promise<unknown> | undefined
    let completion: Promise<unknown> | undefined
    try {
      await parent.create({ sessionId: parentId, state: { cursor: 0 } })
      const creator = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner : childOwner,
      })
      await creator.create({ sessionId: childId, parentSessionId: parentId, state: { cursor: 0 } },
        undefined, { fenceSessionId: parentId })
      await parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'work', 1)
      await child.claimChildCommand(childId)
      await child.markChildCommandDispatched(childId, commandId)
      const transaction = hotA.database.transaction.bind(hotA.database)
      const spy = vi.spyOn(hotA.database, 'transaction').mockImplementation((operation) =>
        transaction((client) => operation({
          query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values)
            if (sql.includes('SELECT document') && sql.includes('FOR UPDATE') && values?.[1] === parentId) {
              parentLocked()
              await parentMayProceed
            }
            return result
          },
        })))
      try {
        const nextId = randomUUID()
        enqueue = parent.enqueueChildCommand(parentId, childId, nextId, 'message', 'next', 1)
        await parentHasLock
        completion = child.completeChildCommand(childId, commandId, { ok: true, content: 'done' })
        const concurrent = Promise.all([enqueue, completion])
        void concurrent.catch(() => undefined)
        await eventually(async () => {
          const waiting = await hotA.database.query<{ waiting: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
          ) AS waiting`, [childApplication])
          expect(waiting.rows[0]?.waiting).toBe(true)
        }, 5_000)
        releaseParent()
        await expect(concurrent).resolves.toHaveLength(2)
        expect((await parent.readChildCommands(parentId, childId)).map((item) => item.status))
          .toEqual(['completed', 'pending'])
        await child.claimChildCommand(childId)
        await child.markChildCommandDispatched(childId, nextId)
        const completeTransaction = hotB.database.transaction.bind(hotB.database)
        const rollback = vi.spyOn(hotB.database, 'transaction').mockImplementationOnce((operation) =>
          completeTransaction(async (client) => {
            await operation(client)
            throw Object.assign(new Error('injected completion rollback'), { code: '40P01' })
          }))
        try {
          await expect(child.completeChildCommand(childId, nextId, { ok: true, content: 'next done' }))
            .rejects.toMatchObject({ code: '40P01' })
          expect(await child.readActiveChildMessage(childId)).toMatchObject({
            commandId: nextId, status: 'claimed', dispatchedAt: expect.any(String),
          })
        } finally { rollback.mockRestore() }
        await expect(child.claimChildCommand(childId)).resolves.toBeUndefined()
        await expect(child.completeChildCommand(childId, nextId, { ok: true, content: 'next done' }))
          .resolves.toMatchObject({ status: 'completed', outcome: { ok: true, content: 'next done' } })
        const unmarkedId = randomUUID()
        await parent.enqueueChildCommand(parentId, childId, unmarkedId, 'message', 'safe retry', 1)
        await child.claimChildCommand(childId)
        const dispatchTransaction = hotB.database.transaction.bind(hotB.database)
        const failedMark = vi.spyOn(hotB.database, 'transaction').mockImplementationOnce((operation) =>
          dispatchTransaction(async (client) => {
            await operation(client)
            throw Object.assign(new Error('injected mark rollback'), { code: '40001' })
          }))
        try {
          await expect(child.markChildCommandDispatched(childId, unmarkedId))
            .rejects.toMatchObject({ code: '40001' })
        } finally { failedMark.mockRestore() }
        const undispatched = await child.readActiveChildMessage(childId)
        expect(undispatched).toMatchObject({
          commandId: unmarkedId, status: 'claimed', ownerGeneration: childOwner.generation.toString(),
        })
        expect(undispatched?.dispatchedAt).toBeUndefined()
        expect(await child.findOperation(childId, unmarkedId)).toBeUndefined()
        const marked = await child.markChildCommandDispatched(childId, unmarkedId, true)
        expect(marked.dispatchedAt).toBeTruthy()
        await expect(child.markChildCommandDispatched(childId, unmarkedId, true))
          .rejects.toThrow('already recorded')
        const takeoverId = randomUUID()
        await parent.enqueueChildCommand(parentId, childId, takeoverId, 'message', 'after takeover', 1)
        // A claimed-but-unmarked head can only be resumed after a new owner
        // proves that neither the marker nor a matching SDK operation exists.
        await child.completeChildCommand(childId, unmarkedId, { ok: false, content: 'fixture only' })
        await child.claimChildCommand(childId)
        await second.releaseResourceOwner(childOwner)
        const successor = await first.acquireResourceOwner({
          organizationId, unitId, resourceType: 'session', resourceId: childId,
        }, memberA, randomUUID(), 60_000)
        const afterTakeover = new PostgresSessionAuthority(hotA, organizationId, {
          schemaManagement: 'external', unitId, resourceOwnerForSession: () => successor,
        })
        const reclaimed = await afterTakeover.claimChildCommand(childId)
        expect(reclaimed).toMatchObject({ commandId: takeoverId, status: 'claimed', reclaimed: true,
          ownerGeneration: successor.generation.toString() })
        expect(reclaimed?.dispatchedAt).toBeUndefined()
      } finally {
        releaseParent()
        spy.mockRestore()
        await Promise.allSettled([enqueue, completion].filter((value) => value !== undefined))
      }
    } finally {
      await Promise.allSettled([hotA.close(), hotB.close()])
    }
  }, 20_000)

  it('targets a budgeted follow-up with child-owner timeout Stop across parent and child replicas', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), initialId = randomUUID()
    const [memberA, memberB] = await Promise.all([
      first.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://budget-parent.example' }, 60_000),
      second.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(),
        origin: 'https://budget-child.example' }, 60_000),
    ])
    const parentOwner = await first.acquireResourceOwner(
      { organizationId, unitId, resourceType: 'session', resourceId: parentId }, memberA, randomUUID(), 60_000)
    const childOwner = await second.acquireResourceOwner(
      { organizationId, unitId, resourceType: 'session', resourceId: childId }, memberB, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `${project}-budget-parent` })
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: `${project}-budget-child` })
    const authority = (hot: typeof hotA) => new PostgresSessionAuthority(hot, organizationId, {
      schemaManagement: 'external', unitId,
      resourceOwnerForSession: (id) => id === parentId ? parentOwner : childOwner,
    })
    try {
      const parent = authority(hotA), child = authority(hotB)
      await parent.create({ sessionId: parentId, config: { maxAgentFanOut: 1 }, state: { status: 'idle' } })
      await child.create({ sessionId: childId, parentSessionId: parentId, parentCallId: initialId,
        state: { status: 'done' } }, undefined, { fenceSessionId: parentId })
      const commandId = randomUUID()
      await parent.enqueueChildCommand(parentId, childId, commandId, 'message', 'next turn', 1,
        { timeoutMs: 1_000, maxTurns: 2 })
      expect(await child.readActiveChildMessage(childId)).toMatchObject({
        commandId, timeoutMs: 1_000, maxTurns: 2, status: 'pending',
      })
      await child.claimChildCommand(childId)
      await child.markChildCommandDispatched(childId, commandId)
      const stopId = randomUUID()
      await expect(child.enqueueTimedOutChildStop(childId, stopId, commandId))
        .resolves.toMatchObject({ commandId: stopId, kind: 'stop', status: 'pending' })
      await expect(child.claimChildStop(childId)).resolves.toMatchObject({ commandId: stopId })
      const laterId = randomUUID()
      await expect(parent.enqueueChildCommand(parentId, childId, laterId, 'message', 'later', 1))
        .rejects.toThrow('Stop barrier')
      expect(await child.claimChildCommand(childId)).toBeUndefined()
      expect(await child.hasUnconfirmedMessageBeforeStop(childId, stopId)).toBe(true)
      await expect(child.markChildCommandDispatched(childId, laterId)).rejects.toThrow()
    } finally { await Promise.allSettled([hotA.close(), hotB.close()]) }
  })

  it('creates a child and initial command atomically with bounded fan-out across independent owner leases', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID())
    const parentId = randomUUID(), childId = randomUUID(), rejectedId = randomUUID(), commandId = randomUUID()
    const memberA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://create-a.example',
    }, 60_000)
    const memberB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://create-b.example',
    }, 60_000)
    const parentScope = { organizationId, unitId, resourceType: 'session' as const, resourceId: parentId }
    const childScope = { ...parentScope, resourceId: childId }
    let parentOwner = await first.acquireResourceOwner(parentScope, memberA, randomUUID(), 60_000)
    const childOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
    const rejectedOwner = await first.acquireResourceOwner({ ...childScope, resourceId: rejectedId }, memberA, randomUUID(), 60_000)
    const hotA = createPostgresHotStateStore({ connectionString, applicationName: `${project}-create-a` })
    const hotB = createPostgresHotStateStore({ connectionString, applicationName: `${project}-create-b` })
    const createOnA = new PostgresSessionAuthority(hotA, organizationId, {
      schemaManagement: 'external', unitId, localReplicaId: memberA.replicaId,
      resourceOwnerForSession: (id) => id === parentId ? parentOwner : id === childId ? childOwner : rejectedOwner,
    })
    try {
      await createOnA.create({ sessionId: parentId, config: { maxAgentFanOut: 1 }, state: { cursor: 0, status: 'done' } })
      const childDocument = {
        sessionId: childId, parentSessionId: parentId, parentCallId: commandId,
        preferredChildReplicaId: memberB.replicaId,
        preferences: { selectedModel: 'provider/model-v1' },
        agentRuntime: 'copilot', state: { cursor: 0, status: 'idle', pendingCalls: [] },
      }
      await createOnA.createChildWithCommand(childDocument, commandId, 'initial prompt', 1)
      expect(await createOnA.pendingChildSessionIds()).not.toContain(childId)
      expect(await createOnA.claimChildCommand(childId)).toBeUndefined()
      expect(await createOnA.readChildCommands(parentId, childId)).toMatchObject([
        { commandId, status: 'pending', message: 'initial prompt' },
      ])
      await expect(createOnA.createChildWithCommand({
        sessionId: rejectedId, parentSessionId: parentId, parentCallId: randomUUID(),
        state: { cursor: 0, status: 'idle' },
      }, randomUUID(), 'another prompt', 1)).rejects.toThrow()
      expect(await createOnA.load(rejectedId)).toBeUndefined()
      await expect(createOnA.createChildWithCommand(childDocument, commandId, 'initial prompt', 1))
        .resolves.toMatchObject(childDocument)
      await expect(createOnA.createChildWithCommand(childDocument, commandId, 'different prompt', 1))
        .rejects.toThrow()
      await first.releaseResourceOwner(childOwner)
      const successorOwner = await second.acquireResourceOwner(childScope, memberB, randomUUID(), 60_000)
      const ownerB = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId, localReplicaId: memberB.replicaId,
        resourceOwnerForSession: (id) => id === childId ? successorOwner : undefined,
      })
      expect(await ownerB.pendingChildSessionIds()).toContain(childId)
      expect(await ownerB.readChildCommandsForDashboard(parentId, childId)).toMatchObject([
        { commandId, status: 'pending', parentSessionId: parentId },
      ])
      expect(await ownerB.readChildCommandsForDashboard(rejectedId, childId)).toEqual([])
      expect((await ownerB.load(childId))?.preferences).toEqual({ selectedModel: 'provider/model-v1' })
      const delivered = await consumeNextChildCommand(ownerB, childId, async (command) => {
        expect(command.dispatchedOwnerGeneration).toBe(successorOwner.generation.toString())
        await ownerB.mutate(childId, {
          mutationId: randomUUID(), eventType: 'copilot.user_message',
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
            action: 'copilot.user_message', payload: { operationId: command.commandId, text: command.message,
              requestFingerprint: messageOperationFingerprint(command.message!) } },
          apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'thinking' } } },
        })
        expect(await ownerB.enqueueTimedOutChildStop(childId, 'timeout-initial'))
          .toMatchObject({ kind: 'stop', status: 'pending', parentSessionId: parentId })
        await ownerB.mutate(childId, {
          mutationId: randomUUID(), eventType: 'copilot.assistant_turn_end',
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
            action: 'copilot.assistant_turn_end', payload: { childCommandId: command.commandId, turnId: 'sdk-turn-1' } },
          apply(current) { return current },
        })
        await ownerB.mutate(childId, {
          mutationId: randomUUID(), eventType: 'copilot.session_idle',
          entry: { kind: 'runtime_metadata', ts: new Date().toISOString(), sessionId: childId,
            action: 'copilot.session_idle', payload: { childCommandId: command.commandId } },
          apply(current) { return current && { ...current, state: { ...current.state, cursor: current.state.cursor + 1, status: 'done' } } },
        })
      }, async (command) => reconcileChildTurn({
        inbox: ownerB,
        store: {
          load: (id: string) => ownerB.load(id),
          findOperation: (id: string, operationId: string) => ownerB.findOperation(id, operationId),
          findLatestRuntimeMetadata: (id: string, action: string) => ownerB.findLatestRuntimeMetadata(id, action),
        } as never,
        runtimes: {} as never,
        assertOwner: async () => await hotB.database.transaction(async (transaction) => {
          await second.assertResourceOwner(transaction, successorOwner)
        }),
      }, command))
      expect(delivered).toMatchObject({ commandId, status: 'completed', outcome: { ok: true } })
      expect(await ownerB.readChildTurnEnds(childId, commandId)).toHaveLength(1)
      expect(await createOnA.pendingFinishedParentSessionIds()).toContain(parentId)
      await expect(ownerB.readPendingChildCompletions(parentId)).rejects.toThrow()
      const replicaRoomEvents = await ownerB.readFinishedChildCompletions(parentId)
      expect(replicaRoomEvents).toMatchObject([{ commandId, childSessionId: childId, outcome: { ok: true } }])
      expect(await ownerB.readFinishedChildCompletions(parentId, {
        sequence: replicaRoomEvents[0]!.sequence,
      })).toEqual([])
      const peerFinished = vi.fn()
      const peerOwnerAttempt = vi.fn(async () => { throw new Error('Parent belongs to replica A') })
      const stopPeerWorker = startChildCommandWorker({
        inbox: {
          pendingChildSessionIds: async () => [],
          pendingFinishedParentSessionIds: async () => [],
          readFinishedChildCompletions: (id, since) => ownerB.readFinishedChildCompletions(id, since),
        } as never,
        store: {
          load: (id: string) => ownerB.load(id),
          countCompletedChildModelTurns: async (id: string, operationId: string) =>
            (await ownerB.readChildTurnEnds(id, operationId)).length,
        } as never,
        runtimes: {} as never,
        assertOwner: peerOwnerAttempt,
        listLocalParentRooms: () => [parentId],
        onChildFinished: peerFinished,
      }, 10)
      try {
        await vi.waitFor(() => expect(peerFinished).toHaveBeenCalledOnce())
        expect(peerFinished).toHaveBeenCalledWith(expect.objectContaining({
          parentSessionId: parentId, childSessionId: childId, parentCallId: commandId,
          status: 'completed', turns: 1,
        }))
        expect(peerOwnerAttempt).not.toHaveBeenCalled()
      } finally { await stopPeerWorker() }
      const notices = await createOnA.readPendingChildCompletions(parentId)
      expect(notices).toMatchObject([{ commandId, parentSessionId: parentId, childSessionId: childId, outcome: { ok: true } }])
      expect(Date.parse(notices[0]!.completedAt)).toBeGreaterThan(0)
      await expect(ownerB.acknowledgeChildCompletion(parentId, childId, commandId)).rejects.toThrow()
      await first.releaseResourceOwner(parentOwner)
      const newParentOwner = await second.acquireResourceOwner(parentScope, memberB, randomUUID(), 60_000)
      const parentOnB = new PostgresSessionAuthority(hotB, organizationId, {
        schemaManagement: 'external', unitId, localReplicaId: memberB.replicaId,
        resourceOwnerForSession: (id) => id === parentId ? newParentOwner : successorOwner,
      })
      await expect(createOnA.acknowledgeChildCompletion(parentId, childId, commandId)).rejects.toThrow()
      expect(await parentOnB.readPendingChildCompletions(parentId)).toHaveLength(1)
      await parentOnB.acknowledgeChildCompletion(parentId, childId, commandId)
      expect(await createOnA.pendingFinishedParentSessionIds()).not.toContain(parentId)
      expect(await parentOnB.readPendingChildCompletions(parentId)).toEqual([])
      expect(await createOnA.readFinishedChildCompletions(parentId)).toHaveLength(1)
      await second.releaseResourceOwner(newParentOwner)
      parentOwner = await first.acquireResourceOwner(parentScope, memberA, randomUUID(), 60_000)
      await expect(createOnA.markChildCommandDispatched(childId, commandId)).rejects.toThrow()
      expect(await ownerB.claimChildCommand(childId)).toBeUndefined()
      await expect(consumeNextChildStop(ownerB, childId, async () => {
        throw new Error('timeout cancellation ACK lost')
      })).rejects.toThrow('timeout cancellation ACK lost')
      await second.releaseResourceOwner(successorOwner)
      await second.releaseReplica(memberB)
      const fallbackOwner = await first.acquireResourceOwner(childScope, memberA, randomUUID(), 60_000)
      const fallback = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId, localReplicaId: memberA.replicaId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner : fallbackOwner,
      })
      expect(await fallback.pendingChildSessionIds()).toContain(childId)
      expect(await consumeNextChildStop(fallback, childId, async () => {
        throw new Error('never repeat an unacknowledged cancellation')
      })).toMatchObject({ status: 'completed', outcome: { ok: false, content: expect.stringContaining('UNKNOWN') } })
      await expect(ownerB.completeChildCommand(childId, 'timeout-initial', { ok: true, content: 'stale ACK' }))
        .rejects.toThrow()
      const competingId = randomUUID()
      const competingOwner = await first.acquireResourceOwner({ ...childScope, resourceId: competingId }, memberA, randomUUID(), 60_000)
      const competing = new PostgresSessionAuthority(hotA, organizationId, {
        schemaManagement: 'external', unitId,
        resourceOwnerForSession: (id) => id === parentId ? parentOwner
          : id === rejectedId ? rejectedOwner : id === competingId ? competingOwner : undefined,
      })
      const candidates = [rejectedId, competingId]
      const outcomes = await Promise.allSettled(candidates.map(async (id) =>
        competing.createChildWithCommand({
          sessionId: id, parentSessionId: parentId, parentCallId: id,
          state: { cursor: 0, status: 'idle' },
        }, id, `prompt for ${id}`, 1)))
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect((await Promise.all(candidates.map(async (id) => competing.load(id)))).filter(Boolean)).toHaveLength(1)
    } finally {
      await Promise.all([hotA.close(), hotB.close()])
    }
  })

  it('fences HotState event and projection callbacks in one transaction even on idempotent retry', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://event-a.example',
    }, 8_000)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://event-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const oldOwner = await first.acquireResourceOwner(scope, replicaA, randomUUID(), 100)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-fenced-event` })
    try {
      const token = await hotState.acquireLease({ tenantId: organizationId, scopeType: 'session', scopeId: scope.resourceId }, 'writer-a', 5_000)
      const event = { idempotencyKey: randomUUID(), eventType: 'session.updated', payload: { value: 1 } }
      const sideEffect = async (transaction: HotStateSqlExecutor) => {
        await transaction.query('SELECT 1')
      }
      await hotState.appendEventWithSideEffect(token, event, sideEffect, oldOwner)
      let successor: Awaited<ReturnType<typeof second.acquireResourceOwner>> | undefined
      await eventually(async () => {
        successor = await second.acquireResourceOwner(scope, replicaB, randomUUID(), 5_000)
      }, 5_000)
      await expect(hotState.appendEventWithSideEffect(token, event, sideEffect, oldOwner))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(hotState.appendEventWithSideEffect(token, {
        ...event, idempotencyKey: randomUUID(),
      }, sideEffect, oldOwner)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(hotState.appendEventWithSideEffect(token, event, sideEffect, {
        ...successor!, resourceId: randomUUID(),
      })).rejects.toThrow('scope must match')
      const accepted = await hotState.appendEventWithSideEffect(token, {
        ...event, idempotencyKey: randomUUID(),
      }, sideEffect, successor!)
      expect(accepted.sequence).toBe(2n)
      expect(await hotState.replay({ tenantId: organizationId, scopeType: 'session', scopeId: scope.resourceId })).toHaveLength(2)
    } finally { await hotState.close() }
  })

  it('fences native SDK chunks across owner takeover, tenant isolation and Session final deletion', async () => {
    const organizationId = randomUUID(), unitId = parseTenantRuntimeUnitId(randomUUID()), sessionId = randomUUID()
    const memberA = await first.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://native-a.example' }, 60_000)
    const memberB = await second.registerReplica({ organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://native-b.example' }, 60_000)
    const scope = { organizationId, unitId, resourceType: 'session' as const, resourceId: sessionId }
    const ownerA = await first.acquireResourceOwner(scope, memberA, randomUUID(), 60_000)
    const hot = createPostgresHotStateStore({ connectionString, applicationName: `${project}-native-chunks` })
    const authority = (owner: typeof ownerA, tenantId = organizationId) => new PostgresSessionAuthority(hot, tenantId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => owner,
    })
    try {
      const old = authority(ownerA), oldFs = old.nativeSessionFs(sessionId)
      await old.create({ sessionId, state: { cursor: 0 } })
      await oldFs.writeFile('/session-state/events.jsonl', 'native-before-takeover\n')
      const auditBefore = await hot.database.query('SELECT count(*)::integer AS n FROM tenant_runtime_hot_events WHERE tenant_id = $1', [organizationId])
      await first.releaseResourceOwner(ownerA)
      const ownerB = await second.acquireResourceOwner(scope, memberB, randomUUID(), 60_000)
      const live = authority(ownerB), fs = live.nativeSessionFs(sessionId)
      await expect(oldFs.readFile('/session-state/events.jsonl')).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(oldFs.appendFile('/session-state/events.jsonl', 'stale')).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(authority(ownerB, randomUUID()).nativeSessionFs(sessionId).readFile('/session-state/events.jsonl')).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await fs.appendFile('/session-state/events.jsonl', 'native-after-takeover\n')
      expect(await fs.readFile('/session-state/events.jsonl')).toBe('native-before-takeover\nnative-after-takeover\n')
      const auditAfter = await hot.database.query('SELECT count(*)::integer AS n FROM tenant_runtime_hot_events WHERE tenant_id = $1', [organizationId])
      expect(auditAfter.rows).toEqual(auditBefore.rows)
      await live.requestDeletion(sessionId)
      await expect(fs.appendFile('/session-state/events.jsonl', 'after tombstone')).rejects.toBeInstanceOf(SessionDeletingError)
      await live.delete(sessionId)
      const chunks = await hot.database.query('SELECT count(*)::integer AS n FROM tenant_session_native_fs_chunks WHERE tenant_id = $1 AND session_id = $2', [organizationId, sessionId])
      expect(chunks.rows[0]?.n).toBe(0)
    } finally { await hot.close() }
  })

  it('fences object intents and idempotent metadata writes when a Session owner moves to another replica', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const sessionId = randomUUID()
    const [memberA, memberB] = await Promise.all([
      first.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://object-a.example' }, 15_000),
      second.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://object-b.example' }, 15_000),
    ])
    const scope = { organizationId, unitId, resourceType: 'session' as const, resourceId: sessionId }
    const ownerA = await first.acquireResourceOwner(scope, memberA, randomUUID(), 10_000)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-fenced-objects` })
    const objectLog = (owner: typeof ownerA) => new PostgresObjectMetadataLog(organizationId, hotState, {
      schemaManagement: 'external', prepareSessionOwner: async () => undefined,
      resourceOwnerForSession: () => owner,
    })
    const objectsA = objectLog(ownerA)
    const sessionY = randomUUID()
    const ownerY = await second.acquireResourceOwner({ ...scope, resourceId: sessionY }, memberB, randomUUID(), 10_000)
    const objectsY = objectLog(ownerY)
    const capacity = (owner: typeof ownerA) => new PostgresObjectCapacityLedger(organizationId, 1024, hotState, {
      schemaManagement: 'external', prepareSessionOwner: async () => undefined,
      resourceOwnerForSession: () => owner,
    })
    try {
      await capacity(ownerA).initialize()
      const reservationA = await capacity(ownerA).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })
      const intentA = await objectsA.prepareObject(sessionId, `objects/${randomUUID()}`)
      const firstEvent = { idempotencyKey: randomUUID(), eventType: 'artifact.registered', payload: { objectKey: intentA.objectKey }, intent: intentA }
      await objectsA.append(sessionId, firstEvent)
      const intentY = await objectsY.prepareObject(sessionY, `objects/${randomUUID()}`)
      await objectsY.append(sessionY, { idempotencyKey: randomUUID(), eventType: 'artifact.registered',
        payload: { objectKey: intentY.objectKey }, intent: intentY })
      expect(await objectsY.replay(sessionY)).toHaveLength(1)
      const takeoverIntent = await objectsA.prepareObject(sessionId, `objects/${randomUUID()}`)
      await hotState.database.query(`UPDATE tenant_object_orphan_intents
        SET upload_expires_at = clock_timestamp() - interval '1 millisecond'
        WHERE tenant_id = $1 AND object_key = $2`, [organizationId, takeoverIntent.objectKey])
      const deleted: string[] = []
      const cleaner: ArtifactObjectStore = {
        put: async () => { throw new Error('unexpected put') },
        get: async () => { throw new Error('unexpected get') },
        signedGetUrl: async () => { throw new Error('unexpected signed URL') },
        delete: async (_organizationId: string, objectKey: string) => { deleted.push(objectKey) },
      }
      await expect(objectsA.reconcileOrphanIntents(cleaner, { limit: 1 }))
        .resolves.toEqual({ claimed: 0, deleted: 0, failed: 0 })
      await expect(objectLog(ownerY).prepareObject(sessionId, `objects/${randomUUID()}`))
        .rejects.toThrow('scope must match')
      await expect(capacity(ownerY).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })).rejects.toThrow('scope must match')
      const wrongOrganization = new PostgresObjectMetadataLog(randomUUID(), hotState, {
        schemaManagement: 'external', prepareSessionOwner: async () => undefined,
        resourceOwnerForSession: () => ownerA,
      })
      await expect(wrongOrganization.prepareObject(sessionId, `objects/${randomUUID()}`))
        .rejects.toThrow('scope must match')
      await first.releaseResourceOwner(ownerA)
      const ownerB = await second.acquireResourceOwner(scope, memberB, randomUUID(), 10_000)
      const objectsB = objectLog(ownerB)
      await expect(objectsB.reconcileOrphanIntents(cleaner, { limit: 1 }))
        .resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 })
      expect(deleted).toEqual([takeoverIntent.objectKey])
      await expect(objectsA.prepareObject(sessionId, `objects/${randomUUID()}`))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(capacity(ownerA).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(objectsA.beginSessionDeletion(sessionId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(objectsA.completeObjectCleanup(intentA)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(objectsA.append(sessionId, firstEvent))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await capacity(ownerB).release(reservationA)
      const reservationB = await capacity(ownerB).reserve({ objectKey: `objects/${randomUUID()}`, sessionId,
        kind: 'session_artifact', bytes: 1 })
      const intentB = await objectsB.prepareObject(sessionId, `objects/${randomUUID()}`)
      await objectsB.append(sessionId, {
        idempotencyKey: randomUUID(), eventType: 'artifact.registered', payload: { objectKey: intentB.objectKey }, intent: intentB,
      })
      expect(await objectsB.replay(sessionId)).toHaveLength(2)
      await objectsB.beginSessionDeletion(sessionId)
      await capacity(ownerB).release(reservationB)
      expect(await capacity(ownerB).usageBytes()).toBe(0)
    } finally { await hotState.close() }
  })

  it('acquires live Session owners for SessionAuthority and queue and recovers them on a second replica', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const [memberA, memberB] = await Promise.all([
      first.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://session-a.example' }, 1_200),
      second.registerReplica({ organizationId, unitId, replicaId: randomUUID(),
        membershipToken: randomUUID(), origin: 'https://session-b.example' }, 9_000),
    ])
    const lostA = async () => undefined
    const ownershipA = new RuntimeSessionOwnership(organizationId, unitId,
      { activeLease: () => memberA }, new RuntimeResourceOwnershipManager(first), lostA)
    const ownershipB = new RuntimeSessionOwnership(organizationId, unitId,
      { activeLease: () => memberB }, new RuntimeResourceOwnershipManager(second), async () => undefined)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-managed-sessions` })
    const authority = (ownership: RuntimeSessionOwnership) => new PostgresSessionAuthority(hotState, organizationId, {
      schemaManagement: 'external', unitId,
      resourceOwnerForSession: (sessionId) => ownership.activeLease(sessionId),
      prepareSessionOwner: async (sessionId) => { await ownership.ensure(sessionId) },
    })
    const old = authority(ownershipA)
    const live = authority(ownershipB)
    const sessionA = randomUUID()
    const sessionB = randomUUID()
    try {
      await Promise.all([
        old.create({ sessionId: sessionA, organizationId, state: { cursor: 0 } }),
        live.create({ sessionId: sessionB, organizationId, state: { cursor: 0 } }),
      ])
      expect(ownershipA.activeLease(sessionA)?.replicaId).toBe(memberA.replicaId)
      expect(ownershipB.activeLease(sessionB)?.replicaId).toBe(memberB.replicaId)
      const queued = { id: 'first', operationId: 'first', text: 'one', mode: 'queue' as const, createdAt: new Date().toISOString() }
      await old.messageQueue.enqueue(sessionA, queued, 'back')
      await old.agentBoardTransaction(sessionA, (_root, board) => {
        board.entries.note = { topic: 'note', content: 'persisted', authorSessionId: sessionA, tags: [],
          revision: 1, updatedAt: new Date().toISOString() }
        board.revision += 1
      })
      await expect(live.load(sessionA)).resolves.toMatchObject({ sessionId: sessionA })
      await expect(live.list([sessionA])).resolves.toEqual([expect.objectContaining({ sessionId: sessionA })])
      expect(ownershipB.activeLease(sessionA)).toBeUndefined()
      await expect(live.messageQueue.load(sessionA)).rejects.toBeInstanceOf(RuntimeResourceOwnershipHeldError)
      await eventually(async () => { await live.messageQueue.load(sessionA) }, 5_000)
      expect(ownershipB.activeLease(sessionA)?.replicaId).toBe(memberB.replicaId)
      await expect(old.messageQueue.enqueue(sessionA, { ...queued, id: 'stale', operationId: 'stale' }, 'back'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.agentBoardTransaction(sessionA, () => undefined))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      expect(await live.agentBoardTransaction(sessionA, (_root, board) => board.entries.note?.content)).toBe('persisted')
      await live.messageQueue.enqueue(sessionA, { ...queued, id: 'recovered', operationId: 'recovered' }, 'back')
      expect((await live.messageQueue.load(sessionA)).items.map((item) => item.operationId)).toEqual(['first', 'recovered'])
      await expect(live.load(sessionA)).resolves.toMatchObject({ sessionId: sessionA })
    } finally {
      await Promise.allSettled([ownershipA.close(), ownershipB.close()])
      await hotState.close()
    }
  })

  it('fences SessionAuthority create, retry, mutation and projection repair by the current owner', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://authority-a.example',
    }, 1_200)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://authority-b.example',
    }, 8_000)
    const scope = resource(organizationId, unitId, 'session')
    const ownerA = await first.acquireResourceOwner(scope, replicaA, randomUUID(), 6_000)
    const hotState = createPostgresHotStateStore({ connectionString, applicationName: `${project}-session-authority` })
    const old = new PostgresSessionAuthority(hotState, organizationId, {
      schemaManagement: 'external', unitId, resourceOwnerForSession: () => ownerA,
    })
    try {
      const initial = { sessionId: scope.resourceId, organizationId, state: { cursor: 0 } }
      await old.create(initial)
      await old.initializeEmptyNativePosixSession(scope.resourceId)
      const oldNative = old.nativePosixSessionFs(scope.resourceId)
      await oldNative.create('/epoch', 0o600)
      await oldNative.write('/epoch', 0, Buffer.from([0, 1, 255]))
      const queued = { id: 'queued-old', operationId: 'queued-old', text: 'one', mode: 'queue' as const, createdAt: new Date().toISOString() }
      await old.messageQueue.enqueue(scope.resourceId, queued, 'back')
      const claim = (await old.messageQueue.claimHead(scope.resourceId, 'writer-a', 5_000)).claim!
      expect(claim.item.operationId).toBe('queued-old')
      expect(() => new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', resourceOwnerForSession: () => ownerA,
      })).toThrow('trusted Unit ID')
      expect(() => new PostgresSessionAuthority(hotState, organizationId, {
        unitId, resourceOwnerForSession: () => ownerA,
      })).toThrow('operator-migrated PostgreSQL schema')
      const wrongUnit = new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', unitId: parseTenantRuntimeUnitId(randomUUID()), resourceOwnerForSession: () => ownerA,
      })
      await expect(wrongUnit.messageQueue.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      let ownerB: Awaited<ReturnType<typeof second.acquireResourceOwner>> | undefined
      await eventually(async () => {
        ownerB = await second.acquireResourceOwner(scope, replicaB, randomUUID(), 5_000)
      }, 5_000)
      expect(ownerA.expiresAt.getTime()).toBeGreaterThan(Date.now())
      await expect(old.create(initial)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(oldNative.write('/epoch', 0, Buffer.from('stale'))).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.loadOrInitialize(scope.resourceId, async () => ({ items: [], cancelledOperationIds: [] })))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.confirmClaim(claim)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.renewClaim(claim, 5_000)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.releaseClaim(claim)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.completeClaim(claim)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.messageQueue.enqueue(scope.resourceId, { ...queued, id: 'stale', operationId: 'stale' }, 'back'))
        .rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(old.mutate(scope.resourceId, {
        mutationId: 'stale-session-mutation', eventType: 'session.updated',
        apply: (document) => document && { ...document, state: { cursor: 1 } },
      })).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      const absent = new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', unitId, resourceOwnerForSession: () => undefined,
      })
      await expect(absent.create(initial)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(absent.messageQueue.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      const live = new PostgresSessionAuthority(hotState, organizationId, {
        schemaManagement: 'external', unitId, resourceOwnerForSession: () => ownerB,
      })
      await expect(live.nativePosixSessionFs(scope.resourceId).read('/epoch', 0, 3)).resolves.toEqual(Buffer.from([0, 1, 255]))
      await live.messageQueue.enqueue(scope.resourceId, { ...queued, id: 'queued-new', operationId: 'queued-new' }, 'back')
      expect((await live.messageQueue.load(scope.resourceId)).items.map((item) => item.operationId)).toEqual(['queued-old', 'queued-new'])
      await expect(live.mutate(scope.resourceId, {
        mutationId: 'live-session-mutation', eventType: 'session.updated',
        apply: (document) => document && { ...document, state: { cursor: 1 } },
      })).resolves.toMatchObject({ state: { cursor: 1 } })
      await hotState.database.query('DELETE FROM tenant_session_latest_projection WHERE tenant_id=$1 AND session_id=$2', [
        organizationId, scope.resourceId,
      ])
      await expect(old.load(scope.resourceId)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
      await expect(live.load(scope.resourceId)).resolves.toMatchObject({ state: { cursor: 1 } })
      await expect(hotState.replay({ tenantId: organizationId, scopeType: 'session', scopeId: scope.resourceId }))
        .resolves.toHaveLength(2)
    } finally { await hotState.close() }
  })

  it('rejects the same organization-global Session ID across Units but allows distinct Sessions', async () => {
    const organizationId = randomUUID()
    const unitA = parseTenantRuntimeUnitId(randomUUID())
    const unitB = parseTenantRuntimeUnitId(randomUUID())
    const resourceId = randomUUID()
    const [replicaA, replicaB] = await Promise.all([
      first.registerReplica({
        organizationId, unitId: unitA, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://unit-a.example',
      }, 5_000),
      second.registerReplica({
        organizationId, unitId: unitB, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://unit-b.example',
      }, 5_000),
    ])
    const sessionA: RuntimeResourceScope = { organizationId, unitId: unitA, resourceType: 'session', resourceId }
    const sameSessionInAnotherUnit: RuntimeResourceScope = { organizationId, unitId: unitB, resourceType: 'session', resourceId }
    const attempts = await Promise.allSettled([
      first.acquireResourceOwner(sessionA, replicaA, randomUUID(), 5_000),
      second.acquireResourceOwner(sameSessionInAnotherUnit, replicaB, randomUUID(), 5_000),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected'))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: '23505' }) })])
    const winningScope = attempts[0]?.status === 'fulfilled' ? sessionA : sameSessionInAnotherUnit
    const winner = attempts.find((attempt) => attempt.status === 'fulfilled')
    if (!winner || winner.status !== 'fulfilled') throw new Error('missing ownership winner')
    await expect(first.lookupResourceOwner(winningScope)).resolves.toMatchObject({
      unitId: winningScope.unitId, replicaId: winner.value.replicaId,
    })
    const distinctSession: RuntimeResourceScope = { ...sameSessionInAnotherUnit, resourceId: randomUUID() }
    const distinctOwner = await second.acquireResourceOwner(distinctSession, replicaB, randomUUID(), 5_000)
    await expect(second.lookupResourceOwner(distinctSession)).resolves.toMatchObject({
      unitId: unitB, replicaId: distinctOwner.replicaId, origin: replicaB.origin,
    })
  })

  it('joins ownership to a live organization membership and fences expired membership and old owner tokens', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://short-lived.example',
    }, 100)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://takeover.example',
    }, 8_000)
    const task = resource(organizationId, unitId, 'task')
    const oldOwner = await first.acquireResourceOwner(task, replicaA, randomUUID(), 8_000)

    await eventually(async () => {
      expect(await second.lookupResourceOwner(task)).toBeUndefined()
    }, 5_000)
    const newOwner = await second.acquireResourceOwner(task, replicaB, randomUUID(), 8_000)
    expect(newOwner.generation).toBe(oldOwner.generation + 1n)
    await expect(first.renewResourceOwner(oldOwner, 5_000)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(first.releaseResourceOwner(oldOwner)).rejects.toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    await expect(first.renewReplica(replicaA, 5_000)).rejects.toThrow()

    const otherOrganizationReplica = await first.registerReplica({
      organizationId: randomUUID(), unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://other-org.example',
    }, 5_000)
    await expect(first.acquireResourceOwner(
      resource(organizationId, otherOrganizationReplica.unitId, 'session'), otherOrganizationReplica, randomUUID(), 5_000,
    )).rejects.toThrow('organizationId and unitId must match')
    await expect(second.lookupResourceOwner(task)).resolves.toMatchObject({ replicaId: replicaB.replicaId })
  })

  it('fences an old writer inside its SQL transaction and remains usable after rollback', async () => {
    const organizationId = randomUUID()
    const unitId = parseTenantRuntimeUnitId(randomUUID())
    const replicaA = await first.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://writer-a.example',
    }, 5_000)
    const replicaB = await second.registerReplica({
      organizationId, unitId, replicaId: randomUUID(), membershipToken: randomUUID(), origin: 'https://writer-b.example',
    }, 5_000)
    const session = resource(organizationId, unitId, 'session')
    const oldOwner = await first.acquireResourceOwner(session, replicaA, randomUUID(), 80)
    let newOwner: Awaited<ReturnType<typeof second.acquireResourceOwner>> | undefined
    await eventually(async () => {
      newOwner = await second.acquireResourceOwner(session, replicaB, randomUUID(), 5_000)
    }, 5_000)

    await first.database.query('CREATE TABLE IF NOT EXISTS resource_owner_fenced_writes (value text)')
    const staleTransaction = await first.database.connect()
    await staleTransaction.query('BEGIN')
    try {
      await first.assertResourceOwner(staleTransaction, oldOwner)
      await staleTransaction.query('INSERT INTO resource_owner_fenced_writes (value) VALUES ($1)', ['stale'])
      await staleTransaction.query('COMMIT')
      throw new Error('stale owner unexpectedly committed a mutation')
    } catch (error) {
      await staleTransaction.query('ROLLBACK').catch(() => undefined)
      expect(error).toBeInstanceOf(RuntimeResourceOwnershipFencedError)
    } finally {
      staleTransaction.release()
    }
    const staleWrites = await first.database.query('SELECT value FROM resource_owner_fenced_writes')
    expect(staleWrites.rows).toEqual([])

    const liveTransaction = await second.database.connect()
    try {
      await liveTransaction.query('BEGIN')
      await second.assertResourceOwner(liveTransaction, newOwner!)
      await liveTransaction.query('SELECT 1')
      await liveTransaction.query('COMMIT')
    } catch (error) {
      await liveTransaction.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      liveTransaction.release()
    }

    await expect(second.renewResourceOwner(newOwner!, 5_000)).resolves.toMatchObject({ generation: newOwner!.generation })
    await expect(first.renewReplica({ ...replicaA, membershipToken: randomUUID() }, 5_000))
      .rejects.toBeInstanceOf(RuntimeUnitReplicaMembershipFencedError)
  })
})

function resource(
  organizationId: string,
  unitId: ReturnType<typeof parseTenantRuntimeUnitId>,
  resourceType: 'session' | 'task',
): RuntimeResourceScope {
  return { organizationId, unitId, resourceType, resourceId: randomUUID() }
}

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw lastError
}
