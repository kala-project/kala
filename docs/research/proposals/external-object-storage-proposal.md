# External Object Storage Proposal

**Status:** Deferred proposal; not implemented

**Scope:** Dedicated and Private Cloud storage tiering for immutable and
large-payload data

**Decision:** Keep active Runtime authority on a durable filesystem. Introduce
an object-storage tier only when product capacity, disaster-recovery, or
multi-node requirements justify the implementation.

## 1. Summary

Kala must not replace a Runtime Unit data root with an S3 or Azure Blob mount.
Active Session and deployment state depends on filesystem operations that object
stores do not provide: durable append, `fsync`, atomic rename, directory
durability, file locking, and stable state-root identity.

The intended future architecture is tiered:

```text
┌─────────────────────────────────────────────────────────────┐
│ Durable hot state                                           │
│ local SSD / EBS / Azure Managed Disk / qualified POSIX NFS │
│                                                             │
│ Session JSONL, Queue, Approval, restart/deploy receipts,    │
│ route state, write lease, current snapshots                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ durable content reference
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Object storage                                              │
│ S3 / MinIO / Azure Blob Storage                            │
│                                                             │
│ Attachments, large traces, Tool artifacts, RL/Evaluation    │
│ artifacts, exports, backups, sealed Session segments        │
└─────────────────────────────────────────────────────────────┘
```

Object bytes and transactional metadata have separate authorities. A Session
event or database row records the object key, byte count, media type, and
SHA-256 digest. Bucket listings are never treated as authoritative product
state.

## 2. Goals

- reduce Runtime local-disk growth from large immutable payloads;
- support AWS S3, S3-compatible stores such as MinIO, and Azure Blob Storage;
- retain Session replay, restart continuation, deletion, quota, and export
  invariants;
- support streaming transfer rather than buffering complete objects in memory;
- use workload identity instead of long-lived credentials where available;
- allow short-lived, permission-checked downloads;
- keep the Agent Kernel, Session reducer, Queue, Compact, and Executor protocol
  independent of cloud-vendor SDKs;
- provide migration and rollback paths that do not silently move authority.

## 3. Non-goals

- mounting an object store as the complete Unit filesystem;
- treating S3FS, BlobFuse, or another FUSE layer as equivalent to a tested
  durable POSIX filesystem;
- moving active Session JSONL, Queue, route state, or write leases directly to
  object storage;
- making cloud storage mandatory for Portable or Dedicated;
- synchronizing complete Workspace trees from Executor machines;
- introducing a second metadata authority derived from object-store listing;
- implementing multi-node Runtime ownership. That requires a separate
  generation-fenced lease and transactional state-store design.

## 4. Current repository foundation

Kala already has relevant boundaries, but they do not constitute a production
external-storage feature:

- `packages/host/src/artifacts/object-store.ts` defines an
  `ArtifactObjectStore` and an initial `S3ArtifactObjectStore`.
- The S3 adapter supports bounded object upload, delete, and signed download
  URLs. It is covered by isolated tests but is not wired into Dedicated
  Session artifacts.
- The Private Cloud architecture assigns object bytes to S3/MinIO and object
  metadata to the PostgreSQL control plane.
- Private Cloud Compose can place `tenant-data` on external NFS. This is a
  filesystem deployment option, not object-storage support and not proof that
  an arbitrary managed NFS implementation satisfies Runtime durability.
- Active Session logs still use durable local append and `fsync`; snapshots
  use temporary-file write, `fsync`, atomic rename, and directory `fsync`.

The current S3 adapter also has deliberate limitations that a production design
must address:

- it accepts a complete `Uint8Array` instead of a stream;
- it has no Azure Blob implementation;
- it receives explicit access keys instead of using a workload-identity
  credential chain;
- its API lacks streamed reads, `head`, conditional create, checksum
  verification, and multipart/block upload;
- its key model assumes an Organization rather than a generic Runtime Unit
  storage scope;
- no durable metadata/outbox protocol currently connects object upload to a
  Session event.

## 5. Data placement

| Data class | Future authority | Reason |
|---|---|---|
| Active Session JSONL | Durable filesystem | Requires append, `fsync`, replay cursor, and crash consistency |
| Message Queue and cancellation tombstones | Session event log | Queue acceptance is a first-persist-then-ack boundary |
| Approval and Pending Call state | Session event log | Restart must preserve the exact human-input boundary |
| Restart marker and continuation receipts | Durable filesystem | Requires atomic ownership, fencing, and immediate startup access |
| Deployment receipts and route state | Durable filesystem | Supervisor and Ingress depend on atomic local state transitions |
| Runtime write lease | Local/qualified POSIX lock or future transactional lease | Prevents concurrent Runtime writers |
| Current Session snapshot | Durable hot filesystem | Must correspond to a precise JSONL size and cursor |
| Attachment bytes | Object storage | Large, immutable after commit, hash-verifiable |
| LLM request/response sidecars | Object storage | Large payloads already referenced separately from core events |
| Tool and user-visible artifacts | Object storage | Immutable object semantics and signed delivery fit naturally |
| RL and Evaluation artifacts | Object storage | High volume, immutable, and primarily consumed offline |
| Export archives | Object storage | Versioned, immutable, checksum-addressed download |
| Backup archives | Object storage after local verification | Benefits from off-host retention and replication |
| Sealed historical Session segments | Object storage | Eligible only after cursor range and digest are immutable |
| Workspace files | Executor machine | Workspace ownership remains with the execution environment |
| Control-plane relationships and object metadata | PostgreSQL | Requires transactions, indexes, constraints, and Outbox delivery |
| Dashboard static generations | Immutable local release or object storage/CDN | Safe when release digest and protocol generation remain authoritative |

## 6. Storage Port

Vendor SDKs terminate at one explicit Port. The eventual interface should be
stream-oriented and capability-neutral:

```ts
type ObjectScope = {
  unitId: string
  organizationId?: string
}

type ObjectDescriptor = {
  key: string
  bytes: number
  sha256: string
  contentType: string
  createdAt: string
}

interface ObjectStore {
  put(input: {
    scope: ObjectScope
    key: string
    body: AsyncIterable<Uint8Array>
    bytes: number
    sha256: string
    contentType: string
  }): Promise<ObjectDescriptor>

  get(scope: ObjectScope, key: string): Promise<{
    descriptor: ObjectDescriptor
    body: AsyncIterable<Uint8Array>
  }>

  head(scope: ObjectScope, key: string): Promise<ObjectDescriptor | undefined>
  delete(scope: ObjectScope, key: string): Promise<void>
  signedGetUrl(scope: ObjectScope, key: string, ttlSeconds: number): Promise<URL>
}
```

The final shape may differ, but it must preserve streaming, scoped keys,
integrity metadata, bounded signed access, and explicit absence. Application
code must not switch on S3 or Azure environment variables.

Required adapters:

- `LocalObjectStore` for development, Portable, and default Dedicated;
- `S3ObjectStore` for AWS S3 and S3-compatible services such as MinIO;
- `AzureBlobObjectStore` using the native Azure Blob API.

Azure Blob Storage is not S3 API-compatible. The Azure adapter must use the
Azure Storage SDK and map temporary access to a User Delegation SAS or another
policy-approved SAS mechanism. An S3 compatibility proxy is not part of the
preferred architecture because it adds another credential, availability, and
semantic-translation boundary.

## 7. Key and namespace contract

Object keys begin with an opaque Unit scope and resource class:

```text
units/<opaque-unit-id>/attachments/sha256/<digest>
units/<opaque-unit-id>/traces/sha256/<digest>
units/<opaque-unit-id>/artifacts/sha256/<digest>
units/<opaque-unit-id>/exports/<export-id>/<digest>
units/<opaque-unit-id>/backups/<backup-id>/<digest>
units/<opaque-unit-id>/sessions/<session-id>/segments/<first>-<last>-<digest>
```

Rules:

- keys never contain user-visible organization names, Workspace paths, prompts,
  filenames containing secrets, or provider credentials;
- every persistent reference includes byte count and SHA-256;
- write-once content uses content-addressed keys where practical;
- cross-Unit identifier collision is expected and safe;
- signed URLs are issued only after an authorization and retention check;
- object-store ETags are not assumed to be content hashes;
- list results support diagnostics only and cannot recreate missing metadata
  authority.

## 8. Commit protocols

### 8.1 Object creation

Object creation is not complete when an SDK upload call returns. The intended
protocol is:

```text
1. Reserve quota and create an operation identity.
2. Stream bytes to an operation-scoped or content-addressed key.
3. Verify expected byte count and SHA-256.
4. Durably commit the Session event or transactional metadata reference.
5. Acknowledge success to the caller.
6. Reconcile and delete uploads that never acquired a durable reference.
```

If step 3 or 4 fails, the product reports failure. It must not return a
success-shaped response and hope that asynchronous reconciliation repairs
authority later.

For PostgreSQL metadata, steps 4 and asynchronous follow-up use an Outbox. For
Session-local metadata, the object reference is appended and synced in the
Session JSONL before acknowledgement.

### 8.2 Object deletion

Deletion remains asynchronous, idempotent, and observable:

```text
1. Commit a deletion tombstone or metadata transition.
2. Remove the object from product reads.
3. Delete the object bytes idempotently.
4. Record deletion completion or retry state.
5. Retain only the bounded content-free evidence required by policy.
```

An object missing before step 3 is treated as repairable cleanup, not proof that
the metadata transition occurred.

### 8.3 Reads

- metadata authorization happens before object access;
- private server-side reads verify expected size and digest when materializing a
  cache entry;
- browser downloads use short-lived URLs scoped to one object;
- a missing or corrupt object produces an explicit stable error and repair
  evidence;
- local caches are disposable and never become authority.

## 9. Session segment archival

Session archival is a later phase, separate from initial Artifact support.
Active logs remain local:

```text
active.jsonl
snapshot.json
```

At a safe cursor boundary, an immutable prefix may be sealed:

```text
segment-00000001-00001000-<sha256>.jsonl
segment-00001001-00002000-<sha256>.jsonl
```

Archival is complete only after:

1. the segment cursor range and digest are fixed;
2. upload and remote verification succeed;
3. a local durable index commits the segment reference;
4. replay from local index plus remote segments reproduces the same state;
5. rollback evidence exists before local bytes are removed.

The active tail, Queue metadata, restart checkpoint, and current snapshot remain
on hot durable storage.

## 10. Security and privacy

- AWS uses IAM roles/default credential providers; Azure uses Managed Identity
  and Azure RBAC. Static access keys are a compatibility fallback, not the
  default.
- Access uses private endpoints or equivalent network controls in production.
- Buckets/containers deny public listing and public object access.
- Server-side encryption is mandatory; customer-managed keys are deployment
  policy, not embedded application secrets.
- Signed URLs have a short bounded TTL and are never persisted in Session
  events, logs, or audit records.
- Object metadata and diagnostics exclude prompts, Tool bodies, secrets, raw
  credentials, and user-identifying path fragments.
- Retention, replication, versioning, and object-lock policies must remain
  compatible with Unit deletion and documented backup expiry.
- Credential values stay in the deployment secret resolver and are never
  returned to the Dashboard.

## 11. Quota, retention, and inventory

Quota authority uses committed metadata, not provider list or billing APIs.
Reservations prevent concurrent uploads from exceeding the hard threshold
before bytes are accepted. Reads, export, and deletion remain available after a
write quota is reached.

Storage inventory reports hot and object tiers separately:

```text
Session state
Attachments
Artifacts
Traces
RL/Evaluation
Exports
Backups
Temporary/orphan candidates
```

Provider lifecycle policies are a cleanup defense, not the product retention
authority. Kala still records expiry and deletion outcomes.

## 12. Failure behavior

| Failure | Required behavior |
|---|---|
| Object store unavailable before upload | Reject or retain a bounded durable local spool; never acknowledge an uncommitted reference |
| Upload succeeds but metadata commit fails | Leave a reconciler-visible orphan and report failure |
| Metadata commits but object is missing | Fail the read explicitly, emit repair evidence, and preserve metadata authority |
| Signed URL generation fails | Return an actionable retryable error without exposing credentials |
| Object digest mismatch | Quarantine the cache/object reference and block consumption |
| Delete fails | Keep deletion tombstone and retry; do not make the object visible again |
| Local cache is lost | Rehydrate from verified object bytes |
| Provider list is stale/incomplete | No product-state effect |

Core Session operation during an object-store outage depends on the requested
effect. A turn that does not require a missing object may continue. A turn that
must persist an attachment or Artifact fails before claiming that payload was
committed.

## 13. Cloud mappings

### AWS

```text
EBS or qualified EFS    active Runtime filesystem
S3                      immutable objects and backups
RDS PostgreSQL          future/control-plane transactional metadata
IAM role + KMS          identity and encryption
PrivateLink             private object access
```

### Azure

```text
Azure Managed Disk      active Runtime filesystem
Azure Blob Storage      immutable objects and backups
Azure Database for
PostgreSQL              future/control-plane transactional metadata
Managed Identity + Key
Vault                   identity and key policy
Private Endpoint        private object access
```

Azure Files NFS and AWS EFS are possible filesystem tiers, not object-store
adapters. Before hosting active Runtime state they require acceptance for
`fsync`, atomic rename, advisory lock recovery, directory durability, inode and
device stability, Blue/Green write fencing, backup, and failover.

## 14. Deferred implementation phases

No phase is currently approved for implementation.

### Phase 1 — object Port and immutable Artifacts

- replace the initial in-memory S3 body API with a streaming Port;
- add Local, S3/MinIO, and native Azure Blob adapters;
- use workload-identity credential chains;
- externalize Attachments and selected immutable Artifacts;
- retain local metadata authority and add orphan reconciliation.

### Phase 2 — large Session sidecars

- move LLM trace/effect payloads and other large sidecars behind object
  references;
- add verified local caching;
- expose hot/object-tier inventory and quota separately;
- validate export, deletion, and unavailable-provider behavior.

### Phase 3 — exports and backups

- upload only complete locally verified archives;
- verify remote byte count and checksum;
- implement restore drills, retention, replication, and deletion evidence;
- keep deployment receipts and active Runtime state local.

### Phase 4 — sealed Session segments

- define a versioned segment/index format;
- prove replay equivalence and crash recovery at every sealing boundary;
- retain the active append tail locally;
- remove local sealed bytes only after verified rollback-safe migration.

### Phase 5 — transactional state redesign, only if required

If multi-node Runtime mobility or high availability becomes a product
requirement, evaluate PostgreSQL/event-store authority for Session metadata,
Queue, receipts, Outbox, and generation-fenced leases. This is not an extension
of the object adapter; it is a separate storage architecture migration.

## 15. Acceptance gates

Any future implementation must prove:

- first-persist-then-publish for Session and Queue references;
- no acknowledged reference to an absent or unverified object;
- upload, metadata commit, delete, cache, and restore crash matrices;
- cross-Unit key and authorization isolation;
- quota reservation under concurrent uploads;
- stream backpressure and bounded memory for large objects;
- checksum verification for upload, download, export, and restore;
- workload identity and private network operation for AWS and Azure;
- signed URL TTL and permission enforcement;
- retention and Unit deletion with provider versioning enabled;
- backup restore into a disposable Unit with exact manifest reproduction;
- object-store outage behavior without infinite loading or silent fallback;
- Dedicated upgrade, rollback, write lease, and Session continuation remain
  unchanged when object storage is enabled.

## 16. Activation criteria

Revisit this proposal only when at least one of these conditions is true:

- Artifact growth is a material Dedicated or Private Cloud capacity problem;
- customers require S3 or Azure Blob retention and residency controls;
- off-host backup and restore objectives cannot be met by the existing flow;
- large Session sidecars materially affect restart, backup, or inventory cost;
- multi-node Runtime work establishes a transactional metadata authority.

Until then, the existing durable filesystem remains the supported Runtime
authority. The presence of the initial S3 adapter must not be presented as a
supported external-storage feature.
