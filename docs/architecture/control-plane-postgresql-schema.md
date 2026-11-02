# Control-plane PostgreSQL Schema

Status: normative schema refinement of the [deployment-mode SoT](./deployment-mode-contract.md), not a claim that every target invariant is implemented.
Migrations: ordered files in `packages/runtime-ingress-gateway/migrations/`; durable delivery is `0008_webhook_deliveries.sql` and governance/retention is `0009_governance_ledger_retention.sql`.

## Aggregate boundaries

- **Organization aggregate:** Organization, contract entitlement, membership, invite, retention policy and Runtime Unit placement.
- **Workspace aggregate:** Workspace, grant and versioned Tool Policy.
- **Executor aggregate:** pool, machine identity and one-time enrollment token.
- **Identity/session aggregate:** principal, browser session and notification device.
- **Ledgers:** Usage/Audit records and Outbox event envelopes are append-only from application code. Separate per-endpoint webhook delivery rows carry mutable, lease-fenced operational state.

All tenant-owned relationships carry `organization_id`. Composite foreign keys prevent a Workspace, membership, pool, browser session, notification device or Executor from referencing an object in another Organization even if IDs collide or application authorization is defective.

## Invariants requiring transactions

PostgreSQL constraints cover shape and referential isolation. The repository transaction must additionally enforce:

1. Organization provisioning creates Organization, Owner membership, entitlement, retention policy, placement and Outbox event atomically.
2. Owner transfer locks all memberships for the Organization, creates/promotes the new Owner, demotes the prior Owner and increments `authorization_version`; commit is rejected if no active Owner remains.
3. Membership/grant/policy/contract changes increment `authorization_version` and append Audit + Outbox in the same transaction.
4. Executor enrollment consumes `used_count` with `SELECT ... FOR UPDATE`, verifies expiry/revocation, inserts machine identity and appends Audit atomically.
5. Placement mutation compares generation and `last_operation_id`; stale generations fail and repeated operation IDs return the original result.
6. Usage insertion is idempotent on `(organization_id, source_operation_id)`.
7. Audit and Usage rows are never updated or deleted by ordinary application/retention roles, including through FK cascades or SET NULL. Intent/outcome rows append separately; per-Organization/day retention admission and its captured cutoff live in a mutable operational table. Retention uses a separate narrowly scoped identity and never silently replays unresolved Runtime effects; the deployment-mode SoT defines admission and settlement.
8. Outbox recipient fan-out and delivery claims use short `FOR UPDATE SKIP LOCKED` transactions. Each endpoint has independent attempt/terminal state and a lease token/generation; completion requires the current unexpired claim. HTTP and SecretResolver calls occur outside transactions. Legacy unresolved events require review, never automatic replay. The deployment-mode SoT defines the protocol and rollout boundary.

## Deliberate choices

- IDs are application-generated opaque text so imports preserve identity; database sequences are not exposed externally.
- Money/cost estimates use integer microunits, never floating point.
- Token and invite plaintext is never persisted—only cryptographic hashes.
- Provider refresh tokens and push subscriptions remain encrypted envelopes pending migration to `credentialRef` where appropriate.
- Runtime Session/Event Log payloads are not copied into this schema.
- `jsonb` is limited to versioned policy/capability/device/metadata envelopes; query-critical authority remains typed columns.
- Tenant subdomains and tenant URL slugs are not routing dependencies. Optional `slug` is display/admin metadata only.

## Migration policy

- Forward migrations are immutable, ordered SQL files recorded in a migration ledger with checksum and execution time.
- Startup may verify schema compatibility but must not run unbounded DDL in every application replica.
- Destructive changes use expand/backfill/verify/contract across releases.
- Every migration runs with statement and lock timeouts and fails before traffic cutover if a required lock cannot be acquired.
- A release records the minimum and maximum compatible schema versions for Gateway and worker binaries.

## Security roles

- `runlab_migrator`: DDL only during controlled release.
- `runlab_app`: CRUD on mutable control tables; insert/select only on ledgers; no schema ownership.
- Separately provisioned webhook identity: SELECT events/endpoints/deliveries/schema/installation markers, INSERT deliveries and UPDATE only fan-out/delivery progress columns; no other maintenance jobs, ledger mutation, schema ownership or Runtime/S3 authority. The operator chooses its role name.
- Separate narrowly scoped maintenance identities own deliberate retention/repair jobs; they are not webhook worker credentials.
- `runlab_backup`: read-only backup privileges.
- ZITADEL uses a separate database and role.

Production connections require TLS and server identity verification. Credentials are resolved through the secret boundary and are not stored in Compose environment values or repository files.

## Source implementation boundary

Migration 0008 separates immutable event envelopes from per-endpoint snapshots/attempts/leases. Endpoint invalidation generation prevents disable/re-enable or URL/reference reversion from reviving old work. The producer's six envelope INSERT columns exclude operational state. Physical event/endpoint deletion is restricted while delivery history references it; logical endpoint deletion disables delivery. Event-level legacy completion/retry columns remain historical, not the new delivery completion view.

The [design/status ledger](./private-cloud-design-status.md#durable-external-delivery-bounded-local-source-acceptance) records the source acceptance and gaps. Migration 0009 closes ordinary Audit/Usage mutation and attribution-loss paths, makes principal identity keys immutable, separates maintenance grants from the app writer, and stores daily retention admission/settlement separately from immutable audit records. The shared effective-role audit rejects excess inherited/column/function authority and high-privilege logins disguised with SET ROLE. Old identity data already nulled or audit intentions already overwritten cannot be reconstructed by this migration. Existing cross-Organization usage/Workspace references must be reviewed before migration; the FK is validated, never silently rewritten. Privileged archive/anonymization and unresolved-operation reconciliation tooling remain separate implementation gates, as do Workspace authorization and subscriber administration.
