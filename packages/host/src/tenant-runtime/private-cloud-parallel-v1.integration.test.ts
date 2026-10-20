import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_PRIVATE_CLOUD_STORAGE_INTEGRATION === '1' ? describe : describe.skip
const nodeImage = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
const browserImage = 'ghcr.io/puppeteer/puppeteer@sha256:9665f5b57abc5cc7080a641878964018de219055a4d2c9d8d050ceb1161778ba'
const siloImage = 'pgsty/silo@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7'
const postgresImage = 'postgres:16-alpine'
const parallelBarrier = 'kala-parallel-placement-barrier-v1'
const parallelBarrierOrigin = 'https://parallel-placement-barrier.invalid'

integrationDescribe('Private Cloud parallel-v1 real two-Runtime acceptance', () => {
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
  const bucket = 'kala-parallel-acceptance'
  const unitId = `unit-${id}`
  const organizationId = `org_${id}`
  const principalId = `prn_${id}`
  const sessionX = `session-x-${id}`
  const sessionY = `session-y-${id}`
  const workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const marker = `parallel-executor-marker-${id}`
  const executorInvite = `ak_invite_${randomBytes(24).toString('base64url')}`
  const executorInviteId = `inv_${randomBytes(12).toString('base64url')}`
  const browserToken = randomBytes(32).toString('base64url')
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

  beforeAll(async () => {
    try {
      await docker('info', '--format', '{{.ServerVersion}}')
    } catch (error) {
      throw new Error(`sudo -n docker is required for the isolated parallel-v1 acceptance; no existing container was contacted: ${errorMessage(error)}`)
    }

    setupStarted = true
    try {
      testKeyDirectory = await mkdtemp(join(tmpdir(), 'kala-parallel-v1-state-key-'))
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
        '--env', `KALA_INGRESS_DATABASE_URL=postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${database}`,
        nodeImage, 'node', '--import', '/app/packages/host/node_modules/tsx/dist/loader.mjs', 'src/bin/migrate-control-plane.ts')

      await installParallelGateAsOperator()
      await installGatewayAuthorityAndReader()
      await assertRuntimeCannotWriteGate()
      await startFakeOpenAi()
      await Promise.all([startRuntime(runtimeA), startRuntime(runtimeB)])
      await startIdentityDiscovery()
      await startGateway()
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
    for (const name of containers) {
      await docker('rm', '--force', name).catch((error) => failures.push(`container ${name}: ${errorMessage(error)}`))
    }
    await docker('volume', 'rm', '--force', workspaceVolume).catch((error) => failures.push(`volume ${workspaceVolume}: ${errorMessage(error)}`))
    await docker('network', 'rm', network).catch((error) => failures.push(`network ${network}: ${errorMessage(error)}`))
    for (const name of containers) {
      if (await dockerResourceExists('container', name)) failures.push(`container still exists: ${name}`)
    }
    if (await dockerResourceExists('network', network)) failures.push(`network still exists: ${network}`)
    if (await dockerResourceExists('volume', workspaceVolume)) failures.push(`volume still exists: ${workspaceVolume}`)
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
    } catch (error) {
      await dumpLogs('Executor tool acceptance failure')
      throw error
    }
  }, 120_000)

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
    } catch (error) {
      await dumpLogs('acceptance failure')
      throw error
    }
  }, 150_000)

  it('fences the isolated owner after PostgreSQL network loss, takeover and restored connectivity', async () => {
    if (!killedOwnerName || !survivingOwnerName) throw new Error('SIGKILL prerequisite did not complete')
    try {
      // Restart the killed replica with its ephemeral local state gone; the
      // logical Unit is reconstructed from the same versioned PG/S3 state.
      await docker('start', killedOwnerName)
      await eventually(async () => {
        expect((await internalFetch(killedOwnerName!, '/internal/health')).status).toBe(200)
      }, 20_000)
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
    } catch (error) {
      await dumpLogs('network partition acceptance failure')
      throw error
    }
  }, 180_000)

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
    const sql = `BEGIN;
      INSERT INTO organizations (id,name,status,runtime_unit_id) VALUES ('${organizationId}','Parallel Gateway acceptance','active','${unitId}');
      INSERT INTO runtime_unit_placements (runtime_unit_id,organization_id,desired_state,generation,last_operation_id)
        VALUES ('${unitId}','${organizationId}','ready',1,'acceptance-seed');
      INSERT INTO principals (id,kind,issuer,subject,display_name) VALUES ('${principalId}','human','${issuer}','browser-user','Gateway acceptance browser');
      INSERT INTO organization_memberships (organization_id,principal_id,role,status) VALUES ('${organizationId}','${principalId}','owner','active');
      INSERT INTO executor_pools (id,organization_id,name,mode) VALUES ('${poolId}','${organizationId}','Parallel acceptance pool','organization');
      INSERT INTO executor_enrollment_tokens (id,organization_id,pool_id,token_hash,created_by,expires_at)
        VALUES ('enr_${id}','${organizationId}','${poolId}','${executorRouteHash}','${principalId}',clock_timestamp()+interval '1 hour');
      INSERT INTO executor_identities (organization_id,unit_id,record_kind,record_id,record)
        VALUES ('${organizationId}','${unitId}','invite','${executorInviteId}',$invite$${executorInviteRecord}$invite$::jsonb);
      INSERT INTO browser_sessions (id,principal_id,organization_id,token_hash,cache_namespace,device,idle_expires_at,absolute_expires_at)
        VALUES ('bs_${id}','${principalId}','${organizationId}','${tokenHash}','acceptance-cache','{"label":"Browser-like Socket.IO client"}'::jsonb,
          clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day');
      CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}';
      GRANT USAGE ON SCHEMA public TO ${readerRole};
      GRANT SELECT ON tenant_runtime_unit_placement_leases,tenant_runtime_unit_protocol_gates,
        tenant_runtime_unit_replica_memberships,tenant_runtime_resource_ownerships,tenant_session_latest_projection TO ${readerRole};
      COMMIT;`
    await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql)
    gatewayReaderConnection = `postgresql://${readerRole}:${encodeURIComponent(readerPassword)}@${postgres}:5432/${database}`
  }

  async function startIdentityDiscovery(): Promise<void> {
    const issuer = `http://${identity}:8080`
    const discovery = JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    })
    const script = `import http from 'node:http';const body=${JSON.stringify(discovery)};http.createServer((request,response)=>{if(request.url?.includes('.well-known/openid-configuration')){response.writeHead(200,{'content-type':'application/json'});response.end(body);return}response.writeHead(404);response.end()}).listen(8080,'0.0.0.0',()=>console.log('identity_discovery_ready'))`
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
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--workdir', '/app/packages/runtime-ingress-gateway',
      '--env', 'KALA_INGRESS_PORT=13001',
      '--env', 'KALA_INGRESS_LISTEN_HOST=0.0.0.0',
      '--env', `KALA_PUBLIC_URLS=http://${gateway}:13001`,
      '--env', `KALA_INGRESS_SESSION_SECRET=${sessionSecret}`,
      '--env', `KALA_INGRESS_SHARED_SECRET=${ingressSecret}`,
      '--env', `KALA_INGRESS_DATABASE_URL=postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${database}`,
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
      if (logs.stdout.includes('private_cloud_gateway_ready')) return
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
      '--tmpfs', '/state:rw,nosuid,size=128m',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `type=bind,source=${repository},target=/app,readonly`,
      '--mount', `type=bind,source=${testKeyPath},target=/run/kala-test-state-master-key,readonly`,
      '--workdir', '/app/packages/host',
      '--env', 'KALA_DEPLOYMENT_CONFIG=/app/deploy/private-cloud/deployment.json',
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
      operationId: `${operation}-${id}`,
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

  async function runBrowserJourney(action: 'initial' | 'tools' | 'history' | 'recover' | 'recover-y'): Promise<unknown> {
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
      '--env', `TEST_WORKSPACE_ID=${workspaceId}`,
      '--env', `TEST_ACTION=${action}`,
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

function assertCompletedReceipt(receipts: ExecutionReceipts, sessionId: string, callId: string, marker: string): void {
  const receipt = receipts[`${sessionId}:${callId}`]
  expect(receipt?.result).toMatchObject({ callId, ok: true })
  expect(receipt?.result.content).toContain(marker)
}

const fakeOpenAiServer = String.raw`
import http from 'node:http'
const server = http.createServer((request, response) => {
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
    if (body.stream !== true || !tools.includes('read_file')) {
      response.writeHead(422, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'streaming read_file tool required' }))
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const hasToolResult = messages.some((message) => message?.role === 'tool')
    const transcript = JSON.stringify(messages)
    const suffix = transcript.includes('marker read X') ? 'x' : transcript.includes('marker read Y') ? 'y' : 'unknown'
    const chunks = hasToolResult
      ? [
          { id: 'done_' + suffix, choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] },
          { id: 'done_' + suffix, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
        ]
      : [
          { id: 'tool_' + suffix, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + suffix, type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/marker.txt"}' } }] }, finish_reason: 'tool_calls' }] },
          { id: 'tool_' + suffix, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        ]
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' })
    for (const chunk of chunks) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
    response.end('data: [DONE]\n\n')
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
const origin = process.env.TEST_GATEWAY_ORIGIN
const browser = await puppeteer.launch({
  executablePath: process.env.HOME + '/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const page = await browser.newPage()
  await page.setCookie({ url: origin, name: 'ak_session', value: process.env.TEST_BROWSER_TOKEN, httpOnly: true, sameSite: 'Lax' })
  await page.goto(origin + '/signed-out', { waitUntil: 'domcontentloaded' })
  await page.addScriptTag({ path: '/app/node_modules/socket.io-client/dist/socket.io.min.js' })
  const results = {}
  for (const [label, callId] of [['x', 'call_x'], ['y', 'call_y']]) {
    const sessionId = process.env['TEST_SESSION_' + label.toUpperCase()]
    results[label] = await page.evaluate(async ({ origin, sessionId, callId, clientVersion }) => {
      const response = await fetch(origin + '/runtime/route-ticket', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
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
}
`

// Separate Node Socket.IO driver for fault drills; not a browser engine.
const gatewayBrowserJourney = String.raw`
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
const origin = process.env.TEST_GATEWAY_ORIGIN
const cookie = 'ak_session=' + process.env.TEST_BROWSER_TOKEN
const browserHeaders = { Cookie: cookie, Origin: origin }
const timeout = (message, ms = 10000) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))

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
