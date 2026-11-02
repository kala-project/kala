import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { OnlineTelemetry } from '@agent-kernel/shared/node-telemetry'

export type ArtifactObject = { organizationId: string; key: string; contentType: string; body: Uint8Array; expiresAt?: Date }
export interface ArtifactObjectStore {
  put(object: ArtifactObject): Promise<void>
  get(organizationId: string, key: string): Promise<Uint8Array>
  delete(organizationId: string, key: string): Promise<void>
  signedGetUrl(organizationId: string, key: string, ttlSeconds: number): Promise<URL>
}

export function tenantObjectKey(organizationId: string, key: string): string {
  if (!/^org_[A-Za-z0-9_-]+$/u.test(organizationId) || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(key) || key.includes('..')) throw new Error('invalid artifact key')
  return `organizations/${organizationId}/${key}`
}

export class S3ArtifactObjectStore implements ArtifactObjectStore {
  private readonly client: S3Client
  constructor(private readonly options: {
    endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string
    maxObjectBytes: number; forcePathStyle?: boolean; telemetry?: OnlineTelemetry
  }) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000, throwOnRequestTimeout: true },
    })
  }
  async put(object: ArtifactObject): Promise<void> {
    if (object.body.byteLength > this.options.maxObjectBytes) throw new Error('artifact quota exceeded')
    const send = () => this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: tenantObjectKey(object.organizationId, object.key), Body: object.body, ContentType: object.contentType, ...(object.expiresAt ? { Expires: object.expiresAt } : {}) }))
    await (this.options.telemetry ? this.options.telemetry.traceClientCall({ provider: 's3', operation: 'put' }, send) : send())
  }
  async get(organizationId: string, key: string): Promise<Uint8Array> {
    const send = () => this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: tenantObjectKey(organizationId, key) }))
    const response = await (this.options.telemetry ? this.options.telemetry.traceClientCall({ provider: 's3', operation: 'get' }, send) : send())
    if (!response.Body) throw new Error('artifact body is unavailable')
    return await response.Body.transformToByteArray()
  }
  async delete(organizationId: string, key: string): Promise<void> {
    const send = () => this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: tenantObjectKey(organizationId, key) }))
    await (this.options.telemetry ? this.options.telemetry.traceClientCall({ provider: 's3', operation: 'delete' }, send) : send())
  }
  async signedGetUrl(organizationId: string, key: string, ttlSeconds: number): Promise<URL> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('invalid signed URL TTL')
    const href = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: tenantObjectKey(organizationId, key) }), { expiresIn: ttlSeconds })
    return new URL(href)
  }
}
