/**
 * Runtime schemas for cross-process boundaries.
 *
 * Convention:
 *   - Every wire-protocol envelope defined in ../protocol.ts should have a
 *     matching Zod schema here. Where a schema is authoritative, derive the
 *     TS type via `z.infer<typeof S>` and re-export.
 *   - Only validate at trust boundaries (socket handlers, HTTP handlers,
 *     JSONL log ingest). Never inside pure internal functions.
 *   - Prefer `.strict()` on message envelopes so unknown fields surface as
 *     protocol drift instead of being silently dropped.
 */

export * from './kernel.js'
export * from './executor.js'
export * from './dashboard-inbound.js'
export * from './dashboard-outbound.js'
export * from './executor-installation.js'
export * from './settings-operator.js'
export * from './settings-webhooks.js'
export * from './settings-model-management.js'
export * from './settings-operational.js'
