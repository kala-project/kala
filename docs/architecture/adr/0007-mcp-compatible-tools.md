# ADR 0007: JSON-Schema tool contracts and MCP adapter boundary

**Status:** accepted (updated to reflect the current codebase)
**Date:** 2026-07-04; clarified 2026-10-05

## Context

Kala has a native tool protocol between Host and Executor, and a growing ecosystem of third-party Model Context Protocol (MCP) servers. Aligning the *shape* of input definitions with JSON Schema makes tools adaptable to MCP, but does not turn our native tool wire contract into MCP.

The older wording of this ADR claimed that native tool output was structured MCP content and that schemas were owned by the Executor. Neither is true of current code: the Host constructs model-facing `ToolSchema` definitions in `packages/host/src/builtin-tools.ts` and records them in session configuration; Executor `name → runner` does not include schemas. Native `tool:result` is `{ ok: boolean, content: string }`. `docs/reference/executor/tools.md` is documentation, not the authoritative full schema catalog.

## Decision

1. **Keep native transport.** Host ⇄ Executor uses the existing Socket.IO reverse connection and current tool effects/results. Native string results are **not** lossless MCP content blocks; do not describe them as a one-to-one protocol mapping.
2. **Use JSON-Schema-shaped model-facing inputs.** The Host's `ToolSchema.inputSchema` and tool name/description can be adapted to MCP `Tool` input declarations, subject to validation of the MCP server's schema. This is a compatibility *boundary*, not a guarantee that every internal tool or MCP feature is already supported. Do not treat the separately maintained `docs/reference/executor/tools.md` as runtime authority.
3. **First MCP direction is client integration.** The Executor hosts stdio MCP clients; the Host continues to own schema exposure and approval. The `executor:announce` wire contract must be extended to provide validated, versioned third-party tool descriptors; reporting names alone is insufficient. A Host `ToolSchema` created from a generic MCP tool must require approval by default, regardless of MCP annotations. Existing Kernel event/effect shapes remain unchanged.
4. **Explicit content limits.** Translate supported MCP text results to the native string result. Reject or clearly mark unsupported content types and `isError`; never silently drop blocks. An eventual MCP-server adapter for external clients, non-text results or richer bidirectional transport is a separate decision.
5. **Security and compatibility.** Server configuration belongs to the Executor operator, not model-generated instructions. Do not use shell interpretation of server commands. Host validates catalog ownership against the announcing workspace Executor; do not allow remote descriptors to override built-ins or downgrade approval. Old Executors without descriptors continue to work with built-ins.

The operational design, lifecycle, tests and first-slice limits are specified in [MCP runtime integration](../../host/mcp.md), which is the source of truth for implementing this adapter.

## Consequences and verification

- Schema discovery and execution require changes to **shared, Host and Executor**; the SDK only belongs in Executor. Dashboard need not introduce a parallel approval policy.
- Third-party tools must be visible to new model sessions with the correct schema, while missing or crashed servers must fail closed. Active-session refresh/historical replay must not be advertised without specific tests.
- Dashboard-managed settings are a separate, authenticated operator control plane for a credential-bound, Dashboard-installed Executor. The Executor alone executes and persists the configuration; Host settings return server names, not executable arguments or environment values. CLI/environment-based and legacy installations remain locally configured.
- Verify valid and invalid schema announcements, prefix collisions, approval semantics, text/result conversion, crash/cancellation and normal built-in paths with fixture-server tests.
- MCP server exposure to external clients remains **not implemented**; this ADR does not make an interoperability or full MCP-conformance claim.
