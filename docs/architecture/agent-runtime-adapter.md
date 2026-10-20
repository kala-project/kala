# Agent Runtime Adapter Contract

**Status:** source of truth
**Scope:** Agent backend selection, Kernel preservation, GitHub Copilot SDK integration, Dashboard behavior, persistence, recovery, tenancy, and deployment

## 1. Decision

Agent RunLab supports multiple Agent runtimes through a Host-owned
`AgentRuntimeAdapter` boundary.

The existing Agent Kernel remains the default runtime and keeps its current
pure-reducer architecture. GitHub Copilot SDK is integrated as a separate Agent
runtime, not as an `LLMAdapter` and not as a replacement for the Kernel.

```text
Dashboard / Runtime APIs / Session directory
                    |
           AgentRuntimeRegistry
             /             \
  KernelAgentRuntime   CopilotAgentRuntime
          |                    |
 pure Kernel + Host loop   Copilot SDK
 LLMAdapter + Executor     Copilot CLI runtime
```

The canonical runtime identifiers are:

- `kernel`: the existing Agent RunLab Kernel and Host loop;
- `copilot`: GitHub Copilot SDK backed by the bundled or externally managed
  Copilot runtime.

Unknown runtime identifiers fail closed. Existing Session logs without a
runtime identifier are interpreted as `kernel`.

## 2. Non-negotiable Kernel invariants

The adapter work must not weaken the existing Kernel design:

1. `step(state, event, config)` remains pure and deterministic.
2. Kernel events and effects remain provider and vendor agnostic.
3. The Kernel runtime's append-only JSONL remains its authoritative state.
4. `LLMAdapter` remains a model-provider port used only by the Kernel runtime.
5. Executor Tool dispatch, approval, compaction, Queue, replay, fork, restart,
   and planned continuation retain their current semantics for `kernel`
   Sessions.
6. Copilot SDK types, events, persistence concepts, and lifecycle calls must not
   enter `packages/kernel`.
7. Existing Sessions, protocol clients, release assets, and deployments that do
   not specify a runtime continue to behave exactly as `kernel`.

The first migration extracts the current behavior behind
`KernelAgentRuntime`; it does not rewrite the Host loop.

## 3. Runtime ownership

An Agent runtime owns one complete Agent loop. Two runtimes must never drive the
same Session.

### 3.1 Kernel runtime

The Kernel runtime owns:

- Agent state and reducer transitions;
- LLM call scheduling;
- Tool call and approval effects;
- compaction and context policy;
- Queue continuation;
- Kernel Session replay and recovery.

### 3.2 Copilot runtime

The Copilot runtime owns:

- Copilot conversation and Agent loop;
- Copilot model turns and internal context management;
- Copilot-native Session persistence;
- Copilot-native tool invocation sequencing;
- Copilot cancellation and resume operations.

RunLab continues to own:

- product Session identity and access control;
- tenant and Workspace routing;
- Dashboard protocol and UI state;
- admission, deployment, audit, retention, and artifacts;
- Tool authorization and dispatch into the selected Workspace;
- mapping between RunLab Session IDs and Copilot Session IDs.

The Copilot CLI process runs on the Host and must use a Host-local working
directory. A Session `cwd` belongs to its Workspace Executor and is passed only
through RunLab custom Tool dispatch; it must never be used as the SDK process
working directory.

Copilot is enabled by default while Kernel remains the recommended runtime for
new Sessions. Operators can set `KALA_COPILOT_ENABLED=1` to explicitly enable
Copilot, or turn it off with `KALA_COPILOT_ENABLED=0` (or `false`), or with
`copilot.enabled: false` when embedding the Host. An enabled Host loads
`@github/copilot-sdk` at startup; if it is missing, the Host still starts and
reports `unavailable`. Install SDK
and its optional platform dependencies **in the Host installation directory**
using `npm install --include=optional @github/copilot-sdk@1.0.14`, then restart
the Host. Installing on the browser or Workspace Executor does not help.
Standalone bundled executables cannot be repaired with this npm command: they
must be replaced with a complete release containing the Copilot platform assets.

Kala does not select a separately published CLI by default. The official
`@github/copilot-sdk` first discovers the platform-specific `@github/copilot`
package installed in its npm dependency tree. Operators may instead set
`COPILOT_CLI_PATH` to a compatible, executable Copilot CLI. If neither source is
available, the runtime remains visibly `unavailable` with remediation rather
than being reported as disabled. Authentication errors are reported separately;
reinstalling the SDK does not log in to Copilot. The platform package and its
license remain part of an npm deployment of the SDK; that is distinct from
copying its binary into a Kala release or container as a separately managed asset.

Copilot must not be implemented through `LLMAdapter.call()`. Doing so would
create two competing Agent loops and make Tool, approval, replay, and
compaction ownership ambiguous.

## 4. Adapter contract

The Host exposes one internal runtime contract:

```typescript
export type AgentRuntimeId = 'kernel' | 'copilot'

export interface AgentRuntimeAdapter {
  readonly id: AgentRuntimeId
  readonly capabilities: AgentRuntimeCapabilities

  create(input: AgentRuntimeCreateInput): Promise<void>
  load(input: AgentRuntimeLoadInput): Promise<void>
  prompt(input: AgentRuntimePromptInput): Promise<void>
  cancel(sessionId: string): Promise<void>
  close(sessionId: string): Promise<void>
}
```

Adapters publish normalized runtime events through a Host-owned sink. The
normalized surface includes:

- lifecycle status;
- assistant text and streaming deltas;
- Tool start, progress, completion, and failure;
- permission request and resolution;
- usage when available;
- runtime error;
- idle/completed state;
- opaque native-event artifact references.

The normalized event model is a product projection, not a claim that all
runtimes implement identical internal semantics. Runtime-specific information
may be retained as redacted artifacts and exposed only through capability-gated
debug views.

### 4.1 Context-management contract

Both adapters publish one normalized, effective compaction policy. The policy
states:

- whether the Host or runtime owns context replacement;
- whether automatic compaction runs at a safe boundary or in the background;
- warning, start, and optional blocking thresholds;
- whether work may continue while compaction runs;
- manual-compaction behavior while a turn is active;
- whether the summary is Host-gated or merely runtime-reported.

This policy normalizes observability, not implementation. Kernel compaction
remains Host-owned and replayable through `messages_replaced`. Copilot
compaction remains SDK-owned and is projected from native lifecycle events.
The Dashboard must use the policy rather than branching on the runtime ID.

Lifecycle events distinguish immutable start/completion snapshots from the
latest current usage snapshot and carry a root/subagent scope. Copilot events
with an `agentId` must never update root context state or root compaction
markers.

Manual compaction enters the selected adapter in all cases:

- `KernelAgentRuntime` delegates to the Host loop;
- `CopilotAgentRuntime` delegates to `history.compact`.

The Dashboard namespace must not fall through to a runtime-specific loop.

## 5. Session persistence and authority

Every Session header stores:

```typescript
{
  agentRuntime: 'kernel' | 'copilot'
  agentRuntimeVersion?: string
  externalSessionId?: string
}
```

Compatibility rules:

- missing `agentRuntime` means `kernel`;
- `kernel` keeps the current format and authoritative event stream;
- `copilot` stores a RunLab lifecycle/projection log plus a stable mapping to
  Copilot Session state;
- a Copilot Session is resumed through the SDK, not reconstructed by folding
  projected RunLab events through the Kernel;
- projected Copilot events must never be fed to `step`;
- native Copilot events may be stored as redacted Session artifacts;
- deleting a RunLab Copilot Session deletes or tombstones the mapped Copilot
  Session according to the configured retention policy.

Ingress admission, durable message queues, Dashboard reconnect hydration, and
deployment continuation must dispatch through the Session's registered
`AgentRuntime`. The Kernel Loop fails closed if asked to mutate a non-Kernel
Session.

Each durable Copilot projection change is appended as a `runtime_metadata`
record followed by an authoritative `snapshot` at the next cursor. There is
deliberately no synthetic Kernel `event` entry. `SessionStore.loadFromFile()`
loads the latest snapshot for non-Kernel runtimes and skips Kernel fold/crash
recovery; the Dashboard likewise does not call Kernel `step()` for those
Sessions.

Fork remains a Kernel capability until a runtime explicitly advertises
semantically equivalent fork support. The Dashboard must not emulate fork by
copying projected events.

## 6. Tool and permission bridge

Copilot runs in the SDK's safe explicit-tool mode. Ambient Copilot CLI
filesystem and shell tools are disabled for shared Platform runtimes.

RunLab registers selected existing tools as Copilot custom tools. Each handler:

1. resolves the RunLab Session and bound Workspace;
2. validates the current tenant, Session, Workspace, and Tool policy;
3. requests approval through the RunLab permission surface when required;
4. dispatches through the existing Host/Executor Tool boundary;
5. returns a bounded, structured result to Copilot;
6. records normalized Tool lifecycle and timing evidence.

Every registered RunLab custom Tool explicitly overrides an SDK built-in with
the same name. Built-in and MCP tools remain excluded, so the RunLab
authorization and dispatch path is the only executable implementation.

Kernel and Copilot must call the same runtime Tool dispatcher. The dispatcher
applies memory policy and pre/post hooks before routing by the configured
`executionKind`: Host tools stay in the Host and Executor tools cross the
Workspace Executor boundary. A runtime must never call the Executor registry
directly for an arbitrary model-facing Tool name.

Tool handlers must not bypass Executor sandbox roots, existing authorization,
audit, cancellation, or output limits.

Copilot permission callbacks are mapped to the same Dashboard approval
experience, but they are not converted into Kernel `user_approve` or
`user_reject` events. Each runtime owns its own permission continuation.

## 7. Dashboard contract

Agent runtime selection is a first-class Session creation decision.

### 7.1 Creation

The New Session dialog displays available Agent runtimes before creation:

- **Agent RunLab** (`kernel`) is selected on first use;
- the Dashboard remembers the user's most recently selected runtime and
  preselects it for later Session creation when it is available;
- an unavailable remembered runtime falls back to an available runtime without
  discarding the preference;
- **GitHub Copilot** (`copilot`) is shown only when the Host reports it ready;
- unavailable runtimes remain visible only when an actionable configuration
  message can be shown; otherwise they are omitted;
- Workspace, initial directory, model, and Tool controls are filtered by the
  selected runtime's capabilities.

`client:create_session` accepts `agentRuntime`. The Host validates it against
the runtime registry before persisting the Session. The acknowledgement is not
successful until the selected runtime has completed its durable create
boundary.

### 7.2 Session identity

Session lists include:

```typescript
{
  agentRuntime: 'kernel' | 'copilot'
  agentRuntimeVersion?: string
}
```

`session:ready` includes:

```typescript
{
  agentRuntime: 'kernel' | 'copilot'
  agentRuntimeCapabilities: AgentRuntimeCapabilities
}
```

Session metadata shows the human-readable runtime label, stable runtime ID, and
persisted runtime version without replacing the Session title or Workspace
identity.

### 7.3 Capability-driven interaction

The Dashboard must not infer behavior from the runtime name. It uses advertised
capabilities to enable:

- model selection;
- approval-mode editing;
- context compaction;
- Session clearing and working-directory mutation;
- image attachments and memory consolidation;
- replay and fork;
- Queue/Steer;
- Tool detail and native trace views;
- sub-agent controls;
- runtime-specific usage.

Unsupported controls are removed or disabled with an explanation. The server
also rejects unsupported raw protocol requests.

Sub-agent Sessions inherit the parent Session's Runtime identity and version.
The Host must execute and cancel the child through that Runtime rather than
silently falling back to the Kernel Loop.

### 7.4 Transcript projection

Both runtimes render through one transcript vocabulary:

- user message;
- assistant text and streaming state;
- Tool activity;
- permission request;
- warning/error;
- completion/idle.

Copilot reasoning and native events are never silently coerced into Kernel
events. They use optional, capability-gated presentation records. Unknown
native event types are preserved as artifacts and do not break transcript
rendering.

Persisted runtime metadata contains only native event identity, type, and
timestamp. Prompt, response, reasoning, Tool arguments, credentials, and other
provider payload fields must be projected through the typed Session snapshot
or a dedicated redacted artifact rather than copied wholesale.

### 7.5 Recovery UX

On reconnect, the Dashboard shows whether a Session is:

- loading RunLab projection;
- reconnecting to its Agent runtime;
- resuming external runtime state;
- ready;
- blocked because the configured runtime is unavailable.

A Copilot runtime outage must not be presented as loss of the RunLab Session.

## 8. Runtime discovery and configuration

The Host exposes a sanitized runtime catalog containing:

- stable runtime ID and display label;
- availability and normalized reason when unavailable;
- version;
- capability flags;
- supported models when safe to expose;
- authentication mode without credentials.

Copilot configuration is resolved only by the Host composition root. Secrets
must not enter Session JSONL, Dashboard payloads, logs, traces, release
manifests, or deployment receipts.

Dedicated and Private Cloud may disable `copilot` entirely. Absence is an
expected configuration, not a degraded Kernel runtime.

## 9. Tenancy and security

Shared Platform deployments use Copilot SDK `mode: "empty"` and explicit Tool
registration.

- A RunLab Session maps to one Copilot Session.
- Session ownership is checked before create, resume, prompt, cancel, delete,
  or artifact access.
- Per-user GitHub tokens are used when the deployment authenticates Copilot as
  the end user.
- A shared personal Copilot credential must not be exposed across tenants.
- `COPILOT_HOME` and SDK Session state are isolated by Runtime Unit or provided
  through a tenant-aware `sessionFs`.
- Copilot runtime JSON-RPC endpoints remain private and require an equivalent
  service boundary if moved out of process.

## 10. Restart and deployment

The existing deployment mechanisms remain authoritative.

### Dedicated

- Copilot runtime state lives below the logical Unit data root, never inside an
  immutable release directory.
- The active slot is the only writer for the Unit's Copilot state.
- checkpoint drain prevents new prompts and waits for active adapter
  operations to reach a safe boundary;
- the candidate slot validates SDK/runtime compatibility without opening
  mutable Session state;
- after write-lease handoff, the candidate reconnects or resumes Copilot
  Sessions before `runtime_ready`;
- route generation, admission reconciliation, public verification, and
  rollback remain Supervisor-owned.

### Private Cloud

- Copilot state and credentials are Unit scoped;
- Runtime, Ingress, Dashboard, PostgreSQL, and storage release lifecycles remain
  unchanged;
- no Copilot runtime port is exposed publicly;
- backup/restore includes the configured Copilot Session-state authority.

No deployment script may copy files directly into the active Runtime release or
restart the LXD-hosted service outside the Dedicated Supervisor protocol.

## 11. Delivery sequence

1. Add runtime identifiers and capability contracts with `kernel` defaults.
2. Wrap current Host-loop entry points in `KernelAgentRuntime` without behavior
   changes.
3. Add runtime catalog and Dashboard creation/runtime metadata UI.
4. Add Copilot SDK dependency and `CopilotAgentRuntime`.
5. Bridge explicit Copilot custom tools to existing Executor dispatch.
6. Add permission, cancellation, streaming, persistence, and recovery.
7. Add process, Browser, restart, and isolation acceptance.
8. Build immutable release assets and deploy through `deploy:dedicated` to the
   inactive LXD slot.

## 12. Acceptance

- every legacy Session loads as `kernel` without migration;
- Kernel unit, integration, replay, Queue, compaction, and restart tests remain
  unchanged and pass;
- creating each runtime from Dashboard persists the selected runtime;
- runtime-specific unsupported controls cannot be invoked through UI or raw
  protocol;
- Copilot Tool calls execute only through the bound RunLab Workspace and
  approval policy;
- Copilot cancellation and reconnect do not create duplicate Tool effects;
- no credential appears in JSONL, artifacts, telemetry, Dashboard payloads, or
  deployment receipts;
- Dedicated upgrade changes slot and release digest through the Supervisor,
  preserves existing Kernel Sessions, and restores Copilot Sessions before
  `runtime_ready`;
- failed candidate verification automatically preserves or restores the prior
  route and runtime.

The deployed-runtime Tool matrix is repeatable with:

```bash
KALA_URL=http://host:13000 pnpm verify:agent-runtime-tools
```

It creates disposable Kernel and Copilot Sessions, executes one Executor tool
and one Host tool through each runtime, verifies projected and reloaded
Tool-call results, and deletes the Sessions.
