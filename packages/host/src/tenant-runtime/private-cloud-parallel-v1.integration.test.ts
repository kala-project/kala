import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_PRIVATE_CLOUD_STORAGE_INTEGRATION === '1' ? describe : describe.skip
const nodeImage = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
const browserImage = 'ghcr.io/puppeteer/puppeteer@sha256:9665f5b57abc5cc7080a641878964018de219055a4d2c9d8d050ceb1161778ba'
const siloImage = 'pgsty/silo@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7'
const postgresImage = 'postgres@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36'
const parallelBarrier = 'kala-parallel-placement-barrier-v1'
const parallelBarrierOrigin = 'https://parallel-placement-barrier.invalid'
const acceptanceProduct = process.env.KALA_PARALLEL_ACCEPTANCE_PRODUCT ?? 'private-cloud'
if (acceptanceProduct !== 'private-cloud' && acceptanceProduct !== 'dedicated') throw new Error('KALA_PARALLEL_ACCEPTANCE_PRODUCT must be private-cloud or dedicated')
const dedicated = acceptanceProduct === 'dedicated'
const deploymentPath = dedicated ? '/app/deploy/aspire/deployment.json' : '/app/deploy/private-cloud/deployment.json'

integrationDescribe(`${acceptanceProduct} parallel-v1 real two-Runtime acceptance`, () => {
  const id = randomUUID()
  const project = `kala-pc-parallel-${id}`
  const network = `${project}-net`
  const postgres = `${project}-postgres`
  const silo = `${project}-silo`
  const runtimeA = `${project}-runtime-a`
  const runtimeB = `${project}-runtime-b`
  const identity = `${project}-identity`
  const gateway = `${project}-gateway`
  const model = `${project}-model`
  const executor = `${project}-executor`
  const workspaceVolume = `${project}-workspace`
  const containers = [executor, gateway, identity, runtimeA, runtimeB, model, silo, postgres]
  const repository = resolve(import.meta.dirname, '../../../..')
  const ingressSecret = `ingress-${randomUUID()}-${randomUUID()}`
  const postgresPassword = `pg-${randomUUID()}`
  const runtimeDatabasePassword = `role-${randomUUID()}`
  const runtimeDatabaseRole = 'kala_parallel_runtime_test'
  const accessKeyId = `access-${randomUUID()}`
  const secretAccessKey = `secret-${randomUUID()}-${randomUUID()}`
  const database = 'kala_parallel_acceptance'
  const controlDatabase = dedicated ? 'runlab_control' : database
  const bucket = 'kala-parallel-acceptance'
  let unitId = `unit-${id}`
  let organizationId = `org_${id}`
  let principalId = `prn_${id}`
  const sessionX = `session-x-${id}`
  const sessionY = `session-y-${id}`
  const sessionBoard = `session-board-${id}`
  const workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const marker = `parallel-executor-marker-${id}`
  const executorInvite = `ak_invite_${randomBytes(24).toString('base64url')}`
  const executorInviteId = `inv_${randomBytes(12).toString('base64url')}`
  let browserToken = randomBytes(32).toString('base64url')
  const routingTicketKey = randomBytes(32).toString('base64url')
  const sessionSecret = `session-${randomUUID()}-${randomUUID()}`
  let gatewayReaderConnection = ''
  let setupStarted = false
  let testKeyDirectory: string | undefined
  let testKeyPath: string | undefined
  const runtimeEvidence: Array<{ name: string; containerId: string; pid: number }> = []
  let killedOwnerName: string | undefined
  let survivingOwnerName: string | undefined
  let receiptsBeforeRuntimeKill: ExecutionReceipts | undefined
  let exportedArtifacts: ArtifactProof[] = []

  beforeAll(async () => {
    try {
      await docker('info', '--format', '{{.ServerVersion}}')
    } catch (error) {
      throw new Error(`sudo -n docker is required for the isolated parallel-v1 acceptance; no existing container was contacted: ${errorMessage(error)}`)
    }

    setupStarted = true
    try {
      testKeyDirectory = join(repository, '.receipt-test-tmp', project)
      await mkdir(testKeyDirectory, { recursive: true, mode: 0o700 })
      testKeyPath = join(testKeyDirectory, 'master-key')
      await writeFile(testKeyPath, randomBytes(32), { flag: 'wx', mode: 0o600 })
      await chmod(testKeyPath, 0o600)
      const keyFile = await stat(testKeyPath)
      expect(keyFile.size).toBe(32)
      expect(keyFile.mode & 0o777).toBe(0o600)

      await docker('network', 'create', '--internal', '--label', `dev.kala.test.project=${project}`, network)
      await docker('volume', 'create', '--label', `dev.kala.test.project=${project}`, workspaceVolume)
      await docker('run', '--detach', '--name', postgres,
        '--label', `dev.kala.test.project=${project}`,
        '--network', network,
        '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
        '--env', `POSTGRES_PASSWORD=${postgresPassword}`,
        '--env', `POSTGRES_DB=${database}`,
        postgresImage)
      await docker('run', '--detach', '--name', silo,
        '--label', `dev.kala.test.project=${project}`,
        '--network', network,
        '--tmpfs', '/data:rw,nosuid,size=256m',
        '--env', `MINIO_ROOT_USER=${accessKeyId}`,
        '--env', `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
        siloImage, 'server', '/data')

      await eventually(async () => {
        const logs = await docker('logs', postgres)
        if (!`${logs.stdout}${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.')) {
          throw new Error('PostgreSQL init process has not completed')
        }
        await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-c', 'SELECT 1')
      }, 30_000)
      await eventually(async () => {
        await docker('exec', silo, 'mcli', 'alias', 'set', 'self', 'http://127.0.0.1:9000', accessKeyId, secretAccessKey)
      }, 30_000)
      await docker('exec', silo, 'mcli', 'mb', `self/${bucket}`)
      if (dedicated) await initializeDedicatedClaims()

      await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c',
        `CREATE ROLE ${runtimeDatabaseRole} LOGIN PASSWORD '${runtimeDatabasePassword}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`)
      await docker('run', '--rm', '--network', network,
        '--mount', `type=bind,source=${repository},target=/app,readonly`,
        '--workdir', '/app/packages/host',
        '--env', `KALA_POSTGRES_MIGRATION_CONNECTION_STRING=postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${database}`,
        nodeImage, 'node', '--import', 'tsx', 'bin/kala-postgres-migrate.ts', '--runtime-role', runtimeDatabaseRole)
      await docker('run', '--rm', '--network', network,
        '--mount', `type=bind,source=${repository},target=/app,readonly`,
        '--workdir', '/app/packages/runtime-ingress-gateway',
        '--env', `KALA_INGRESS_DATABASE_URL=postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${controlDatabase}`,
        nodeImage, 'node', '--import', '/app/packages/host/node_modules/tsx/dist/loader.mjs', 'src/bin/migrate-control-plane.ts')

      if (dedicated) await bootstrapDedicatedOwner()
      await installParallelGateAsOperator()
      await installGatewayAuthorityAndReader()
      await assertRuntimeCannotWriteGate()
      await startFakeOpenAi()
      await Promise.all([startRuntime(runtimeA), startRuntime(runtimeB)])
      if (dedicated) await Promise.all([provision(runtimeA, 'provision-unit'), provision(runtimeB, 'provision-unit')])
      await startIdentityDiscovery()
      await startGateway()
      if (dedicated) await loginDedicatedOwner()
      await assertPrivateNetwork([postgres, silo, model, runtimeA, runtimeB, identity, gateway])
      runtimeEvidence.push(await runtimeIdentity(runtimeA), await runtimeIdentity(runtimeB))
      expect(runtimeEvidence[0]?.pid).toBeGreaterThan(1)
      expect(runtimeEvidence[1]?.pid).toBeGreaterThan(1)
      expect(runtimeEvidence[0]?.pid).not.toBe(runtimeEvidence[1]?.pid)
      expect(runtimeEvidence[0]?.containerId).not.toBe(runtimeEvidence[1]?.containerId)
      console.info(`[private-cloud-parallel-v1.integration] Runtime evidence ${JSON.stringify(runtimeEvidence)}`)
    } catch (error) {
      await dumpLogs('setup failure')
      throw error
    }
  }, 180_000)

  afterAll(async () => {
    if (!setupStarted) return
    const failures: string[] = []
    const chromium = `${project}-chromium`
    if (await dockerResourceExists('container', chromium)) {
      await docker('rm', '--force', chromium).catch((error) => failures.push(`container ${chromium}: ${errorMessage(error)}`))
    }
    for (const name of containers) {
      await docker('rm', '--force', name).catch((error) => failures.push(`container ${name}: ${errorMessage(error)}`))
    }
    const listed = await docker('ps', '-a', '--filter', `label=dev.kala.test.project=${project}`, '--format', '{{.Names}}')
    for (const name of listed.stdout.trim().split('\n').filter((name) => name.startsWith(`${project}-`))) {
      await docker('rm', '--force', name).catch((error) => failures.push(`transient container ${name}: ${errorMessage(error)}`))
    }
    await docker('volume', 'rm', '--force', workspaceVolume).catch((error) => failures.push(`volume ${workspaceVolume}: ${errorMessage(error)}`))
    await docker('network', 'rm', network).catch((error) => failures.push(`network ${network}: ${errorMessage(error)}`))
    for (const name of containers) {
      if (await dockerResourceExists('container', name)) failures.push(`container still exists: ${name}`)
    }
    if (await dockerResourceExists('network', network)) failures.push(`network still exists: ${network}`)
    if (await dockerResourceExists('volume', workspaceVolume)) failures.push(`volume still exists: ${workspaceVolume}`)
    const remaining = await docker('ps', '-a', '--filter', `label=dev.kala.test.project=${project}`, '--format', '{{.Names}}')
    if (remaining.stdout.trim()) failures.push(`labelled containers still exist: ${remaining.stdout.trim()}`)
    if (testKeyDirectory) {
      await rm(testKeyDirectory, { recursive: true, force: true }).catch((error) => failures.push(`test key directory: ${errorMessage(error)}`))
      if (testKeyPath) {
        try {
          await stat(testKeyPath)
          failures.push(`test key file still exists: ${testKeyPath}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(`test key cleanup check: ${errorMessage(error)}`)
        }
      }
    }
    if (failures.length > 0) throw new Error(`isolated parallel-v1 cleanup failed:\n${failures.join('\n')}`)
    console.info(`[private-cloud-parallel-v1.integration] removed UUID resources for ${project}; stopped Runtime PIDs ${runtimeEvidence.map(({ pid }) => pid).join(', ')}`)
  }, 45_000)

  it('runs real X/Y read_file calls through one external Executor connected to both owners', async () => {
    try {
      await provision(runtimeA, 'provision-unit')
      await provision(runtimeB, 'provision-unit')
      await eventually(async () => {
        expect(await liveReplicaOrigins()).toEqual([
          `http://${runtimeA}:13002`, `http://${runtimeB}:13002`,
        ].sort())
      }, 10_000)
      await startExternalExecutor()
      await assertPrivateNetwork([postgres, silo, model, runtimeA, runtimeB, identity, gateway, executor])

      const initial = await runBrowserJourney('initial') as InitialGatewayResult
      expect(initial).toEqual({
        x: { sessionId: sessionX, routed: true, preferenceWritten: true },
        y: { sessionId: sessionY, routed: true, preferenceWritten: true },
      })
      const owners = await sessionOwners()
      expect(owners.map(({ sessionId, generation }) => ({ sessionId, generation }))).toEqual([
        { sessionId: sessionX, generation: 1 }, { sessionId: sessionY, generation: 1 },
      ])
      expect(new Set(owners.map(({ origin }) => origin)).size).toBe(2)

      const dispatched = await runBrowserJourney('tools') as ToolGatewayResult
      expect(dispatched).toEqual({
        x: { sessionId: sessionX, accepted: true }, y: { sessionId: sessionY, accepted: true },
      })
      await eventually(async () => {
        const projections = await sessionProjections()
        const terminalError = [...projections.values()].map((document) => {
          const parsed = JSON.parse(document) as { state?: { status?: string; error?: string } }
          return parsed.state?.status === 'error' ? parsed.state.error : undefined
        }).find(Boolean)
        if (terminalError) throw new Error(`Executor tool turn entered terminal error state: ${terminalError}`)
        const receipts = await executionReceipts()
        assertCompletedReceipt(receipts, sessionX, 'call_x', marker)
        assertCompletedReceipt(receipts, sessionY, 'call_y', marker)
        const completedOwners = await sessionOwners()
        expect(completedOwners.map(({ sessionId, origin }) => ({ sessionId, origin }))).toEqual(
          owners.map(({ sessionId, origin }) => ({ sessionId, origin })),
        )
        expect(projections.get(sessionX)).toContain(marker)
        expect(projections.get(sessionX)).toContain('call_x')
        expect(projections.get(sessionY)).toContain(marker)
        expect(projections.get(sessionY)).toContain('call_y')
        receiptsBeforeRuntimeKill = receipts
      }, 30_000)
      const history = await runBrowserJourney('history') as HistoryGatewayResult
      expect(history).toEqual({
        x: { sessionId: sessionX, toolResultFound: true },
        y: { sessionId: sessionY, toolResultFound: true },
      })
      const objectRequestsBefore = await objectRequestCounts()
      exportedArtifacts = await runBrowserJourney('exports') as ArtifactProof[]
      expect(exportedArtifacts).toHaveLength(14)
      let objectRequestsAfter = objectRequestsBefore
      await eventually(async () => {
        objectRequestsAfter = await objectRequestCounts()
        expect(objectRequestsAfter.put - objectRequestsBefore.put).toBe(exportedArtifacts.length)
      }, 30_000)
      console.info(`[parallel-object-workload] ${JSON.stringify({
        product: acceptanceProduct, objects: exportedArtifacts.length,
        bytes: exportedArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
        putRequests: objectRequestsAfter.put - objectRequestsBefore.put,
        getRequests: objectRequestsAfter.get - objectRequestsBefore.get,
      })}`)
      await measureWriteWorkload('two-runtime-short-history', 2)
      expect(await runBrowserJourney('grow-history')).toEqual({ turns: 16 })
      await measureWriteWorkload('two-runtime-extended-history', 2)
      receiptsBeforeRuntimeKill = await executionReceipts()
      expect(Object.keys(receiptsBeforeRuntimeKill)).toHaveLength(18)
    } catch (error) {
      await dumpLogs('Executor tool acceptance failure')
      throw error
    }
  }, 120_000)

  it('routes durable next-turn child work, completion and Stop across both live Runtime owners', async () => {
    try {
      await provision(runtimeA, 'provision-unit')
      await provision(runtimeB, 'provision-unit')
      await eventually(async () => expect(await liveReplicaOrigins()).toHaveLength(2), 10_000)
      if (!await dockerResourceExists('container', executor)) await startExternalExecutor()
      await runBrowserJourney('board-create')
      expect(await runBrowserJourney('board-start')).toMatchObject({ accepted: true })
      let childId = ''
      let parentCallId = ''
      await eventually(async () => {
        const children = await boardChildren()
        const child = children.find((item) => item.parentSessionId === sessionBoard)
        expect(child?.parentCallId).toBeTruthy()
        childId = child!.sessionId
        parentCallId = child!.parentCallId
        const parentOwner = await sessionOwner(sessionBoard)
        const childOwner = await sessionOwner(childId)
        expect(childOwner?.origin).toBeTruthy()
        expect(childOwner?.origin).not.toBe(parentOwner?.origin)
        const commands = await boardCommands(childId)
        expect(commands.find((item) => item.commandId === parentCallId)).toMatchObject({
          kind: 'message', status: 'claimed', dispatchedAt: expect.any(String),
        })
      }, 30_000)
      const ownerBefore = await sessionOwner(childId)
      expect(await boardSummary(childId)).toMatchObject({ status: 'running', commandState: 'processing' })
      expect(await runBrowserJourney('board-follow', childId)).toMatchObject({ accepted: true })
      await eventually(async () => {
        const commands = await boardCommands(childId)
        expect(commands.filter((item) => item.kind === 'message')).toHaveLength(2)
        expect(commands[1]).toMatchObject({ status: 'pending', dispatchedAt: null })
        expect(await boardSummary(childId)).toMatchObject({
          status: 'running', commandState: 'processing', pendingCommandCount: 1,
        })
      }, 15_000)
      const finished = await runBrowserJourney('board-finished', childId)
      expect(finished).toMatchObject({ childSessionId: childId, status: 'completed', parentCallId })
      await eventually(async () => {
        const commands = await boardCommands(childId)
        expect(commands.filter((item) => item.kind === 'message')).toHaveLength(2)
        expect(commands.filter((item) => item.kind === 'message' && item.status === 'completed')).toHaveLength(2)
        const receipts = await executionReceipts()
        expect(Object.entries(receipts).filter(([key, receipt]) => key.startsWith(`${childId}:`)
          && receipt.result.ok && receipt.result.content.includes(marker))).toHaveLength(2)
        expect(await sessionOwner(childId)).toEqual(ownerBefore)
      }, 30_000)
      expect(await runBrowserJourney('board-stop', childId, parentCallId)).toMatchObject({ accepted: true })
      await eventually(async () => {
        const stop = (await boardCommands(childId)).find((item) => item.kind === 'stop')
        expect(stop).toMatchObject({ status: 'completed', outcome: { ok: true } })
      }, 15_000)

      expect(await runBrowserJourney('board-start-takeover')).toMatchObject({ accepted: true })
      let abandonedId = ''
      let abandonedCallId = ''
      await eventually(async () => {
        const child = (await boardChildren()).find((item) => item.sessionId !== childId)
        expect(child?.parentCallId).toBeTruthy()
        abandonedId = child!.sessionId
        abandonedCallId = child!.parentCallId
        expect((await boardCommands(abandonedId))[0]).toMatchObject({
          status: 'claimed', dispatchedAt: expect.any(String),
        })
      }, 30_000)
      const abandonedOwner = await sessionOwner(abandonedId)
      const parentOwner = await sessionOwner(sessionBoard)
      expect(abandonedOwner?.origin).not.toBe(parentOwner?.origin)
      const failedRuntime = abandonedOwner?.origin === `http://${runtimeA}:13002` ? runtimeA : runtimeB
      await docker('kill', '--signal', 'KILL', failedRuntime)
      killedOwnerName = failedRuntime
      survivingOwnerName = failedRuntime === runtimeA ? runtimeB : runtimeA
      await eventually(async () => {
        const owner = await sessionOwner(abandonedId)
        expect(owner?.generation).toBeGreaterThan(abandonedOwner!.generation)
        expect(owner?.origin).toBe(`http://${survivingOwnerName}:13002`)
      }, 30_000)
      expect(await runBrowserJourney('board-stop', abandonedId, abandonedCallId))
        .toMatchObject({ accepted: true })
      await eventually(async () => {
        const commands = await boardCommands(abandonedId)
        expect(commands.find((item) => item.kind === 'stop')).toMatchObject({
          status: 'completed', outcome: { ok: false, content: expect.stringContaining('UNKNOWN') },
        })
        expect(commands[0]).toMatchObject({ status: 'claimed' })
        expect(await boardSummary(abandonedId)).toMatchObject({ commandState: 'unknown' })
      }, 30_000)
      await releaseBoardModel('takeover')
    } catch (error) {
      await releaseBoardModel('marker').catch(() => undefined)
      await releaseBoardModel('takeover').catch(() => undefined)
      await dumpLogs('Board end-to-end failure')
      throw error
    }
  }, 150_000)

  ;(process.env.KALA_RUN_REAL_BROWSER_INTEGRATION === '1' ? it : it.skip)('routes both Sessions and replays tool history in real headless Chromium', async () => {
    const client = `${project}-chromium`
    const args = ['run', '--rm', '--name', client,
      '--label', `dev.kala.test.project=${project}`,
      '--network', network,
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--workdir', '/app',
      '--entrypoint', 'node',
      '--env', `TEST_PROTOCOL_VERSION=${PROTOCOL_VERSION}`,
      '--env', `TEST_GATEWAY_ORIGIN=http://${gateway}:13001`,
      '--env', `TEST_BROWSER_TOKEN=${browserToken}`,
      '--env', `TEST_SESSION_X=${sessionX}`,
      '--env', `TEST_SESSION_Y=${sessionY}`,
      browserImage, '--input-type=module', '--eval', chromiumBrowserJourney]
    const result = parseLastJson((await docker(...args)).stdout) as HistoryGatewayResult & { browser: string }
    expect(result.browser).toMatch(/Chrome/)
    expect(result.x).toEqual({ sessionId: sessionX, toolResultFound: true })
    expect(result.y).toEqual({ sessionId: sessionY, toolResultFound: true })
  }, 60_000)

  it('spreads X/Y through Gateway, proxies owner tickets exactly, and reconnects X after SIGKILL', async () => {
    try {
      // Both replicas materialize one logical Unit generation, so provisioning
      // must replay the same control-plane operation rather than invent another.
      await provision(runtimeA, 'provision-unit')
      await provision(runtimeB, 'provision-unit')
      await eventually(async () => {
        expect(await liveReplicaOrigins()).toEqual([
          `http://${runtimeA}:13002`,
          `http://${runtimeB}:13002`,
        ].sort())
      }, 10_000)

      const initial = await runBrowserJourney('initial') as InitialGatewayResult
      expect(initial).toEqual({
        x: { sessionId: sessionX, routed: true, preferenceWritten: true },
        y: { sessionId: sessionY, routed: true, preferenceWritten: true },
      })
      // Replica ids are intentionally opaque, so either server may win the
      // initial tie. The invariant is one exact Docker-DNS owner per Session.
      const owners = await sessionOwners()
      expect(owners.map(({ sessionId, generation }) => ({ sessionId, generation }))).toEqual([
        { sessionId: sessionX, generation: 1 },
        { sessionId: sessionY, generation: 1 },
      ])
      expect(owners.map(({ origin }) => origin).sort()).toEqual([
        `http://${runtimeA}:13002`,
        `http://${runtimeB}:13002`,
      ].sort())
      const xOwner = owners.find(({ sessionId }) => sessionId === sessionX)!.origin === `http://${runtimeA}:13002` ? runtimeA : runtimeB
      const takeover = xOwner === runtimeA ? runtimeB : runtimeA
      killedOwnerName = xOwner
      survivingOwnerName = takeover

      await docker('exec', xOwner, 'node', '--input-type=module', '--eval',
        "import {writeFile} from 'node:fs/promises';await writeFile('/state/disposable-node-marker','must-not-survive')")
      await docker('kill', '--signal', 'KILL', xOwner)
      expect((await docker('inspect', '--format', '{{.State.Running}}', xOwner)).stdout.trim()).toBe('false')

      const recovered = await runBrowserJourney('recover') as RecoveryGatewayResult
      expect(recovered).toEqual({ sessionId: sessionX, prepared: true, routed: true, preferenceWritten: true })
      await eventually(async () => {
        expect(await sessionOwner(sessionX)).toEqual({
          sessionId: sessionX,
          generation: 2,
          origin: `http://${takeover}:13002`,
        })
        expect(await liveReplicaOrigins()).toEqual([`http://${takeover}:13002`])
      }, 15_000)
      if (receiptsBeforeRuntimeKill) {
        await eventually(async () => {
          expect(await executionReceipts()).toEqual(receiptsBeforeRuntimeKill)
          const logs = await docker('logs', executor)
          if (!`${logs.stdout}${logs.stderr}`.includes('socket connected; announcing workspace')) {
            throw new Error('Executor has not announced through a Runtime replica')
          }
        }, 15_000)
      }
      expect(await runBrowserJourney('verify-exports')).toEqual({ verified: exportedArtifacts.length })
      await measureWriteWorkload('one-runtime-extended-history', 1)
    } catch (error) {
      await dumpLogs('acceptance failure')
      throw error
    }
  }, 150_000)

  it('fences the isolated owner after PostgreSQL network loss, takeover and restored connectivity', async () => {
    if (!killedOwnerName || !survivingOwnerName) throw new Error('SIGKILL prerequisite did not complete')
    try {
      // Recreate the killed replica with its ephemeral local state gone; the
      // logical Unit is reconstructed from the same versioned PG/S3 state.
      const previousIdentity = await runtimeIdentity(killedOwnerName)
      await docker('rm', killedOwnerName)
      await startRuntime(killedOwnerName)
      const replacementIdentity = await runtimeIdentity(killedOwnerName)
      expect(replacementIdentity.containerId).not.toBe(previousIdentity.containerId)
      await docker('exec', killedOwnerName, 'node', '--input-type=module', '--eval',
        "import {access} from 'node:fs/promises';try{await access('/state/disposable-node-marker');process.exitCode=1}catch(error){if(error.code!=='ENOENT')throw error}")
      await provision(killedOwnerName, 'provision-unit')
      await eventually(async () => {
        expect(await liveReplicaOrigins()).toEqual([
          `http://${runtimeA}:13002`, `http://${runtimeB}:13002`,
        ].sort())
      }, 15_000)

      // The surviving replica still owns Y, but is now unable to renew either
      // its PG Session owner or Unit membership. The other live replica must
      // take Y via Gateway only after those leases expire.
      await docker('network', 'disconnect', network, survivingOwnerName)
      const recovered = await runBrowserJourney('recover-y') as RecoveryGatewayResult
      expect(recovered).toEqual({ sessionId: sessionY, prepared: true, routed: true, preferenceWritten: true })
      await eventually(async () => {
        expect(await sessionOwner(sessionY)).toEqual({
          sessionId: sessionY, generation: 2, origin: `http://${killedOwnerName}:13002`,
        })
      }, 15_000)
      await docker('network', 'connect', network, survivingOwnerName)
      const stale = await runStaleWrite(survivingOwnerName, sessionY) as { outcome: string }
      expect(stale.outcome).toBe('rejected')
      expect(await sessionOwner(sessionY)).toEqual({
        sessionId: sessionY, generation: 2, origin: `http://${killedOwnerName}:13002`,
      })
      await runBrowserJourney('recover')
      expect(await runBrowserJourney('verify-exports')).toEqual({ verified: exportedArtifacts.length })
    } catch (error) {
      await dumpLogs('network partition acceptance failure')
      throw error
    }
  }, 180_000)

  it('does not publish a local success or a PG reference while S3 is unreachable', async () => {
    const publicationCount = async (): Promise<number> => {
      const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
        `SELECT count(*) FROM tenant_runtime_hot_events WHERE tenant_id='${organizationId}' AND event_type='session_artifact.registered'`)
      return Number(stdout.trim())
    }
    const before = await publicationCount()
    expect(before).toBe(exportedArtifacts.length)
    await docker('network', 'disconnect', network, silo)
    try {
      await expect(runBrowserJourney('exports')).rejects.toThrow('Durable export failed')
      expect(await publicationCount()).toBe(before)
    } finally {
      await docker('network', 'connect', network, silo)
    }
    expect(await runBrowserJourney('verify-exports')).toEqual({ verified: exportedArtifacts.length })
    const recovered = await runBrowserJourney('exports') as ArtifactProof[]
    expect(recovered.length).toBeGreaterThanOrEqual(14)
    exportedArtifacts.push(...recovered)
    expect(await publicationCount()).toBe(before + recovered.length)
    expect(await runBrowserJourney('verify-exports')).toEqual({ verified: exportedArtifacts.length })
  }, 180_000)

  async function initializeDedicatedClaims(): Promise<void> {
    if (!testKeyDirectory) throw new Error('test secret directory is unavailable')
    await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE runlab_control')
    const secretFiles: Record<string, string> = {
      'installation-id': id,
      'control-url': `postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${controlDatabase}`,
      'runtime-url': `postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${database}`,
      's3-access': accessKeyId,
      's3-secret': secretAccessKey,
    }
    for (const [name, value] of Object.entries(secretFiles)) await writeFile(join(testKeyDirectory, name), value, { flag: 'wx', mode: 0o600 })
    await docker('run', '--rm', '--network', network,
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--mount', `type=bind,source=${testKeyDirectory},target=/run/kala-test,readonly`,
      '--workdir', '/app/packages/host',
      '--env', 'KALA_INSTALLATION_ID_FILE=/run/kala-test/installation-id',
      '--env', 'KALA_FRESH_CLAIM_CONTROL_DATABASE_URL_FILE=/run/kala-test/control-url',
      '--env', 'KALA_FRESH_CLAIM_RUNTIME_DATABASE_URL_FILE=/run/kala-test/runtime-url',
      '--env', 'KALA_FRESH_CLAIM_STATE_MASTER_KEY_FILE=/run/kala-test/master-key',
      '--env', 'KALA_FRESH_CLAIM_S3_ACCESS_KEY_ID_FILE=/run/kala-test/s3-access',
      '--env', 'KALA_FRESH_CLAIM_S3_SECRET_ACCESS_KEY_FILE=/run/kala-test/s3-secret',
      '--env', `KALA_FRESH_CLAIM_S3_ENDPOINT=http://${silo}:9000`,
      '--env', `KALA_FRESH_CLAIM_S3_BUCKET=${bucket}`,
      '--env', 'KALA_FRESH_CLAIM_S3_REGION=us-east-1',
      nodeImage, 'node', '--import', 'tsx', 'bin/kala-fresh-storage-claim.ts')
  }

  async function bootstrapDedicatedOwner(): Promise<void> {
    if (!testKeyDirectory) throw new Error('test secret directory is unavailable')
    const { stdout } = await docker('run', '--rm', '--network', network,
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--mount', `type=bind,source=${testKeyDirectory},target=/run/kala-test,readonly`,
      '--workdir', '/app/packages/runtime-ingress-gateway',
      '--env', `KALA_DEPLOYMENT_CONFIG=${deploymentPath}`,
      '--env', `KALA_INGRESS_DATABASE_URL=postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${controlDatabase}`,
      '--env', `OIDC_ISSUER=http://${identity}:8080`,
      '--env', 'KALA_DEDICATED_OWNER_OIDC_SUBJECT=parallel-owner',
      '--env', 'KALA_DEDICATED_ORGANIZATION_NAME=Isolated Dedicated parallel acceptance',
      nodeImage, 'node', '--import', '/app/packages/host/node_modules/tsx/dist/loader.mjs', 'src/bin/bootstrap-dedicated-oidc-owner.ts')
    const result = parseLastJson(stdout) as { organizationId: string; runtimeUnitId: string }
    expect(result.organizationId).toMatch(/^org_[A-Za-z0-9_-]+$/u)
    expect(result.runtimeUnitId).toMatch(/^tenant_[A-Za-z0-9_-]+$/u)
    organizationId = result.organizationId
    unitId = result.runtimeUnitId
    const principal = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', controlDatabase, '-A', '-t', '-c',
      "SELECT principal_id FROM dedicated_oidc_owner_bindings WHERE singleton=true")
    principalId = principal.stdout.trim()
    expect(principalId).toMatch(/^prn_[A-Za-z0-9_-]+$/u)
  }

  async function loginDedicatedOwner(): Promise<void> {
    const script = `const origin=process.env.TEST_ORIGIN;
      const login=await fetch(origin+'/auth/login',{redirect:'manual'});
      if(login.status!==302)throw new Error('OIDC authorization redirect failed');
      const authorization=await fetch(login.headers.get('location'),{redirect:'manual'});
      if(authorization.status!==302)throw new Error('OIDC fixture authorization failed');
      const response=await fetch(authorization.headers.get('location'),{redirect:'manual',
        headers:{cookie:login.headers.get('set-cookie').split(';')[0]}});
      const token=response.headers.get('set-cookie')?.match(/ak_session=([^;]+)/u)?.[1];
      if(response.status!==302||!token)throw new Error('Dedicated OIDC Owner login failed: '+response.status);
      console.log(JSON.stringify({token}));`
    const { stdout } = await docker('run', '--rm', '--network', network,
      '--env', `TEST_ORIGIN=http://${gateway}:13001`,
      nodeImage, 'node', '--input-type=module', '--eval', script)
    const result = parseLastJson(stdout) as { token: string }
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    browserToken = result.token
  }

  async function installParallelGateAsOperator(): Promise<void> {
    const sql = `BEGIN;
      INSERT INTO tenant_runtime_unit_placement_leases
        (unit_id, organization_id, node_id, owner_token, origin, generation, expires_at)
      VALUES ('${unitId}', '${organizationId}', '${parallelBarrier}', '${parallelBarrier}', '${parallelBarrierOrigin}', 1, 'infinity');
      INSERT INTO tenant_runtime_unit_protocol_gates
        (organization_id, unit_id, feature_version, barrier_generation)
      VALUES ('${organizationId}', '${unitId}', 1, 1);
      COMMIT;`
    await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql)
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
      `SELECT gate.feature_version, lease.node_id, lease.expires_at='infinity'::timestamptz
       FROM tenant_runtime_unit_protocol_gates AS gate
       JOIN tenant_runtime_unit_placement_leases AS lease USING (organization_id, unit_id)
       WHERE gate.organization_id='${organizationId}' AND gate.unit_id='${unitId}'`)
    expect(stdout.trim()).toBe(`1|${parallelBarrier}|t`)
  }

  async function installGatewayAuthorityAndReader(): Promise<void> {
    const readerRole = 'kala_parallel_gateway_reader'
    const readerPassword = `reader-${randomUUID()}`
    const issuer = `http://${identity}:8080`
    const tokenHash = createHash('sha256').update(browserToken, 'ascii').digest('base64url')
    const executorRouteHash = createHash('sha256').update(executorInvite).digest('base64url')
    const executorInviteRecord = JSON.stringify({
      id: executorInviteId,
      inviteHash: `sha256:${createHash('sha256').update(executorInvite).digest('hex')}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      revoked: false,
      workspaceId,
      label: 'Parallel acceptance Executor',
    })
    const poolId = `pool_${id.replaceAll('-', '_')}`
    const newOrganization = dedicated ? '' : `
      INSERT INTO organizations (id,name,status,runtime_unit_id) VALUES ('${organizationId}','Parallel Gateway acceptance','active','${unitId}');
      INSERT INTO contract_entitlements (organization_id,contract_reference,support_tier,starts_at,ends_at,seat_limit,concurrent_session_limit,workspace_limit)
        VALUES ('${organizationId}','isolated-parallel-acceptance','standard',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day',1,100,100);
      INSERT INTO runtime_unit_placements (runtime_unit_id,organization_id,desired_state,generation,last_operation_id)
        VALUES ('${unitId}','${organizationId}','ready',1,'acceptance-seed');
      INSERT INTO principals (id,kind,issuer,subject,display_name) VALUES ('${principalId}','human','${issuer}','browser-user','Gateway acceptance browser');
      INSERT INTO organization_memberships (organization_id,principal_id,role,status) VALUES ('${organizationId}','${principalId}','owner','active');`
    const sql = `BEGIN;
      ${newOrganization}
      UPDATE runtime_unit_placements SET desired_state='ready',generation=1,last_operation_id='acceptance-seed'
        WHERE runtime_unit_id='${unitId}';
      INSERT INTO executor_pools (id,organization_id,name,mode) VALUES ('${poolId}','${organizationId}','Parallel acceptance pool','organization');
      INSERT INTO executor_enrollment_tokens (id,organization_id,pool_id,token_hash,created_by,expires_at)
        VALUES ('enr_${id}','${organizationId}','${poolId}','${executorRouteHash}','${principalId}',clock_timestamp()+interval '1 hour');
      ${dedicated ? '' : `
      INSERT INTO browser_sessions (id,principal_id,organization_id,token_hash,cache_namespace,device,idle_expires_at,absolute_expires_at)
        VALUES ('bs_${id}','${principalId}','${organizationId}','${tokenHash}','acceptance-cache','{"label":"Browser-like Socket.IO client"}'::jsonb,
          clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day');`}
      COMMIT;`
    await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', controlDatabase, '-v', 'ON_ERROR_STOP=1', '-c', sql)
    const runtimeSql = `BEGIN;
      INSERT INTO executor_identities (organization_id,unit_id,record_kind,record_id,record)
        VALUES ('${organizationId}','${unitId}','invite','${executorInviteId}',$invite$${executorInviteRecord}$invite$::jsonb);
      CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}';
      GRANT USAGE ON SCHEMA public TO ${readerRole};
      GRANT SELECT ON tenant_runtime_unit_placement_leases,tenant_runtime_unit_protocol_gates,
        tenant_runtime_unit_replica_memberships,tenant_runtime_resource_ownerships,tenant_session_latest_projection TO ${readerRole};
      ${dedicated ? `GRANT USAGE ON SCHEMA kala_installation_claim TO ${readerRole},${runtimeDatabaseRole};
      GRANT SELECT ON ALL TABLES IN SCHEMA kala_installation_claim TO ${readerRole},${runtimeDatabaseRole};` : ''}
      COMMIT;`
    await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', runtimeSql)
    gatewayReaderConnection = `postgresql://${readerRole}:${encodeURIComponent(readerPassword)}@${postgres}:5432/${database}`
  }

  async function startIdentityDiscovery(): Promise<void> {
    const issuer = `http://${identity}:8080`
    const discovery = JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      userinfo_endpoint: `${issuer}/userinfo`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    })
    const script = `import http from 'node:http';
      import {generateKeyPairSync,sign,randomUUID,createHash} from 'node:crypto';
      const discovery=${discovery};
      const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
      const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'};
      const codes=new Map();
      const json=(response,status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value))};
      http.createServer(async(request,response)=>{
        const url=new URL(request.url,discovery.issuer);
        if(url.pathname.includes('.well-known/openid-configuration'))return json(response,200,discovery);
        if(url.pathname==='/jwks')return json(response,200,{keys:[jwk]});
        if(url.pathname==='/userinfo')return json(response,200,{sub:'parallel-owner',name:'Parallel Owner'});
        if(url.pathname==='/authorize'){
          const code=randomUUID();codes.set(code,Object.fromEntries(url.searchParams));
          const target=new URL(url.searchParams.get('redirect_uri'));
          target.searchParams.set('code',code);target.searchParams.set('state',url.searchParams.get('state'));
          response.writeHead(302,{location:target.href});return response.end();
        }
        if(url.pathname==='/token'){
          let body='';for await(const chunk of request)body+=chunk;
          const params=new URLSearchParams(body),code=params.get('code'),authorization=codes.get(code);codes.delete(code);
          if(!authorization||createHash('sha256').update(params.get('code_verifier')??'').digest('base64url')!==authorization.code_challenge
            ||params.get('redirect_uri')!==authorization.redirect_uri)return json(response,400,{error:'invalid_grant'});
          const now=Math.floor(Date.now()/1000);
          const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');
          const payload=Buffer.from(JSON.stringify({iss:discovery.issuer,sub:'parallel-owner',aud:'acceptance-client',
            iat:now,exp:now+3600,nonce:authorization.nonce})).toString('base64url');
          const unsigned=header+'.'+payload;
          return json(response,200,{access_token:randomUUID(),token_type:'Bearer',expires_in:3600,
            id_token:unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url')});
        }
        response.writeHead(404);response.end();
      }).listen(8080,'0.0.0.0',()=>console.log('identity_discovery_ready'))`
    await docker('run', '--detach', '--name', identity,
      '--label', `dev.kala.test.project=${project}`, '--network', network, '--read-only',
      nodeImage, 'node', '--input-type=module', '--eval', script)
    await eventually(async () => {
      const logs = await docker('logs', identity)
      if (!logs.stdout.includes('identity_discovery_ready')) throw new Error('identity discovery is not ready')
    }, 10_000)
  }

  async function startFakeOpenAi(): Promise<void> {
    await docker('run', '--detach', '--name', model,
      '--label', `dev.kala.test.project=${project}`, '--network', network, '--read-only',
      nodeImage, 'node', '--input-type=module', '--eval', fakeOpenAiServer)
    await eventually(async () => {
      const logs = await docker('logs', model)
      if (!logs.stdout.includes('fake_openai_ready')) throw new Error('fake OpenAI server is not ready')
    }, 10_000)
  }

  async function startExternalExecutor(): Promise<void> {
    const command = `mkdir -p /workspace/.kala/profiles/acceptance; printf '%s\\n' '${workspaceId}' > /workspace/.kala/workspace-id; printf '%s\\n' '${marker}' > /workspace/marker.txt; exec node --import tsx bin/kala-executor.ts`
    await docker('run', '--detach', '--name', executor,
      '--label', `dev.kala.test.project=${project}`, '--network', network,
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--mount', `type=volume,source=${workspaceVolume},target=/workspace`,
      '--workdir', '/app/packages/executor',
      '--env', `HOST_URL=http://${gateway}:13001`,
      '--env', `EXECUTOR_INVITE=${executorInvite}`,
      '--env', 'SANDBOX_ROOTS=/workspace',
      '--env', 'HOME=/workspace',
      '--env', 'KALA_EXECUTOR_PROFILE=acceptance',
      '--env', 'KALA_NO_UPDATE_CHECK=1',
      '--env', 'KALA_WORKSPACE_ID_FILE=/workspace/.kala/workspace-id',
      nodeImage, '/bin/sh', '-c', command)
    await eventually(async () => {
      const logs = await docker('logs', executor)
      const output = `${logs.stdout}${logs.stderr}`
      const running = (await docker('inspect', '--format', '{{.State.Running}}', executor)).stdout.trim()
      if (running !== 'true') throw new Error(`${executor} stopped:\n${output}`)
      if (!output.includes('executor announced; awaiting tool calls')) throw new Error('Executor fleet has not announced to both Runtime replicas')
    }, 30_000)
  }

  async function startGateway(): Promise<void> {
    await docker('run', '--detach', '--name', gateway,
      '--label', `dev.kala.test.project=${project}`,
      '--network', network,
      '--read-only',
      '--tmpfs', '/state:rw,nosuid,size=16m',
      '--env', 'TMPDIR=/state',
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      ...(dedicated ? ['--mount', `type=bind,source=${testKeyDirectory},target=/run/kala-test,readonly`] : []),
      '--workdir', '/app/packages/runtime-ingress-gateway',
      '--env', `KALA_DEPLOYMENT_CONFIG=${deploymentPath}`,
      ...(dedicated ? ['--env', 'KALA_INGRESS_REQUIRE_INSTALLATION_CLAIM=1', '--env', 'KALA_INSTALLATION_ID_FILE=/run/kala-test/installation-id'] : []),
      '--env', 'KALA_INGRESS_PORT=13001',
      '--env', 'KALA_INGRESS_LISTEN_HOST=0.0.0.0',
      '--env', `KALA_PUBLIC_URLS=http://${gateway}:13001`,
      '--env', `KALA_INGRESS_SESSION_SECRET=${sessionSecret}`,
      '--env', `KALA_INGRESS_SHARED_SECRET=${ingressSecret}`,
      '--env', `KALA_INGRESS_DATABASE_URL=postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${controlDatabase}`,
      '--env', 'KALA_INGRESS_LOGIN_STATE_STORE=/state/login.json',
      '--env', `OIDC_ISSUER=http://${identity}:8080`,
      '--env', 'OIDC_CLIENT_ID=acceptance-client',
      '--env', 'OIDC_CLIENT_SECRET=acceptance-secret',
      '--env', `KALA_INGRESS_IDENTITY_ORIGIN=http://${identity}:8080`,
      '--env', 'KALA_INGRESS_ALLOW_INSECURE_HTTP=1',
      '--env', `KALA_RUNTIME_HOST_ORIGIN=http://${runtimeA}:13002`,
      '--env', 'KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE=1',
      '--env', `KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING=${gatewayReaderConnection}`,
      '--env', `KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST=http://${runtimeA}:13002,http://${runtimeB}:13002`,
      '--env', `KALA_INGRESS_RUNTIME_ROUTING_TICKET_KEY=${routingTicketKey}`,
      '--env', 'KALA_INGRESS_RUNTIME_ROUTING_TICKET_AUDIENCE=parallel-gateway-acceptance',
      '--env', 'KALA_INGRESS_RUNTIME_ROUTING_TICKET_MAX_TTL_MS=60000',
      '--env', 'KALA_INGRESS_RETENTION_ENABLED=0',
      nodeImage, 'node', '--import', '/app/packages/host/node_modules/tsx/dist/loader.mjs', 'src/bin/kala-runtime-ingress.ts')
    await eventually(async () => {
      const logs = await docker('logs', gateway)
      if (logs.stdout.includes(`${acceptanceProduct}_gateway_ready`)) return
      const running = (await docker('inspect', '--format', '{{.State.Running}}', gateway)).stdout.trim()
      if (running !== 'true') throw new Error(`${gateway} stopped:\n${logs.stdout}\n${logs.stderr}`)
      throw new Error('Gateway is not ready yet')
    }, 35_000)
  }

  async function assertRuntimeCannotWriteGate(): Promise<void> {
    const connection = `postgresql://${runtimeDatabaseRole}:${encodeURIComponent(runtimeDatabasePassword)}@${postgres}:5432/${database}`
    let rejected = false
    try {
      await docker('exec', postgres, 'psql', connection, '-v', 'ON_ERROR_STOP=1', '-c',
        `INSERT INTO tenant_runtime_unit_protocol_gates (organization_id, unit_id, feature_version, barrier_generation) VALUES ('forbidden', 'forbidden', 1, 1)`)
    } catch (error) {
      rejected = /permission denied for table tenant_runtime_unit_protocol_gates/u.test(errorMessage(error))
    }
    expect(rejected).toBe(true)
  }

  async function startRuntime(name: string): Promise<void> {
    if (!testKeyPath) throw new Error('isolated test state master key was not created')
    const connectionString = `postgresql://${runtimeDatabaseRole}:${encodeURIComponent(runtimeDatabasePassword)}@${postgres}:5432/${database}`
    await docker('run', '--detach', '--name', name,
      '--label', `dev.kala.test.project=${project}`,
      '--network', network,
      '--read-only',
      '--tmpfs', '/state:rw,noexec,nosuid,nodev,size=128m',
      '--env', 'TMPDIR=/state',
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--mount', `type=bind,source=${testKeyPath},target=/run/kala-test-state-master-key,readonly`,
      ...(dedicated ? ['--mount', `type=bind,source=${testKeyDirectory}/installation-id,target=/run/kala-test-installation-id,readonly`] : []),
      '--workdir', '/app/packages/host',
      '--env', `KALA_DEPLOYMENT_CONFIG=${deploymentPath}`,
      ...(dedicated ? ['--env', 'KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM=1', '--env', 'KALA_INSTALLATION_ID_FILE=/run/kala-test-installation-id'] : []),
      '--env', 'KALA_RUNTIME_HOST_DATA_ROOT=/state',
      '--env', 'KALA_RUNTIME_KALA_BIND_HOST=0.0.0.0',
      '--env', `KALA_INGRESS_SHARED_SECRET=${ingressSecret}`,
      '--env', 'KALA_RUNTIME_HOST_LLM_API_KEY=isolated-test-placeholder',
      '--env', 'KALA_RUNTIME_HOST_LLM_MODEL=test-only-model',
      '--env', `KALA_RUNTIME_HOST_LLM_BASE_URL=http://${model}:8081/v1`,
      '--env', `KALA_RUNTIME_NODE_ID=node-${name}`,
      '--env', `KALA_RUNTIME_NODE_ORIGIN=http://${name}:13002`,
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE=1',
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_PLACEMENT_TTL_MS=5000',
      '--env', 'KALA_RUNTIME_POSTGRES_SCHEMA_MODE=versioned',
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP=1',
      '--env', `KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING=${connectionString}`,
      '--env', `KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT=http://${silo}:9000`,
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_S3_REGION=us-east-1',
      '--env', `KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET=${bucket}`,
      '--env', `KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID=${accessKeyId}`,
      '--env', `KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY=${secretAccessKey}`,
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_S3_MAX_OBJECT_BYTES=1048576',
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_S3_FORCE_PATH_STYLE=true',
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE=/run/kala-test-state-master-key',
      nodeImage, 'node', '--import', 'tsx', 'bin/kala-runtime-service.ts')
    await eventually(async () => {
      const logs = await docker('logs', name)
      if (logs.stdout.includes('tenant_runtime_service_ready')) return
      const running = (await docker('inspect', '--format', '{{.State.Running}}', name)).stdout.trim()
      if (running !== 'true') throw new Error(`${name} stopped:\n${logs.stdout}\n${logs.stderr}`)
      throw new Error(`${name} is not ready yet`)
    }, 35_000)
    expect((await internalFetch(name, '/internal/health')).status).toBe(200)
  }

  async function provision(name: string, operation: string): Promise<void> {
    const result = await internalFetch(name, '/internal/runtime-units', {
      unitId,
      organizationId,
      operationId: dedicated ? `host-materialize:${unitId}:1:ready` : `${operation}-${id}`,
      generation: 1,
      action: 'provision',
    })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body).toMatchObject({ ok: true, unitId, action: 'provision' })
  }

  async function sessionOwners(): Promise<Array<{ sessionId: string; generation: number; origin: string }>> {
    const sql = `SELECT ownership.resource_id, ownership.generation, member.origin
      FROM tenant_runtime_resource_ownerships AS ownership
      JOIN tenant_runtime_unit_replica_memberships AS member USING (organization_id, unit_id, replica_id)
      WHERE ownership.organization_id='${organizationId}' AND ownership.unit_id='${unitId}'
        AND ownership.resource_type='session'
      ORDER BY ownership.resource_id`
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c', sql)
    return stdout.trim() ? stdout.trim().split('\n').map((line) => {
      const [sessionId = '', generation = '', origin = ''] = line.split('|')
      return { sessionId, generation: Number(generation), origin }
    }) : []
  }

  async function sessionOwner(sessionId: string): Promise<{ sessionId: string; generation: number; origin: string } | undefined> {
    return (await sessionOwners()).find((owner) => owner.sessionId === sessionId)
  }

  async function liveReplicaOrigins(): Promise<string[]> {
    const sql = `SELECT origin FROM tenant_runtime_unit_replica_memberships
      WHERE organization_id='${organizationId}' AND unit_id='${unitId}' AND expires_at>clock_timestamp()
      ORDER BY origin`
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c', sql)
    return stdout.trim() ? stdout.trim().split('\n') : []
  }

  async function executionReceipts(): Promise<ExecutionReceipts> {
    try {
      const { stdout } = await docker('exec', executor, 'cat', '/workspace/.kala/execution-receipts.json')
      return JSON.parse(stdout) as ExecutionReceipts
    } catch {
      return {}
    }
  }

  async function boardChildren(): Promise<Array<{ sessionId: string; parentSessionId: string; parentCallId: string }>> {
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
      `SELECT session_id,document->>'parentSessionId',document->>'parentCallId'
       FROM tenant_session_latest_projection WHERE tenant_id='${organizationId}'
         AND document->>'parentSessionId'='${sessionBoard}' ORDER BY session_id`)
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [sessionId = '', parentSessionId = '', parentCallId = ''] = line.split('|')
      return { sessionId, parentSessionId, parentCallId }
    })
  }

  async function boardCommands(childSessionId: string): Promise<Array<{
    commandId: string; kind: string; status: string; dispatchedAt: string | null;
    outcome: { ok: boolean; content: string } | null
  }>> {
    if (!/^[\w-]+$/u.test(childSessionId)) throw new Error('Invalid test child ID')
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
      `SELECT json_build_object('commandId',command_id,'kind',kind,'status',status,
        'dispatchedAt',dispatched_at,'outcome',outcome)::text
       FROM tenant_session_child_commands WHERE tenant_id='${organizationId}'
         AND child_session_id='${childSessionId}' ORDER BY ordinal`)
    return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  async function boardSummary(childSessionId: string): Promise<Record<string, unknown>> {
    return await runBrowserJourney('board-list', childSessionId) as Record<string, unknown>
  }

  async function releaseBoardModel(target: 'marker' | 'takeover' = 'marker'): Promise<void> {
    if (!await dockerResourceExists('container', model)) return
    await docker('exec', model, 'node', '--input-type=module', '--eval',
      `await fetch('http://127.0.0.1:8081/board/release?target=${target}',{method:'POST'})`)
  }

  async function sessionProjections(): Promise<Map<string, string>> {
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-F', '|', '-c',
      `SELECT session_id,document::text FROM tenant_session_latest_projection WHERE tenant_id='${organizationId}' AND session_id IN ('${sessionX}','${sessionY}') ORDER BY session_id`)
    return new Map(stdout.trim().split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf('|')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
  }

  async function messageQueueEvidence(): Promise<string> {
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
      `SELECT session_id||'|'||items::text||'|'||COALESCE(claim_owner,'')||'|'||claim_generation::text FROM tenant_session_message_queue WHERE tenant_id='${organizationId}' ORDER BY session_id`)
    return stdout.trim()
  }

  async function runtimeIdentity(name: string): Promise<{ name: string; containerId: string; pid: number }> {
    const { stdout } = await docker('inspect', '--format', '{{.Id}}|{{.State.Pid}}', name)
    const [containerId = '', pid = '0'] = stdout.trim().split('|')
    return { name, containerId, pid: Number(pid) }
  }

  async function internalFetch(name: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const script = `const response = await fetch('http://127.0.0.1:13002${path}', {${body === undefined ? '' : "method:'POST',body:process.env.TEST_BODY,"}headers:{'x-agent-runlab-ingress-secret':process.env.TEST_SECRET,'content-type':'application/json'}}); console.log(JSON.stringify({status:response.status,body:await response.json()}))`
    const args = ['exec', '--env', `TEST_SECRET=${ingressSecret}`]
    if (body !== undefined) args.push('--env', `TEST_BODY=${JSON.stringify(body)}`)
    args.push(name, 'node', '--input-type=module', '--eval', script)
    return parseLastJson((await docker(...args)).stdout) as { status: number; body: Record<string, unknown> }
  }

  async function runStaleWrite(name: string, sessionId: string): Promise<unknown> {
    const args = ['exec',
      '--env', `TEST_SESSION_ID=${sessionId}`,
      '--env', `TEST_UNIT_ID=${unitId}`,
      '--env', `TEST_ORGANIZATION_ID=${organizationId}`,
      '--env', `TEST_INGRESS_SECRET=${ingressSecret}`,
      name, 'node', '--input-type=module', '--eval', staleOwnerWriteJourney]
    return parseLastJson((await docker(...args)).stdout)
  }

  async function measureWriteWorkload(label: string, replicas: number): Promise<void> {
    expect(await liveReplicaOrigins()).toHaveLength(replicas)
    const snapshot = async (): Promise<{ lsn: string; projectionBytes: number; auditBytes: number; auditEvents: number }> => {
      const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
        `SELECT json_build_object('lsn',pg_current_wal_insert_lsn()::text,
          'projectionBytes',(SELECT COALESCE(sum(octet_length(document::text)),0) FROM tenant_session_latest_projection WHERE tenant_id='${organizationId}'),
          'auditBytes',(SELECT COALESCE(sum(pg_column_size(payload)),0) FROM tenant_runtime_hot_events WHERE tenant_id='${organizationId}'),
          'auditEvents',(SELECT count(*) FROM tenant_runtime_hot_events WHERE tenant_id='${organizationId}'))`)
      return JSON.parse(stdout.trim())
    }
    const before = await snapshot()
    const lockSamples: number[] = []
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")
        lockSamples.push(Number(stdout.trim()))
        if (sampling) await new Promise((resolve) => setTimeout(resolve, 50))
      }
    })()
    let metrics: { writes: number; elapsedMs: number; writesPerSecond: number; p50Ms: number; p95Ms: number }
    try {
      metrics = await runBrowserJourney('benchmark') as typeof metrics
    } finally {
      sampling = false
      await sampler
    }
    const after = await snapshot()
    expect(metrics.writes).toBe(80)
    expect(metrics.writesPerSecond).toBeGreaterThan(0)
    expect(metrics.p95Ms).toBeGreaterThanOrEqual(metrics.p50Ms)
    expect(after.auditEvents - before.auditEvents).toBe(80)
    expect(before.lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/u)
    const wal = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c',
      `SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'${before.lsn}'::pg_lsn)::text`)
    console.info(`[parallel-write-workload] ${JSON.stringify({
      product: acceptanceProduct, label, replicas, ...metrics,
      projectionBytes: after.projectionBytes,
      auditBytesAdded: after.auditBytes - before.auditBytes,
      clusterWalBytesDuringWindow: Number(wal.stdout.trim()),
      lockSamples: lockSamples.length,
      samplesWithLockWaiters: lockSamples.filter((count) => count > 0).length,
      peakSampledLockWaiters: Math.max(...lockSamples),
      caveat: 'Bounded Session preference writes; cluster WAL includes leases/control activity; sampled lock waiters, not cumulative lock time or model-token throughput',
    })}`)
  }

  async function objectRequestCounts(): Promise<{ put: number; get: number }> {
    const { stdout } = await docker('exec', silo, 'mcli', 'admin', 'prometheus', 'metrics', 'self')
    const counts = { put: 0, get: 0 }
    const rows = [...stdout.matchAll(/^(?:minio_s3_requests_total|minio_api_requests_total)\{([^}]+)\}\s+(\d+(?:\.\d+)?)$/gmu)]
    if (rows.length === 0) throw new Error('SILO metrics did not expose a recognized S3 request counter')
    for (const [, labels = '', value = '0'] of rows) {
      const api = /\bapi="([^"]+)"/u.exec(labels)?.[1]?.toLowerCase()
      if (api === 'putobject') counts.put += Number(value)
      if (api === 'getobject') counts.get += Number(value)
    }
    return counts
  }

  async function runBrowserJourney(action: 'initial' | 'tools' | 'history' | 'recover' | 'recover-y' | 'exports' | 'verify-exports' | 'benchmark' | 'grow-history'
    | 'board-create' | 'board-start' | 'board-follow' | 'board-list' | 'board-finished' | 'board-stop' | 'board-start-takeover',
  childSessionId?: string, parentCallId?: string): Promise<unknown> {
    const client = `${project}-browser-${action}`
    const args = ['run', '--rm', '--name', client,
      '--label', `dev.kala.test.project=${project}`,
      '--network', network,
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--workdir', '/app/packages/host',
      '--env', `TEST_GATEWAY_ORIGIN=http://${gateway}:13001`,
      '--env', `TEST_BROWSER_TOKEN=${browserToken}`,
      '--env', `TEST_SESSION_X=${sessionX}`,
      '--env', `TEST_SESSION_Y=${sessionY}`,
      '--env', `TEST_SESSION_BOARD=${sessionBoard}`,
      '--env', `TEST_MODEL_CONTAINER=${model}`,
      ...(childSessionId ? ['--env', `TEST_CHILD_ID=${childSessionId}`] : []),
      ...(parentCallId ? ['--env', `TEST_PARENT_CALL_ID=${parentCallId}`] : []),
      '--env', `TEST_WORKSPACE_ID=${workspaceId}`,
      '--env', `TEST_ACTION=${action}`,
      '--env', `TEST_ARTIFACT_PROOFS=${JSON.stringify(exportedArtifacts)}`,
      nodeImage, 'node', '--input-type=module', '--eval', gatewayBrowserJourney]
    return parseLastJson((await docker(...args)).stdout)
  }

  async function assertPrivateNetwork(expectedRunning: readonly string[]): Promise<void> {
    const inspected = JSON.parse((await docker('network', 'inspect', network)).stdout) as Array<{
      Internal: boolean
      Labels: Record<string, string>
      Containers: Record<string, { Name: string }>
    }>
    const details = inspected[0]
    expect(details?.Internal).toBe(true)
    expect(details?.Labels['dev.kala.test.project']).toBe(project)
    expect(Object.values(details?.Containers ?? {}).map(({ Name }) => Name).sort()).toEqual([...expectedRunning].sort())
    for (const name of expectedRunning) expect((await docker('port', name)).stdout.trim()).toBe('')
  }

  async function dumpLogs(reason: string): Promise<void> {
    const queueEvidence = await messageQueueEvidence().catch(() => '')
    if (queueEvidence) console.error(`[private-cloud-parallel-v1.integration] ${reason}: message queues\n${queueEvidence}`)
    for (const name of containers) {
      const logs = await docker('logs', name).catch(() => undefined)
      if (logs) console.error(`[private-cloud-parallel-v1.integration] ${reason}: ${name}\n${logs.stdout}${logs.stderr}`)
    }
  }
})

type InitialGatewayResult = {
  x: { sessionId: string; routed: boolean; preferenceWritten: boolean }
  y: { sessionId: string; routed: boolean; preferenceWritten: boolean }
}
type RecoveryGatewayResult = { sessionId: string; prepared: boolean; routed: boolean; preferenceWritten: boolean }
type ToolGatewayResult = {
  x: { sessionId: string; accepted: boolean }
  y: { sessionId: string; accepted: boolean }
}
type HistoryGatewayResult = {
  x: { sessionId: string; toolResultFound: boolean }
  y: { sessionId: string; toolResultFound: boolean }
}
type ExecutionReceipts = Record<string, { completedAt: number; result: { callId: string; ok: boolean; content: string } }>
type ArtifactProof = { uri: string; sha256: string; bytes: number }

function assertCompletedReceipt(receipts: ExecutionReceipts, sessionId: string, callId: string, marker: string): void {
  const receipt = receipts[`${sessionId}:${callId}`]
  expect(receipt).toMatchObject({ ownerGeneration: '1' })
  expect(receipt?.result).toMatchObject({ callId, ok: true })
  expect(receipt?.result.content).toContain(marker)
}

const fakeOpenAiServer = String.raw`
import http from 'node:http'
const held = { marker: [], takeover: [] }
const released = { marker: false, takeover: false }
const stream = (response, chunks) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' })
  for (const chunk of chunks) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
  response.end('data: [DONE]\n\n')
}
const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url?.startsWith('/board/release?target=')) {
    const target = new URL(request.url, 'http://localhost').searchParams.get('target')
    if (target !== 'marker' && target !== 'takeover') { response.writeHead(400); response.end(); return }
    released[target] = true
    for (const pending of held[target].splice(0)) pending()
    response.writeHead(204); response.end(); return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404); response.end(); return
  }
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    let body
    try { body = JSON.parse(raw) } catch { response.writeHead(400); response.end(); return }
    const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name) : []
    console.log('fake_openai_request ' + JSON.stringify({ stream: body.stream, tools, roles: Array.isArray(body.messages) ? body.messages.map((message) => message?.role) : [] }))
    if (body.stream !== true || !tools.some((tool) => ['read_file', 'agent', 'write_agent'].includes(tool))) {
      response.writeHead(422, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'streaming read_file tool required' }))
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastUser = messages.findLastIndex((message) => message?.role === 'user')
    const hasToolResult = messages.slice(lastUser + 1).some((message) => message?.role === 'tool')
    const transcript = JSON.stringify(messages)
    const userText = JSON.stringify(messages[lastUser]?.content ?? '')
    const boardParentStart = userText.includes('BOARD-START')
    const boardParentFollow = userText.includes('BOARD-FOLLOW:')
    const boardInitial = userText.includes('board child marker')
    const boardTakeover = userText.includes('board child takeover')
    const boardFollow = userText.includes('next-turn marker')
    if (boardParentStart || boardParentFollow || boardInitial || boardTakeover || boardFollow) {
      const requestId = 'board_' + messages.filter((message) => message?.role === 'user').length
      let next
      if (hasToolResult) next = [
        { id: requestId, choices: [{ index: 0, delta: { content: 'board turn done' }, finish_reason: 'stop' }] },
      ]
      else {
        const name = boardParentStart ? 'agent' : boardParentFollow ? 'write_agent' : 'read_file'
        const childId = userText.match(/BOARD-FOLLOW:([A-Za-z0-9_-]+)/)?.[1]
        const args = name === 'agent'
          ? { prompt: boardTakeover || userText.includes('TAKEOVER') ? 'board child takeover' : 'board child marker',
              mode: 'background', role: 'research', max_turns: 10, timeout_ms: 120000 }
          : name === 'write_agent'
            ? { agent_id: childId, message: 'next-turn marker', mode: 'background' }
            : { path: '/workspace/marker.txt' }
        next = [{ id: requestId, choices: [{ index: 0, delta: { role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_' + requestId, type: 'function',
            function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]
      }
      next.push({ id: requestId, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })
      const send = () => stream(response, next)
      const gate = boardInitial ? 'marker' : boardTakeover ? 'takeover' : null
      if (hasToolResult && gate && !released[gate]) held[gate].push(send)
      else send()
      return
    }
    const suffix = transcript.includes('marker read X') ? 'x' : transcript.includes('marker read Y') ? 'y' : 'unknown'
    const userCount = messages.filter((message) => message?.role === 'user').length
    const callId = 'call_' + suffix + (userCount > 1 ? '_' + userCount : '')
    const chunks = hasToolResult
      ? [
          { id: 'done_' + suffix, choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] },
          { id: 'done_' + suffix, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
        ]
      : [
          { id: 'tool_' + suffix, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/marker.txt"}' } }] }, finish_reason: 'tool_calls' }] },
          { id: 'tool_' + suffix, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        ]
    stream(response, chunks)
  })
})
server.listen(8081, '0.0.0.0', () => console.log('fake_openai_ready'))
`

const staleOwnerWriteJourney = String.raw`
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
const sessionId = process.env.TEST_SESSION_ID
const socket = io('http://127.0.0.1:13002/dashboard', {
  transports: ['websocket'], reconnection: false, timeout: 4000,
  extraHeaders: {
    'x-agent-runlab-ingress-secret': process.env.TEST_INGRESS_SECRET,
    'x-agent-runlab-runtime-unit': process.env.TEST_UNIT_ID,
    'x-agent-runlab-principal': 'member@example.test',
    'x-agent-runlab-organization-id': process.env.TEST_ORGANIZATION_ID,
    'x-agent-runlab-organization-role': 'member',
  },
  auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
})
const result = await Promise.race([
  new Promise((resolve) => socket.once('connect_error', () => resolve('rejected'))),
  new Promise((resolve) => socket.once('connect', async () => {
    try {
      const ack = await socket.timeout(4000).emitWithAck('client:update_preferences', {
        sessionId, operationId: 'partition-stale-write', preferences: { chapterReadingMode: 'continuous' },
      })
      resolve(ack?.ok === true ? 'accepted' : 'rejected')
    } catch { resolve('timeout') }
  })),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
])
socket.close()
console.log(JSON.stringify({ outcome: result }))
`

// Real Chrome page: exercise same-origin Cookie, ticket, WebSocket, and PG
// history without treating a Node Socket.IO client as a browser engine.
const chromiumBrowserJourney = String.raw`
import puppeteer from 'puppeteer-core'
const deadline = setTimeout(() => { console.error('Chromium journey exceeded its 45-second bound'); process.exit(1) }, 45000)
const origin = process.env.TEST_GATEWAY_ORIGIN
const browser = await puppeteer.launch({
  executablePath: process.env.HOME + '/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  console.log('Chromium launched')
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(10000)
  await page.setCookie({ url: origin, name: 'ak_session', value: process.env.TEST_BROWSER_TOKEN, httpOnly: true, sameSite: 'Lax' })
  await page.goto(origin + '/signed-out', { waitUntil: 'domcontentloaded' })
  console.log('Chromium same-origin page loaded')
  await page.addScriptTag({ path: '/app/node_modules/socket.io-client/dist/socket.io.min.js' })
  const results = {}
  for (const [label, callId] of [['x', 'call_x'], ['y', 'call_y']]) {
    const sessionId = process.env['TEST_SESSION_' + label.toUpperCase()]
    results[label] = await page.evaluate(async ({ origin, sessionId, callId, clientVersion }) => {
      const response = await fetch(origin + '/runtime/route-ticket', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(10000),
      })
      const { ticket } = await response.json()
      if (!response.ok || typeof ticket !== 'string') throw new Error('Chromium ticket request failed: ' + response.status)
      return await new Promise((resolve, reject) => {
        const socket = window.io(origin + '/dashboard', {
          auth: { sessionId, role: 'dashboard', clientVersion },
          query: { runtimeRouteTicket: ticket }, transports: ['websocket'], reconnection: false, timeout: 5000,
        })
        const timer = setTimeout(() => { socket.close(); reject(new Error('Chromium history timed out')) }, 8000)
        socket.once('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error) })
        socket.once('session:ready', () => socket.emit('client:load_history', { sessionId }))
        socket.once('server:history', (history) => {
          clearTimeout(timer); socket.close()
          resolve({ sessionId, toolResultFound: history.entries?.some((entry) => entry.event?.kind === 'tool_result' && entry.event.callId === callId && entry.event.ok) === true })
        })
      })
    }, { origin, sessionId, callId, clientVersion: process.env.TEST_PROTOCOL_VERSION })
  }
  console.log(JSON.stringify({ browser: await browser.version(), ...results }))
} finally {
  await browser.close()
  clearTimeout(deadline)
}
`

// Separate Node Socket.IO driver for fault drills; not a browser engine.
const gatewayBrowserJourney = String.raw`
import { io } from 'socket.io-client'
import { createHash } from 'node:crypto'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
const origin = process.env.TEST_GATEWAY_ORIGIN
const cookie = 'ak_session=' + process.env.TEST_BROWSER_TOKEN
const browserHeaders = { Cookie: cookie, Origin: origin }
const timeout = (message, ms = 10000) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms)
  timer.unref()
})

async function openControl(label) {
  const socket = io(origin + '/dashboard', {
    auth: { clientId: 'browser-control-' + label, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
    extraHeaders: browserHeaders, forceNew: true, reconnection: false, transports: ['websocket'], timeout: 5000,
  })
  await Promise.race([
    new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) }),
    timeout('Gateway control socket timeout'),
  ])
  return socket
}

async function createThroughFreshControl(sessionId, label) {
  const socket = await openControl('create-' + label)
  try {
    const result = await socket.timeout(10000).emitWithAck('client:create_session', {
      sessionId, operationId: 'gateway-create-' + label,
      agentRuntime: 'kernel',
      workspaceId: process.env.TEST_WORKSPACE_ID, workspaceName: 'Parallel acceptance workspace', cwd: '/workspace',
    })
    if (!result?.ok) throw new Error('Gateway Session creation failed: ' + JSON.stringify(result))
  } finally {
    socket.close()
  }
}

async function requestTicket(sessionId) {
  const response = await fetch(origin + '/runtime/route-ticket', {
    method: 'POST', headers: { ...browserHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || typeof body.ticket !== 'string') throw new Error('Route ticket failed: ' + response.status + ' ' + JSON.stringify(body))
  return body.ticket
}

async function openOwnerTicket(sessionId) {
  const ticket = await requestTicket(sessionId)
  const socket = io(origin + '/dashboard', {
    auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
    query: { runtimeRouteTicket: ticket }, extraHeaders: browserHeaders,
    forceNew: true, reconnection: false, transports: ['websocket'], timeout: 5000,
  })
  const ready = await Promise.race([
    new Promise((resolve, reject) => { socket.once('session:ready', resolve); socket.once('connect_error', reject) }),
    timeout('Owner-routed Session socket timeout', 8000),
  ])
  if (ready?.sessionId !== sessionId) { socket.close(); throw new Error('Owner-routed socket returned the wrong Session') }
  return socket
}

async function writeThroughOwnerTicket(sessionId, label) {
  const socket = await openOwnerTicket(sessionId)
  try {
    const preference = await socket.timeout(10000).emitWithAck('client:update_preferences', {
      sessionId, operationId: 'gateway-preference-' + label,
      preferences: { chapterReadingMode: label === 'y' ? 'chapters' : 'continuous' },
    })
    if (!preference?.ok) throw new Error('Owner-routed preference failed: ' + JSON.stringify(preference))
    return { sessionId, routed: true, preferenceWritten: true }
  } finally {
    socket.close()
  }
}

async function messageThroughOwnerTicket(sessionId, label) {
  const socket = await openOwnerTicket(sessionId)
  try {
    const result = await socket.timeout(20000).emitWithAck('client:user_message', {
      sessionId, operationId: 'gateway-tool-' + label, intent: 'text', mode: 'steer',
      text: 'Perform marker read ' + label.toUpperCase(),
    })
    if (!result?.ok) throw new Error('Owner-routed user message failed: ' + JSON.stringify(result))
    return { sessionId, accepted: true }
  } finally {
    socket.close()
  }
}

async function historyThroughOwnerTicket(sessionId, callId) {
  const socket = await openOwnerTicket(sessionId)
  try {
    const history = await Promise.race([
      new Promise((resolve) => { socket.once('server:history', resolve); socket.emit('client:load_history', { sessionId }) }),
      timeout('Owner-routed PostgreSQL history timeout', 8000),
    ])
    if (history.sessionId !== sessionId || !Array.isArray(history.entries)) throw new Error('Invalid Session history payload')
    return { sessionId, toolResultFound: history.entries.some((entry) => entry.event?.kind === 'tool_result' && entry.event.callId === callId && entry.event.ok) }
  } finally {
    socket.close()
  }
}

async function boardMessage(text, operation) {
  const sessionId = process.env.TEST_SESSION_BOARD
  const socket = await openOwnerTicket(sessionId)
  try {
    const result = await socket.timeout(20000).emitWithAck('client:user_message', {
      sessionId, operationId: operation + '-' + crypto.randomUUID(), intent: 'text', mode: 'queue', text,
    })
    if (!result?.ok) throw new Error('Board user message rejected: ' + JSON.stringify(result))
    return { accepted: true }
  } finally { socket.close() }
}

async function boardList(childSessionId) {
  const parentSessionId = process.env.TEST_SESSION_BOARD
  const socket = await openOwnerTicket(parentSessionId)
  try {
    const result = await socket.timeout(10000).emitWithAck('sub_agent:list', {
      requestId: crypto.randomUUID(), parentSessionId,
    })
    if (result?.error) throw new Error('Board list failed: ' + result.error)
    const child = result?.children?.find((item) => item.childSessionId === childSessionId)
    if (!child) throw new Error('Board child not visible: ' + childSessionId)
    return child
  } finally { socket.close() }
}

async function boardStop() {
  const socket = await openOwnerTicket(process.env.TEST_SESSION_BOARD)
  try {
    socket.emit('client:interrupt_sub_agent', {
      operationId: 'gateway-stop-' + crypto.randomUUID(),
      parentSessionId: process.env.TEST_SESSION_BOARD,
      parentCallId: process.env.TEST_PARENT_CALL_ID,
      childSessionId: process.env.TEST_CHILD_ID,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { accepted: true }
  } finally { socket.close() }
}

async function waitForBoardFinished() {
  const socket = await openOwnerTicket(process.env.TEST_SESSION_BOARD)
  try {
    const finished = new Promise((resolve) => {
      socket.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_finished' && payload.childSessionId === process.env.TEST_CHILD_ID) resolve(payload)
      })
    })
    const release = await fetch('http://' + process.env.TEST_MODEL_CONTAINER + ':8081/board/release?target=marker',
      { method: 'POST' })
    if (!release.ok) throw new Error('Board model gate did not release: ' + release.status)
    return await Promise.race([finished, timeout('Cross-replica completion notification missing', 30000)])
  } finally { socket.close() }
}

if (process.env.TEST_ACTION === 'initial') {
  const sessionX = process.env.TEST_SESSION_X
  const sessionY = process.env.TEST_SESSION_Y
  await createThroughFreshControl(sessionX, 'x')
  const x = await writeThroughOwnerTicket(sessionX, 'x')
  await createThroughFreshControl(sessionY, 'y')
  const y = await writeThroughOwnerTicket(sessionY, 'y')
  console.log(JSON.stringify({ x, y }))
} else if (process.env.TEST_ACTION === 'tools') {
  const [x, y] = await Promise.all([
    messageThroughOwnerTicket(process.env.TEST_SESSION_X, 'x'),
    messageThroughOwnerTicket(process.env.TEST_SESSION_Y, 'y'),
  ])
  console.log(JSON.stringify({ x, y }))
} else if (process.env.TEST_ACTION === 'history') {
  const [x, y] = await Promise.all([
    historyThroughOwnerTicket(process.env.TEST_SESSION_X, 'call_x'),
    historyThroughOwnerTicket(process.env.TEST_SESSION_Y, 'call_y'),
  ])
  console.log(JSON.stringify({ x, y }))
} else if (process.env.TEST_ACTION === 'board-create') {
  await createThroughFreshControl(process.env.TEST_SESSION_BOARD, 'board')
  console.log(JSON.stringify({ accepted: true }))
} else if (process.env.TEST_ACTION === 'board-start' || process.env.TEST_ACTION === 'board-start-takeover') {
  console.log(JSON.stringify(await boardMessage(
    process.env.TEST_ACTION === 'board-start' ? 'BOARD-START' : 'BOARD-START-TAKEOVER', 'gateway-board-start')))
} else if (process.env.TEST_ACTION === 'board-follow') {
  console.log(JSON.stringify(await boardMessage('BOARD-FOLLOW:' + process.env.TEST_CHILD_ID, 'gateway-board-follow')))
} else if (process.env.TEST_ACTION === 'board-list') {
  console.log(JSON.stringify(await boardList(process.env.TEST_CHILD_ID)))
} else if (process.env.TEST_ACTION === 'board-finished') {
  console.log(JSON.stringify(await waitForBoardFinished()))
} else if (process.env.TEST_ACTION === 'board-stop') {
  console.log(JSON.stringify(await boardStop()))
} else if (process.env.TEST_ACTION === 'benchmark') {
  const sockets = await Promise.all([openOwnerTicket(process.env.TEST_SESSION_X), openOwnerTicket(process.env.TEST_SESSION_Y)])
  const latencies = []
  const batch = crypto.randomUUID()
  const started = performance.now()
  try {
    await Promise.all(sockets.map(async (socket, sessionIndex) => {
      for (let index = 0; index < 40; index++) {
        const start = performance.now()
        const ack = await socket.timeout(10000).emitWithAck('client:update_preferences', {
          sessionId: process.env[sessionIndex === 0 ? 'TEST_SESSION_X' : 'TEST_SESSION_Y'],
          operationId: 'benchmark-' + batch + '-' + sessionIndex + '-' + index,
          preferences: { chapterReadingMode: index % 2 === 0 ? 'chapters' : 'continuous' },
        })
        if (!ack?.ok) throw new Error('Benchmark write was not committed: ' + JSON.stringify(ack))
        latencies.push(performance.now() - start)
      }
    }))
    const elapsedMs = performance.now() - started
    latencies.sort((a, b) => a - b)
    console.log(JSON.stringify({ writes: latencies.length, elapsedMs, writesPerSecond: latencies.length * 1000 / elapsedMs,
      p50Ms: latencies[Math.ceil(latencies.length * 0.50) - 1], p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1] }))
  } finally { for (const socket of sockets) socket.close() }
} else if (process.env.TEST_ACTION === 'grow-history') {
  for (const [label, sessionId] of [['x', process.env.TEST_SESSION_X], ['y', process.env.TEST_SESSION_Y]]) {
    const socket = await openOwnerTicket(sessionId)
    try {
      for (let index = 0; index < 8; index++) {
        const ack = await socket.timeout(10000).emitWithAck('client:user_message', {
          sessionId, operationId: 'extended-history-' + label + '-' + index, intent: 'text', mode: 'queue',
          text: 'Perform marker read ' + label.toUpperCase() + '\n' + 'bounded synthetic context '.repeat(330),
        })
        if (!ack?.ok) throw new Error('Extended history message was not admitted')
        const callId = 'call_' + label + '_' + (index + 2)
        const deadline = Date.now() + 10000
        let completed = false
        while (Date.now() < deadline) {
          const history = await Promise.race([
            new Promise((resolve) => { socket.once('server:history', resolve); socket.emit('client:load_history', { sessionId }) }),
            timeout('Extended history read timeout'),
          ])
          const tool = history.entries.find((entry) => entry.event?.kind === 'tool_result' && entry.event.callId === callId && entry.event.ok)
          completed = tool && history.entries.some((entry) => entry.seq > tool.seq && entry.event?.kind === 'llm_response'
            && entry.event.message?.content?.some((part) => part.type === 'text' && part.text === 'done'))
          if (completed) break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        if (!completed) throw new Error('Extended history tool turn did not complete: ' + callId)
      }
    } finally { socket.close() }
  }
  console.log(JSON.stringify({ turns: 16 }))
} else if (process.env.TEST_ACTION === 'exports') {
  const proofs = []
  for (const sessionId of [process.env.TEST_SESSION_X, process.env.TEST_SESSION_Y]) {
    for (const action of ['trace-export-session', 'profile-session', 'rollout-export-segments']) {
      const response = await fetch(origin + '/enhancement/action', {
        method: 'POST', headers: { ...browserHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ action, sessionId }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error('Durable export failed: ' + response.status + ' ' + JSON.stringify(result))
      for (const artifact of [result.artifact ?? result.traceArtifact, ...(result.llmArtifacts ?? [])]) {
        if (!artifact?.uri?.startsWith('/session-artifacts/')) throw new Error('Export did not return an authoritative object reference')
        proofs.push({ uri: artifact.uri, sha256: artifact.sha256, bytes: artifact.bytes })
      }
    }
  }
  console.log(JSON.stringify(proofs))
} else if (process.env.TEST_ACTION === 'verify-exports') {
  const proofs = JSON.parse(process.env.TEST_ARTIFACT_PROOFS)
  for (const proof of proofs) {
    const response = await fetch(origin + proof.uri, { headers: browserHeaders })
    const data = Buffer.from(await response.arrayBuffer())
    if (!response.ok || response.headers.get('content-type') !== 'application/json'
      || data.byteLength !== proof.bytes || createHash('sha256').update(data).digest('hex') !== proof.sha256) {
      throw new Error('Authoritative export failed integrity verification after takeover: ' + response.status)
    }
    JSON.parse(data.toString('utf8'))
  }
  console.log(JSON.stringify({ verified: proofs.length }))
} else {
  const sessionId = process.env.TEST_ACTION === 'recover-y' ? process.env.TEST_SESSION_Y : process.env.TEST_SESSION_X
  const deadline = Date.now() + 45000
  let lastError
  while (Date.now() < deadline) {
    let control
    try {
      control = await openControl('takeover')
      const prepared = await control.timeout(5000).emitWithAck('client:prepare_session_route', { sessionId })
      if (!prepared?.ok) throw new Error('Owner preparation failed: ' + JSON.stringify(prepared))
      control.close()
      control = undefined
      const routed = await writeThroughOwnerTicket(sessionId, 'recovered')
      console.log(JSON.stringify({ sessionId, prepared: true, routed: routed.routed, preferenceWritten: routed.preferenceWritten }))
      process.exit(0)
    } catch (error) {
      lastError = error
      control?.close()
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError ?? new Error('Gateway takeover timed out')
}
`

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}

async function dockerResourceExists(kind: 'container' | 'network' | 'volume', name: string): Promise<boolean> {
  try {
    await docker(kind, 'inspect', name)
    return true
  } catch {
    return false
  }
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await operation()
      return
    } catch (error) {
      if (error instanceof Error && error.message.includes(' stopped:')) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError
}

function parseLastJson(output: string): unknown {
  const line = output.trim().split('\n').at(-1)
  if (!line) throw new Error('Docker journey produced no output')
  return JSON.parse(line)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
