# Executor Protocol Reliability Audit

**Status:** focused implementation complete
**Invariants:** S8, S10, S13, S18

## Confirmed defects

- Executor in-memory and durable receipt keys used only `callId`. Identical provider call IDs in different Sessions collided.
- Hosted loopback Executors explicitly disabled durable receipts despite performing real filesystem mutations.

## Changes

- Receipt/in-flight/completed identities are now scoped as `sessionId:callId`.
- Tool cancellation uses the same scoped identity.
- Hosted loopback Executors persist receipts under the Unit Workspace `.kala` directory.
- Added a two-Session/same-callId regression proving both tools execute independently.

## Evidence

- Executor typecheck passed.
- Executor suite: 29 files, 165 passed.
- Hosted TenantRuntimeUnit focused suite: 5 passed.

## Deferred to downstream integration

Organization/Workspace generation must become an explicit wire operation identity for remote customer Executors. Session scope fixes the demonstrated collision, while `outboundChannelReliability` and enrollment work own cross-generation credential/operation identity and compatibility negotiation.
