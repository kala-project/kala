import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { S3ArtifactObjectStore } from './object-store.js'

const execFileAsync = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_SILO_INTEGRATION === '1' ? describe : describe.skip
const siloImage = 'pgsty/silo@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7'

integrationDescribe('S3 artifact store with isolated Docker Silo', () => {
  const project = `kala-s3-test-${randomUUID()}`
  const container = `${project}-silo`
  const accessKeyId = 'kala-test-access'
  const secretAccessKey = `test-${randomUUID()}-only`
  let endpoint: string
  let store: S3ArtifactObjectStore

  beforeAll(async () => {
    await docker('run', '--detach', '--rm', '--name', container,
      '--label', `dev.kala.test.project=${project}`,
      '--tmpfs', '/data:rw,nosuid,size=256m',
      '--publish', '127.0.0.1::9000',
      '--env', `MINIO_ROOT_USER=${accessKeyId}`,
      '--env', `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      siloImage, 'server', '/data')
    const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}', container)
    const port = stdout.trim()
    if (!/^\d+$/u.test(port)) throw new Error('Silo test port unavailable')
    endpoint = `http://127.0.0.1:${port}`
    await eventually(async () => {
      const response = await fetch(`${endpoint}/minio/health/live`)
      if (!response.ok) throw new Error(`Silo not ready: ${response.status}`)
    }, 30_000)
    await docker('exec', container, 'mcli', 'alias', 'set', 'test', 'http://127.0.0.1:9000', accessKeyId, secretAccessKey)
    await docker('exec', container, 'mcli', 'mb', 'test/kala-test-artifacts')
    store = new S3ArtifactObjectStore({
      endpoint, region: 'us-east-1', bucket: 'kala-test-artifacts',
      accessKeyId, secretAccessKey, maxObjectBytes: 128,
    })
  }, 120_000)

  afterAll(async () => {
    await docker('rm', '--force', container).catch(() => undefined)
  }, 30_000)

  it('writes tenant-scoped objects, signs reads, and deletes against Silo', async () => {
    const body = new TextEncoder().encode('private-cloud-object-test')
    await store.put({ organizationId: 'org_test', key: 'sessions/s1/output.txt', contentType: 'text/plain', body })
    expect(Buffer.from(await store.get('org_test', 'sessions/s1/output.txt'))).toEqual(Buffer.from(body))
    const url = await store.signedGetUrl('org_test', 'sessions/s1/output.txt', 60)
    expect((await fetch(url)).status).toBe(200)
    expect(await (await fetch(url)).text()).toBe('private-cloud-object-test')
    const otherTenantUrl = await store.signedGetUrl('org_other', 'sessions/s1/output.txt', 60)
    expect((await fetch(otherTenantUrl)).status).toBe(404)
    await store.delete('org_test', 'sessions/s1/output.txt')
    expect((await fetch(url)).status).toBe(404)
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
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError
}
