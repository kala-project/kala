# Agentic RL Training Design

Status: training methodology and execution plan
Scope: what to train, how to train it, on which hardware, under which budget,
      with which stop conditions, and against which risks.

This document describes *how* to execute Agentic RL training for
`agent-kernel` against slime. It complements two other documents in this
directory:

- [`system-design.md`](system-design.md) — the source-of-truth architecture,
  including why historical product sessions are not RL samples, the
  rollout-then-train boundary, and the schemas the design produces. Read that
  first.
- [`implementation.md`](implementation.md) — the local implementation gate
  and acceptance criteria that must be green *before* any paid training
  attempt.

Experiment records and evidence reports live under `experiments/` and are not
committed. See `experiments/README.md`.

## 0. Fixed Execution Decisions

The following decisions are fixed for the current phase. They should not be
relitigated unless local facts contradict them.

- **Target framework:** slime only. verl is a future extension and is not part
  of the first real training claim.
- **Target model for the first trainer smoke:** `Qwen/Qwen2.5-0.5B-Instruct`,
  because `references/slime/tests/test_qwen2.5_0.5B_short.py` and
  `references/slime/scripts/models/qwen2.5-0.5B.sh` already exercise this exact
  model in slime's own test path. Starting from slime's own known-good shape
  removes trainer-side risk before agent-kernel is attached.
- **GPU provider:** configurable rented GPU host. Set an explicit per-run budget cap before launch.
- **GPU choice, in preferred order:**
  1. 4× A100 40GB or 4× A100 80GB — primary target. Matches slime's official
     Qwen2.5-0.5B short-test shape (4 GPUs, `--attention-backend flash`,
     TransformerEngine/Megatron, SGLang). A100 is mature for
     BF16/FlashAttention-2/Megatron.
  2. 4× H100/H200 80GB — best technical target if budget is raised or an
     affordable verified offer exists. Hopper is the strongest path for modern
     TransformerEngine/FP8/FlashAttention-3 stacks but is not required for the
     0.5B smoke.
  3. 4× RTX 4090 — fallback only when A100/H100 cannot be obtained. Ada
     supports FlashAttention-2 but consumer training environments are less
     predictable for Megatron/TE packed THD paths.
  4. 4× RTX 3090 — last-resort budget fallback for integration smoke only. Do
     not present a 3090-only workaround as production-grade success.
- **Not single-GPU** for the first full trainer E2E unless the runbook is
  explicitly changed and validated against slime's Qwen2.5-0.5B test. The
  reference uses `NUM_GPUS = 4`.
- **One instance at a time.** Never keep multiple paid instances running.
- **Data-center GPUs preferred over consumer GPUs** even when consumer cards
  are cheaper — the active blocker has been attention-backend compatibility,
  not raw FLOPS.

## 1. Executive Summary

The production-grade Agentic RL path for `agent-kernel` is:

1. Use benchmark/task datasets to select tasks.
2. Let slime call `agent-kernel` during its rollout phase via
   `--custom-generate-function-path
   integrations.slime_agent_kernel.generate.generate`.
3. Route `agent-kernel` model calls through slime's current policy serving
   stack (SGLang native `/generate`).
4. Capture exact sampled token ids and logprobs at generation time.
5. Convert multi-turn tool traces into loss-masked trajectory segments.
6. Verify final outcomes in clean environments.
7. Return native slime `Sample`s to the framework.
8. Persist event logs, traces, sidecars, and rewards for audit and debugging.
9. Add verl later only after the slime path has completed real training.

Anything less is useful infrastructure, but it is not yet real Agentic RL
training.

The overall boundary is:

```text
curated task pool
  -> slime custom_generate
  -> agent-kernel live rollout
  -> policy gateway backed by SGLang
  -> token capture artifacts
  -> verifier reward
  -> trajectory/sample validation
  -> slime Sample
  -> slime trainer step
```

The design rationale for that boundary — including why product session JSONL
is not on the training data plane — lives in
[`system-design.md`](system-design.md).

## 2. Product Data Flywheel

Even though product session logs are not RL rollouts, the product still feeds
training indirectly. The flywheel is:

- Product usage produces session logs, traces, and reward-related events.
- Curation extracts *task candidates* (prompts, initial state, hidden tests,
  known failures) from those logs.
- Curated tasks become entries in the task pool.
- slime rolls out on that task pool during training.
- Training improves the model; the improved model is deployed back into the
  product, which produces new session logs.

The training-time data plane still consists of on-policy rollouts, not
historical logs. See `system-design.md` §5.

## 3. What Product Sessions Can Become

Product sessions are still highly valuable after curation. The right
conversion depends on what evidence exists.

| Target asset | Input from product sessions | Extra processing required |
| --- | --- | --- |
| Badcase corpus | failed traces, user corrections, errors | dedup, taxonomy labels, redaction |
| Eval cases | reproducible tasks and expected checks | initial state reconstruction, verifier script |
| SFT examples | high-quality assistant/tool behavior | prompt/completion extraction, retokenization, filtering |
| Preference pairs | two attempts, user edits, explicit feedback | pair construction, label confidence scoring |
| Reward model data | outcome signals, tests, user feedback | normalize labels, separate weak/strong reward |
| RL task pool | issue/task candidate plus reconstructable initial state | sandbox image, base commit, verifier, task metadata; no old assistant actions |

Only the final row, the RL task pool, becomes a source for live RL rollout.
The trainer still reruns the agent against the current policy to generate
trainable tokens.

An RL task pool entry should therefore contain task conditions, not
historical actions:

```json
{
  "task_id": "product-derived:repo:issue-123",
  "prompt": "Fix the failing parser behavior described below...",
  "initial_state": {
    "repo_ref": "git:<remote-or-snapshot>",
    "base_commit": "abc123",
    "sandbox_image": "registry/project-image:tag",
    "workdir": "/workspace/repo"
  },
  "verifier": {
    "type": "pytest",
    "command": "pytest tests/test_parser.py",
    "timeout_ms": 600000
  },
  "provenance": {
    "source": "product_session",
    "session_ref": "redacted-session-index-only",
    "redaction_status": "passed",
    "training_allowed": true
  }
}
```

It must not contain a field such as `assistant_response_to_train`,
`tool_trajectory_to_train`, or `old_rollout_tokens` unless that data is being
used for a non-RL purpose such as SFT or preference learning with explicit
quality controls.

Not uses for the on-policy training path:

- On-policy PPO/GRPO/RLVR data.
- Loss-mask input.
- Rollout logprobs.

## 4. What Real Agentic RL Training Requires

For the training-time rollout, every sample must include:

- policy-sampled token ids (prompt + response),
- response mask / loss mask aligned to response length,
- rollout logprobs aligned with the mask,
- reward from a clean verifier,
- model / tokenizer / chat-template identity,
- weight version or trainer step of the actor,
- rollout id and session id for grouping.

If any of these are missing or synthesized from re-tokenized text, the sample
is not trainable.

## 5. Framework Selection Decision

slime is the first and only target for the initial real training claim.

Reasons:

- slime's extension points (`custom_generate`, custom reward path) are built
  around live rollout generation, which matches the agent-kernel data plane.
- slime already ships a Qwen2.5-0.5B test path with concrete Megatron/SGLang
  configuration. Starting from that shape removes trainer-side risk.
- verl's data model is tensor-first (`DataProto`) and its Agent Loop is a
  reasonable second target *after* the slime path is proven.
- OpenRLHF and TRL are useful downstream adapters for simpler prompt/
  completion or preference workflows, but they do not match the interactive
  multi-turn tool-use shape of `agent-kernel` rollouts.

Explicit non-scope for the first implementation:

- verl `AgentLoopBase` implementation,
- generic adapter compatibility layer,
- universal trajectory schema,
- training directly from historical product sessions.

## 6. Reference Framework Contracts

The observations below are grounded in the checked-in `references/slime` and
`references/verl` code, not in generic imagined schemas.

### 6.1 slime

Relevant local files:

- `references/slime/docs/en/get_started/agent.md`
- `references/slime/docs/en/get_started/customization.md`
- `references/slime/slime/utils/types.py`
- `references/slime/slime/agent/trajectory.py`
- `references/slime/slime/agent/adapters/common.py`
- `references/slime/examples/coding_agent_rl/generate.py`
- `references/slime/examples/coding_agent_rl/README.md`

slime combines Megatron training, SGLang rollout serving, a router, and a
Data Buffer. Agentic workflows plug into data generation rather than replacing
the trainer.

Preferred agentic extension point:

```python
async def custom_generate(args, sample: Sample, sampling_params: dict) -> Sample | list[Sample]
```

configured with:

```bash
--custom-generate-function-path my_module.generate
```

The `Sample` dataclass includes the training fields slime needs:

```python
@dataclass
class Sample:
    prompt: str | list[dict[str, str]] = ""
    tokens: list[int] = field(default_factory=list)
    response: str = ""
    response_length: int = 0
    reward: float | dict[str, Any] | None = None
    loss_mask: list[int] | None = None
    rollout_log_probs: list[float] | None = None
    weight_versions: list[str] = field(default_factory=list)
    rollout_id: int | None = None
    session_id: str | None = None
    status: Sample.Status = Sample.Status.PENDING
    metadata: dict = field(default_factory=dict)
```

slime's coding-agent example is the closest reference design. Its
`generate.py` does the real rollout: load tokenizer, open adapter session,
boot sandbox, prepare workspace/task prompt, run a real coding agent CLI,
capture the diff, grade in a second clean sandbox, drain the adapter session
into slime `Sample`s, return.

The key trajectory object is:

```python
@dataclass(frozen=True)
class TurnRecord:
    prompt_ids: list[int]
    output_ids: list[int]
    finish_reason: str
    output_log_probs: list[float] = field(default_factory=list)
    ill_formed: bool = False
```

Linearization rules:

- generated model output tokens → `loss_mask=1`,
- prompt/tool/environment/template tokens → `loss_mask=0`,
- response-side logprobs aligned with response-side masks,
- fork handling when prompt token drift cannot be safely realigned,
- one or more sibling samples for sub-agent or compaction branches.

### 6.2 verl (future)

Relevant local files:

- `references/verl/docs/advance/agent_loop.rst`
- `references/verl/docs/start/agentic_rl.rst`
- `references/verl/verl/experimental/agent_loop/agent_loop.py`
- `references/verl/verl/utils/dataset/rl_dataset.py`

verl's Agent Loop is explicitly designed for multi-turn rollout and agentic
RL. The output contract is token-first:

```python
class AgentLoopOutput(BaseModel):
    prompt_ids: list[int]
    response_ids: list[int]
    response_mask: list[int]
    response_logprobs: Optional[list[float]] = None
    reward_score: Optional[float] = None
    num_turns: int = 0
    metrics: AgentLoopMetrics
    extra_fields: dict[str, Any] = {}
```

For a future verl adapter, the clean implementation is
`AgentKernelLoop(AgentLoopBase)` registered as a custom agent loop class. Its
`run()` should call `LLMServerClient.generate(prompt_ids=...)` when the agent
needs the policy model, and return `AgentLoopOutput` with token ids and
masks. This is a Phase 6 concern; not first-implementation scope.

## 7. Corrected Integration Principle

The earlier wording "export rollout JSONL for verl/slime" is too weak. The
corrected principle is:

> `agent-kernel` must be callable as a live rollout harness inside slime's
> rollout phase. Its logs and JSONL artifacts are audit and replay products
> of that rollout. The trainer consumes slime `Sample`s produced by the same
> rollout, not historical product session JSONL and not audit sidecars by
> themselves.

The implementation must cover both **rollout** and **training**:

- Rollout: start task, run agent, call current policy model, run tools,
  manage sandbox, capture exact sampled tokens, capture trace, finish
  session.
- Reward: apply patch or final state in a clean verifier environment, compute
  reward and structured failure labels.
- Training handoff: return `Sample | list[Sample]` to slime.
- Training: let slime compute logprobs/advantages/loss and update actor
  weights through their native trainer.
- Weight sync: use the framework's rollout server lifecycle so subsequent
  rollouts sample from the updated actor.

## 8. Target Architecture

### 8.1 Layers

The architecture separates durable observability artifacts from training
samples.

**Event Ledger**

- Existing append-only session JSONL.
- Records user messages, LLM calls, tool calls, tool results, approvals,
  compactions, child sessions, terminal process state, errors, and final
  state.
- Used for replay, debugging, UI, audit, badcase mining, and later dataset
  extraction.

**Trace Artifact**

- OpenInference/OpenTelemetry-shaped spans.
- Records timing, hierarchy, errors, LLM call metadata, tool latency, sandbox
  lifecycle, verifier runs, benchmark task identity.
- Redacts secrets and private endpoints.

**Rollout Sidecar / JSONL Index**

- Links `rollout_id`, `session_id`, `task_id`, event log ref, trace ref,
  reward ref, token artifact ref, framework target, model, weight version,
  status.
- Not a trainer tensor file.

**Token Capture Artifact**

- Generated during model calls, not after the fact.
- Records per-turn `prompt_ids`, `output_ids`, `output_log_probs`, finish
  reason, request id, route key/session id, tokenizer, chat template, model,
  weight version, prompt-message hash.

**Trajectory Builder**

- Converts per-turn token snapshots into trainable segments.
- Assigns `loss_mask=1` only to policy-generated assistant/action tokens.
- Assigns `loss_mask=0` to user/system/tool/environment/verifier/template
  tokens.
- Detects token drift across multi-turn prompts.
- Forks or demotes unsafe spans when token provenance cannot be proven.
- Produces one or more training segments per rollout when compaction,
  sub-agents, or branches require fan-out.

**Reward Artifact**

- Produced by a clean verifier.
- Records binary reward, optional shaped labels, logs, patch application
  status, test results, timeout/error class, and verifier environment
  identity.

**Framework Adapter Output**

- slime: `Sample | list[Sample]` returned live from `custom_generate()`.
- future verl: `AgentLoopOutput` returned live from `AgentLoopBase.run()`.

### 8.2 Component Diagram

```text
Trainer step
  |
  '-- slime rollout/Data Buffer
        -> custom_generate()
        -> agent-kernel rollout session
             |-- tools / executor / sandbox
             |-- policy model gateway
             |     '-- slime SGLang /generate adapter
             |-- event log + trace + sidecar
             '-- clean verifier reward
        -> slime Sample(s)
        -> slime trainer update

Future path, not first implementation:

verl PPOTrainer
  -> AgentLoopManager
  -> AgentKernelLoop.run()
  -> AgentLoopOutput
```

## 9. Token-Correct Model Gateway Design

`agent-kernel` currently supports provider-style model calls. For training,
those calls go through a *policy gateway* provider that preserves token
provenance.

### 9.1 Interface

The gateway supports a message-oriented interface for the agent while
internally preserving token-level provenance:

```ts
type PolicyGatewayRequest = {
  sessionId: string
  turnId: string
  messages: KernelMessage[]
  tools?: ToolSchema[]
  sampling: SamplingParams
  routeKey: string
}

type PolicyGatewayResponse = {
  assistantMessage: KernelMessage
  providerRawResponse: unknown
  tokenSnapshot: {
    promptIds: number[]
    outputIds: number[]
    outputLogProbs?: number[]
    finishReason: string
    responseMaskHint?: number[]
    requestId: string
    routeKey: string
    tokenizer: string
    chatTemplateHash: string
    model: string
    weightVersion?: string
  }
}
```

### 9.2 slime Gateway

For slime, the training-smoke gateway uses SGLang native `/generate` by
default:

- Render incoming messages into the prompt passed to the served model.
- Call SGLang native `/generate` with sampling params, route key, and
  `return_logprob=True`.
- Read prompt token ids from `meta_info.input_token_logprobs` and generated
  token ids from `output_ids` or `meta_info.output_token_logprobs`.
- Read generated-token logprobs from `meta_info.output_token_logprobs`.
- Parse tool calls and reasoning blocks using the configured SGLang parsers.
- Return a provider-shaped response to `agent-kernel`.
- Record a `TurnRecord(prompt_ids, output_ids, output_log_probs, finish_reason)`
  into a trajectory manager.
- Use the same `sessionId` as a router key for session affinity.

The OpenAI-compatible `/v1/chat/completions` gateway is **not** the training
default. In the tested SGLang path it returned response text/logprob metadata
but did not expose the real token ids needed to build a slime `Sample`.

## 10. Reward and Verification Design

For coding tasks, reward must be computed outside the mutable agent
workspace. The verifier uses a two-sandbox design.

Training rollout sandbox:

1. Boot workspace from task image or clean checkout.
2. Place problem statement and task metadata.
3. Run `agent-kernel` with tools enabled.
4. Let the agent read/edit/run tests.
5. Capture final patch or workspace diff.

Verifier sandbox:

1. Boot a second clean environment from the same base image/commit.
2. Apply the captured patch.
3. Run official benchmark harness or configured tests.
4. Emit reward and structured diagnostics.
5. Destroy sandbox.

Canonical reward artifact:

```json
{
  "schemaVersion": 1,
  "kind": "rl_reward",
  "taskId": "swebench:sympy__sympy-20590",
  "sessionId": "...",
  "rolloutId": "...",
  "reward": 1.0,
  "resolved": true,
  "label": "resolved",
  "patchApplied": true,
  "verifier": {
    "type": "swe-bench",
    "image": "...",
    "baseCommit": "...",
    "timeoutMs": 600000
  },
  "logs": {
    "stdoutRef": "...",
    "stderrRef": "..."
  }
}
```

Reward labels (low-cardinality for aggregation):

- `resolved`
- `empty_patch`
- `patch_apply_failed`
- `test_failed`
- `agent_timeout`
- `agent_error`
- `harness_error`
- `infrastructure_error`

For slime, reward is assigned directly in `Sample.reward` from
`custom_generate()`. A separate `--custom-rm-path` is useful later when reward
computation is centralized or batched.

## 11. Can Current Rollout JSONL Be Used for Training?

Short answer: **not for real PPO/GRPO/RLVR training by itself**.

Current run-level JSONL rows are useful for indexing benchmark trials,
joining reward to session id, selecting successes/failures, replaying
sessions, badcase mining, and extracting candidate task prompts for a later
live rollout job. They are not sufficient for policy-gradient training,
advantage computation over policy-sampled tokens, old-logprob objectives,
response masking, weight-version-aware on-policy rollout, or framework-native
Data Buffer ingestion.

| Use | Current JSONL enough? | Additional requirements |
| --- | --- | --- |
| Audit/replay/debug | Yes | Event log and trace refs |
| Offline eval report | Yes | Benchmark trial artifacts |
| Badcase mining | Yes | Failure labels and traces |
| SFT extraction | Partially | Convert messages to prompt/completion, retokenize, accept mismatch risk |
| Rejection sampling | Partially | Successful completions, retokenization, dedup/filtering |
| DPO/preference data | Partially | Paired outputs and preference labels |
| Real on-policy RL | No | Live rollout through trainer, token ids, masks, logprobs, reward, weight sync |

## 12. Implementation Plan

The plan is phased. Phases 0–5 are in scope for the first real training
claim. Phase 6 (verl) and later expansions are out of scope until slime is
proven.

### Phase 0: Contract Baseline

Goal: make existing limitations explicit and testable.

- Keep current guarded verl export behavior for legacy/export tooling: no
  `tokenIdsCaptured=true`, no ready `AgentLoopOutput` file.
- Document run-level export as `rollout-index.jsonl`, not
  `training-data.jsonl`.
- Add contract tests that assert metadata-only JSONL lacks trainable fields.
- Add docs and CLI warnings: `export-rollouts` is not a trainer dataset.

Acceptance: tests fail if code fabricates token ids from text; dashboard/CLI
display `metadata-only` or `not training-ready` for current exports.

### Phase 1: Token Capture Artifact and Trajectory Builder

Goal: define the local training data plane independent of a specific
framework.

- Add `PolicyTokenSnapshot` schema.
- Add `CapturedTurnRecord` schema equivalent to slime's `TurnRecord`.
- Add `AgentTrajectoryBuilder` inspired by slime `TrajectoryManager`:
  clean append when prompt ids extend existing tokens; realign short drift
  inside most recent response as `loss_mask=0`; fork on unsafe drift; emit
  one or more segments; never train tokens whose sampled origin cannot be
  proven.
- Persist token artifacts under:

  ```text
  runs/rollouts/token-captures/<session_id>.jsonl
  runs/rollouts/train-segments/<rollout_id>.json
  ```

Artifact shape:

```json
{
  "schemaVersion": 1,
  "kind": "policy_token_capture",
  "sessionId": "...",
  "turnId": "...",
  "requestId": "...",
  "routeKey": "...",
  "promptIds": [1, 2, 3],
  "outputIds": [4, 5],
  "outputLogProbs": [-0.1, -0.4],
  "finishReason": "stop",
  "model": "...",
  "weightVersion": "...",
  "tokenizer": "...",
  "chatTemplateHash": "...",
  "eventSeq": 42
}
```

Acceptance: unit tests cover clean multi-turn append, tool observation
masking, compaction drift, sub-agent fork, changed token counts, aborted
rollout; builder refuses to mark retokenized text as trainable.

### Phase 2: Policy Gateway for Local Serving

Goal: make `agent-kernel` call a training policy server while capturing
tokens.

- Add a provider adapter mode such as `KALA_PROVIDER=policy-gateway`.
- For slime, call SGLang `/generate` and request logprobs.
- Pass stable session route keys for prefix-cache affinity.
- Store request id, model, tokenizer, and weight version on every LLM trace.

Acceptance: a local smoke rollout produces token captures with non-empty
`promptIds`, `outputIds`, `outputLogProbs`, and matching lengths; redacted
LLM artifacts do not contain API keys or private base URLs.

### Phase 3: Clean Verifier Runtime

Goal: turn final agent output into reliable reward.

Verifier interface:

```ts
type VerifierInput = {
  taskId: string
  baseImage?: string
  baseCommit?: string
  workdir: string
  patch: string
  timeoutMs: number
}

type VerifierOutput = {
  reward: number
  resolved: boolean
  label: EvalFailureLabel
  patchApplied: boolean
  stdoutRef?: string
  stderrRef?: string
  metadata: Record<string, unknown>
}
```

- See §10 for the canonical persisted reward artifact shape.
- Implement local Docker verifier first if available.
- Keep E2B/remote sandbox as a production deployment option.
- Ensure verifier uses a clean checkout, not the agent workspace.
- Persist reward artifact and attach reward ref to rollout sidecar.

Acceptance: tests prove verifier rejects bad patches, accepts a synthetic
passing patch, and never reads mutated agent-only files.

### Phase 4: slime Live Training Integration

Goal: make slime run `agent-kernel` during rollout and train from returned
`Sample`s.

Package layout:

```text
integrations/slime_agent_kernel/
  __init__.py
  generate.py
  adapter.py
  sandbox.py
  reward.py
  dataset.py
```

`generate.py` contract:

```python
async def generate(args, base_sample: Sample, sampling_params: dict, evaluation: bool = False):
    service = AgentKernelService(args)
    task = parse_task(base_sample)
    session_id = make_session_id(base_sample, task)

    service.adapter.open_session(session_id, sampling_defaults=sampling_params)

    try:
        rollout = await service.run_agent_kernel(
            session_id=session_id,
            task=task,
            adapter_url=service.adapter_url,
            timeout=args.agent_kernel_rollout_timeout,
        )
        reward = await service.verify(task, rollout.patch)
        samples = await service.adapter.finish_session(
            session_id,
            base_sample=base_sample,
            reward=reward.value,
            extra_metadata={
                "agent_kernel_session_id": rollout.session_id,
                "event_log_ref": rollout.event_log_ref,
                "trace_ref": rollout.trace_ref,
                "reward_ref": reward.artifact_ref,
            },
        )
        return samples or abort_sample(base_sample, "empty_trajectory")
    finally:
        await service.adapter.drop_session(session_id)
```

Invocation options:

- Option A: run host/executor as long-lived services and call an HTTP action
  to create/run a session for each sample. Preferred for throughput and
  observability.
- Option B: per-sample `kala-host run-task` subprocess. Simpler for
  first smoke tests.

Required `Sample` fields on return:

- `tokens`, `response_length`, `loss_mask`, `rollout_log_probs`, `reward`,
- `status` (`COMPLETED`, `ABORTED`, `FAILED`, or `TRUNCATED`),
- `rollout_id`, `session_id`, `metadata`.

Launch shape:

```bash
cd references/slime

export HF_CHECKPOINT=/models/Qwen2.5-0.5B-Instruct
export REF_MODEL_PATH=/models/Qwen2.5-0.5B-Instruct_torch_dist
export PROMPT_DATA=/data/swebench_agent_kernel_train.jsonl
export KALA_HOST_URL=http://127.0.0.1:13000
export KALA_EXECUTOR_URL=http://127.0.0.1:13002
export KALA_ARTIFACT_ROOT=/runs/agent-kernel-rollouts
export ADAPTER_PUBLIC_HOST=<routable-host-ip>
export ADAPTER_PORT=18001

python train.py \
  --hf-checkpoint "$HF_CHECKPOINT" \
  --ref-load "$REF_MODEL_PATH" \
  --prompt-data "$PROMPT_DATA" \
  --input-key prompt \
  --label-key label \
  --metadata-key metadata \
  --custom-generate-function-path integrations.slime_agent_kernel.generate.generate \
  --rollout-batch-size 2 \
  --n-samples-per-prompt 2 \
  --rollout-max-context-len 32768 \
  --rollout-max-response-len 8192 \
  --num-rollout 1 \
  --num-steps-per-rollout 1 \
  --global-batch-size 4 \
  --micro-batch-size 1 \
  --save-debug-rollout-data /runs/slime/rollout_{rollout_id}.pt \
  --sglang-mem-fraction-static 0.70
```

Exact Megatron/SGLang model-parallel flags depend on model and cluster.

### Phase 5: Full slime Training Smoke

Goal: prove the first real training loop before adding another framework.

- Provide a small slime launcher pinned to a tested slime commit.
- Provide a tiny model/small-task smoke path when GPU resources are limited.
- Write rollout debug artifacts and link them back to `agent-kernel`
  sidecars.
- Verify at least one slime train step consumes `Sample`s produced by
  `agent-kernel` live rollout.
- Record exact versions: `agent-kernel` commit, slime commit, model
  checkpoint, tokenizer hash, SGLang version, CUDA/runtime details.

Acceptance:

- `custom_generate` runs `agent-kernel` for a task from the curated task
  pool.
- The policy model call goes through SGLang and records token ids/logprobs.
- A clean verifier computes reward.
- slime receives non-empty `Sample.tokens`, aligned `loss_mask`, aligned
  `rollout_log_probs`, and `reward`.
- A trainer step completes or fails with a framework/runtime error unrelated
  to missing rollout data. Missing token ids, masks, logprobs, or reward is
  a failure of this phase.
- A completed report exists under `experiments/rl/`.

### Phase 6 (deferred): verl Live Training Integration

Only after Phase 5 succeeds. See `system-design.md` §12.2 diagram and §6.2
above for the expected shape.

### Phase 7: Dashboard and CLI Surface

Goal: expose real training readiness without hiding missing pieces.

CLI additions:

```bash
kala-host rl prepare-swebench-dataset \
  --source swebench_verified \
  --output data/swebench_agent_kernel.jsonl \
  --limit 20

kala-host rl run-rollout-smoke \
  --task data/swebench_agent_kernel.jsonl \
  --provider policy-gateway \
  --artifact-root runs/rollouts-smoke

kala-host rl export-slime-plugin \
  --output integrations/slime_agent_kernel

kala-host rl inspect-rollout \
  --rollout runs/rollouts/<rollout_id>.json
```

Dashboard additions:

- Rollout readiness badge: `metadata-only`, `token-captured`,
  `reward-verified`, `slime-ready`, future `verl-ready`.
- Token capture detail view: prompt/output lengths, mask counts, logprob
  coverage, tokenizer, chat template hash, weight version.
- Verifier detail view: patch application, test result, logs, failure label.
- Framework adapter view: whether a rollout can enter training.

## 13. Testing and Acceptance Criteria

### Unit Tests

- Token capture schema validation.
- Trajectory builder clean append.
- Tool observation masking.
- Drift realignment.
- Unsafe drift fork.
- Sub-agent fan-out with shared rollout id.
- Compaction boundary handling.
- Verifier reward label mapping.
- Adapter blocked state when token ids are missing.

### Contract Tests

- slime `Sample` fixture generated from a synthetic two-turn tool trace.
- verl `AgentLoopOutput` fixture generated from a synthetic two-turn tool
  trace.
- JSONL export fixture proving metadata-only rows do not contain trainable
  tensor fields.
- Redaction fixture proving base URLs and tokens are removed from request
  and response artifacts.

### E2E Tests

- Headless dashboard test showing rollout readiness states and artifact
  detail.
- CLI token-capture smoke with fake SGLang server returning deterministic
  ids.
- Docker verifier smoke with one passing and one failing patch.
- slime custom-generate dry run returning a valid `Sample` without full
  trainer.
- Future verl AgentLoop dry run returning a valid `AgentLoopOutput` without
  full cluster.
- Optional GPU CI/manual gate that runs one real slime rollout/training step
  on a tiny model.

### Completion Gates

A rollout is `training-ready` only if all of the following are true:

- Token ids were captured at generation time.
- Trainable tokens are marked with loss/response mask.
- Logprob coverage matches framework requirements.
- Reward was computed by a verifier or explicit reward function.
- Model and tokenizer identity are recorded.
- Weight version or trainer step is recorded when running on-policy
  training.
- Framework adapter output passes a local contract test.

## 14. Definition of One Real Trainer Step

For the first success claim, *one real trainer step* means all of:

- slime invokes `integrations.slime_agent_kernel.generate.generate` during
  the rollout phase;
- agent-kernel runs a live rollout from a task pool entry;
- SGLang returns real prompt/output token ids and rollout logprobs;
- agent-kernel writes token capture, reward, trajectory, sample validation,
  and rollout result artifacts;
- the Python adapter returns a slime `Sample` built from those artifacts;
- slime consumes that sample in the training path;
- the trainer completes at least one optimizer/training step with finite
  loss, or an equivalent slime/Megatron log that proves the batch reached
  training.

A second rollout using weights updated by that trainer step is desirable but
not required for the first success claim. If achieved, label it as the
stronger *full on-policy round trip* result.

## 15. Constraints

### 15.1 What Not To Repeat

- Do not treat session JSONL as a PPO/GRPO training dataset.
- Do not emit fake token ids, fake logprobs, or fake reward evidence.
- Do not add RL framework fields into the core reducer protocol.
- Do not build a generic slime/verl abstraction for the first E2E. Target
  slime only.
- Do not count a dashboard/CLI smoke as a completed training run.
- Do not paste API keys, private SSH material, provider base URLs, or
  rented host addresses into committed code.
- Do not keep rented GPU host instances running after an experiment.

### 15.2 Environment Repair Boundary

The first valid E2E should use slime's native Qwen2.5-0.5B path and the
required TransformerEngine/flash-attn backend. Do not patch slime to bypass
the packed THD attention path and then claim full success.

Allowed changes:

- dependency/version fixes,
- preflight improvements,
- diagnostic patches that only print clearer environment/backend
  information,
- minimal adapter patches needed for agent-kernel integration.

If a non-THD or disabled-packed-attention workaround is attempted, label it
as exploratory only. It can inform a blocker report, but it is not the
target success path unless the report explicitly justifies the tradeoff and
states the result is not equivalent to the official slime path.

## 16. Risks

### 16.1 Token Drift

Risk: final messages re-tokenize differently from sampled tokens.

Mitigation: capture generation-time ids and use drift-aware trajectory
building. Demote unsafe spans to `loss_mask=0` or fork the trajectory.

### 16.2 Weight Staleness

Risk: rollout sampled from an old actor checkpoint.

Mitigation: run inside slime's rollout lifecycle so its server and
weight-sync mechanisms control policy freshness. Record weight version on
every token snapshot. Apply the same principle to a future verl adapter.

### 16.3 Long-Tail Agent Rollouts

Risk: a few tasks block rollout rounds.

Mitigation: wall-clock guards, sandbox boot concurrency, abort samples with
structured reasons, and slime fully-async path for production.

### 16.4 Underpowered Local Hardware

Risk: the development laptop can serve a small model for token-capture smoke
but cannot complete a realistic slime training step (optimizer state,
Megatron, Ray, rollout serving, context memory exceed available VRAM).

Mitigation: separate local rollout smoke from full training smoke. Use the
detected `Qwen/Qwen2.5-1.5B-Instruct` local cache for SGLang/token-capture
smoke, and run the complete slime train step on a slime-supported
Docker/GPU host. The E2E report must state which host ran each phase.

### 16.5 Reward Hacking and Test Cheating

Risk: agent tampers with the grading environment.

Mitigation: grade in a second clean sandbox; never run final verification
in the mutable agent workspace.

### 16.6 Artifact Privacy

Risk: traces leak API keys, private base URLs, or workspace paths.

Mitigation: redaction at artifact writer boundary; contract tests for
request and response artifacts; keep secrets out of sample metadata.

### 16.7 Framework API Drift

Risk: slime extension hooks evolve, and a future verl adapter may introduce
a second moving target.

Mitigation: pin tested commits in integration tests; keep framework
adapters in small Python packages; preserve event ledger as the stable
project-owned contract.

### 16.8 Attention-Backend Compatibility

Risk: TransformerEngine/Megatron reference-logprob forward requires a
compiled flash-attn extension (`flash_attn_2_cuda`) for the packed THD
sequence layout used by slime's training data path. A namespace-only
`import flash_attn` is not sufficient.

Observed failure mode:

```text
qkv_layout=thd_thd_thd
qkv_dtype: torch.bfloat16
attn_mask_type: padding_causal
Selected backend = NoBackend
flash_attn_2_cuda missing or unusable for the required THD packed sequence path
```

Mitigation: strict preflight that imports `flash_attn_2_cuda` explicitly,
plus a TransformerEngine/Megatron packed-THD attention smoke or the
official slime Qwen2.5-0.5B short test *before* attaching agent-kernel. Do
not attempt in-instance source builds of flash-attn during paid runtime —
prior attempts ran for hours and emitted unrelated architecture targets.
Prefer a prebuilt image that ships a compatible `flash_attn_2_cuda`.

## 17. Stop Conditions

Stop and write/update the blocker report when any of these happens:

- projected or actual spend would exceed the configured budget cap;
- spend reaches the configured preflight spend threshold without passing strict preflight on a selected host;
- three consecutive rented GPU provider instances fail before usable SSH;
- two different usable instances hit the same strict-preflight blocker;
- a trainer run reaches the same
  Megatron/TransformerEngine/flash-attn backend failure twice after
  dependency repair attempts;
- the next meaningful step would require source changes that bypass slime's
  official Qwen2.5-0.5B training path.

Stopping with a precise blocker report is better than spending the remaining
budget on unstructured image/provider permutations.

## 18. Task Pool for the Smoke

If no curated production task pool exists, create a minimal checked or
generated smoke task pool under the run artifact directory, not in
committed source. The first E2E smoke may use a trivial `local-fixture`
task and a command verifier whose purpose is to prove the training data
path, not agent coding ability.

Acceptable first-smoke task:

```json
{
  "schemaVersion": "agent.rl.task.v1",
  "taskId": "smoke-agent-kernel-slime-live-rollout",
  "source": { "kind": "local-fixture" },
  "prompt": "Return a short confirmation that the live rollout path is active.",
  "workspace": { "kind": "empty-tempdir" },
  "verifier": { "kind": "command", "command": ["bash", "-lc", "true"], "timeoutMs": 30000 },
  "governance": {
    "trainingAllowed": true,
    "redactionStatus": "not_required",
    "retentionClass": "training_allowed"
  }
}
```

This only proves integration. A stronger follow-up should use a real code
task with a verifier that fails before the agent acts and passes after the
intended change.

## 19. E2E Report Requirement

A complete implementation is not accepted only because tests pass. It must
also produce a human-readable E2E report with direct evidence that a real
slime rollout/training path executed. Reports live under
`experiments/` and are not committed. See `experiments/README.md`.

The report must include:

- agent-kernel commit, slime commit, SGLang version, Python environment,
  CUDA/driver/GPU details,
- selected model checkpoint path,
- tokenizer/chat template identity,
- task pool entry,
- all startup commands,
- session id and rollout id,
- token-capture artifact path and validation summary,
- verifier artifact path and reward,
- emitted slime `Sample` validation summary,
- slime trainer log excerpt proving sample consumption and train-step
  result,
- checkpoint or explicit reason no checkpoint was produced,
- known limitations and next scaling steps,
- a cleanup line showing `gpu-provider-cli show instances --raw` returns `[]`.

The report should distinguish local smoke evidence from full training
evidence. A local SGLang token-capture smoke on the RTX 5060 laptop is not
the same as a full slime training step on a larger host. Both are
valuable, but they prove different things.

## 20. Final Design Position

The production-grade Agentic RL path for `agent-kernel` is:

1. Use benchmark/task datasets to select tasks.
2. Let slime call `agent-kernel` during its rollout phase.
3. Route `agent-kernel` model calls through the framework's current policy
   serving stack.
4. Capture exact sampled token ids and logprobs at generation time.
5. Convert multi-turn tool traces into loss-masked trajectory segments.
6. Verify final outcomes in clean environments.
7. Return native slime `Sample`s to the framework.
8. Persist event logs, traces, sidecars, and rewards for audit and debugging.
9. Add verl later only after the slime path has completed real training.

Anything less is useful infrastructure, but it is not yet real Agentic RL
training.

## Appendix A: Architectural Rationale (from earlier research note)

The paragraphs below are the earlier research-note reasoning that informed
this design. They are preserved for context and because they capture the
reasoning path from "custom trajectory JSON" (rejected) to "framework-native
adapter" (chosen).

### A.1 Summary

The durable contract for `agent-kernel` should remain its append-only JSONL
event log and replayable kernel state. For RL training, however, the primary
contract should be adapter-first: emit or convert rollouts into the native
data contracts expected by mature training systems such as slime, verl,
OpenRLHF, or TRL.

The first serious integration target should be slime-style agentic rollout
generation, not a generic JSON trajectory format. slime's coding-agent
examples are closer to this project than ordinary prompt/completion RLHF
pipelines because they explicitly deal with tool calls, sandboxed code
execution, verifier rewards, token-level loss masks, and long-horizon agent
traces.

### A.2 Context

`agent-kernel` has several properties useful for RL rollout infrastructure:
replayable kernel reducer + append-only JSONL event log; host/executor
separation with tools executed outside the pure reducer; workspace-root
sandboxing and a host-side `agent` builtin for child sessions; tool,
approval, compaction, memory, and session events that can be audited; a
dashboard that can inspect state.

These are good control-plane properties. They are not, by themselves,
sufficient training data. RL frameworks need model-token-level samples,
logprobs, loss masks, rewards, rollout grouping, and sometimes
framework-specific tensor or buffer types. A JSONL UI/event trace is
valuable for audit and replay, but it is not a replacement for the training
framework's data plane.

### A.3 Industrial observations

There is no single accepted industrial "TrajectoryV1 JSON" standard for
agentic RL. The production practice is framework-native and adapter-driven.

**verl.** Core data movement is tensor-first (`DataProto`: tensor batches
plus non-tensor metadata plus `meta_info`). Appropriate for distributed
PPO/GRPO but not a natural source format for a browser-visible agent event
log. Implication: do not design `agent-kernel` around a custom JSON
trajectory and hope verl accepts it. Build a converter.

**slime.** Better first target for long-horizon coding agents. Extension
points are built around custom rollout generation and reward/verifier
hooks. Agentic workflows are plugged into data generation instead of being
forced through a universal trajectory JSON first. The key lesson: the agent
harness operates in a message/string/tool/environment world, but the
training sample must preserve the actual sampled model token ids,
logprobs, and loss masks.

**OpenRLHF and TRL.** Mature and useful, but common entry points are closer
to prompt/completion/reward-function datasets. Less expressive for a full
interactive coding agent. Keep as possible downstream adapters, but do not
let their simplest dataset shapes define the internal architecture.

### A.4 Decision direction

`agent-kernel` should become an RL-ready rollout harness, not a training
framework and not the owner of a new universal trajectory standard.

Concretely:

- Keep JSONL event logs as the audit, replay, and debugging source of
  truth.
- Add a token-capture path around model generation for training samples.
- Build framework adapters that produce the native data expected by slime,
  verl, OpenRLHF, or TRL.
- Start with a slime adapter because it matches agentic coding workflows
  most closely.
- Treat any JSON sidecar as control-plane trace metadata, not as the
  primary training-plane format.

### A.5 Non-goals

- Do not implement PPO/GRPO/DAPO inside `agent-kernel`.
- Do not define a universal `TrajectoryV1` as the main interface.
- Do not make JSONL event logs carry token tensors directly.
- Do not couple the pure kernel reducer to any RL framework.
- Do not treat UI replay data as sufficient training data.

### A.6 Open research questions

- Which serving path should provide reliable token ids and logprobs: SGLang,
  vLLM, a custom OpenAI-compatible gateway, or another backend?
- How should compaction be represented in training samples without
  corrupting token-prefix consistency?
- How should sub-agent traces be credited: parent-only outcome reward,
  per-child segment reward, or hierarchical credit assignment?
- How should sibling rollouts and rollout ids map to slime and verl
  grouping semantics?
- Which benchmark tasks should be used first: SWE-bench style repo tasks,
  smaller unit-test repair tasks, or synthetic tool-use tasks?
- How much verifier detail should be exposed to the model during training
  versus retained only for audit?
- How should failed tool calls, cancelled turns, and partial rollouts be
  sampled or filtered?
