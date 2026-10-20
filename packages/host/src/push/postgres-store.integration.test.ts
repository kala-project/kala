import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPostgresHotStateStore, type PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { PostgresTenantStateStore } from '../tenant-runtime/postgres-state.js'
import { PostgresPushSubscriptionStore } from './postgres-store.js'
import type { PushSubscriptionRecord } from './store.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('PostgreSQL push subscription store integration', () => {
  const testProject = `kala-push-store-test-${randomUUID()}`
  const containerName = `${testProject}-postgres`
  const databases: PostgresHotStateStore[] = []
  const masterKey = randomBytes(32)
  let connectionString: string

  beforeAll(async () => {
    await docker('run', '--detach', '--rm',
      '--name', containerName,
      '--label', `dev.kala.test.project=${testProject}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', 'POSTGRES_PASSWORD=kala_test_only',
      '--env', 'POSTGRES_DB=kala_push_store_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error(`Docker did not assign a PostgreSQL port: ${port}`)
    connectionString = `postgresql://postgres:kala_test_only@127.0.0.1:${port}/kala_push_store_test`
    await eventually(async () => await tenantState('schema', masterKey).initializeSchema(), 30_000)
  }, 120_000)

  afterAll(async () => {
    await Promise.allSettled(databases.map(async (database) => await database.close()))
    await docker('rm', '--force', containerName).catch(() => undefined)
  }, 30_000)

  function tenantState(tenantId: string, key: Uint8Array): PostgresTenantStateStore {
    const database = createPostgresHotStateStore({ connectionString, applicationName: `${testProject}-${tenantId}` })
    databases.push(database)
    return new PostgresTenantStateStore(database.database, tenantId, key)
  }

  it('persists all mutations across clients while keeping subscription fields encrypted', async () => {
    const tenant = `org-${randomUUID()}`
    const writerState = tenantState(tenant, masterKey)
    const writer = new PostgresPushSubscriptionStore(writerState)
    const first = subscription('https://push.example/sensitive-one', 'phone')
    const second = subscription('https://push.example/sensitive-two', 'phone')

    await writer.upsert(first)
    await writer.upsert(second)
    expect(await writer.size()).toBe(2)

    const reader = new PostgresPushSubscriptionStore(tenantState(tenant, masterKey))
    expect(await reader.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: first.endpoint, deviceId: 'phone', enabled: true }),
      expect.objectContaining({ endpoint: second.endpoint, deviceId: 'phone', enabled: true }),
    ]))
    expect(await reader.updateDevice('phone', { enabled: false, name: 'Encrypted phone' })).toBe(true)

    const reloaded = new PostgresPushSubscriptionStore(tenantState(tenant, masterKey))
    expect(await reloaded.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ enabled: false, deviceName: 'Encrypted phone' }),
    ]))
    expect(await reloaded.remove(second.endpoint)).toBe(true)
    expect(await reloaded.remove(second.endpoint)).toBe(false)
    expect(await reloaded.removeDevice('phone')).toBe(true)
    expect(await reloaded.size()).toBe(0)

    await writer.upsert(first)
    const rows = await writerState.database.query<{ ciphertext: Buffer; metadata: unknown }>(
      'SELECT ciphertext, metadata FROM tenant_state_credentials WHERE tenant_id = $1 AND credential_id = $2',
      [tenant, 'push-subscriptions:v1'],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.ciphertext.toString('utf8')).not.toContain('push.example')
    expect(JSON.stringify(rows.rows[0]!.metadata)).not.toContain('push.example')
    expect(JSON.stringify(rows.rows[0]!.metadata)).not.toContain('private-auth-key')
  })

  it('serializes concurrent upserts by separate Runtime clients without losing subscribers', async () => {
    const tenant = `org-${randomUUID()}`
    const first = new PostgresPushSubscriptionStore(tenantState(tenant, masterKey))
    const second = new PostgresPushSubscriptionStore(tenantState(tenant, masterKey))
    await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const store = index % 2 === 0 ? first : second
      await store.upsert(subscription(`https://push.example/concurrent-${index}`, `device-${index}`))
    }))
    expect(await first.size()).toBe(12)
    expect(await second.list()).toHaveLength(12)
  })

  it('isolates organizations and fails closed with the wrong master key', async () => {
    const tenant = `org-${randomUUID()}`
    const writer = new PostgresPushSubscriptionStore(tenantState(tenant, masterKey))
    await writer.upsert(subscription('https://push.example/tenant-secret', 'desktop'))

    const otherTenant = new PostgresPushSubscriptionStore(tenantState(`${tenant}-other`, masterKey))
    expect(await otherTenant.list()).toEqual([])

    const wrongKey = new PostgresPushSubscriptionStore(tenantState(tenant, randomBytes(32)))
    await expect(wrongKey.list()).rejects.toThrow('credential_decryption_failed')
  })
})

function subscription(endpoint: string, deviceId: string): PushSubscriptionRecord {
  return {
    endpoint,
    keys: { p256dh: 'private-p256dh-key', auth: 'private-auth-key' },
    kinds: ['approval_required'],
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    deviceId,
  }
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
