# Session storage inventory and cleanup

Kala treats Session transcripts as authoritative data. Storage reporting and
cleanup therefore run outside the event append path and fail closed.

## Growth control

External Runtime projections keep their latest compacted state in an atomic
snapshot sidecar. Repeated projections append only bounded runtime metadata to
the main JSONL. Existing JSONLs with embedded snapshots remain readable. This
avoids growth proportional to `event count × complete projected state`.

Kernel event artifacts remain separate from authoritative replay entries. When
a full redacted LLM trace exists, Kala does not also persist the large
`call_llm` effect payload: the trace is the detailed diagnostic authority and
the JSONL retains a slim effect marker. If no trace exists, the complete effect
is retained as a fallback. This removes the dominant duplicate copy while
keeping every request debuggable.

## Lazy inventory

`StorageInventory` persists cached totals in SQLite. Construction and cached
queries do not scan the Session directory.

- `markDirty()` changes in-memory counters and coalesces persistence; it does
  not write SQLite for every event.
- The default flush interval is 600 seconds.
- `reconcile()` is explicit, singleflight and metadata-only. It reads the first
  JSONL line to identify a Session and uses `lstat` for sizes.
- Reconciliation ignores symlinks and yields periodically.
- Dirty deltas received during a reconciliation are merged into the completed
  scan instead of being overwritten.
- Session queries expose direct and descendant-tree totals. Global queries
  expose category totals, largest root trees and orphan candidates.

The Dashboard reads cached values when a Session Info or Storage panel opens.
The Refresh action starts reconciliation and displays the measurement time.
Any Session or storage write only invalidates the cached measurement in memory;
this advisory callback cannot reject or roll back an already committed Kernel
event. Observer failures are reported as process warnings.

## Safe cleanup

Cleanup is a prepare/execute transaction:

1. Prepare resolves the exact target set, rejects active Sessions, rejects
   symlinks and path escapes, verifies quarantine is on the same filesystem,
   and records device, inode, size and modification time for every item.
2. The Dashboard shows the operation, item count, estimated bytes and expiry.
3. The operator must pass two separate confirmation steps. Preparing a plan is
   not itself treated as either confirmation.
4. Execute checks plan ownership and repeats all active-state and file-identity
   checks before mutation.
5. A durable journal is fsynced, then exact top-level targets are atomically
   renamed into a per-plan quarantine directory.
6. Audit metadata records identities and byte counts, never transcript
   content. Startup recovery validates both remaining sources and already moved
   quarantine targets against the original manifest before completing a journal.

Quarantine is never automatically purged by this mechanism. A later retention
policy may permanently purge it only after an explicit grace period.

`subagent-details` is allowed only for child Sessions. Detail and tree cleanup
write a small durable tombstone outside the authoritative transcript before the
first move. The Host loads those tombstones at startup, evicts quarantined
records while the per-Session mutation lease is held, and rejects later
load/ensure/create/write attempts for the same IDs. This prevents stale clients
or cached runtime objects from recreating headerless logs after cleanup. The
result remains embedded in the parent Session. Root Session deletion continues
to use the existing full-tree operation.

The mutation lease also gates mutating Session loads. Loads admitted before a
cleanup lease are allowed to finish and are awaited; loads arriving after the
lease begins fail before reading or publishing a record. Cleanup therefore
cannot race dangling-turn recovery or sidecar persistence.

Host-wide orphan and derived-artifact operations are unavailable to
organization-scoped ingress actors. Session operations revalidate tenant
ownership for every Session in the plan.

The inventory and cleanup services are Host control-plane facilities. They do
not participate in Kernel transition calculation, do not modify event folding,
and do not become an alternative source of Session state authority.
