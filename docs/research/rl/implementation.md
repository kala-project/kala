# Agentic RL Implementation

Status: local implementation gate passed; remote SGLang data-plane and slime `custom_generate` passed; slime trainer invoked live `agent-kernel` rollout; one full trainer step completed on 2026-07-12 with a placeholder verifier (see `experiments/`).
Last updated: 2026-07-12

## Document Role

This document is the implementation gate and component inventory for the
design in `system-design.md`. It assumes that design context and focuses on
what code, tests, artifacts, and failure behavior must exist before a real
slime E2E training run is meaningful.

For the overall product/training architecture and the comparison with slime's
official custom-generate workflow, read `system-design.md` first. For the
concrete execution plan (GPU/model/budget decisions, stop conditions, risks),
read `training-design.md`.

This document defines the implementation work that must finish before a paid
rented GPU host full training run is meaningful. It is the first engineering milestone
for the slime-first Agentic RL plan.

The goal is not to prove that rented GPU provider can launch a GPU container or that SGLang
can serve a model. The goal is to prove that `agent-kernel` can run as a live
rollout harness inside slime, capture generation-time policy tokens, construct
native slime `Sample`s, and reach a trainer step.

The core rule is: **do not make the core agent reducer understand RL
frameworks**. The reducer continues to process agent events and emit runtime
effects. RL integration lives around the host, model provider, artifact store,
verifier, and external Python adapter.

## 1. Target Execution Path

The target path for the first real training E2E is:

```text
slime train.py
  -> slime default rollout loop
  -> integrations.slime_agent_kernel.generate.generate(args, sample, sampling_params)
  -> agent-kernel rollout runner
  -> agent-kernel host/reducer/executor
  -> SGLang policy gateway for every model turn
  -> token capture artifact per policy generation
  -> verifier reward artifact
  -> trajectory builder
  -> native slime Sample(s)
  -> slime trainer step
```

The historical product session path remains separate:

```text
product user session
  -> session log / trace / redacted artifacts
  -> task candidate and badcase evidence
  -> curated task pool
  -> future live rollout
```

No implementation should convert historical assistant messages directly into
policy-gradient action tokens. Product traces can suggest tasks and verifiers;
they are not trainer samples.

## 2. Curated Task Pool Contract

The rollout entrypoint must start from a curated task pool record, not from an
old session transcript. The minimal task record should be JSONL-friendly and
validated with Zod in TypeScript plus a matching Python validator or dataclass
for the slime adapter.

Suggested TypeScript shape:

```ts
type AgentRlTaskV1 = {
  schemaVersion: 'agent.rl.task.v1'
  taskId: string
  source: {
    kind: 'swebench' | 'terminal-bench' | 'local-fixture' | 'manual-curated'
    sourceId?: string
    sourceUrl?: string
  }
  prompt: string
  workspace: {
    kind: 'git' | 'archive' | 'empty-tempdir'
    repoUrl?: string
    baseCommit?: string
    archiveRef?: string
    workdir?: string
  }
  verifier: {
    kind: 'command' | 'swebench' | 'terminal-bench'
    command?: string[]
    timeoutMs: number
    env?: Record<string, string>
  }
  governance: {
    trainingAllowed: boolean
    redactionStatus: 'not_required' | 'redacted' | 'blocked'
    retentionClass: 'debug_only' | 'curation_allowed' | 'training_allowed'
  }
  metadata?: Record<string, unknown>
}
```

Required behavior:

- Reject records with `trainingAllowed=false` in training mode.
- Reject ambiguous verifier definitions.
- Normalize relative workdir/archive refs under an artifact root; never let task
  records escape the configured workspace root.
- Preserve enough metadata to link the resulting rollout back to the task
  without embedding old assistant turns.

## 3. Live Rollout Runner

The live rollout runner is the host-side orchestrator that executes one task
through the existing agent runtime. It should not bypass the reducer or invent
a parallel agent loop. It should programmatically create a session, submit the
task prompt as the first user turn, wait until the agent reaches a terminal
state or timeout, then run the verifier.

Proposed API:

```ts
type RunRlRolloutInput = {
  task: AgentRlTaskV1
  artifactRoot: string
  provider: 'policy-gateway'
  model: string
  maxTurns: number
  timeoutMs: number
  sampling: {
    temperature?: number
    topP?: number
    maxNewTokens?: number
  }
  slime?: {
    rolloutId?: string
    sampleId?: string
    routeKey?: string
    weightVersion?: string
  }
}

type RunRlRolloutResult = {
  rolloutId: string
  taskId: string
  sessionId: string
  status: 'completed' | 'failed' | 'timeout' | 'blocked'
  readiness: RolloutReadiness
  eventLogRef: ArtifactRef
  traceRef?: ArtifactRef
  tokenCaptureRefs: ArtifactRef[]
  rewardRef?: ArtifactRef
  trajectoryRef?: ArtifactRef
  blockedReason?: string
}
```

Rules:

- The runner uses the normal `user_message -> call_llm -> llm_response ->
  finish/tool` path. RL stays outside the reducer.
- The first local runner supports `empty-tempdir` and command verifiers. Git
  checkout/archive materialization and SWE-bench/Terminal-Bench verifier
  runners remain future extensions on top of the same task contract.
- If no generation-time token capture appears, the rollout is persisted as
  `blocked` with a reason instead of producing a fake sample.
- The runner must be idempotent at the artifact level. If it crashes after
  creating a session but before verifier completion, the next inspection
  command should report `blocked` or `timeout` with the last durable artifact
  refs instead of pretending the rollout never existed.

## 4. Policy Gateway Provider

The policy gateway is a host model-provider implementation used only for
training-mode rollout. It takes the exact messages/tools assembled by
`agent-kernel`, renders them with the selected tokenizer/chat template, calls
SGLang, and returns a normal assistant message/tool-call response to the agent
runtime while writing token-capture artifacts.

Configuration:

```bash
KALA_PROVIDER=policy-gateway
KALA_POLICY_BASE_URL=http://127.0.0.1:30080
KALA_POLICY_MODEL=Qwen/Qwen2.5-1.5B-Instruct
KALA_POLICY_TOKENIZER=/models/Qwen2.5-1.5B-Instruct
KALA_POLICY_ROUTE_KEY=<rollout_or_session_id>
KALA_POLICY_WEIGHT_VERSION=<trainer_step_or_checkpoint_id>
```

The gateway should call SGLang native `/generate` in token-first mode for the
current training path:

- render prompt to `input_ids`,
- pass sampling params from slime or CLI,
- request output token ids and logprobs,
- use `X-SMG-Routing-Key` or the configured routing header for session
  affinity when slime/SGLang router supports it,
- parse the generated content into the same assistant message shape the host
  already expects.

The OpenAI-compatible `/v1/chat/completions` path remains a fallback only for
non-training smoke or future tool-schema serving. It is not the default
training path because the tested SGLang OpenAI-compatible response exposed
logprob/token strings but did not expose the real token ids required for slime
`Sample` construction. The current default is therefore native `/generate`,
which has been verified to return real `output_ids`,
`meta_info.input_token_logprobs`, and `meta_info.output_token_logprobs` on
remote A100 smoke runs.

Token-capture artifact shape:

```ts
type PolicyTokenCaptureV1 = {
  schemaVersion: 'agent.policy_token_capture.v1'
  captureId: string
  rolloutId: string
  sessionId: string
  callId: string
  provider: 'policy-gateway'
  backend: 'sglang'
  model: string
  tokenizer: {
    nameOrPath: string
    chatTemplateHash: string
  }
  routeKey?: string
  weightVersion?: string
  promptIds: number[]
  outputIds: number[]
  outputLogProbs?: number[]
  responseMask: number[]
  finishReason?: string
  usage?: {
    promptTokens: number
    completionTokens: number
  }
  requestRef?: ArtifactRef
  responseRef?: ArtifactRef
}
```

Hard validation rules:

- `promptIds.length > 0`.
- `outputIds.length > 0` unless the backend failed before generation.
- `responseMask.length === outputIds.length`.
- If logprobs are required for the selected training path,
  `outputLogProbs.length === outputIds.length`.
- `tokenizer.chatTemplateHash` must be recorded because the same messages can
  tokenize differently under a different template.
- Redacted request/response artifacts must not contain API tokens or private
  base URLs.

## 5. Trajectory Builder

The trajectory builder consumes event log refs, token capture refs, and reward
refs, then emits a framework-neutral audit trajectory plus framework-specific
views. It should be inspired by slime's `TrajectoryManager`/`TurnRecord`, but
the durable project artifact should remain a local audit object, not a copied
slime internal class.

Suggested durable shape:

```ts
type AgentTrainingTrajectoryV1 = {
  schemaVersion: 'agent.training_trajectory.v1'
  rolloutId: string
  taskId: string
  sessionId: string
  turns: Array<{
    turnIndex: number
    callId: string
    promptTokenCount: number
    responseTokenCount: number
    tokenCaptureRef: ArtifactRef
    lossMaskStart: number
    lossMaskEnd: number
    role: 'assistant_policy_output'
  }>
  rewardRef?: ArtifactRef
  readiness: RolloutReadiness
}
```

The builder's job is not to replay the whole conversation as text. Its job is
to prove which generated token spans are trainable and which artifacts explain
the environment observations around them.

Rules:

- Assistant output tokens from the policy gateway get `loss_mask=1` unless a
  parser marks a non-trainable suffix.
- Tool outputs, terminal logs, verifier output, system prompts, user prompts,
  and compaction summaries get `loss_mask=0` or remain outside response tokens
  depending on the target framework contract.
- Failed tool calls may still be useful context but are not assistant actions.
- If a rollout includes multiple model turns, preserve turn boundaries so
  slime debug dumps and dashboard views can explain which turn produced each
  segment.
- Trajectory token/reward refs are relative to the artifact root when
  possible, so downstream UI and reports do not need to expose local absolute
  paths.

Multi-turn tool-call segmentation is still a recommended hardening item
before a large training run.

## 6. Verifier and Reward Artifact

The verifier must run after the rollout in a clean environment derived from
the task pool record. The first implementation may support a local fixture
command and one benchmark adapter, but it must keep the interface general
enough for SWE-bench and Terminal-Bench.

Reward artifact shape:

```ts
type AgentRewardArtifactV1 = {
  schemaVersion: 'agent.reward.v1'
  rolloutId: string
  taskId: string
  verifierKind: 'command' | 'swebench' | 'terminal-bench'
  reward: number
  label: 'resolved' | 'unresolved' | 'runtime_error' | 'timeout' | 'invalid_patch'
  startedAt: string
  completedAt: string
  durationMs: number
  stdoutRef?: ArtifactRef
  stderrRef?: ArtifactRef
  patchRef?: ArtifactRef
  metadata?: Record<string, unknown>
}
```

Required behavior:

- Apply the agent-produced patch or workspace diff before running the
  verifier.
- Run with a timeout and a bounded output capture policy.
- Store stdout/stderr as artifacts, not inline in the main session log.
- Convert verifier result to a numeric reward through a simple documented
  rule, for example `resolved -> 1`, `unresolved -> 0`, runtime infrastructure
  failure -> blocked or a separate non-training failure label.
- Do not reward a rollout if the verifier environment itself failed to start.

Current command verifier maps `exitCode=0` to reward `1`, timeout/non-zero to
reward `0`. SWE-bench and Terminal-Bench reward runners are not yet wired into
the live rollout runner; existing eval modules remain available for the next
adapter-specific extension.

## 7. slime `custom_generate` Adapter

The slime adapter should be a small Python package that translates between
slime's `Sample` object and the host rollout runner. It should not reimplement
the agent. It should not parse historical JSONL into training data.

Proposed package layout:

```text
integrations/slime_agent_kernel/
  __init__.py
  generate.py
  client.py
  sample_builder.py
  validators.py
  README.md
```

Adapter flow:

1. Receive `args`, `sample`, and `sampling_params` from slime.
2. Extract `task_id`, `prompt`, and metadata from the sample.
3. Resolve the task pool record or build a temporary local-fixture task from
   the sample metadata for smoke tests.
4. Call the host rollout runner over HTTP or spawn the local Node CLI,
   depending on configured mode.
5. Load token capture, trajectory, and reward artifacts from the returned
   refs.
6. Construct a slime `Sample` with token fields populated from captured policy
   tokens, not retokenized assistant text.
7. Preserve `rollout_id`, `session_id`, `task_id`, artifact refs, readiness,
   and blocked reasons in `sample.metadata`.

`integrations/slime_agent_kernel/generate.py` supports both modes:

- artifact dry-run mode: `trajectory_path` + `reward_path` in sample metadata
  or args;
- live local mode: `agent_kernel_task_file` + `agent_kernel_root_dir`, which
  invokes `kala-host rl run-rollout-smoke`, checks for
  `slime-sample-ready`, then builds the slime-compatible sample.

Minimum `Sample` fields that must be populated for training readiness:

```text
tokens
response_length
loss_mask
rollout_log_probs when required
reward
status
metadata.rollout_id
metadata.agent_kernel_session_id
metadata.agent_kernel_artifacts
```

The adapter must fail closed. If token ids, masks, reward, or required
logprobs are missing, return a blocked/failed sample according to slime's
contract or raise a clear exception during dry-run validation. It must not
silently emit a fake successful sample.

## 8. CLI and Dashboard Inspection

The implementation must expose readiness to humans before running paid
training. The CLI should provide deterministic artifact inspection; the
dashboard should make the same states visible without implying that
metadata-only logs are trainable.

Implemented CLI commands:

```bash
kala-host rl validate-task-pool --task-file tasks.jsonl
kala-host rl run-rollout-smoke --task-file tasks.jsonl \
    --root-dir runs/rl-smoke \
    --policy-base-url http://127.0.0.1:30080 \
    --model Qwen/Qwen2.5-1.5B-Instruct --require-logprobs
kala-host rl inspect-rollout --root-dir runs/rl-smoke \
    --rollout runs/rl-smoke/rl-rollouts/<id>.json
kala-host rl build-trajectory --root-dir runs/rl-smoke \
    --rollout-id <id> --task-id <task> --session-id <session> \
    --token-captures <path>
kala-host rl validate-slime-sample \
    --trajectory runs/rl-smoke/trajectories/<id>.json \
    --reward runs/rl-smoke/rewards/<id>.json
```

Readiness enum:

```ts
type RolloutReadiness =
  | 'metadata-only'
  | 'task-validated'
  | 'live-rollout-complete'
  | 'token-captured'
  | 'reward-verified'
  | 'slime-sample-ready'
  | 'training-consumed'
  | 'blocked'
```

Dashboard requirements:

- Show rollout/task readiness as a state machine with precise blocked reasons.
- Link token capture, reward, trajectory, event log, and trace artifacts.
- Show token/mask/logprob counts and alignment checks.
- Show whether the sample came from live training rollout or metadata-only
  historical export.
- Never label a historical product session as `slime-sample-ready` unless a
  live rollout sidecar proves token capture, reward verification, and sample
  construction.
- Missing artifact directories render as empty states rather than raw ENOENT
  or private filesystem paths. Expanded artifact details redact absolute
  private paths and ENOENT text before rendering.

## 9. Local Test Plan

The implementation goal must add tests that prove behavior locally before any
A100-class rental.

Unit tests:

- Task pool validation rejects missing verifier, bad governance, and path
  traversal.
- Token capture validation enforces non-empty ids and mask/logprob alignment.
- Trajectory builder keeps only policy output tokens trainable.
- Reward mapping distinguishes task failure from verifier infrastructure
  failure.
- slime sample builder refuses fake or incomplete token artifacts.

Integration tests with fake SGLang:

- A local HTTP fake returns deterministic token ids, text, and logprobs.
- The policy gateway writes a valid `PolicyTokenCaptureV1` artifact.
- The rollout runner produces a trajectory and reward against a local fixture.
- `validate-slime-sample` accepts the generated artifacts.

Python adapter tests:

- Import `integrations.slime_agent_kernel.generate.generate` in a clean Python
  environment.
- Call it with a synthetic slime-like `Sample` fixture.
- Verify returned fields: `tokens`, `response_length`, `loss_mask`, reward,
  status, and metadata refs.

Product Dashboard evaluation views are outside this implementation. Inspect
rollout readiness through the Host RL CLI and artifact contracts; standalone
evaluation consumes only fresh canonical runs through its own Control Plane.

Local gate commands (must pass before any paid experiment):

```bash
pnpm --filter @agent-kernel/shared build
pnpm --filter @agent-kernel/host typecheck
pnpm --filter @agent-kernel/host test
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard exec vitest run
python3 -m pytest \
  tests/python/test_slime_agent_kernel_adapter.py \
  tests/python/test_slime_trainer_preflight.py -q
gpu-provider-cli show instances --raw
```

## 10. Blocking Conditions

The implementation goal should stop and report `blocked` instead of renting a
full training instance if any of these checks fail:

- `integrations.slime_agent_kernel.generate.generate` cannot be imported.
- The policy gateway cannot produce non-empty prompt and response token ids.
- `loss_mask` length does not align with the generated response segment.
- Rollout logprobs are missing in a training path that requires them.
- The verifier cannot produce a reward artifact.
- slime cannot construct or validate a native `Sample`.
- The dashboard or CLI cannot distinguish metadata-only artifacts from
  training-ready rollouts.
- rented GPU provider cleanup cannot be guaranteed.

Only after all design elements in this document are implemented and tested
should the workflow move to a paid full training step. Until then, the only
acceptable paid run is a short low-cost remote environment or SGLang smoke
labeled `partial` in the E2E report.

## 11. Trainer Environment Preflight

After the local gate passes, the training host must additionally pass a
strict Python-side preflight before any full trainer command:

```bash
python3 -m integrations.slime_agent_kernel.preflight \
  --slime-root references/slime \
  --strict
```

This emits `agent.slime_trainer_preflight.v1` JSON. It import-checks the
slime trainer stack and explicitly checks `flash_attn_2_cuda`, not just
`flash_attn`. It also verifies the checked-out slime source still has the
Qwen2.5-0.5B HF `--ref-load` test path and that the Megatron data path
builds `PackedSeqParams(qkv_format="thd")`.

`import flash_attn` passing is not enough. The strict preflight must
validate the actual extension/backend required by slime's packed THD path.
Strict mode exits non-zero when the environment is not ready. Do not start a
paid full trainer attempt before this preflight passes on the target
machine.

## 12. Acceptance Gates

A satisfactory final result should include all of the following. Individual
items are checked by the CLI/dashboard evidence listed above; the full set is
the "one real trainer step" bar.

Preconditions:

- A passing strict trainer preflight on the actual training host.
- The exact selected model and hardware configuration recorded.
- SGLang health evidence and native `/generate` token/logprob evidence.

Rollout evidence:

- A slime run log showing `integrations.slime_agent_kernel.generate.generate`
  invoked by slime.
- Agent-kernel rollout artifacts for that run: token capture, reward,
  trajectory, sample validation, rollout result.
- A slime sample or trainer-side log showing the sample was consumed.

Training evidence:

- At least one real trainer step: slime/Megatron optimizer or training step
  consumes an agent-kernel-generated `Sample` and reports finite loss. A
  second rollout after weight sync is a stronger result but is not required
  for the first success claim.
- A precise blocker with the failing stack and next fix if the step did not
  complete.

Cleanup evidence:

- `gpu-provider-cli show instances --raw` returns `[]` after the run.

The blocking conditions in §10 remain in force. Any failing condition means
the acceptance gate is not met even if some evidence rows are green.

## 13. First Real Trainer Step — Success Definition

The first full-success evidence requires all of these:

1. slime invokes `integrations.slime_agent_kernel.generate.generate` from its
   rollout path;
2. agent-kernel creates and runs a live rollout from an `agent.rl.task.v1` task;
3. SGLang returns real prompt/output token ids and rollout logprobs;
4. agent-kernel writes token capture, reward, trajectory, sample validation,
   and rollout result artifacts;
5. the Python adapter builds and returns a slime `Sample` from those artifacts;
6. slime consumes the sample in training;
7. at least one optimizer/training step completes with finite loss, or slime
   logs an equivalent completed trainer step.

The following are **partial evidence only** and must not be reported as full
success:

- local fixture-policy smoke;
- fake SGLang HTTP tests;
- dashboard readiness display;
- sample construction from prewritten artifacts;
- SGLang `/generate` smoke without slime trainer consumption;
- a trainer command that starts but never consumes an agent-kernel sample.

## 14. First Smoke Task Pool Fixture

If no curated task pool exists, generate this task under the run artifact root:

```json
{
  "schemaVersion": "agent.rl.task.v1",
  "taskId": "smoke-agent-kernel-slime-live-rollout",
  "source": { "kind": "local-fixture" },
  "prompt": "Return a short confirmation that the live rollout path is active.",
  "workspace": { "kind": "empty-tempdir" },
  "verifier": {
    "kind": "command",
    "command": ["bash", "-lc", "true"],
    "timeoutMs": 30000
  },
  "governance": {
    "trainingAllowed": true,
    "redactionStatus": "not_required",
    "retentionClass": "training_allowed"
  }
}
```

This task is intentionally trivial. Its purpose is to prove the live
rollout/sample/trainer path. After that works, replace it with a real code task
whose verifier checks meaningful behavior.

## 15. Stop Conditions

Stop and write the blocker report instead of continuing to spend when any of
these happens:

- projected spend would exceed the configured budget;
- actual spend reaches the configured preflight spend threshold without passing strict preflight on a selected
  host;
- three consecutive rented GPU provider instances fail before usable SSH;
- two usable instances hit the same strict-preflight blocker;
- the same Megatron/TransformerEngine/flash-attn backend failure appears twice
  after dependency repair attempts;
- the only next step is bypassing slime's official Qwen2.5-0.5B trainer path.

## 16. Required Runtime Evidence

A claimed complete E2E training run must produce evidence for every stage:

- SGLang server/router started and accepted generation requests.
- The concrete selected model was loaded from the expected checkpoint path.
- `agent-kernel` created a live rollout session from a curated task pool entry.
- The model call went through the training policy gateway, not a commercial API.
- Token capture artifact contains non-empty prompt ids and output ids.
- Rollout logprobs are present when required by slime training.
- Loss mask length aligns with response length.
- Verifier ran in a clean environment and produced reward.
- slime received a `Sample` with `tokens`, `response_length`, `loss_mask`,
  `rollout_log_probs`, and `reward`.
- At least one slime train step completed or the run reached the trainer with a
  non-data-plane runtime failure. Missing token ids, masks, logprobs, or reward
  means the E2E run did not reach the required standard.
- A report was written under `experiments/rl/` with exact commands,
  versions, artifacts, and conclusions.

## 17. Testing and Acceptance Criteria

### 17.1 Unit Tests

- Token capture schema validation.
- Trajectory builder clean append.
- Tool observation masking.
- Drift realignment.
- Unsafe drift fork.
- Sub-agent fan-out with shared rollout id.
- Compaction boundary handling.
- Verifier reward label mapping.
- Adapter blocked state when token ids are missing.

### 17.2 Contract Tests

- slime `Sample` fixture generated from a synthetic two-turn tool trace.
- verl `AgentLoopOutput` fixture generated from a synthetic two-turn tool trace.
- JSONL export fixture proving metadata-only rows do not contain trainable
  tensor fields.
- Redaction fixture proving base URLs and tokens are removed from request and
  response artifacts.

### 17.3 E2E Tests

- Headless dashboard test showing rollout readiness states and artifact detail.
- CLI token-capture smoke with fake SGLang server returning deterministic ids.
- Docker verifier smoke with one passing and one failing patch.
- slime custom-generate dry run returning a valid `Sample` without full trainer.
- Future verl AgentLoop dry run returning a valid `AgentLoopOutput` without
  full cluster.
- Optional GPU CI/manual gate that runs one real slime rollout/training step on
  a tiny model.

### 17.4 Completion Gates

A rollout is `training-ready` only if all of the following are true:

- Token ids were captured at generation time.
- Trainable tokens are marked with loss/response mask.
- Logprob coverage matches framework requirements.
- Reward was computed by a verifier or explicit reward function.
- Model and tokenizer identity are recorded.
- Weight version or trainer step is recorded when running on-policy training.
- Framework adapter output passes a local contract test.

## 18. E2E Report Requirement

A complete implementation is not accepted only because tests pass. It must also
produce a human-readable E2E report with direct evidence that a real slime
rollout/training path executed. The report path is:

```text
experiments/rl/<date>-run-<n>/final-report.md
```

The report must include:

- agent-kernel commit,
- slime commit,
- SGLang version,
- Python environment,
- CUDA/driver/GPU details,
- selected model checkpoint path,
- tokenizer/chat template identity,
- task pool entry,
- all startup commands,
- session id and rollout id,
- token-capture artifact path and validation summary,
- verifier artifact path and reward,
- emitted slime `Sample` validation summary,
- slime trainer log excerpt proving sample consumption and train-step result,
- checkpoint or explicit reason no checkpoint was produced,
- known limitations and next scaling steps.

The report should distinguish local smoke evidence from full training evidence.
For example, a local SGLang token-capture smoke on the RTX 5060 laptop is not
the same as a full slime training step on a larger host. Both are valuable, but
they prove different things.

## Appendix A. Implemented Components Inventory

Source-side implementation:

- Shared Agentic RL schemas in `packages/shared/src/rl-types.ts`.
- RL artifact kinds in the shared artifact store and host artifact manifest.
- Host task-pool validation in `packages/host/src/rl/task-pool.ts`.
- Token capture validation/writing in `packages/host/src/rl/token-capture.ts`.
- Training trajectory and slime readiness validation in
  `packages/host/src/rl/trajectory-builder.ts`.
- Command verifier and local rollout workspace handling in
  `packages/host/src/rl/verifier.ts`.
- Host live rollout smoke runner in `packages/host/src/rl/rollout-runner.ts`.
- SGLang policy gateway provider in `packages/host/src/llm/policy-gateway.ts`.
- CLI commands under `kala-host rl ...` through
  `packages/host/src/ops-cli.ts`.
- Python slime adapter under `integrations/slime_agent_kernel/`.
- Python trainer-environment preflight under
  `integrations/slime_agent_kernel/preflight.py`.

Test coverage per module:

- `packages/host/src/rl/implementation-gate.test.ts` — task pool
  training-mode rejection, path traversal, live `runRlRollout` smoke through
  `policyGatewayAdapter` against a fake SGLang HTTP server (request routing,
  token/logprob capture, reward artifact creation, trajectory construction,
  slime sample readiness in one local integration path).
- `packages/host/src/llm/policy-gateway.test.ts` — fake SGLang-compatible
  response proving capture and fail-closed behavior.
- `tests/python/test_slime_agent_kernel_adapter.py` — Python adapter import
  and synthetic slime `Sample` construction.
- `tests/python/test_slime_trainer_preflight.py` — preflight schema and
  strict-mode exit codes.

Baseline local results recorded on 2026-07-12:

```text
shared build: passed
host typecheck: passed
host tests: 52 files, 518 tests passed
dashboard typecheck: passed
dashboard tests: 47 files, 338 tests passed
Python adapter tests: 2 passed
Python preflight tests: passed
Chromium E2E: passed
```

## Appendix B. Secrets and Credentials Rules

Do not put secrets in docs, git commits, artifacts, command transcripts, or
reports.

Defaults:

- **GPU-provider authentication**: use the existing local rented GPU provider CLI
  configuration or shell environment already present on the machine. Do not
  paste or record the API key.
- **SSH**: use the local SSH key already registered with the provider. Do not
  copy private key material into the repo or report.
- **Remote secrets**: if a remote environment file is needed, create an
  untracked file such as `~/agent-kernel-secrets.env` with `chmod 600` and
  source it in the shell. Do not include it in artifacts.
- **Endpoints**: redact concrete provider base URLs and private hostnames in
  any committed report. Local loopback addresses and intentionally public
  non-secret service names are fine.
- **Experiment files**: full-fidelity run logs and evidence reports live under
  `experiments/` which is `.gitignore`d for exactly this reason. They may
  contain instance ids, ssh hosts, and internal IPs.
