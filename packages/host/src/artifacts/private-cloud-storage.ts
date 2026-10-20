import type { PostgresHotStateStore } from '../tenant-runtime/postgres-hot-state.js'
import { S3MessageAttachmentStore } from '../message-attachments/s3-message-attachment-store.js'
import type { PostgresSchemaManagement } from '../postgres-migrations.js'
import type { RuntimeResourceOwnership } from '../tenant-runtime/postgres-runtime-resource-ownership.js'
import { S3ArtifactObjectStore } from './object-store.js'
import { PostgresObjectCapacityLedger } from './postgres-object-capacity.js'
import { PostgresObjectMetadataLog } from './postgres-object-metadata.js'
import { S3SessionArtifactRegistry } from './s3-session-artifact-registry.js'

export type PrivateCloudObjectStorageOptions = {
  organizationId: string
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  maxObjectBytes: number
  maxArtifactBytes: number
  forcePathStyle?: boolean
  hotState: PostgresHotStateStore
  prepareSessionOwner?: (sessionId: string) => Promise<void>
  resourceOwnerForSession?: (sessionId: string) => RuntimeResourceOwnership | undefined
  databaseSchema?: string
  schemaManagement?: PostgresSchemaManagement
  orphanReconciliationLimit?: number
  orphanClaimTimeoutMs?: number
}

/**
 * The single Private Cloud construction path for Session Artifacts and message
 * attachments. Callers must inject both returned stores into the Host; creating
 * only S3ArtifactObjectStore does not activate object-backed Runtime behavior.
 */
export async function createPrivateCloudObjectStorage(options: PrivateCloudObjectStorageOptions): Promise<{
  sessionArtifacts: S3SessionArtifactRegistry
  messageAttachments: S3MessageAttachmentStore
  reconcileOrphans: () => Promise<void>
  resourceArtifactUsage: () => Promise<number>
  quotaManagedExternally: true
}> {
  const objects = new S3ArtifactObjectStore({
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    region: options.region,
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    maxObjectBytes: options.maxObjectBytes,
    ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
  })
  const capacity = new PostgresObjectCapacityLedger(options.organizationId, options.maxArtifactBytes, options.hotState, {
    ...(options.databaseSchema ? { schema: options.databaseSchema } : {}),
    schemaManagement: options.schemaManagement,
    ...(options.prepareSessionOwner ? { prepareSessionOwner: options.prepareSessionOwner } : {}),
    ...(options.resourceOwnerForSession ? { resourceOwnerForSession: options.resourceOwnerForSession } : {}),
  })
  const metadata = new PostgresObjectMetadataLog(options.organizationId, options.hotState, {
    ...(options.databaseSchema ? { schema: options.databaseSchema } : {}),
    schemaManagement: options.schemaManagement,
    capacity,
    ...(options.prepareSessionOwner ? { prepareSessionOwner: options.prepareSessionOwner } : {}),
    ...(options.resourceOwnerForSession ? { resourceOwnerForSession: options.resourceOwnerForSession } : {}),
  })
  await metadata.initialize()
  await capacity.initialize()
  await metadata.reconcileOrphanIntents(objects, {
    ...(options.orphanReconciliationLimit !== undefined ? { limit: options.orphanReconciliationLimit } : {}),
    ...(options.orphanClaimTimeoutMs !== undefined ? { claimTimeoutMs: options.orphanClaimTimeoutMs } : {}),
  })
  return {
    sessionArtifacts: new S3SessionArtifactRegistry(options.organizationId, objects, metadata, capacity),
    messageAttachments: new S3MessageAttachmentStore(options.organizationId, objects, metadata, capacity),
    resourceArtifactUsage: async () => await capacity.usageBytes(),
    quotaManagedExternally: true,
    reconcileOrphans: async () => {
      await metadata.reconcileOrphanIntents(objects, {
        ...(options.orphanReconciliationLimit !== undefined ? { limit: options.orphanReconciliationLimit } : {}),
        ...(options.orphanClaimTimeoutMs !== undefined ? { claimTimeoutMs: options.orphanClaimTimeoutMs } : {}),
      })
    },
  }
}
