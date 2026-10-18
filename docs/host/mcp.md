# MCP runtime integration

**Status:** First stdio MCP client slice implemented locally; not deployed. The limitations below remain part of the contract. See [implementation checklist](#implementation-checklist).

## Current code and boundaries

- The Host owns model-facing tool definitions (description, JSON input schema, execution handler and `requiresApproval`) in `packages/host/src/builtin-tools.ts` and the session's `AgentConfig.tools`. The Executor registry holds `name → run`; `executor:announce.mcpTools` now optionally carries third-party schemas and hashes in addition to legacy names. Host validates these and snapshots them into **new** sessions for their owning workspace.
- The wire `tool:result` contains a **string**, not MCP content blocks. Tool input schemas are JSON Schema-shaped. Kala consumes third-party stdio MCP tools, but is **not** an MCP server. [ADR 0007](../architecture/adr/0007-mcp-compatible-tools.md) records this distinction.
- The Host/Kernel evaluates approvals. `auto` consults `requiresApproval`; `ask` prompts for every call; `deny` rejects calls requiring approval; `allow_all` bypasses prompts under Host policy. Do not assume a `KALA_ALLOW_ALL_OK` guard exists. All discovered third-party MCP tools are marked `requiresApproval: true` by the Host.
- Executor reconnection re-announces its catalog; a third-party server crash removes its tools and re-announces. Existing sessions keep their original catalog snapshot: deleted or same-name/different-schema tools fail closed on invocation, not hot-refreshed in model context.

## First supported slice: third-party tools as an Executor MCP client

```
Dashboard ⇄ Host (session tool schemas + approval) ⇄ Executor (MCP client) ⇄ stdio MCP server
```

The MCP client runs next to the sandbox in the Executor. The Host remains the **authority for model-visible schemas and approval**, while the Executor remains the authority for the live server process and tool execution. The shared announce protocol must carry validated MCP tool descriptors as well as legacy tool names. A new Host session binds a snapshot of the currently available tools from its workspace Executor; when the Executor disconnects or a server exits, calls must fail closed rather than silently falling back to another executor. Active session catalog refresh and historical replay semantics must be specified and tested before advertising them as supported. This design does not change Kernel effect/event shapes.

For the first slice, support `tools/list` and `tools/call` over **stdio** using the official `@modelcontextprotocol/sdk` client. Name every advertised tool `<server_name>__<tool_name>`, validate against model-provider name restrictions, refuse collisions with built-ins, and retain a reverse mapping to the original server/tool. The Host must receive a safe description and JSON input schema and create a ToolSchema with `executionKind: 'executor'`, `executionHandler` set to the prefixed name and **`requiresApproval: true` by default**. Preserve built-in behavior. Never accept MCP-provided metadata as authority to waive approval.

A tool catalog change must be versioned or hashed so Host and Executor cannot silently disagree about a schema. An unavailable tool must not be advertised to new sessions; already-running calls should fail explicitly if its server exits. Any policy for changing active sessions' model-visible catalog must be documented and verified before enabling live refresh.

## Configuration and secrets

MCP servers are configured at Executor startup, not in the Kernel prompt or an untrusted tool result. Prefer structured `{ name, command, args, env }` declarations rather than interpreting one concatenated shell command: do **not** execute a user-supplied command through a shell or interpolate `$VARS` in argument strings. Validate server names, duplicates, executable/argument shapes and relevant sandbox/trust constraints before spawning. Support the actual interactive and managed-Executor startup routes before claiming either is available. Never log command-line secrets, environment values, tool arguments or server stderr unredacted. A third-party MCP subprocess is trusted operator configuration and may have external side effects; approval remains per call.

## Dashboard-managed configuration (local implementation, not deployed)

The Workspace → MCP servers setting can manage **online Dashboard-native installed Executors** only. It uses `GET/PUT /settings/mcp` with an explicit workspace ID and a dedicated Host → Executor Socket.IO control message; the Host never starts third-party processes. The operator must be authenticated (GitHub, shared bearer token or trusted ingress owner/admin), and Host checks organization ownership and the installation ID bound to the actual Executor credential before forwarding commands. Anonymous access, legacy/unbound installations and CLI/environment-managed Executors cannot be managed here; use the Executor's `--mcp`, `MCP_SERVERS` or local service config instead. Existing installations redeemed before credential binding must be reinstalled to enable Dashboard management.

The UI accepts an entire replacement list of `{ name, command, args: string[] }`, warns that saving executes code under the Executor account, and requires explicit confirmation. It does not invoke a shell or split a command string. `env` is intentionally unsupported via the Dashboard endpoint; values in command arguments can still be sensitive and should not contain tokens. Settings GET and PUT responses expose **server names only**; operators must re-enter command and arguments for *every server they wish to keep* when replacing the list. Do not return or audit commands, arguments or environment values. The Executor validates and initializes all candidates first, then atomically saves its own restricted managed config, switches the live catalog and reannounces; on failure it retains the previous configuration. It does not restart the service. Existing Sessions retain their original model-facing catalog and fail closed for changed tools.

## Tool results and failure semantics

The existing Host ↔ Executor result is `{ ok, content: string }`. The first slice must define a deterministic conversion for **text-only** MCP tool results and `isError`, and explicitly reject or flag image, resource, audio and unrepresentable structured content instead of silently discarding it or claiming lossless MCP compatibility. Errors, startup timeouts, per-call timeouts and cancellations should be explicit and should not be mistaken for successful tool output. Treat MCP tool descriptions/schemas and server responses as untrusted data; apply size and nesting bounds.

Use the existing `tool:call` routing, abort signal and approval state machine. MCP subprocesses belong to the Executor lifecycle: bounded initialize and `tools/list`, one failed server must not block built-ins or other servers, server exit invalidates its tools and in-flight calls, and shutdown terminates child processes (TERM, then KILL after a grace period). Re-announcement must update the Host catalog atomically. The Executor's current synchronous `close()` and direct exit paths must be accounted for if asynchronous cleanup is added.

## Not in the first slice

- Exposing Kala as an MCP **server** to outside clients (a separate adapter and security boundary).
- HTTP/SSE/streamable-HTTP transport, MCP resources/prompts/sampling, dynamic server administration, credential brokerage or progress forwarding.
- Lossless non-text content or per-tool trust exemptions.

## Implementation checklist

- [x] Structured repeated `--mcp` JSON declarations, managed config `mcpServers`, and `MCP_SERVERS` JSON array; CLI overrides managed config, which overrides environment. Explicit validation; SDK dependency isolated to Executor.
- [x] MCP stdio client discovery and `tools/call`, prefixing, collision checks, timeouts, cancellations and child cleanup. Server crashes remove tools and trigger reannounce; no automatic server restart.
- [x] Versioned schema descriptors in shared announce; Host hash/schema validation, workspace-scoped **new-session** catalog snapshot and approval-required default. Existing sessions reject missing or incompatible live schemas, not hot-refresh them.
- [x] Text-only conversion, `isError` and unsupported content errors, failure isolation, real stdio fixture tests and Socket.IO Host integration tests.
- [x] Dashboard-managed Executor MCP configuration with authenticated operator, credential-bound installation and workspace checks, names-only settings responses, strict validation, Executor-local atomic persistence and live catalog replacement. Never grant this endpoint to anonymous users.
- [ ] End-to-end tests with a deployed, externally managed third-party server and active-session model-context refresh; neither is claimed by this initial slice.
