import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { PostgresExecutorIdentityStore } from './postgres-executor-identity.js'
import { initializePrivateCloudExperimentalStorageSchema } from './postgres-private-cloud-storage.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgreSQL Executor identity authority integration', () => {
  const project = `kala-executor-identity-${randomUUID()}`
  const container = `${project}-postgres`
  const clients: PostgresHotStateStore[] = []
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', container,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_executor_identity_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    const databaseUrl = new URL(`postgresql://127.0.0.1:${port}/kala_executor_identity_test`)
    databaseUrl.username = 'postgres'
    databaseUrl.password = 'kala_test_only'
    connectionString = databaseUrl.toString()
    await eventually(async () => {
      const database = client()
      await initializePrivateCloudExperimentalStorageSchema(database.database)
    }, 30_000)
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(clients.map(async (database) => await database.close()))
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  function client(): PostgresHotStateStore {
    const database = createPostgresHotStateStore({ connectionString, applicationName: `${project}-${randomUUID()}` })
    clients.push(database)
    return database
  }

  it('shares provision, resolve, rotate, revoke, invite and pairing state across independent clients without plaintext secrets', async () => {
    const writerDatabase = client()
    const readerDatabase = client()
    const writer = new PostgresExecutorIdentityStore(writerDatabase.database, 'org-a', 'unit-a')
    const reader = new PostgresExecutorIdentityStore(readerDatabase.database, 'org-a', 'unit-a')
    await Promise.all([writer.load(), reader.load()])

    const firstToken = await writer.provisionWorkspace('ws-a', 'Laptop', 'install-a')
    expect(await reader.resolveToken(firstToken)).toMatchObject({ workspaceId: 'ws-a', label: 'Laptop', installId: 'install-a' })
    expect(await resolveInChildProcess(connectionString, firstToken, 'org-a', 'unit-a')).toMatchObject({ workspaceId: 'ws-a', installId: 'install-a' })
    const rotatedToken = await reader.rotateWorkspaceCredential('ws-a')
    expect(await writer.resolveToken(firstToken)).toBeUndefined()
    expect(await writer.resolveToken(rotatedToken)).toMatchObject({ workspaceId: 'ws-a', credentialVersion: 2 })

    const invite = await writer.createInvite({ label: 'Phone' })
    expect((await reader.inviteSnapshot()).map((entry) => entry.id)).toContain(invite.id)
    expect(await reader.consumeInvite(invite.inviteToken, 'ws-phone')).toMatchObject({ ok: true })
    expect(await writer.consumeInvite(invite.inviteToken, 'ws-other')).toEqual({ ok: false, reason: 'invalid_invite' })

    const pairing = await writer.createPairing({ workspaceId: 'ws-paired', label: 'Desktop' })
    expect((await reader.decidePairing(pairing.id, true))?.status).toBe('approved')
    const claimed = await writer.claimPairing(pairing.id, pairing.claimSecret)
    expect(claimed?.status).toBe('claimed')
    expect(await reader.resolveToken(claimed?.token)).toMatchObject({ workspaceId: 'ws-paired' })

    expect(await reader.revokeWorkspace('ws-a')).toBe(true)
    expect(await writer.resolveToken(rotatedToken)).toBeUndefined()
    expect(await new PostgresExecutorIdentityStore(readerDatabase.database, 'org-a', 'unit-b').resolveToken(claimed?.token)).toBeUndefined()
    expect(await new PostgresExecutorIdentityStore(readerDatabase.database, 'org-b', 'unit-a').resolveToken(claimed?.token)).toBeUndefined()

    const rows = await writerDatabase.database.query<{ record: unknown }>('SELECT record FROM executor_identities WHERE organization_id = $1 AND unit_id = $2', ['org-a', 'unit-a'])
    const serialized = JSON.stringify(rows.rows)
    expect(serialized).not.toContain(firstToken)
    expect(serialized).not.toContain(rotatedToken)
    expect(serialized).not.toContain(invite.inviteToken)
    expect(serialized).not.toContain(pairing.claimSecret)
    expect(serialized).toContain('sha256:')
  })

  it('allows exactly one concurrent invitation redemption across two clients', async () => {
    const first = new PostgresExecutorIdentityStore(client().database, 'org-race', 'unit-race')
    const second = new PostgresExecutorIdentityStore(client().database, 'org-race', 'unit-race')
    const invite = await first.createInvite()
    const results = await Promise.all([
      first.consumeInvite(invite.inviteToken, 'ws-first'),
      second.consumeInvite(invite.inviteToken, 'ws-second'),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'invalid_invite' }])
    const winner = results.find((result): result is { ok: true; token: string } => result.ok)!
    expect((await second.resolveToken(winner.token))?.workspaceId).toMatch(/^ws-(first|second)$/u)
  })
})

async function resolveInChildProcess(connectionString: string, token: string, organizationId: string, unitId: string): Promise<unknown> {
  const hotStateModule = new URL('../tenant-runtime/postgres-hot-state.ts', import.meta.url).href
  const identityModule = new URL('./postgres-executor-identity.ts', import.meta.url).href
  const script = `
    import { createPostgresHotStateStore } from ${JSON.stringify(hotStateModule)}
    import { PostgresExecutorIdentityStore } from ${JSON.stringify(identityModule)}
    const database = createPostgresHotStateStore({ connectionString: process.env.TEST_DATABASE_URL, applicationName: 'identity-child-process' })
    try {
      const store = new PostgresExecutorIdentityStore(database.database, process.env.TEST_ORGANIZATION_ID, process.env.TEST_UNIT_ID)
      process.stdout.write(JSON.stringify(await store.resolveToken(process.env.TEST_EXECUTOR_TOKEN)))
    } finally {
      await database.close()
    }
  `
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEST_DATABASE_URL: connectionString,
      TEST_EXECUTOR_TOKEN: token,
      TEST_ORGANIZATION_ID: organizationId,
      TEST_UNIT_ID: unitId,
    },
  })
  return JSON.parse(stdout) as unknown
}

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
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
