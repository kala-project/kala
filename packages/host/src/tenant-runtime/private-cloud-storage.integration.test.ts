import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_PRIVATE_CLOUD_STORAGE_INTEGRATION === '1' ? describe : describe.skip
const nodeImage = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
const siloImage = 'pgsty/silo@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7'
const postgresImage = 'postgres:16-alpine'

integrationDescribe('current Private Cloud Runtime with PostgreSQL and Silo', () => {
  const id = randomUUID()
  const project = `kala-pc-storage-${id}`
  const network = `${project}-net`
  const postgres = `${project}-postgres`
  const silo = `${project}-silo`
  const runtimeA = `${project}-runtime-a`
  const runtimeB = `${project}-runtime-b`
  const containers = [runtimeA, runtimeB, silo, postgres]
  const repository = resolve(import.meta.dirname, '../../../..')
  const ingressSecret = `ingress-${randomUUID()}-${randomUUID()}`
  const postgresPassword = `pg-${randomUUID()}`
  const versionedSchema = process.env.KALA_TEST_PRIVATE_CLOUD_VERSIONED_SCHEMA === '1'
  const sessionOwnership = process.env.KALA_TEST_PRIVATE_CLOUD_SESSION_OWNERSHIP === '1'
  const forceKill = process.env.KALA_TEST_PRIVATE_CLOUD_FORCE_KILL === '1'
  const networkPartition = process.env.KALA_TEST_PRIVATE_CLOUD_NETWORK_PARTITION === '1'
  const abruptTakeover = forceKill || networkPartition
  const runtimeDatabasePassword = `role-${randomUUID()}`
  const runtimeDatabaseRole = 'kala_runtime_test'
  const accessKeyId = `access-${randomUUID()}`
  const secretAccessKey = `secret-${randomUUID()}-${randomUUID()}`
  const database = 'kala_private_cloud_test'
  const bucket = 'kala-private-cloud-test'
  const unitId = `unit-${id}`
  const organizationId = `org_${id}`
  const sessionId = `session-${id}`
  let setupStarted = false
  let testKeyDirectory: string | undefined
  let testKeyPath: string | undefined

  beforeAll(async () => {
    if (forceKill && networkPartition) throw new Error('select only one isolated failure mode')
    if (sessionOwnership && !versionedSchema) throw new Error('Session owner acceptance requires versioned PostgreSQL schema')
    try {
      await docker('info', '--format', '{{.ServerVersion}}')
    } catch (error) {
      throw new Error(`sudo -n docker is required for the isolated Private Cloud storage integration test; no existing container was contacted: ${errorMessage(error)}`)
    }

    setupStarted = true
    try {
      testKeyDirectory = await mkdtemp(join(tmpdir(), 'kala-private-cloud-state-key-'))
      testKeyPath = join(testKeyDirectory, 'master-key')
      await writeFile(testKeyPath, randomBytes(32), { flag: 'wx', mode: 0o600 })
      await chmod(testKeyPath, 0o600)
      const keyFile = await stat(testKeyPath)
      expect(keyFile.size).toBe(32)
      expect(keyFile.mode & 0o777).toBe(0o600)

      await docker('network', 'create', '--internal', '--label', `dev.kala.test.project=${project}`, network)
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
        await docker('exec', postgres, 'pg_isready', '-U', 'postgres', '-d', database)
      }, 30_000)
      await eventually(async () => {
        await docker('exec', silo, 'mcli', 'alias', 'set', 'self', 'http://127.0.0.1:9000', accessKeyId, secretAccessKey)
      }, 30_000)
      await docker('exec', silo, 'mcli', 'mb', `self/${bucket}`)
      if (versionedSchema) {
        await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c',
          `CREATE ROLE ${runtimeDatabaseRole} LOGIN PASSWORD '${runtimeDatabasePassword}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`)
        await docker('run', '--rm', '--network', network,
          '--mount', `type=bind,source=${repository},target=/app,readonly`,
          '--workdir', '/app/packages/host',
          '--env', `KALA_POSTGRES_MIGRATION_CONNECTION_STRING=postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${database}`,
          nodeImage, 'node', '--import', 'tsx', 'bin/kala-postgres-migrate.ts', '--runtime-role', runtimeDatabaseRole)
      }
      await startRuntime(runtimeA)
      await assertPrivateNetwork([postgres, silo, runtimeA])
    } catch (error) {
      await dumpLogs('setup failure')
      throw error
    }
  }, 150_000)

  afterAll(async () => {
    if (!setupStarted) return
    const failures: string[] = []
    for (const name of containers) {
      await docker('rm', '--force', name).catch((error) => failures.push(`container ${name}: ${errorMessage(error)}`))
    }
    await docker('network', 'rm', network).catch((error) => failures.push(`network ${network}: ${errorMessage(error)}`))
    for (const name of containers) {
      if (await dockerResourceExists('container', name)) failures.push(`container still exists: ${name}`)
    }
    if (await dockerResourceExists('network', network)) failures.push(`network still exists: ${network}`)
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
    if (failures.length > 0) throw new Error(`isolated Docker cleanup failed:\n${failures.join('\n')}`)
    console.info(`[private-cloud-storage.integration] removed UUID resources for ${project}`)
  }, 45_000)

  it('creates on Runtime A, rejects the retired endpoint, and recovers the Session and S3 attachment on Runtime B', async () => {
    try {
      await provision(runtimeA, 'provision-a')
      const written = await runJourney(runtimeA, writerJourney, {
        TEST_RUNTIME_ORIGIN: `http://${runtimeA}:13002`,
        TEST_INGRESS_SECRET: ingressSecret,
        TEST_UNIT_ID: unitId,
        TEST_ORGANIZATION_ID: organizationId,
        TEST_SESSION_ID: sessionId,
      }) as { attachmentId: string }
      expect(written.attachmentId).toMatch(/\S/u)
      expect(await liveReplicaOrigins()).toEqual([`http://${runtimeA}:13002`])
      const initialOwner = sessionOwnership ? await sessionOwner() : undefined
      if (sessionOwnership) expect(initialOwner).toMatchObject({ generation: 1, origin: `http://${runtimeA}:13002` })
      if (networkPartition) {
        // Survive the five-second test TTL before isolating the live writer.
        await new Promise((resolve) => setTimeout(resolve, 6_000))
        expect(await liveReplicaOrigins()).toEqual([`http://${runtimeA}:13002`])
      }

      // Graceful retirement releases placement. SIGKILL or Docker network
      // isolation leaves A's old token behind; B must wait for database TTL
      // and acquire a newer generation before becoming routable.
      if (networkPartition) {
        await docker('network', 'disconnect', network, runtimeA)
        expect((await docker('inspect', '--format', '{{.State.Running}}', runtimeA)).stdout.trim()).toBe('true')
      } else {
        await (forceKill ? docker('kill', runtimeA) : docker('stop', '--time', '10', runtimeA))
        expect((await docker('inspect', '--format', '{{.State.Running}}', runtimeA)).stdout.trim()).toBe('false')
      }

      await startRuntime(runtimeB)
      await assertPrivateNetwork([postgres, silo, runtimeB])
      if (abruptTakeover) {
        await eventually(async () => await provision(runtimeB, 'provision-after-crash', 2), 25_000)
      }
      type RecoveredJourney = {
        attachmentBytes: number
        retiredRejected: boolean
        sessionRecovered: boolean
        takeoverWrite: boolean
        memoRecovered: boolean
        webSearchRecovered: boolean
        speechRecovered: boolean
      }
      let recovered: RecoveredJourney | undefined
      await eventually(async () => {
        recovered = await runJourney(runtimeB, readerJourney, {
          TEST_RUNTIME_ORIGIN: `http://${runtimeB}:13002`,
          TEST_RETIRED_ORIGIN: `http://${runtimeA}:13002`,
          TEST_INGRESS_SECRET: ingressSecret,
          TEST_UNIT_ID: unitId,
          TEST_ORGANIZATION_ID: organizationId,
          TEST_SESSION_ID: sessionId,
          TEST_ATTACHMENT_ID: written.attachmentId,
        }) as RecoveredJourney
      }, abruptTakeover ? 35_000 : 10_000)

      if (networkPartition) {
        // A is still alive, but B has fenced its PG placement. Reconnect the
        // isolated process and prove its old socket cannot commit another write.
        await docker('network', 'connect', network, runtimeA)
        await assertPrivateNetwork([postgres, silo, runtimeA, runtimeB])
        expect((await docker('inspect', '--format', '{{.State.Running}}', runtimeA)).stdout.trim()).toBe('true')
        const health = await docker('exec', '--env', `TEST_SECRET=${ingressSecret}`, runtimeB, 'node', '--input-type=module', '--eval',
          `const result = await fetch('http://${runtimeA}:13002/internal/health', { headers: { 'x-agent-runlab-ingress-secret': process.env.TEST_SECRET }, signal: AbortSignal.timeout(3000) }); console.log(result.status)`)
        expect(health.stdout.trim()).toBe('200')
        const stale = await runJourney(runtimeB, staleWriteJourney, {
          TEST_RUNTIME_ORIGIN: `http://${runtimeA}:13002`,
          TEST_INGRESS_SECRET: ingressSecret,
          TEST_UNIT_ID: unitId,
          TEST_ORGANIZATION_ID: organizationId,
          TEST_SESSION_ID: sessionId,
        }) as { rejected: boolean }
        expect(stale.rejected).toBe(true)
      }
      expect(await liveReplicaOrigins()).toEqual([`http://${runtimeB}:13002`])
      if (sessionOwnership) expect(await sessionOwner()).toMatchObject({
        generation: 2, origin: `http://${runtimeB}:13002`,
      })
      expect(recovered).toEqual({
        attachmentBytes: 68,
        retiredRejected: true,
        sessionRecovered: true,
        takeoverWrite: true,
        memoRecovered: true,
        webSearchRecovered: true,
        speechRecovered: true,
      })
    } catch (error) {
      await dumpLogs('journey failure')
      throw error
    }
  }, 150_000)

  async function startRuntime(name: string): Promise<void> {
    if (!testKeyPath) throw new Error('isolated test state master key was not created')
    const connectionString = versionedSchema
      ? `postgresql://${runtimeDatabaseRole}:${encodeURIComponent(runtimeDatabasePassword)}@${postgres}:5432/${database}`
      : `postgresql://postgres:${encodeURIComponent(postgresPassword)}@${postgres}:5432/${database}`
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
      '--env', `KALA_RUNTIME_HOST_LLM_BASE_URL=http://${name}:9/v1`,
      '--env', `KALA_RUNTIME_NODE_ID=node-${name}`,
      '--env', `KALA_RUNTIME_NODE_ORIGIN=http://${name}:13002`,
      '--env', 'KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE=1',
      ...(abruptTakeover ? ['--env', 'KALA_RUNTIME_EXPERIMENTAL_PLACEMENT_TTL_MS=5000'] : []),
      ...(versionedSchema ? ['--env', 'KALA_RUNTIME_POSTGRES_SCHEMA_MODE=versioned'] : []),
      ...(sessionOwnership ? ['--env', 'KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP=1'] : []),
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
    const health = await internalFetch(name, '/internal/health')
    expect(health.status).toBe(200)
  }

  async function sessionOwner(): Promise<{ generation: number; origin: string } | undefined> {
    const sql = `SELECT ownership.generation, member.origin FROM tenant_runtime_resource_ownerships AS ownership JOIN tenant_runtime_unit_replica_memberships AS member USING (organization_id, unit_id, replica_id) WHERE ownership.organization_id = '${organizationId}' AND ownership.unit_id = '${unitId}' AND ownership.resource_type = 'session' AND ownership.resource_id = '${sessionId}'`
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c', sql)
    const result = stdout.trim()
    if (!result) return undefined
    const [generation, origin] = result.split('|')
    return { generation: Number(generation), origin: origin ?? '' }
  }

  async function liveReplicaOrigins(): Promise<string[]> {
    const sql = `SELECT origin FROM tenant_runtime_unit_replica_memberships WHERE organization_id = '${organizationId}' AND unit_id = '${unitId}' AND expires_at > clock_timestamp() ORDER BY origin`
    const { stdout } = await docker('exec', postgres, 'psql', '-U', 'postgres', '-d', database, '-A', '-t', '-c', sql)
    return stdout.trim() ? stdout.trim().split('\n') : []
  }

  async function provision(name: string, operation: string, generation = 1): Promise<void> {
    const result = await internalFetch(name, '/internal/runtime-units', {
      unitId,
      organizationId,
      operationId: `${operation}-${id}`,
      generation,
      action: 'provision',
    })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body).toMatchObject({ ok: true, unitId, action: 'provision' })
  }

  async function internalFetch(name: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const script = `const response = await fetch('http://127.0.0.1:13002${path}', {${body === undefined ? '' : "method:'POST',body:process.env.TEST_BODY,"}headers:{'x-agent-runlab-ingress-secret':process.env.TEST_SECRET,'content-type':'application/json'}}); console.log(JSON.stringify({status:response.status,body:await response.json()}))`
    const args = ['exec', '--env', `TEST_SECRET=${ingressSecret}`]
    if (body !== undefined) args.push('--env', `TEST_BODY=${JSON.stringify(body)}`)
    args.push(name, 'node', '--input-type=module', '--eval', script)
    const output = await docker(...args)
    return parseLastJson(output.stdout) as { status: number; body: Record<string, unknown> }
  }

  async function runJourney(name: string, script: string, environment: Record<string, string>): Promise<unknown> {
    const args = ['exec']
    for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`)
    args.push(name, 'node', '--input-type=module', '--eval', script)
    const output = await docker(...args)
    return parseLastJson(output.stdout)
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
    for (const name of expectedRunning) {
      expect((await docker('port', name)).stdout.trim()).toBe('')
      const labels = (await docker('inspect', '--format', '{{json .Config.Labels}}', name)).stdout
      expect(labels).toContain(`\"dev.kala.test.project\":\"${project}\"`)
    }
  }

  async function dumpLogs(reason: string): Promise<void> {
    for (const name of containers) {
      const logs = await docker('logs', name).catch(() => undefined)
      if (logs) console.error(`[private-cloud-storage.integration] ${reason}: ${name}\n${logs.stdout}${logs.stderr}`)
    }
  }
})

const writerJourney = String.raw`
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
const origin = process.env.TEST_RUNTIME_ORIGIN
const sessionId = process.env.TEST_SESSION_ID
const headers = {
  'x-agent-runlab-ingress-secret': process.env.TEST_INGRESS_SECRET,
  'x-agent-runlab-runtime-unit': process.env.TEST_UNIT_ID,
  'x-agent-runlab-principal': 'member@example.test',
  'x-agent-runlab-organization-id': process.env.TEST_ORGANIZATION_ID,
  'x-agent-runlab-organization-role': 'member',
}
const socket = io(origin + '/dashboard', {
  transports: ['websocket'], extraHeaders: headers,
  auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
})
const ready = new Promise((resolve, reject) => { socket.once('session:ready', resolve); socket.once('connect_error', (error) => reject(new Error(error.message))) })
await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime A socket readiness timeout')), 10000))])
const created = await socket.timeout(10000).emitWithAck('client:create_session', { sessionId, operationId: 'create-on-a' })
if (!created.ok) throw new Error('Session creation failed: ' + created.error)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII=', 'base64')
const uploaded = await fetch(origin + '/runtime/attachments?sessionId=' + encodeURIComponent(sessionId), {
  method: 'POST', headers: { ...headers, 'content-type': 'image/png', 'x-agent-runlab-attachment-name': encodeURIComponent('handoff.png') }, body: png,
})
if (uploaded.status !== 201) throw new Error('Attachment upload failed: ' + uploaded.status + ' ' + await uploaded.text())
const payload = await uploaded.json()
const managementHeaders = { ...headers, 'content-type': 'application/json', 'x-agent-runlab-organization-role': 'admin' }
async function putJson(path, body) {
  const response = await fetch(origin + path, { method: 'PUT', headers: managementHeaders, body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(path + ' write failed: ' + response.status + ' ' + text)
  return JSON.parse(text)
}
await putJson('/memo', { content: 'memo-persisted-on-runtime-a', expectedRevision: 0 })
await putJson('/settings/web-search', { provider: 'serper', apiKey: 'e2e-serper-secret-value' })
await putJson('/settings/speech', {
  endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
  apiKey: 'e2e-azure-speech-secret-value',
  enabled: true,
  mode: 'after_recording',
  realtimeMaxMinutes: 7,
  afterRecordingMaxMinutes: 30,
})
socket.close()
console.log(JSON.stringify({ attachmentId: payload.file.source.attachmentId }))
`

const readerJourney = String.raw`
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
const origin = process.env.TEST_RUNTIME_ORIGIN
const sessionId = process.env.TEST_SESSION_ID
const headers = {
  'x-agent-runlab-ingress-secret': process.env.TEST_INGRESS_SECRET,
  'x-agent-runlab-runtime-unit': process.env.TEST_UNIT_ID,
  'x-agent-runlab-principal': 'member@example.test',
  'x-agent-runlab-organization-id': process.env.TEST_ORGANIZATION_ID,
  'x-agent-runlab-organization-role': 'member',
}
const socket = io(origin + '/dashboard', {
  transports: ['websocket'], extraHeaders: headers,
  auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
})
const ready = new Promise((resolve, reject) => { socket.once('session:ready', resolve); socket.once('connect_error', (error) => reject(new Error(error.message))) })
const recovered = await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime B recovery timeout')), 10000))])
const preference = await socket.timeout(10000).emitWithAck('client:update_preferences', {
  sessionId, operationId: 'write-after-takeover', preferences: { chapterReadingMode: 'continuous' },
})
const image = await fetch(origin + '/runtime/attachments/' + encodeURIComponent(process.env.TEST_ATTACHMENT_ID) + '?sessionId=' + encodeURIComponent(sessionId), { headers })
if (image.status !== 200) throw new Error('Cross-instance S3 read failed: ' + image.status + ' ' + await image.text())
const bytes = Buffer.from(await image.arrayBuffer())
const managementHeaders = { ...headers, 'x-agent-runlab-organization-role': 'admin' }
async function getJson(path) {
  const response = await fetch(origin + path, { headers: managementHeaders })
  const text = await response.text()
  if (!response.ok) throw new Error(path + ' read failed: ' + response.status + ' ' + text)
  return JSON.parse(text)
}
const memo = await getJson('/memo')
const webSearch = await getJson('/settings/web-search')
const speech = await getJson('/settings/speech')
let retiredRejected = false
try {
  await fetch(process.env.TEST_RETIRED_ORIGIN + '/internal/health', {
    headers: { 'x-agent-runlab-ingress-secret': process.env.TEST_INGRESS_SECRET }, signal: AbortSignal.timeout(1500),
  })
} catch { retiredRejected = true }
socket.close()
console.log(JSON.stringify({
  attachmentBytes: bytes.length,
  retiredRejected,
  sessionRecovered: recovered.sessionId === sessionId,
  takeoverWrite: preference.ok === true,
  memoRecovered: memo.content === 'memo-persisted-on-runtime-a' && memo.revision === 1,
  webSearchRecovered: webSearch.configured === true && webSearch.provider === 'serper',
  speechRecovered: speech.configured === true && speech.region === 'japaneast' && speech.enabled === true
    && speech.mode === 'after_recording' && speech.realtimeMaxMinutes === 7 && speech.afterRecordingMaxMinutes === 30,
}))
`

const staleWriteJourney = String.raw`
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
const sessionId = process.env.TEST_SESSION_ID
const socket = io(process.env.TEST_RUNTIME_ORIGIN + '/dashboard', {
  transports: ['websocket'], reconnection: false, timeout: 3000,
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
      const ack = await socket.timeout(3000).emitWithAck('client:update_preferences', {
        sessionId, operationId: 'stale-write-after-network-restore', preferences: { chapterReadingMode: 'continuous' },
      })
      resolve(ack.ok === true ? 'accepted' : 'rejected')
    } catch { resolve('timeout') }
  })),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
])
socket.close()
console.log(JSON.stringify({ rejected: result === 'rejected', outcome: result }))
`

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}

async function dockerResourceExists(kind: 'container' | 'network', name: string): Promise<boolean> {
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
