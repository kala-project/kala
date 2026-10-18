# Session Log and Context Persistence

**Status**: design source of truth for the next session-log rewrite. The
implementation currently still follows parts of `docs/protocol/event-log.md`;
where this document and the current implementation disagree, this document is
the target behavior and the implementation must change.

**Compatibility policy**: the next log format is intentionally breaking. Old
session JSONL files do not need to load after the rewrite. Do not add migration
complexity unless a later product decision explicitly requires it.

This document explains why the current JSONL files can become much larger than
the actual conversation, how Codex and Claude Code persist their sessions, and
how agent-kernel should separate reducer events, runtime effects, persisted
debug metadata, LLM request artifacts, and session-list indexes.

## 1. Problem Statement

The session log must support five different use cases:

1. **Replay**. Rebuild `AgentState` deterministically after host restart.
2. **Resume**. Continue a session with the same model-visible transcript.
3. **Debug**. Explain why the reducer moved from one status to another and
   which external IO the host scheduled.
4. **List**. Show workspaces and sessions quickly without parsing hundreds of
   megabytes of transcript.
5. **Data governance and task extraction**. Provide bounded, redacted,
   provenance-rich records that can identify candidate tasks and failures for
   later curation, without pretending historical user trajectories are direct
   RL rollout samples.

The current design conflates these use cases. It writes reducer events, full
runtime effects, and sometimes provider/debug data into the same append-only
JSONL entry. The most expensive mistake is persisting `call_llm.messages` on
every event whose next effect is another LLM call.

The result is superlinear storage growth. If the transcript size after turn `i`
is `C_i`, and each `call_llm` effect writes the whole transcript again, total
stored context becomes approximately:

$$
\sum_{i=1}^{n} C_i
$$

When `C_i` grows roughly linearly with the number of turns, storage grows like
$O(n^2)$. That is not a property of JSONL itself; it is caused by storing a
derived full-context artifact repeatedly.

## 2. Observed Failure

The failure was reproduced by inspecting a representative oversized
agent-kernel session directory. The raw inspection data contained local paths,
file names, exact byte counts, and exact line numbers; those values are
intentionally not recorded here. They are environment fingerprints and are not
needed to understand or fix the design.

```text
representative oversized session directory
multiple JSONL files
large total log volume
large individual session logs
```

The important measurement was the ratio inside large event lines:

```text
representative tool_result / user_message lines:
  total line size: dominated by persisted effects
  event payload: small
  persisted effects payload: almost the whole line
  effects[0].kind: call_llm
  effects[0].messages: full accumulated model-visible transcript
  effects[0].tools: small compared with messages, but still repeated
```

The large part is not the event. The large part is the persisted effect. The
same model-visible history is stored again and again. This is enough evidence
to identify the root cause without preserving local filenames or transcript
statistics in documentation.

This also explains misleading context indicators. A compact status can show an
implausibly large pre-compact token estimate when the estimator accidentally
counts repeated persisted context. That does not prove that a provider accepted
an oversized request. It proves that local accounting and persistence
boundaries are not clean enough.

The same boundary matters for Agentic RL. A historical product session log is
not a trainable PPO/GRPO rollout because it normally lacks current-policy token
ids, rollout logprobs, loss masks, actor weight version, and reliable verifier
reward. The log can provide task-candidate evidence, replay/audit metadata, and
artifact references. Training samples must be generated later by a live rollout
inside the training framework, with token capture written as separate artifacts.

## 3. Current Agent-Kernel Design

The current kernel deliberately exposes a pure reducer:

```ts
step(state, event, config) -> { next, effects }
```

That boundary is correct. The bug is that the host persists runtime effects
verbatim.

Current runtime effect shape:

```ts
type CallLlmEffect = {
  kind: 'call_llm'
  messages: readonly Message[]
  tools: readonly ToolSchema[]
}

type CallToolEffect = {
  kind: 'call_tool'
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
}

type RequestApprovalEffect = {
  kind: 'request_approval'
  callId: string
  name: string
  input: Record<string, unknown>
}
```

Current persisted event entry:

```ts
type EventEntry = {
  kind: 'event'
  seq: number
  ts: string
  event: AgentEvent
  effects: readonly Effect[]
  usage?: UsageTotal
  llmTrace?: LLMTrace
  model?: string
}
```

Current docs say that `effects` should be exactly what `step()` returned. That
is the design error. Runtime effects are commands for the host. Persisted log
entries are durable facts and lightweight debug records. These are different
protocol layers and must not share the same type.

## 4. Reference: Codex JSONL Shape

Codex session files commonly use a dated rollout path:

```text
<codex-home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
```

Representative line kinds observed from Codex session logs:

```text
response_item
event_msg
turn_context
compacted
world_state
session_meta
```

The observed top-level line shape is:

```ts
type CodexLogLine = {
  timestamp: string
  type:
    | 'session_meta'
    | 'event_msg'
    | 'response_item'
    | 'turn_context'
    | 'compacted'
    | 'world_state'
  payload: unknown
}
```

Important payload shapes observed from the log structure:

```ts
type CodexSessionMetaPayload = {
  id: string
  session_id: string
  timestamp: string
  cwd: string
  originator: string
  cli_version: string
  source: string
  thread_source: string
  model_provider: string
  base_instructions: unknown
  git: unknown
}

type CodexTurnContextPayload = {
  turn_id: string
  cwd: string
  model: string
  effort?: string
  summary?: string
  approval_policy: unknown
  sandbox_policy: unknown
  permission_profile: unknown
  workspace_roots: unknown
  current_date: string
  timezone: string
  collaboration_mode: unknown
}

type CodexEventPayload =
  | { type: 'task_started'; turn_id: string; model_context_window: number }
  | { type: 'token_count'; info: unknown; rate_limits?: unknown }
  | { type: 'agent_message'; message: string; phase?: unknown }
  | { type: string; [key: string]: unknown }

type CodexResponseItemPayload =
  | { type: 'message'; role: 'user' | 'assistant' | 'developer'; content: unknown[]; id?: string }
  | { type: 'function_call'; name: string; arguments: string; call_id: string; id?: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: string; [key: string]: unknown }
```

The important property is not the exact field names. The important property is
that Codex stores atomic response items, events, and turn context. It does not
store a full provider request transcript inside every event that happens to
schedule another model call. Tool outputs can still be large, but growth is
proportional to emitted items, not to repeated full-context snapshots.

Codex also records `compacted` entries and `turn_context` entries. That means
compaction and turn metadata are first-class records, not hidden in a repeated
`call_llm.messages` blob.

## 5. Reference: Claude Code JSONL Shape

Claude Code sessions commonly use per-project transcript files:

```text
<claude-home>/projects/<encoded-project-path>/<session-id>.jsonl
```

Representative line kinds observed from Claude Code transcript logs:

```text
assistant
user
permission-mode
last-prompt
attachment
file-history-snapshot
system
queue-operation
```

Observed transcript line shape:

```ts
type ClaudeTranscriptLine =
  | ClaudeUserLine
  | ClaudeAssistantLine
  | ClaudeSystemLine
  | ClaudeAttachmentLine
  | ClaudeSessionMetadataLine

type ClaudeCommonTranscriptFields = {
  uuid: string
  parentUuid: string | null
  sessionId: string
  timestamp: string
  cwd: string
  gitBranch?: string
  version?: string
  userType?: string
  isSidechain?: boolean
}

type ClaudeUserLine = ClaudeCommonTranscriptFields & {
  type: 'user'
  message: {
    role: 'user'
    content: string | unknown[]
  }
  promptId?: string
  sourceToolAssistantUUID?: string
  toolUseResult?: unknown
}

type ClaudeAssistantLine = ClaudeCommonTranscriptFields & {
  type: 'assistant'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    model: string
    content: unknown[]
    stop_reason?: string | null
    stop_sequence?: string | null
    usage?: unknown
  }
}

type ClaudeSystemLine = ClaudeCommonTranscriptFields & {
  type: 'system'
  level?: string
  subtype?: string
  content?: string
  compactMetadata?: unknown
}

type ClaudeSessionMetadataLine =
  | { type: 'permission-mode'; sessionId: string; permissionMode: string }
  | { type: 'last-prompt'; sessionId: string; leafUuid: string; lastPrompt: string }
  | { type: 'file-history-snapshot'; messageId: string; snapshot: unknown; isSnapshotUpdate: boolean }
```

Claude Code explicitly models the transcript as a parent-linked chain. Source
comments in the local reference implementation say that transcript messages are
`user`, `assistant`, `attachment`, and `system`; progress messages are UI-only
and must not be persisted into the JSONL chain. That is a useful separation:
resume reconstructs conversation state from transcript messages, while
high-frequency progress is kept out of durable storage.

Claude Code stores tool results as user messages containing `tool_result`
blocks and often also stores native tool output in `toolUseResult`. This can
make individual lines large, but each tool result is stored as its own observed
message. It is not repeated as part of every later model-call effect.

Claude Code also stores compact boundaries using system/meta messages with
`compactMetadata`. Compaction is represented as a durable transcript boundary,
not as an accidental side effect of provider request logging.

## 6. Comparison

| System | Durable unit | Context request persisted repeatedly? | Resume source | Debug source |
|---|---|---:|---|---|
| agent-kernel current | reducer event plus full runtime effects | yes, via `call_llm.messages` | fold event log | event effects, state, trace |
| Codex observed | session meta, event messages, response items, turn context, compacted records | no | response/session items | event messages and response items |
| Claude Code observed | parent-linked transcript entries plus metadata entries | no | transcript chain | transcript, metadata, tool result records |

The lesson is specific: JSONL is not the problem. Repeating the full prepared
LLM request inside each event is the problem.

## 7. RL and Data-Flywheel Requirements

The session-log rewrite must support the product data flywheel without
collapsing product logs, task definitions, and RL training samples into one
protocol.

### 7.1 Product Session Logs Are Not RL Samples

The v2 session log may be used to discover candidate tasks, bad cases, user
corrections, failure labels, and reproducible environment hints. It must not
represent historical assistant responses or tool trajectories as direct RL
rollout data.

Forbidden interpretation:

```text
session JSONL -> assistant messages/tool calls -> PPO/GRPO training sample
```

Allowed interpretation:

```text
session JSONL -> task candidate + failure evidence + provenance
             -> redaction and environment reconstruction
             -> curated task pool entry
             -> slime calls agent-kernel for live rollout
             -> token-correct Sample produced during training
```

The session log therefore needs good provenance and extraction hooks, not
trainer tensors.

### 7.2 Task-Candidate Records

Task-candidate metadata should be explicit and bounded. It can be stored as a
metadata entry or as a referenced artifact when large.

```ts
type TaskCandidateMetadataV2 = {
  kind: 'task_candidate'
  id: string
  sessionId: string
  sourceSeqRange: { from: number; to: number }
  status: 'candidate' | 'rejected' | 'curated'
  reason: 'user_request' | 'agent_failure' | 'user_correction' | 'benchmark_like' | 'manual_mark'
  promptSummary: string
  initialStateHints?: {
    cwd?: string
    gitRemote?: string
    baseCommit?: string
    dirtyWorkspace?: boolean
    dependencyHints?: readonly string[]
  }
  verifierHints?: {
    commands?: readonly string[]
    observedTestFiles?: readonly string[]
    observedFailureTextRef?: ArtifactRef
  }
  governance: {
    tenantId?: string
    consent: 'unknown' | 'denied' | 'allowed'
    trainingAllowed: boolean
    redactionStatus: 'not_scanned' | 'passed' | 'failed'
    retentionClass: 'debug_only' | 'curation_allowed' | 'training_allowed'
  }
}
```

A curated RL task pool entry is a separate artifact or dataset row. It should
contain task prompt, initial repository/sandbox state, verifier definition, and
provenance. It should not contain old assistant actions as training targets.

### 7.3 Live Rollout Token Artifacts

When `agent-kernel` is used inside slime training, token-correct rollout data
must be captured at generation time. These records are artifacts, not ordinary
session log lines, because they can be large and because they are training-plane
data rather than replay-plane data.

```ts
type PolicyTokenCaptureArtifactV1 = {
  schemaVersion: 1
  kind: 'policy_token_capture'
  sessionId: string
  rolloutId: string
  turnId: string
  eventSeq?: number
  providerRequestId: string
  routeKey: string
  model: string
  weightVersion?: string
  tokenizer: string
  chatTemplateHash: string
  promptIds: readonly number[]
  outputIds: readonly number[]
  outputLogProbs?: readonly number[]
  finishReason: string
}
```

The session log may reference this artifact from `PersistedCallLlmEffect`, but
must not inline `promptIds`, `outputIds`, or logprobs into the main JSONL.

### 7.4 Training Rollout Sidecars

Training rollout sidecars should link replay, trace, token capture, and reward:

```ts
type TrainingRolloutSidecarV1 = {
  schemaVersion: 1
  rolloutId: string
  sessionId: string
  taskId: string
  framework: 'slime'
  eventLogRef: ArtifactRef
  traceRef?: ArtifactRef
  tokenCaptureRef: ArtifactRef
  rewardRef: ArtifactRef
  sampleRef?: ArtifactRef
  model: string
  weightVersion?: string
  status: 'metadata_only' | 'token_captured' | 'reward_verified' | 'slime_sample_ready' | 'blocked'
  blockedReason?: string
}
```

This sidecar is an index and audit object. The actual slime trainer consumes
the in-memory or serialized slime `Sample` produced by the live rollout.

### 7.5 Protocol Boundaries

The v2 log rewrite must preserve these boundaries:

- Session log: replay/resume/debug/list/task-candidate evidence.
- Artifact store: full provider request/response, token capture, large tool
  output, verifier logs, rollout sidecars.
- Curated task pool: task definitions reconstructed from product data or
  benchmarks.
- Training framework output: slime `Sample`s produced during live rollout.

Do not add fields to `AgentEvent` merely because an RL adapter wants them.
Agentic RL metadata belongs in artifacts and metadata entries unless it is an
observed reducer fact needed for replay.

## 8. Target Design

Agent-kernel should use three separate protocols:

1. **Kernel protocol**: pure reducer events and runtime effects. This is the
   in-process contract between kernel and host loop.
2. **Session-log protocol**: durable JSONL facts and lightweight debug metadata.
   This is the source of truth for replay, resume, list, fork, and audit.
3. **Artifact protocol**: optional external records for expensive debug payloads
   such as full provider requests, full provider responses, or large tool
   outputs. These are referenced from the session log by ID and may have
   retention limits.

The runtime effect type can keep full `messages` and `tools`, because the host
needs them to execute the next LLM call. The persisted effect type must be
different.

## 9. Target Session Log Format

The next format should bump to `formatVersion: 2`. Because old sessions do not
need compatibility, the reader can reject any file whose first line is not v2.

### 9.1 Header

The header captures immutable session setup only:

```ts
type HeaderEntryV2 = {
  kind: 'header'
  seq: 0
  ts: string
  formatVersion: 2
  sessionId: string
  kernelVersion: string
  parentSessionId?: string
  parentCursor?: number
  workspaceId?: string
  workspaceName?: string
  initialCwd?: string
  governance?: SessionGovernance
  config: AgentConfig
  initialState: AgentState
}
```

`config` remains in the header because tool schemas and system prompt are part
of the initial conditions. Do not repeat `config.tools` on every model call.

`governance` is optional but should be present for product deployments:

```ts
type SessionGovernance = {
  tenantId?: string
  dataUseConsent: 'unknown' | 'denied' | 'allowed'
  trainingAllowed: boolean
  retentionClass: 'debug_only' | 'curation_allowed' | 'training_allowed'
  redactionProfile?: string
}
```

`trainingAllowed=true` does not mean the session trajectory is an RL sample. It
only means the session may be considered by downstream curation jobs.

### 9.2 Event Entry

The event entry stores reducer input and small derived metadata:

```ts
type EventEntryV2 = {
  kind: 'event'
  seq: number
  ts: string
  event: AgentEvent
  effects: readonly PersistedEffect[]
  usage?: UsageTotal
  model?: string
  traceRef?: ArtifactRef
}
```

`event` is authoritative for replay. `effects` is not authoritative for replay;
it is a compact debug summary of what the reducer emitted at the time.

### 9.3 Persisted Effects

Persisted effects are intentionally smaller than runtime effects:

```ts
type PersistedEffect =
  | PersistedCallLlmEffect
  | PersistedCallToolEffect
  | PersistedRequestApprovalEffect
  | PersistedFinishEffect
  | PersistedEmitErrorEffect

type PersistedCallLlmEffect = {
  kind: 'call_llm'
  messageCount: number
  toolCount: number
  contextBytes: number
  contextTokensEstimate?: number
  artifactRef?: ArtifactRef
  tokenCaptureRef?: ArtifactRef
  policy?: {
    mode: 'product_provider' | 'training_policy'
    model?: string
    weightVersion?: string
    routeKey?: string
  }
}

type PersistedCallToolEffect = {
  kind: 'call_tool'
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
}

type PersistedRequestApprovalEffect = {
  kind: 'request_approval'
  callId: string
  name: string
  input: Record<string, unknown>
}

type PersistedFinishEffect = { kind: 'finish' }

type PersistedEmitErrorEffect = { kind: 'emit_error'; error: string }
```

`PersistedCallLlmEffect` must never include `messages` or `tools`. It may
include counts and size estimates so the debugger can explain context pressure
without storing the context itself.

`tokenCaptureRef` is present only when the model call went through a training
policy gateway that captured generation-time token ids. Its absence is normal
for product sessions and must not be treated as log corruption. Its presence
does not make the whole session a training sample; a reward artifact and slime
sample output are still required.

`call_tool` and `request_approval` keep `input` because tool lifecycle UI,
approval UI, and RL/export topology need stable call metadata. Tool inputs are
small relative to tool outputs and model transcripts. If a tool input becomes
large, the same artifact-reference mechanism should apply.

### 9.4 Artifact Reference

Large optional debug payloads use explicit references:

```ts
type ArtifactRef = {
  kind: 'artifact_ref'
  id: string
  path: string
  contentType: 'application/json' | 'text/plain' | 'application/octet-stream'
  bytes: number
  sha256: string
}
```

Recommended layout:

```text
<agent-kernel-home>/
  sessions/
    <startedAt>_<sessionId>.jsonl
  artifacts/
    <sessionId>/
      llm-request-<seq>.json
      llm-response-<seq>.json
      tool-result-<callId>.txt
  indexes/
    session-summaries.json
```

Artifacts are not required for replay. If an artifact is missing, the session
must still load. The debugger should show the missing artifact as unavailable,
not as log corruption.

### 9.5 Metadata Entry

Metadata remains out of the reducer event stream:

```ts
type MetadataEntryV2 = {
  kind: 'metadata'
  ts: string
  label?: string
  workspaceId?: string
  workspaceName?: string
  taskCandidate?: TaskCandidateMetadataV2
}
```

Metadata does not advance `seq`. It should not affect replay.

### 9.6 Snapshot Entry

Inline snapshots should be removed from the main JSONL by default. Snapshotting
an entire `AgentState` can reintroduce large repeated `messages[]` blocks. If
snapshot acceleration is needed, store snapshots as separate artifacts with a
hard size cap and a clear retention policy.

Target default:

```ts
type SnapshotIndexEntry = {
  kind: 'snapshot_index'
  sessionId: string
  seq: number
  stateRef: ArtifactRef
}
```

The main session JSONL should not periodically duplicate full state.

## 10. Target Event Semantics

The reducer event union remains the replay source. The important event classes
are:

```ts
type AgentEvent =
  | { kind: 'user_message'; text: string; content?: MessageContent[] }
  | { kind: 'llm_response'; message: Message; usage?: UsageDelta }
  | { kind: 'llm_error'; error: string }
  | { kind: 'user_approve'; callId: string }
  | { kind: 'user_reject'; callId: string; reason?: string }
  | { kind: 'tool_result'; callId: string; ok: boolean; content: string }
  | { kind: 'cancel' }
  | { kind: 'clear' }
  | { kind: 'messages_replaced'; reason: 'compaction' | 'manual_rewrite' | 'recovery'; replaceRange: { start: number; end: number }; replacementMessages: Message[]; artifactRef?: ArtifactRef }
  | { kind: 'approval_mode_changed'; mode: ApprovalMode }
  | { kind: 'cwd_changed'; cwd: string }
```

These events are observed facts. They should be enough to fold state. Effects
are not needed to fold state.

Compaction attempts that do not change reducer state, such as skipped or
rejected attempts, should be written as `runtime_metadata` entries rather than
`AgentEvent` values.

Large `tool_result.content` remains a real event fact. If tool output size is a
problem, solve it with a tool-result content policy, not by hiding it inside
effects. The policy should be explicit:

```ts
type ToolResultEventV2 = {
  kind: 'tool_result'
  callId: string
  ok: boolean
  content: string
  overflowRef?: ArtifactRef
  contentTruncated?: boolean
  originalBytes?: number
}
```

For v2 implementation, `overflowRef` is optional. The required first fix is to
stop persisting `call_llm.messages` and `call_llm.tools`.

## 11. Example V2 JSONL

One round trip with a tool call should look like this:

```jsonl
{"kind":"header","seq":0,"ts":"<iso-timestamp>","formatVersion":2,"sessionId":"s1","kernelVersion":"@agent-kernel/kernel@0.1.0","workspaceId":"w1","initialCwd":"/repo","config":{"systemPrompt":"You are a coding agent.","tools":[{"name":"read","description":"Read a file","inputSchema":{"type":"object"}}]},"initialState":{"sessionId":"s1","messages":[{"role":"system","content":[{"type":"text","text":"You are a coding agent."}]}],"pendingCalls":[],"status":"idle","cursor":0,"usage":{"inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0}}}
{"kind":"event","seq":1,"ts":"<iso-timestamp>","event":{"kind":"user_message","text":"Read README.md"},"effects":[{"kind":"call_llm","messageCount":2,"toolCount":1,"contextBytes":8421,"contextTokensEstimate":1900}]}
{"kind":"event","seq":2,"ts":"<iso-timestamp>","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"tool_call","callId":"c1","name":"read","input":{"path":"README.md"}}]},"usage":{"inputTokens":1900,"outputTokens":48}},"effects":[{"kind":"call_tool","callId":"c1","name":"read","input":{"path":"README.md"}}],"usage":{"inputTokens":1900,"outputTokens":48,"cacheCreationTokens":0,"cacheReadTokens":0},"model":"example-model"}
{"kind":"event","seq":3,"ts":"<iso-timestamp>","event":{"kind":"tool_result","callId":"c1","ok":true,"content":"# README\n..."},"effects":[{"kind":"call_llm","messageCount":4,"toolCount":1,"contextBytes":10522,"contextTokensEstimate":2350}]}
{"kind":"event","seq":4,"ts":"<iso-timestamp>","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"text","text":"README.md describes..."}]},"usage":{"inputTokens":2350,"outputTokens":80}},"effects":[{"kind":"finish"}],"usage":{"inputTokens":4250,"outputTokens":128,"cacheCreationTokens":0,"cacheReadTokens":0},"model":"example-model"}
```

There is no `effects[0].messages` field. The transcript is present exactly once
through reducer events and folded state.

## 12. Session Listing and Indexing

The dashboard must not parse full session logs to show the workspace/session
list on every load. Session listing should read a small persistent index.

Recommended index shape:

```ts
type SessionSummaryIndex = {
  version: 1
  updatedAt: string
  sessions: Record<string, SessionSummaryIndexEntry>
}

type SessionSummaryIndexEntry = {
  sessionId: string
  logPath: string
  createdAt: string
  lastEventAt?: string
  eventCount: number
  workspaceId?: string
  workspaceName?: string
  currentCwd?: string
  status: AgentStatus
  firstUserMessage?: string
  label?: string
  governance?: Pick<SessionGovernance, 'trainingAllowed' | 'retentionClass'>
  taskCandidateCount?: number
  sizeBytes: number
  mtimeMs: number
}
```

Write policy:

1. Create an index entry when the header is written.
2. Update it after every event append using the in-memory `AgentState`.
3. Update label/workspace fields after metadata writes.
4. On host startup, trust the index if `sizeBytes` and `mtimeMs` match the log.
5. If the index is missing or stale, rebuild that one session summary and update
   the index.

This makes session listing $O(number\ of\ sessions)$ over small JSON records,
not $O(total\ log\ bytes)$.

## 13. Context Usage Accounting

Context-window indicators should measure the next provider request, not the
durable JSONL size and not cumulative session token spend.

Recommended fields:

```ts
type ContextWindowUsage = {
  model: string
  contextWindow: number
  inputTokensEstimate: number
  outputReserveTokens: number
  usableInputWindow: number
  pressure: 'normal' | 'soft' | 'hard' | 'overflow'
  basis: 'provider_usage' | 'local_estimate'
  measuredAtSeq: number
}
```

Rules:

1. Do not count persisted `effects.call_llm.messages`; that field will not
   exist in v2.
2. Do not count prior provider requests repeatedly.
3. Do not use cumulative `usage.inputTokens + usage.outputTokens` as current
   window pressure. Cumulative spend and current prompt size are different.
4. Reserve output tokens before deciding whether auto-compact is required.
5. After compaction, recompute usage from the compacted model-visible messages,
   not from historical log bytes.

## 14. Implementation Plan

The implementation should be done as a breaking log-format rewrite in this
order:

1. Introduce `PersistedEffect` in `packages/shared/src/log.ts` and make
   `EventEntry.effects` use it instead of kernel `Effect`.
2. Bump `LOG_FORMAT_VERSION` to `2` and make the reader reject non-v2 logs.
3. Add `toPersistedEffects(effects, nextState, config)` in the host log writer.
4. For `call_llm`, write only `messageCount`, `toolCount`, `contextBytes`, and
   optionally `contextTokensEstimate` or `artifactRef`.
5. Keep runtime `CallLlmEffect.messages/tools` unchanged inside the kernel and
   host loop. Only persistence changes.
6. Remove `llmTrace.request.body.messages` from the main JSONL. If full request
   debug is needed, write it as an artifact and set `traceRef`.
7. Update dashboard inspector and state-flow code to treat persisted
   `call_llm` as a lightweight record. UI should display counts and artifact
   links, not assume `messages` is present.
8. Add a persistent session summary index and make `listSummaries()` prefer it.
9. Remove or disable inline `snapshot` entries that duplicate full state.
10. Add governance metadata and task-candidate metadata without making them
    replay-authoritative.
11. Add token-capture artifact references for training-policy calls, but keep
    token ids/logprobs out of the main JSONL.
12. Add tests that a 500-message state produces a small `call_llm` persisted
    effect and that session listing does not parse unchanged logs.

## 15. Non-Goals

This rewrite does not require:

1. Loading old v1 logs.
2. Migrating old logs.
3. Preserving exact full provider requests in the main JSONL.
4. Making JSONL a database.
5. Removing JSONL entirely.
6. Storing slime `Sample`s or verl tensors in the main session JSONL.
7. Treating historical product sessions as direct RL rollout samples.

JSONL remains a good durable ledger format if each line stores one observed
fact or one bounded metadata record. The broken part is unbounded derived data
inside routine event lines.

## 16. Acceptance Criteria

The rewrite is complete when these statements are true:

1. A session with hundreds of turns does not contain any
   `effects[].messages` or `effects[].tools` fields in JSONL.
2. The largest ordinary `call_llm` event line is bounded by metadata size, not
   by transcript size.
3. Replay folds `event` entries only and ignores `effects` for state recovery.
4. The dashboard can show reducer transitions from persisted effects without a
   full LLM request body.
5. Session list loading does not parse every full JSONL on normal startup.
6. Context-window usage is based on the next model-visible request, not on
   repeated persisted history.
7. Compaction thresholds cannot be delayed past the model context window by
   stale or duplicated local accounting.
8. Product sessions can carry governance and task-candidate metadata without
   changing replay semantics.
9. Training-policy model calls can reference token-capture artifacts, but the
   main JSONL never inlines token id arrays or rollout logprobs.
10. No session-log reader or exporter labels a historical product session as a
    trainable RL rollout unless a separate live-rollout sidecar proves token
    capture, reward verification, and slime sample readiness.

## 17. Design Rationale

The reducer should still emit full runtime effects because that is the cleanest
host/kernel boundary. The host needs the prepared `messages` and `tools` to make
the next model call, and computing them in the reducer keeps state transitions
testable.

The log should not persist those runtime effects verbatim because they are
derived from state and config. Persisting derived full-context data makes the
ledger larger, slower to scan, and easier to misinterpret during context
accounting. A durable event log should store facts that happened; full prepared
LLM requests are execution artifacts.

The proposed split follows the same broad pattern observed in Codex and Claude
Code: append atomic transcript/events, represent compaction as explicit records,
keep progress/debug metadata separate, and avoid repeated full-context writes.
Agent-kernel can keep its event-sourced reducer model while adopting the same
storage discipline.
