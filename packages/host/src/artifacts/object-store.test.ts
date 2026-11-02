import { S3Client } from '@aws-sdk/client-s3'
import { OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'
import { describe, expect, it, vi } from 'vitest'
import { S3ArtifactObjectStore, tenantObjectKey } from './object-store.js'

describe('artifact object store', () => {
  it('always prefixes keys with organization identity and rejects traversal', () => {
    expect(tenantObjectKey('org_acme', 'sessions/s1/out.txt')).toBe('organizations/org_acme/sessions/s1/out.txt')
    expect(() => tenantObjectKey('org_acme', '../org_other/x')).toThrow('invalid artifact key')
  })
  it('wraps the real S3Client.send boundary without exporting object coordinates', async () => {
    const exported: string[] = []
    const telemetry = new OnlineTelemetry({
      serviceName: 'kala-test', endpoint: 'http://localhost:4318', authToken: 't'.repeat(32), flushIntervalMs: 60_000,
      fetch: vi.fn(async (_url, init) => { exported.push(String(init?.body)); return new Response('', { status: 200 }) }) as typeof fetch,
    })
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    try {
      const store = new S3ArtifactObjectStore({
        endpoint: 'https://minio-sensitive.test', region: 'us-east-1', bucket: 'bucket-sensitive',
        accessKeyId: 'key-sensitive', secretAccessKey: 'secret-sensitive', maxObjectBytes: 4, telemetry,
      })
      await store.put({ organizationId: 'org_sensitive', key: 'private/key.txt', contentType: 'text/plain', body: new Uint8Array([1]) })
      expect(send).toHaveBeenCalledOnce()
      await telemetry.flush()
      const body = exported.join('\n')
      expect(body).toContain('s3.put')
      expect(body).not.toMatch(/minio-sensitive|bucket-sensitive|key-sensitive|secret-sensitive|org_sensitive|private\/key/u)
    } finally {
      send.mockRestore()
      await telemetry.close()
    }
  })

  it('enforces quota and bounded SigV4 signed URLs', async () => {
    const store = new S3ArtifactObjectStore({ endpoint: 'https://minio.test', region: 'us-east-1', bucket: 'artifacts', accessKeyId: 'key', secretAccessKey: 'secret', maxObjectBytes: 4 })
    await expect(store.put({ organizationId: 'org_acme', key: 'a', contentType: 'text/plain', body: new Uint8Array(5) })).rejects.toThrow('quota')
    await expect(store.signedGetUrl('org_acme', 'a', 3601)).rejects.toThrow('TTL')
    const url = await store.signedGetUrl('org_acme', 'a', 60)
    expect(url.pathname).toBe('/artifacts/organizations/org_acme/a')
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true)
  })
})
