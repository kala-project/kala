# Dedicated legacy data migration

Status: the local full migration and production cutover have passed authenticated
acceptance, including a complete LXC restart. This remains an operator-gated
migration, not a supported one-click upgrade.

## Completed production cutover

The production LXC is `kala-dedicated-production`; the old installation is
`kala-legacy-recovery-20261101`, stopped with autostart and its application
services disabled. The production Dashboard remains at `http://localhost:18081`.
The original forwarded Executor endpoint on port `13000` reaches the new
installation. All five originally connected Executors automatically reconnected
using their original credentials and configuration, including four 0.2.0
Executors. A session-scoped, read-only devbox directory request succeeded.

The admitted data comprises all 20 retained main Sessions, 71 original-ID
attachments and 41 artifacts. Sixteen main histories and projections match their
sealed source hashes; the four pilots retain their newer target-only changes.
All published objects passed exact-byte S3 readback and authenticated download
checks where the existing preview policy permits them. Non-image attachments
remain in storage; an image-only preview refusal is not data loss.

All 20 native trees use the PostgreSQL binary POSIX backend. Final verification
checked every live block against its SHA-256 and all sixteen non-pilot native
trees against the final source staging copy. The three originally empty
Sessions were admitted as empty, not given fabricated histories. Each main's
original agent-module files remain in its native `/migration-recovery/` tree.
Two pilots also retain source-shutdown native event tails separately, without
overwriting their newer target histories.

Global publication retained the 11 original Executor identity records and
revocations, 29 installations, two pairings, three Workspace aliases, two memos
and tab state, three push subscriptions and the original VAPID keys. Both
completed DAGs retain their original state without replay; the source has no
scheduled-work tables. Agent slots and selected slot 3 were preserved.
The source's two configured LLM providers and three models are operationally
configured. The previously unauthenticated Codex configuration is retained for
recovery, not silently enabled.

Search and Azure Speech credentials were re-encrypted with the existing target
key, retaining their configuration and metadata. Real authenticated search and
speech token tests passed after the final restart. Owner Chromium also verified
all main IDs, Settings, original Executor presence and object access. A real
native devbox turn answered `2` after restart while preserving all 529 prior
messages. Before that turn, all 20 complete message arrays matched their
pre-restart SHA-256 values exactly. No Workspace files were modified.

## Production startup and recovery boundary

Keep the physical Compose project `kala-dedicated-latest`, its network and
existing volumes unchanged. Its historical name is a storage identity, not the
public production name. Renaming the project can create empty replacement
PostgreSQL/S3 volumes.

The enabled `kala-dedicated.service` uses
`/var/lib/kala/dedicated/production.yaml`, requires and starts after
`kala-native-mount-broker.service`, and runs:

```sh
docker compose -p kala-dedicated-latest -f /var/lib/kala/dedicated/production.yaml \
  up -d --no-build --pull never --wait --wait-timeout 180
```

Its bounded `ExecStop` uses the same project and production file. Runtime and
Gateway images are pinned to existing local image digests. The Runtime health
check authenticates `/internal/health` and requires `state: ready`; the Gateway
check requests `/healthz` with the registered canonical public Host. Use
`node:http`, not a fetch implementation that can discard that Host override.
The compatibility listener's own `/health` is only process liveness, not
evidence that its upstream application is available.

A full restart exposed and corrected an old unit still starting
`recovery/published/docker-compose.yaml`: it recreated obsolete binaries that
correctly refused the newer database schemas. Do not start that recovery Compose
file against the live databases. Production now uses Runtime schema 11 and
control-plane schema 10; the corrected complete LXC restart retained the intended
images, healthy services, address takeover and all original Executor connections.

The broker uses the short `/run/kala-native-posix` shared root and an `rslave`
Runtime bind. Keep it short enough for Unix sockets. Startup detaches stale
FUSE mounts; mountpoint directories are mode 000 underneath FUSE. SDK reuse
checks both the mounted filesystem and its authoritative scope. A lost mount
must fail closed, never become a writable local-directory fallback. The Runtime
does not need privileged mode, `/dev/fuse`, or database credentials in the
host-side broker.

Protected migration manifests, final source deltas, publication/integrity
receipts, pre-publication database dumps and source archives live under
`/var/lib/kala/dedicated/migrations/legacy-20261101/`. They contain private
operational data and must not be committed. Provider catalog/secret mounts and
the production encryption key are live dependencies, not disposable fixtures.
`full-final/post-cutover-recovery/` additionally contains complete Runtime and
control-plane custom-format dumps, the protected mounted configuration and
installed service/network configuration, with sizes and SHA-256 recorded.
Both database dumps were read in full through `pg_restore` without executing
their SQL. This is archive verification, not a claim of a separate disaster
restore rehearsal; S3 objects remain in their persistent bucket and immutable
source recovery copies.

After final source/history/native comparisons, only the three isolated
`legacy_full_rehearsal_20261101`, `legacy_boxpc_rehearsal_20261101` and
`legacy_devbox_rehearsal_20261101` schemas were removed. Their receipts and source
archives remain; no live schema, main Session or recovery archive was deleted.
Preserve the stopped old installation and recovery archives. After new target
writes, merely restarting the old authority would discard those writes;
rollback still requires the explicit reverse-delta boundary below.

## Historical boxpc pilot checkpoint

Two retained `boxpc` main Sessions have been atomically admitted to the existing
target organization. Their complete event/runtime-metadata histories match the
immutable source copies, and all 17 native files were read back with matching
SHA-256 hashes. The installed official CLI resumed both isolated native copies
twice across fresh processes, preserving all original events and transcript
prefixes without sending a model turn or executing a tool.

Actual Owner Chromium acceptance after Runtime restart verified both chats,
exact 1,155/1,388-message snapshots, and all four original-ID attachment downloads.
The attachment catalog is a separate source authority: backing up the Session
log/artifact/native directories alone did not include those four objects.
The original 29 pilot source files remain byte-identical.

Publication uses existing Session/native/object authorities with a shared
PostgreSQL transaction; an injected failure proved uncommitted Session
invisibility and rollback of native storage and the Workspace alias. Existing
target projections were retained, including JSON `null` deletion projections.

Object upload intents must obey the target's resource-owner fence. An unowned
operator upload can be reclaimed immediately by a fenced Runtime reconciler,
even before its upload TTL expires. The successful local operator publication
therefore used a bounded maintenance stop, restored the same Runtime container,
and retained normal reconciliation afterwards. Reclaimed object keys were not
reused; original attachment IDs were retained with fresh backing object keys.

At this checkpoint, this proved authenticated data/native continuity, not
Executor or full cutover acceptance. The source-connected Executors and
production naming were subsequently accepted in the completed cutover above.

## Historical devbox and service-configuration checkpoint

Two additional retained `devbox` mains were atomically published, with complete
source histories, native files, and nine original-ID attachment downloads.
Actual Owner Chromium loaded both chats. The same installed 0.2.0 Executor and
original credential completed a session-scoped read-only directory request and
two deliberately tool-free `1+1` questions, both answered `2`. All previous
messages were retained; these target-only question turns must not be overwritten
by the final source import. The original user Executor service, configuration,
credential and legacy connection were restored after the bounded pilot.

The pilot exposed a platform Dashboard authentication fallback. The deployed
Runtime now requires complete trusted ingress identity for platform Dashboard
connections, while preserving Executor token authentication and Portable
behavior. Anonymous Dashboard access through the legacy compatibility route is
denied; the original 0.2.0 device credential remains accepted.

The source `serper` and `azure_speech` credentials, metadata and timestamps were
decrypted locally and re-encrypted under the existing target organization key.
Neither source nor target encryption keys were replaced. Authenticated Owner
Settings checks, actual search and Azure token issuance succeeded. Final source
delta comparison was subsequently completed before cutover.

The original forwarded Executor address and direct source listener on port
`13000` expose matching legacy Executor snapshots. This proves
endpoint identity, not the exact outer forwarding configuration. At that point,
the compatibility listener, address takeover and production rename had not yet
been performed. They are now complete; the old installation is stopped.

## Native compatibility and production admission

Read-only preflight of the 20 retained mains measured 6,235,026,658 bytes of
Session logs and 1,246,039,265 bytes of native files. Whole-batch in-memory replay
or uncompressed duplicate staging is unsafe on the shared host; the full importer
must be bounded and streamed.

The largest native `events.jsonl` is 559,357,556 bytes and contains 551,342,893
UTF-16 code units, exceeding Node's 536,870,888-unit string limit. The current
SDK `SessionFsProvider.readFile` returns one complete string. PostgreSQL stores
the virtual files in validated content chunks, but that does not remove the
SDK/transport limit. Administrator quotas and available swap are separate issues.

An isolated first-party transport probe streamed an exact-byte encoded reply
without constructing the complete Node string. The current official Runtime
rejected the 572,613,784-byte inbound response, so bypassing Node concatenation
alone is not a production solution. Synthetic, network-disabled probes also
confirmed that a 512 MiB-plus-envelope inbound message is rejected; do not infer
that smaller accepted packets guarantee successful native continuation.

The same current official Runtime successfully resumed an isolated writable
POSIX copy of the complete native directory and returned its current model
metadata. Every original transcript byte remained an unchanged prefix; the
source snapshot and running source were unchanged. No model question, tool or
Workspace modification was performed in this large-file probe. This is native
resume evidence, not live usability or PostgreSQL-backed POSIX acceptance.

Persistence has not regressed to loose text files: target business state and
native virtual-file data are in PostgreSQL; attachments are in S3. The legacy
business `state.sqlite` is distinct from the Copilot `session.db` inbox database.
One devbox inbox database was proven intact and empty; its original binary bytes
are retained in the recovery archive and reversibly in target PostgreSQL,
outside the then-live text-only native directory. The final pilot conversion
restored those binary bytes into the live POSIX `/session.db`; the reversible
recovery copy remains retained. No binary file or nonempty inbox was discarded.

The operator approved a first-party PostgreSQL-backed POSIX repair. In an
isolated schema, its real FUSE mount imported all 126 native files
(561,462,382 bytes), verifying every file's size and SHA-256 on readback. The
official Runtime resumed the complete 559,357,556-byte transcript through that
mount, then resumed it again after stopping the backend, unmounting and restarting
both. All original transcript bytes were unchanged; no model turns or tools ran.

An additional unclean-stop rehearsal killed both the FUSE process and backend
after a SQLite WAL commit without closing the database. After remount, the
database and 24,752-byte WAL remained byte-identical, `integrity_check` passed,
and the committed binary row was recovered. Mounted checks also cover binary
range writes across block boundaries, truncate/regrow zero-fill, rename,
open-file unlink, and SQLite rollback. These are isolated storage/native-resume
results; production integration and full migration were subsequently accepted
separately, rather than inferred from the isolated storage checks.

Runtime migration 10 adds separate 64 KiB `BYTEA` blocks, checksums, nodes and
accounting. Each request is bounded to 1 MiB; this is a transfer bound, not a
file or Session quota. Runtime migration 11 adds an exclusive per-Session native
admission row. The text and binary adapters lock that same row before native
access. `beginNativePosixImport` freezes the text adapter and admits only the
matching staging importer; activation records the verified manifest SHA-256,
blocks that importer, and admits the normal binary adapter. Old text rows remain
intact for recovery. A new empty binary tree can only be initialized for an
empty conversation with no existing native files. Import activation requires a
persisted nonempty `events.jsonl`; it never resumes a missing history as an empty
Session. Drain all model/tool work before establishing the migration barrier.

The binary adapter retains same-transaction tenant/Session/resource-owner
fences and tombstone checks, pins each instance to its first owner epoch, and
uses `synchronous_commit=on`. A successful direct write means PostgreSQL
committed it; no local writeback cache is authoritative. SQLite DB/WAL files use
direct I/O. Only reconstructible `*-shm` WAL indexes permit the page cache/mmap
required by libfuse 3.14; writeback caching remains disabled. The mounted driver
is first-party C using existing FUSE and signed official Ubuntu build packages.

Production mount lifecycle, actual SDK wiring, every retained native tree's
admission and global-data mappings have now passed their separate gates.
Migrations 10/11 and the driver are enabled on the live organization. The actual
`CopilotAgentRuntime` POSIX branch resumed the complete 559 MB native history,
in addition to the direct official SDK proof. Live harmless model turns passed
through PostgreSQL fencing and the mount before and after the final restart.
All four pilots' newer target changes were retained.

## Scope and invariants

Source: the existing `agent-runlab-host` systemd Dedicated installation.
Target: the existing organization-bound PostgreSQL/S3 Dedicated installation.
The target Owner, organization, installation markers, encryption key, and existing
records must not be recreated or overwritten to accommodate migration or naming.

The operator has authorized deletion of independent sub-agent Sessions.
An active log is classified as a sub-agent only when its header contains
`parentSessionId`, `parentCallId`, `subAgentStartedAt`, and a nonempty `agentType`. Fork ancestry alone is
not deletion authority. Unparseable records and ambiguous ancestry are retained.
Parent transcripts, recorded delegation results, and parent-referenced objects
remain protected. Existing orphan-artifact quarantine is not automatically
classified as disposable sub-agent data.

## Execution stages

1. Produce a restricted inventory of every main/sub-agent log, native Copilot
   directory, artifact tree, and quarantine cleanup journal. Record original
   main-log hashes, native identity collisions, invalid records, and capacity.
2. Back up deletion targets and control SQLite state before cleanup. Stream
   compression using existing trusted tooling; verify archive contents and
   hashes. Maintain a disk-space reserve and stop before exhausting the shared
   host filesystem. The LXD pool uses `dir`, so a cheap COW snapshot is unavailable.
3. Use the existing Host cleanup prepare/execute protocol and its active-session
   checks, mutation leases, tombstones, and audits. Verify the resulting target
   Session IDs against the approved explicit-sub-agent inventory. Only purge
   exact verified quarantine paths after their backup has been verified.
   Verify all protected main-log hashes and restore service availability.
4. Stage immutable copies of two `boxpc` main Sessions, their complete native
   Copilot state, log sidecars, and referenced artifacts. Never run a model turn
   against the original Session or write to the user's Workspace for validation.
5. Implement an operator-gated import using existing Session and object
   authorities. Validate native-file encoding, file/Session quotas, original
   hashes, history ordering, object references, organization assignment, and
   destination conflicts before admitting a Session. Keep original log bytes
   as verifiable migration evidence; a compact UI projection is not a substitute
   for preserving the source history.
6. Verify both samples through authenticated Owner APIs and Chromium, including
   complete history, native continuity, artifact access, offline Workspace
   identity, restart persistence, and exact source-to-target checks. If a live
   managed Executor is unavailable, record that limitation instead of claiming
   file/tool execution acceptance.
7. Only after pilot acceptance, prepare the complete recovery set, drain source
   turns/tools/queues/schedules, import final deltas, and validate every main
   Session and referenced object. No parallel old/new execution of the same
   pending operation is permitted.
8. Rename the target installation for normal use. Use stable LXC/project/display
   names rather than test/date labels. Existing physical volumes, network
   bindings, certificates, tenant IDs, and installation markers require explicit
   mapping; changing a Compose project name must never create empty replacement
   databases or buckets.
9. Cut over routing only after private acceptance. Verify OIDC callbacks, PWA
   update/reentry, Socket.IO, and Executor reconnection. Retain the old deployment
   and non-sub-agent recovery data during observation.

## Abort and rollback

An unknown schema, malformed nonempty record, unexplained missing native file,
invalid UTF-8/binary incompatibility, capacity shortfall, shared native identity,
checksum mismatch, destination conflict, or dangling required object blocks
admission or cutover. Errors are reported, not skipped.

Before new application writes, rollback is routing back to the preserved old
authority. After new writes, rollback additionally requires an explicit,
verified reverse-delta export; simply switching back would lose those writes.
Cleanup rollback uses its verified deletion archive and SQLite/control recovery
boundary. Do not resurrect removed sub-agents into the production target.

## Initial observations

The source has approximately 20 main Sessions and 560 explicitly identified
sub-agent Sessions; counts are live inventory observations, not fixed constants.
One zero-byte legacy log has sidecars and must be retained for review.
Most existing quarantine bytes are `orphan-artifacts`, not verified sub-agents.
The shared host initially has only approximately 15 GiB free, so uncompressed
whole-container duplication is not a safe backup strategy.

The first detailed inventory estimates 3,172,035,807 bytes of active sub-agent
logs, artifacts, and native state, plus 443,443,443 bytes in candidate prior
sub-agent quarantine. Keep at least 5 GiB free while making the compressed
deletion recovery archive. Archive verification includes every regular member's
original length and SHA-256, plus source stability during capture.

One retained `boxpc` native tree is 559,791,186 bytes, exceeding the former
256 MiB native-session quota. Native storage quotas now default to unlimited.
Administrators can set `KALA_NATIVE_FS_MAX_SESSION_BYTES`,
`KALA_NATIVE_FS_MAX_FILE_BYTES`, and `KALA_NATIVE_FS_MAX_NODES` in the trusted
Runtime service environment (Portable SQLite uses the same options). Unset or
zero means unlimited; other values must be non-negative safe integers. Apply
the configuration consistently to replicas and restart the Runtime service.
These are operator settings, not client-supplied Session parameters.

Quota reductions do not prevent reading, removing, or shrinking existing data.
Configured caps refuse growth atomically; they never truncate existing files.
Runtime schema migration 9 widens native byte/node/chunk counters to PostgreSQL
`bigint`, retaining migration 7's original checksum and all stored content.
Apply it through the trusted operator migrator before replacing a schema-8
Runtime; the application DML role must not be granted schema modification.
Unlimited quotas do not mean unlimited physical disk/RAM or a streaming SDK
`readFile` API: that text SDK contract still returns a complete string. The
production binary POSIX backend avoids whole-file string/RPC transfers rather
than imposing a smaller transcript cap. Native binary/UTF-8 compatibility and
individual transfer bounds remain separate checks.
