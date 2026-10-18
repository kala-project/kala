# Agentic RL System Design

Status: design source of truth
Last updated: 2026-07-12

## 1. Purpose

This document is the entry point for the Agentic RL design. It explains the
product idea, the slime integration model, the data boundary, and the final
target state in plain engineering terms.

Read this document first. Companion documents live alongside it:

- `implementation.md`: local implementation gate, component inventory, and
  acceptance criteria that must be green before any paid experiment.
- `training-design.md`: training methodology, execution decisions
  (GPU/model/budget), stop conditions, and risks for a real slime training
  experiment.
- `experiments/` (local-only, not committed): evidence reports and run logs
  from concrete attempts.

## 2. One-Sentence Design

`agent-kernel` is first a real product agent runtime. The same runtime should
also be callable from slime as a live rollout harness, so slime can train a
model from token-correct agent trajectories produced by the current policy
model.

The key rule is:

```text
Historical product sessions are task evidence, not RL training samples.
Training samples must be generated live by the current policy inside slime's
rollout phase.
```

## 3. Glossary

`agent-kernel`: This project. It owns the agent runtime: sessions, reducer,
host loop, tools, executor, logs, artifacts, and dashboard.

`commercial agent runtime`: The product-shaped agent that users can actually
use. It may be distributed as a local or hosted coding/general agent. The word
`commercial` means product-facing, not necessarily already monetized.

`product session`: A normal user session in the product. It records what the
user asked, what the agent did, which tools ran, and what failed or succeeded.

`session log`: The durable JSONL event ledger for replay, resume, and debug.
It is not a tensor dataset.

`trace`: More detailed execution evidence: LLM request/response, tool calls,
terminal output, timing, errors, and artifact links.

`badcase`: A failure or weak behavior worth studying. Example: the agent says a
background terminal does not exist even though the UI shows one.

`feedback`: User or system signal after an agent action. Example: user says the
answer is wrong, a test fails, or a verifier returns reward 0.

`task candidate`: A possible training/evaluation task extracted from product
usage. It is not ready for training until it is redacted, governed, made
reproducible, and given a verifier.

`redaction`: Removing private data such as API keys, private URLs, local user
paths, tokens, SSH material, or customer content that should not train a model.

`governance`: The data-use decision. It records whether data is allowed for
training, whether redaction passed, and how long the record can be retained.

`verifier`: An automatic grader. For code tasks this can be a test command,
SWE-bench grader, Terminal-Bench grader, or sandbox check. It turns the final
agent result into a reward.

`curated task pool`: A clean, reproducible set of tasks. Each task has a prompt,
initial environment, verifier, and governance metadata.

`policy model`: The model being trained. In the slime path it is served through
SGLang during rollout and updated by slime/Megatron during training.

`rollout`: One attempt by the current policy model to solve a task. In agentic
RL it can include many turns, tools, terminals, and verifier execution.

`live rollout`: A rollout generated now, during training, by the current policy
model. This is different from replaying an old user session.

`token capture`: The exact prompt token ids, generated output token ids,
rollout logprobs, and loss masks recorded when the policy model generates.

`loss mask` or `response mask`: A list marking which generated tokens are
trainable model actions. Tool output, user text, templates, and observations
are context, not policy actions.

`slime Sample`: The object slime trains on. It must contain tokens, response
length, loss mask, reward, and optionally rollout logprobs and metadata.

## 4. Product Data Flywheel

The intended loop is:

```text
commercial agent usage
  -> session logs / traces / badcases / feedback
  -> task candidate extraction
  -> redaction + governance + verifier design
  -> curated reproducible task pool
  -> slime training live rollout
  -> policy model update
  -> commercial agent runtime
```

Step by step:

1. `commercial agent usage`: Users use the product agent for real tasks.
2. `session logs / traces / badcases / feedback`: The product records what
   happened, where it failed, and how users or tests judged it.
3. `task candidate extraction`: The system finds real tasks that could become
   training or evaluation tasks.
4. `redaction + governance + verifier design`: The task is cleaned, approved
   for training use, and given an automatic scoring method.
5. `curated reproducible task pool`: The task becomes a clean record with a
   prompt, initial environment, and verifier.
6. `slime training live rollout`: slime asks the current policy model to solve
   the task through `agent-kernel`.
7. `policy model update`: slime trains the model from the live rollout samples.
8. `commercial agent runtime`: the improved model can be used again by the
   product agent.

The loop reuses product knowledge, not old product actions. Old user sessions
help discover tasks. They are not directly fed to PPO/GRPO as rollouts.

## 5. Why Historical Sessions Are Not RL Samples

A product session usually contains assistant text and tool history. That is not
enough for policy-gradient training.

Directly doing this is forbidden:

```text
session JSONL -> assistant messages/tool calls -> PPO/GRPO training sample
```

The required path is:

```text
session JSONL -> task candidate + evidence
             -> redaction + environment reconstruction + verifier
             -> curated task pool
             -> slime calls agent-kernel for live rollout
             -> token-correct slime Sample
```

Historical sessions are missing or cannot reliably prove these fields:

### 5.1 Current policy token ids

RL trains token actions from the model being optimized. Old text from another
model/provider is not enough. Retokenizing historical assistant text under the
training-time tokenizer does not recover the actions the current policy would
actually take from the same state.

### 5.2 Rollout logprobs

PPO-style methods need the behavior-policy probability of the sampled action.
Hosted product APIs often do not expose per-token logprobs, and even when they
do, those logprobs come from a different model or a different sampling
configuration than the current training policy.

### 5.3 Loss mask / response mask

Agent traces mix user text, system text, tool observations, terminal output,
and model output. Only policy-generated output tokens should usually receive
policy-gradient loss. A historical trace does not carry this mask; recovering
it after the fact is heuristic and error-prone.

### 5.4 Prompt/response boundaries

The training-time policy must know exactly which spans it generated versus
which spans were observations. Historical text does not carry deterministic
span markers, especially across tool interleaving and compaction summaries.

### 5.5 Actor weight version

The trainer needs to know which checkpoint produced the rollout. Product
sessions may come from arbitrary providers or versions. Without an actor
weight version, importance-ratio semantics and staleness bounds cannot be
enforced.

### 5.6 Sampling configuration

Temperature, top-p, top-k, max tokens, stop tokens, and routing affect rollout
distribution. These must be known and reproducible; product sessions may not
record them exactly and may use provider-side defaults that change over time.

### 5.7 Reliable reward

User-visible success is not the same as a reproducible scalar reward. Training
needs an automatic grader executed against a controlled environment, not a
proxy such as "the user did not complain."

### 5.8 Reproducible environment state

Code tasks need the same repository, commit, dependencies, sandbox image, and
test command. Reconstructing this from a stale product session is often
impossible without dedicated capture at task-candidate time.

### 5.9 Tool registry, prompt, skill, and context versions

Agent behavior is a function of more than the model. It also depends on system
prompt, tool schemas, approval policy, context assembly, memory injection,
skills, subagent prompts, and compaction policy. These must be versioned so a
training pipeline can distinguish model failure from runtime/prompt/tooling
changes. A historical session generated under an older tool registry or prompt
version does not represent the current policy's behavior even if the model
weights are identical.

### 5.10 Tokenizer and chat template identity

The same text can map to different token ids under different tokenizers or
chat templates. Training samples must record the tokenizer name/path plus the
chat template version (or a hash of the rendered template) used at rollout
time. Otherwise later retokenization can silently create a different
trajectory from the one the policy actually emitted.

### 5.11 Consent, redaction, and tenant constraints

Product sessions may contain private source code, secrets, internal paths,
private URLs, credentials, or regulated data. A commercial data flywheel needs
explicit metadata before any session can become a training asset:

- tenant id,
- user/workspace consent,
- `training_allowed` flag,
- retention policy,
- redaction status,
- secret scan status,
- deletion/export index,
- data boundary for enterprise tenants.

Without this layer, the data may be technically interesting but unusable for
training.

### 5.12 Data governance boundary

Product logs may contain private or unauthorized data even after redaction
passes; the governance decision (may this specific tenant's data be used for
training?) is separate from redaction and must be recorded on the task
record.

---

This is not a contradiction with using `agent-kernel` as an RL rollout
generator. The generator is the same runtime executed again during training,
against the current policy model, with real token capture and verifier reward.

## 6. slime Official Workflow

The local reference checkout is `references/slime` at commit
`680824dd5e01a2e83750bf87fc366ec6fa98766c`.

slime is an LLM post-training framework centered on two parts:

- Megatron for training.
- SGLang for rollout/inference.

The normal slime training loop is:

```text
prompt dataset
  -> rollout module calls generate
  -> SGLang produces tokens and logprobs
  -> reward/verifier is computed
  -> Samples enter the Data Buffer
  -> Megatron trains on those Samples
  -> updated weights sync back to SGLang
  -> next rollout uses newer policy weights
```

For simple tasks, slime can use its default SGLang rollout implementation in
`references/slime/slime/rollout/sglang_rollout.py`.

For agentic tasks, slime officially recommends customization hooks. The most
important hook for this project is:

```bash
--custom-generate-function-path some.module.generate
```

Inside `sglang_rollout.py`, slime checks this path. If set, it loads and calls
the custom function instead of directly calling the default generator:

```python
custom_func_path = sample.generate_function_path or args.custom_generate_function_path
custom_generate_func = load_function(custom_func_path)
sample = await custom_generate_func(args, sample, sampling_params)
```

The custom function receives:

```python
async def generate(args, sample, sampling_params):
    ...
    return sample
```

It is responsible for environment interaction, tool use, reward calculation,
and writing the fields slime needs on the returned `Sample`.

Typical official setup steps are:

1. Download or choose a HuggingFace checkpoint.
2. Convert it to Megatron/torch-dist format for training.
3. Prepare JSONL prompt data with input, label, and metadata keys.
4. Write or choose a `generate()` function.
5. Configure rollout batch size, samples per prompt, context/response limits,
   and SGLang arguments.
6. Configure Megatron training arguments.
7. Run `train.py` with both training and rollout arguments.

Official examples using this pattern include:

- `references/slime/examples/search-r1`: search/RAG-style multi-turn rollout.
- `references/slime/examples/retool`: tool-enabled code execution.
- `references/slime/examples/tau-bench`: multi-turn tool-use environment.
- `references/slime/examples/coding_agent_rl`: SWE coding-agent RL.

### 6.1 Official slime Usage vs agent-kernel Usage

This project should follow slime's extension model, not replace slime's
trainer or invent a parallel training protocol.

In the normal slime setup, the user provides:

- a prompt/task dataset;
- a HuggingFace checkpoint and any Megatron conversion artifacts required by
  the selected recipe;
- SGLang rollout serving configuration;
- a reward or verifier path;
- optional custom generation logic through `--custom-generate-function-path`;
- Megatron training arguments.

slime then owns the training loop:

```text
load task sample
  -> generate rollout with SGLang or custom_generate
  -> compute reward
  -> build slime Sample
  -> put Sample into slime Data Buffer
  -> Megatron trainer consumes Sample
  -> optimizer step updates policy weights
  -> updated weights sync back to rollout serving
```

`agent-kernel` should plug into the custom generation step only:

```text
slime custom_generate(args, sample, sampling_params)
  -> agent-kernel live rollout for the task
  -> policy gateway calls slime-controlled SGLang
  -> token capture records prompt/output ids, logprobs, masks, weight version
  -> verifier computes reward
  -> Python adapter returns slime-native Sample fields
```

The responsibility split is:

| Area | slime official responsibility | agent-kernel responsibility |
| --- | --- | --- |
| Trainer | Megatron training, optimizer step, data buffer, weight sync | none |
| Rollout serving | SGLang actor/reference serving and route/weight management | call SGLang through policy gateway |
| Agent harness | default examples can own the environment directly | product agent runtime owns sessions, tools, traces, verifier wiring |
| Token data | slime expects `Sample` tokens, masks, logprobs, reward | capture these at generation time and return them in slime's shape |
| Historical sessions | not part of the official trainer data path | used only for task discovery, badcase mining, and curation |
| Framework protocol | slime `Sample` and slime training args | no universal `TrajectoryV1`; keep audit artifacts and adapter output |

The practical difference from slime's own coding-agent example is not the RL
algorithm. It is harness ownership. In the official coding-agent example, the
example code starts a sandbox, runs Claude Code or Codex, intercepts model
calls, verifies the task, and returns samples. In this project, `agent-kernel`
already owns the production agent harness, so slime delegates that environment
interaction to `agent-kernel` and only receives the finished token-correct
`Sample`.

This means a successful integration must prove both sides:

- slime-side proof: custom generate is invoked by slime, returned `Sample`s are
  consumed by the trainer, and at least one trainer step reaches finite loss;
- agent-kernel-side proof: the rollout used the real session/tool/verifier path
  and token capture came from the current policy SGLang call, not retokenized
  transcript text.

Anything else is partial evidence. A dashboard readiness panel, a historical
session export, or a standalone SGLang `/generate` smoke can be useful, but it
is not a complete slime training result.

## 7. Official Coding-Agent Example vs This Project

The closest official example is
`references/slime/examples/coding_agent_rl`.

Its flow is:

```text
slime custom_generate
  -> boot sandbox
  -> install/run Claude Code or Codex CLI
  -> expose Anthropic/OpenAI-compatible adapter
  -> agent CLI calls adapter as if it were a provider API
  -> adapter forwards to SGLang /generate
  -> adapter captures token ids/logprobs/loss masks
  -> agent edits code and produces diff
  -> clean sandbox verifier scores diff
  -> adapter.finish_session returns slime Sample(s)
```

Our flow is:

```text
slime custom_generate
  -> call agent-kernel
  -> agent-kernel creates/runs a real session
  -> agent-kernel host loop uses policy gateway
  -> policy gateway calls SGLang /generate
  -> policy gateway captures token ids/logprobs/loss masks
  -> agent-kernel verifier scores the result
  -> agent-kernel writes rollout artifacts
  -> Python slime adapter reads artifacts and returns slime Sample
```

The shared idea is the same: use slime's custom-generate hook and return
token-correct `Sample`s. The difference is where the agent harness lives.

Official coding-agent example:

```text
slime owns the agent harness code directly inside the example.
```

This project:

```text
agent-kernel owns the product agent runtime; slime delegates live rollout to it.
```

That difference is intentional. It lets the same runtime serve users and train
models, and it gives rollouts the existing dashboard, debugger, artifact store,
session replay, tool execution, and robustness machinery.

It also creates engineering requirements:

- The bridge must not retokenize text and pretend it is sampled token data.
- The policy gateway must capture tokens at generation time.
- A production path should prefer a long-running service over spawning a CLI
  process for every sample.
- Performance, concurrency, cancellation, sandbox isolation, and verifier
  reproducibility must be measured before claiming production readiness.

## 8. agent-kernel Integration Design

The slime integration point is:

```bash
--custom-generate-function-path integrations.slime_agent_kernel.generate.generate
```

The implemented bridge lives in:

- `integrations/slime_agent_kernel/generate.py`
- `integrations/slime_agent_kernel/sample_builder.py`
- `integrations/slime_agent_kernel/preflight.py`

The target runtime path is:

```text
slime train.py
  -> slime rollout loop
  -> integrations.slime_agent_kernel.generate.generate(args, sample, sampling_params)
  -> kala-host rl run-rollout-smoke
  -> packages/host/src/rl/rollout-runner.ts
  -> host/reducer/executor normal agent loop
  -> packages/host/src/llm/policy-gateway.ts
  -> SGLang native /generate
  -> token capture artifact
  -> verifier reward artifact
  -> trajectory artifact
  -> slime sample validation artifact
  -> Python adapter builds slime Sample fields
  -> slime Data Buffer / trainer
```

The current Python adapter can run in two modes:

- artifact mode: read an existing trajectory and reward artifact and build a
  sample.
- live mode: call the `kala-host rl run-rollout-smoke` CLI, then read
  the produced trajectory and reward artifacts.

The expected returned slime sample fields are:

```python
{
    "tokens": prompt_ids + output_ids,
    "response_length": len(output_ids),
    "loss_mask": response_mask,
    "rollout_log_probs": output_log_probs,
    "reward": reward,
    "status": "completed",
    "metadata": {...},
}
```

If token ids, masks, logprobs, or reward are missing when required, the adapter
must fail closed. It must not invent synthetic tokens or fake readiness.

## 9. Internal Data Contracts

The curated task pool entry is `agent.rl.task.v1` and is implemented in
`packages/shared/src/rl-types.ts`.

It contains:

- `taskId`: stable task identifier.
- `source`: where the task came from, such as SWE-bench, Terminal-Bench,
  local fixture, or manual curation.
- `prompt`: the task instruction given to the agent.
- `workspace`: how to reconstruct the initial environment.
- `verifier`: how to score the final result.
- `governance`: whether this task is allowed for training.
- `metadata`: optional extra provenance.

The main RL artifact types are:

- `rl_task_pool`: task definitions or task references.
- `rl_token_capture`: prompt/output token ids, logprobs, mask, model, tokenizer,
  route key, and weight version.
- `rl_reward`: verifier result and scalar reward.
- `rl_trajectory`: links token captures and reward into a training trajectory.
- `rl_sample_validation`: readiness checks for slime sample construction.
- `rl_rollout_result`: top-level rollout status and artifact refs.

These artifacts are deliberately outside the core reducer event protocol. The
kernel should not know about slime, PPO, GRPO, SGLang, or trainer tensors.

## 10. Current Implementation Status

Implemented locally:

- shared Agentic RL schemas and artifact kinds,
- task-pool validation,
- policy gateway provider for SGLang native `/generate`,
- token capture artifact writing and validation,
- command verifier,
- host-side live rollout smoke runner,
- trajectory builder and slime sample readiness validation,
- `kala-host rl ...` CLI commands,
- Python slime adapter,
- Python trainer-environment preflight,
- dashboard Agentic RL readiness panel,
- unit tests, Python tests, and headless browser dashboard test.

Validated locally:

- TypeScript typechecks for host/dashboard,
- host vitest policy/RL implementation tests,
- Python adapter/preflight pytest tests,
- dashboard headless browser test for readiness UI and missing-artifact-root
  behavior.

For the component-level implementation gate, see `implementation.md`. For the
concrete experiment plan and stop conditions, see `training-design.md`.

## 11. Success Criteria

Full success requires all of these:

- strict preflight passes on the actual training host,
- a concrete model and hardware configuration is recorded,
- SGLang health and native `/generate` token/logprob evidence is recorded,
- slime logs show the agent-kernel custom generate function was called,
- agent-kernel artifacts include token capture, reward, trajectory, sample
  validation, and rollout result,
- slime consumes the sample,
- at least one real trainer step completes: for the first success claim this
  means a slime/Megatron optimizer or training step consumes an
  agent-kernel-generated `Sample` and reports finite loss; a second rollout
  after weight sync is a stronger result but is not required for the first
  success claim,
- the report states exact commands and environment versions,
- rented instances are cleaned up and final instance list is empty.

Partial success is acceptable only if clearly labeled. Examples:

- local implementation gate passed,
- SGLang token data-plane passed,
- custom generate bridge passed,
- trainer step blocked by a specific dependency/backend error.

These must not be claimed as full success:

- a dashboard readiness row,
- a fixture-policy smoke,
- fake SGLang endpoint tests,
- historical session export,
- sample construction from synthetic artifacts,
- a trainer command that starts but never consumes agent-kernel samples.
