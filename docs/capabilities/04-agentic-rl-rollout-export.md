# Agentic RL Rollout Export

Status: adapter foundation implemented; training-ready token capture missing
Priority: 4
Last reviewed against implementation: 2026-07-09

## Why This Matters

Agentic RL is a major differentiator for this project, but the critical mistake
would be inventing a simple `TrajectoryV1` JSON and pretending it is sufficient
for training. Production RL systems need token ids, logprobs, response masks,
reward metadata, rollout grouping, weight versions, and verifier outputs.

## Production References

- verl Agent Loop documentation describes multi-turn rollout where a user
  defined loop calls LLMs and tools, then returns `AgentLoopOutput` with
  `prompt_ids`, `response_ids`, and `response_mask` where model-generated tokens
  are marked separately from tool/environment tokens.
- slime describes custom data generation and rollout functions over SGLang,
  verifier rewards, data buffers, fault tolerance, tracing, and coding-agent RL
  examples.
- Existing project docs: [rl/system-design.md](../research/rl/system-design.md) is
  the source of truth for the adapter-first direction; see also
  [rl/training-design.md](../research/rl/training-design.md) and
  [rl/implementation.md](../research/rl/implementation.md).

## Design Principle

`agent-kernel` should be an RL-ready rollout harness, not a trainer and not the
owner of a universal trajectory schema. Export framework-native training data
through adapters while keeping JSONL as the replay/audit ledger.

## Required Layers

Event ledger: existing JSONL session log records what happened.

Trace layer: OpenTelemetry/OpenInference spans describe timing, hierarchy,
failures, and eval events.

Token capture layer: model gateway captures exact sampled token ids, optional
logprobs, response masks, sampling params, request ids, and model weight
version.

Reward layer: clean verifier produces deterministic reward metadata.

Framework adapter layer: converts completed rollouts to slime, verl, TRL, or
OpenRLHF-native formats.

## Token Correctness

The verl Agent Loop docs call out an important problem: re-encoding final chat
history is not equivalent to concatenating sampled prompt and response token ids
across turns. Tool parsers and decode/encode cycles can alter content. This is
not a serving problem, but it is a training correctness problem.

Therefore, the rollout path must capture tokens at generation time. Hosted LLM
APIs may be insufficient for full RL training because they often do not expose
the required token ids/logprobs. A serious RL path should go through a local or
controlled serving stack such as SGLang or vLLM, or through a gateway that can
record token-level data.

## Rollout Record Shape

The project can keep a lightweight sidecar, but it must be described as metadata
only:

```json
{
  "rollout_id": "...",
  "session_id": "...",
  "task_id": "swebench:sympy__sympy-20590",
  "framework_target": "slime",
  "event_log_ref": "sessions/...jsonl",
  "trace_ref": "traces/...otlp.jsonl",
  "token_segments_ref": "segments/...bin_or_jsonl",
  "reward_ref": "rewards/...json",
  "model": "...",
  "weight_version": "..."
}
```

This is not the training tensor format. It is an index that links artifacts.

## Segment Policy

Default loss mask policy:

- User/system/tool/environment/verifier tokens: mask `0`.
- Model-sampled assistant action tokens: mask `1`.
- Replayed context after compaction: mask `0` unless the training objective
  explicitly trains summaries.
- Tool observations inserted into later prompts: mask `0`.

The segment builder must preserve links back to event seq and span ids for
debugging failed samples.

## SWE-bench as RL Source

SWE-bench integration creates high-quality rollout tasks:

1. Task input is a real issue.
2. Agent action trace includes file reads, edits, tests, and shell commands.
3. Final patch is graded by official Docker harness.
4. Reward can be binary resolved/unresolved plus shaped diagnostic labels.
5. Failed traces become valuable negative data for prompt/tool/router changes.

## Adapter Targets

First target: slime custom data generation / custom generate function, because
its design explicitly supports arbitrary rollout generation, tools, sandboxes,
verifiers, and SGLang-backed training.

Second target: verl Agent Loop, because it gives a clear interface for
multi-turn rollouts and token masks.

Later targets: TRL/OpenRLHF for simpler prompt-completion/reward datasets, with
the caveat that they are lossy for long-horizon tool agents.

## Implementation Phases

The shared foundation includes `RolloutSidecar`, which intentionally indexes
event logs, trace artifacts, token segment artifacts, and reward artifacts. It
is not a trajectory format and must remain an adapter-side index.

Implemented local sidecar export command:

```bash
kala-host enhancement rollout export-session \
  --root-dir runs/rollouts \
  --session-log ~/.kala/sessions/<session>.jsonl \
  --task-id swebench:sympy__sympy-20590 \
  --framework slime \
  --model local-policy \
  --reward rewards/<session>.json

kala-host enhancement rollout export-segments \
  --root-dir runs/rollouts \
  --session-log ~/.kala/sessions/<session>.jsonl

kala-host enhancement rollout export-adapter \
  --root-dir runs/rollouts \
  --sidecar runs/rollouts/rollouts/<rollout_id>.json \
  --framework slime
```

The command first exports the OpenInference-shaped trace and redacted LLM
request/response artifacts, then writes:

```text
runs/rollouts/
  traces/<session_id>.openinference.json
  llm/<session_id>/<seq>.request.json
  llm/<session_id>/<seq>.response.json
  rollouts/<rollout_id>.json
```

The sidecar links to the event log, trace, optional reward file, optional token
segment file, target framework, model, and weight version. It deliberately does
not invent token ids or masks when the serving path did not capture them.

The host also exports a conservative rollout segment index:

```text
runs/rollouts/rl-token-segments/<session_id>.json
```

This artifact is intentionally not a framework training tensor file. It marks
assistant message segments with `lossMask=1`, user/system/tool/effect/compaction
segments with `lossMask=0`, preserves event sequence links, and sets
`tokenIdsCaptured=false`. It exists to make rollout structure inspectable and to
provide a stable handoff point for a future gateway that captures real token ids
at generation time.

The segment index also includes rollout topology metadata derived from the same
JSONL ledger: parent session id/cursor for forks and child agents, event counts,
tool call/result counts, compaction summaries, and sub-agent request/result
links parsed from the existing `agent` tool call and `<sub_agent>` result
envelope. This is deliberately metadata, not protocol state. Trainer adapters
can use it to split or filter rollout groups without asking the kernel to know
about RL concepts.

The framework adapter exporter is implemented as a handoff-artifact generator,
not as a trainer. For `slime`, it writes a ready custom rollout manifest under
`rl-adapters/slime/<rollout_id>.json` linking the event log, trace, token
segment artifact, reward artifact, model, and weight version. This is the
correct integration boundary for custom data-generation/rollout code.

For `verl`, the exporter only emits an AgentLoopOutput-shaped artifact when the
referenced token artifact explicitly contains generation-time `prompt_ids`,
`response_ids`, `response_mask`, and `tokenIdsCaptured=true`. If the available
artifact is the conservative segment index produced by `export-segments`, the
exporter writes a `status: blocked` artifact explaining that real token ids and
response masks are required. This prevents fake RL data from entering training
pipelines.

Phase 1: export completed session logs and verifier rewards with stable rollout
ids. Implemented as sidecar export.

Phase 2: add controlled local model gateway token capture for one backend.

Phase 3: segment builder for single-agent, no-compaction coding tasks.
Implemented as a host-side segment index over session logs. It does not
retokenize or synthesize token ids; it records estimated tokens, event seq links,
source roles, and loss-mask policy for debugging and adapter preparation.

Phase 4: slime adapter with verifier reward.
Implemented as `enhancement rollout export-adapter --framework slime`. It emits
a custom rollout manifest that links the replay ledger, trace, token segment
index, and reward reference without fabricating tensors.

Phase 5: verl Agent Loop adapter returning prompt ids, response ids, and masks.
Implemented as a guarded adapter export. It returns the verl AgentLoopOutput
shape only when an external token capture artifact provides real ids and masks;
otherwise it emits a blocked adapter artifact with the missing requirements.

Phase 6: support compaction, forks, subagents, sibling rollouts, and weight
version metadata. Implemented for export-side metadata: generated segment
artifacts now carry parent/fork lineage, compaction summaries, sub-agent
request/result linkage, and sidecar metadata for compaction/sub-agent counts.
Sibling rollout grouping and model weight version are represented in sidecars;
real training tensors still require generation-time token capture from a model
gateway.

## Testing Plan

- Unit test segment masks on synthetic tool-call traces.
- Golden test that event seq links survive export.
- Implemented topology test for parent lineage, compaction summaries, and
  sub-agent request/result linkage.
- Integration test with a small local model/gateway mock returning token ids.
- Verifier test that rewards run in a clean workspace, not the mutated agent
  workspace.
- Implemented adapter contract tests for slime ready manifests, verl blocked
  exports without token ids, and verl ready exports with captured ids/masks.

## Non-Goals

- Do not implement PPO/GRPO inside `agent-kernel`.
- Do not define a universal training trajectory schema.
- Do not rely on re-tokenizing final messages for RL correctness.
- Do not couple the kernel to slime, verl, SGLang, or vLLM.

## Current Implementation Alignment

### Implemented In Code

The current RL implementation is correctly adapter-first:

- `kala-host enhancement rollout export-session` writes a rollout
  sidecar linking session log, trace, token segment artifact, reward artifact,
  target framework, model, and weight version.
- `kala-host enhancement rollout export-segments` writes a conservative
  `rl-token-segments/<session_id>.json` artifact derived from the JSONL ledger.
- Segment artifacts preserve event sequence links, source roles, estimated
  token counts, loss-mask intent, compaction metadata, subagent topology, and
  `tokenIdsCaptured=false` when real ids were not captured.
- `kala-host enhancement rollout export-adapter --framework slime`
  emits a ready handoff manifest for custom rollout generation.
- `--framework verl` is guarded: it only emits AgentLoopOutput-shaped data when
  a referenced token artifact contains real `prompt_ids`, `response_ids`,
  `response_mask`, and `tokenIdsCaptured=true`; otherwise it writes a blocked
  artifact with missing requirements.
- `kala-host enhancement rollout verify-reward` reads a graded eval
  trial (`--trial <path>`) or scored session summary (`--score <path>`) and
  writes a canonical `rl_reward` artifact under `rl-rewards/<taskId>.json`.
  Reward is `1.0` when resolved, `0.0` otherwise; shaped labels reuse the
  low-cardinality `EvalFailureLabel` vocabulary (`resolved`, `empty_patch`,
  `patch_apply_failed`, `test_failed`, `agent_timeout`, `agent_error`,
  `harness_error`, `infrastructure_error`) with reason codes recording the
  source kind and provenance. The same runner is exposed as HTTP action
  `rollout-verify-reward`.
- `LLMTrace` records provider `gatewayRequestId` (Anthropic `request-id`
  header or message id fallback; OpenAI `x-request-id`/`openai-request-id`
  header or `chatcmpl_*` id fallback) and an optional `weightVersion` set via
  adapter options. Both fields flow into the OpenInference LLM span
  attributes `gen_ai.response.id` and `agent_kernel.model.weight_version`,
  which then land in the OTLP export bundle and every downstream trace
  artifact. Local gateways (SGLang, vLLM) can set `weightVersion` to pin a
  policy checkpoint per session.
- `packages/host/fixtures/rl-adapters/slime/custom-rollout-manifest.example.json`
  captures the exact shape a slime custom data-generation function will
  receive. A contract test regenerates the adapter output from a stamped
  sidecar and asserts byte-equality with the fixture, so trainer authors have
  a checked-in reference surface and the exporter cannot silently drift.
- `packages/host/fixtures/rl-adapters/verl/captured-tokens.example.json`
  and `packages/host/fixtures/rl-adapters/verl/agent-loop-output.example.json`
  form a matching pair for the verl ready-path. A contract test feeds the
  captured-token fixture into `exportRolloutFrameworkAdapter --framework verl`
  and asserts the emitted AgentLoopOutput matches the committed output
  fixture. Together they give trainer authors both an input and an output
  reference shape without exposing token ids to fabrication in the exporter.
- Dashboard Ops view renders rollout sidecars, segment indexes, adapter status,
  and related trace artifacts.
- Browser e2e verifies rollout segment, sidecar, and adapter artifacts through
  dashboard-origin actions and actual files on disk.

### Important Gaps

- There is no generation-time token capture gateway. This is the largest gap.
  Without sampled token ids and masks from the serving backend, the project must
  not claim to produce training-ready verl/slime tensors.
- There is no SGLang/vLLM integration and no model weight/version handshake with
  a controlled serving stack.
- No batch rollout controller exists for collecting rollouts at scale.
- No trainer-side smoke exists with slime or verl consuming generated artifacts.
- Segment masks are policy metadata, not authoritative training masks unless
  backed by generation-time token capture.
- The `verify-reward` runner reads from pre-graded artifacts and is not yet a
  standalone verifier service; multi-scorer reward shaping (weighted mixes,
  partial credit, learned reward models) is out of scope.

### Production Quality Criteria

This area is production-level when:

- A controlled model gateway records prompt ids, sampled response ids, logprobs,
  response masks, sampling parameters, request ids, and weight versions per LLM
  call.
- Rollout sidecars link ledger, trace, token capture, reward, and benchmark
  result artifacts for each task.
- slime and verl adapters have contract tests against their expected input
  shapes.
- Failed or compacted rollouts are explicitly labeled and filtered rather than
  silently entering training.
- Rewards are produced in clean verifier workspaces and are reproducible from
  saved artifacts.

### Next Implementation Steps

1. Design a local generation gateway adapter for one backend, preferably
   SGLang or vLLM, that captures token ids/logprobs/masks at generation time
   and populates `LLMTrace.gatewayRequestId` / `weightVersion` from the
   serving stack.
