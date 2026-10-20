import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { ExecutorInstallationError } from './executor-installation.js'
import { PostgresExecutorInstallationStore } from './postgres-executor-installation.js'
import { initializePrivateCloudExperimentalStorageSchema } from './postgres-private-cloud-storage.js'
import { PostgresWorkspaceAliasStore } from './postgres-workspace-alias.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('Private Cloud PostgreSQL workspace metadata integration', () => {
  const project = `kala-workspace-metadata-${randomUUID()}`
  const container = `${project}-postgres`
  const clients: PostgresHotStateStore[] = []
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', container,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_workspace_metadata_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${port}/kala_workspace_metadata_test`
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
    const database = createPostgresHotStateStore({ connectionString, applicationName: project })
    clients.push(database)
    return database
  }

  it('recovers aliases and a complete installation flow across independent clients without plaintext credentials', async () => {
    const writer = client()
    const reader = client()
    const aliases = new PostgresWorkspaceAliasStore(writer.database, 'org-a')
    await aliases.load()
    await aliases.rename(' ws-1 ', ' Production ')
    expect(aliases.apply({ workspaceId: 'ws-1', workspaceName: 'old' }).workspaceName).toBe('Production')
    const recoveredAliases = new PostgresWorkspaceAliasStore(reader.database, 'org-a')
    await recoveredAliases.load()
    expect(recoveredAliases.get('ws-1')).toBe('Production')

    const first = new PostgresExecutorInstallationStore(writer.database, 'org-a')
    const second = new PostgresExecutorInstallationStore(reader.database, 'org-a')
    const created = await first.create(
      { platform: 'linux', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: '/work' },
      'request-1',
      { organizationId: 'org-a', principal: 'admin@example.test', organizationRole: 'admin' },
    )
    await expect(second.create(
      { platform: 'linux', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: '/other' },
      'request-1',
      { organizationId: 'org-a', principal: 'admin@example.test', organizationRole: 'admin' },
    )).rejects.toMatchObject<Partial<ExecutorInstallationError>>({ message: 'idempotency_replayed', status: 409 })

    const claimed = await second.claim(created.setupCode)
    expect(claimed?.install.status).toBe('bootstrap_downloaded')
    const bootstrap = claimed!.bootstrap
    expect(await first.authenticate(created.install.id, bootstrap)).toBe(true)
    await first.reportClient(created.install.id, bootstrap, 'asset_verified')
    expect((await second.reportClient(created.install.id, bootstrap, 'pairing_pending')).status).toBe('paired')
    await first.redeem(created.install.id, bootstrap, 'ws-1')
    await second.reportClient(created.install.id, bootstrap, 'starting')
    expect((await first.markOnline(created.install.id, 'ws-1', { executorId: 'exec-1' }))?.status).toBe('completed')
    expect((await second.events(created.install.id))?.map((event) => event.status)).toEqual([
      'created', 'bootstrap_downloaded', 'asset_verified', 'pairing_pending', 'paired', 'starting', 'online', 'completed',
    ])

    const rows = await writer.database.query<{ record: unknown }>('SELECT record FROM executor_installations WHERE organization_id = $1', ['org-a'])
    const serialized = JSON.stringify(rows.rows)
    expect(serialized).not.toContain(created.setupCode)
    expect(serialized).not.toContain(bootstrap)
    expect(serialized).toContain('sha256:')
  })

  it('isolates organizations and persists TTL expiry observed by another client', async () => {
    const writer = client()
    const reader = client()
    const expiring = new PostgresExecutorInstallationStore(writer.database, 'org-ttl', 15)
    const created = await expiring.create({ platform: 'macos', mode: 'temporary', privilegeMode: 'restricted', workspaceRoot: '/work' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const recovered = new PostgresExecutorInstallationStore(reader.database, 'org-ttl', 15)
    expect((await recovered.get(created.install.id))?.status).toBe('expired')
    expect(await new PostgresExecutorInstallationStore(reader.database, 'org-other').get(created.install.id)).toBeUndefined()
    const persisted = new PostgresExecutorInstallationStore(writer.database, 'org-ttl', 15)
    expect((await persisted.get(created.install.id))?.status).toBe('expired')
  })
})

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
