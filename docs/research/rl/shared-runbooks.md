# Agentic RL Shared Runbooks

Status: shared reference runbooks for the four Agentic RL smoke tiers plus the
rented GPU host paid runbook. Everything in this file applies to *every* run; anything
that changes between runs (task pool contents, launch flags, success criteria)
belongs in `../../experiments/rl/<date>-run-<n>/runbook.md`, not here. This document is
committed; the operator log with concrete instance ids, timings, and error
transcripts lives in `../../experiments/rl/<date>-run-<n>/raw-log.md`, which is
`.gitignore`d.

For design context see `system-design.md`. For the implementation gate see
`implementation.md`. For methodology/budget/stop conditions see
`training-design.md`.

The runbooks are ordered from lightest to heaviest:

1. §1 Metadata-only baseline — audit path, no policy server.
2. §2 Token-capture smoke — SGLang + policy gateway, no trainer.
3. §3 SWE-bench rollout + clean reward smoke — full rollout, no trainer.
4. §4 slime training smoke — full rollout + one trainer step.
5. §5 rented GPU host overnight paid runbook — remote GPU execution of §2–§4.
6. §6 Future verl training smoke — deferred.

Each section states purpose, prerequisites, exact commands, and expected result.
Do not skip the expected-result check; a green command that fails the
expected-result check is not evidence of readiness.

## 1. Metadata-Only Baseline (existing commands)

Purpose: verify the existing audit/index path and prove it is not
training-ready.

Prerequisites:

- An existing `agent-kernel` session log.
- Built host CLI.

Commands:

```bash
pnpm install
pnpm --filter @agent-kernel/host build

export SESSION_LOG="$HOME/.kala/sessions/<session_id>.jsonl"
export ROOT="runs/rollouts-metadata"

node packages/host/dist/bin/kala-host.js enhancement rollout export-session \
  --root-dir "$ROOT" \
  --session-log "$SESSION_LOG" \
  --task-id swebench:sympy__sympy-20590 \
  --framework slime \
  --model local-policy

node packages/host/dist/bin/kala-host.js enhancement rollout export-segments \
  --root-dir "$ROOT" \
  --session-log "$SESSION_LOG"

node packages/host/dist/bin/kala-host.js enhancement rollout export-adapter \
  --root-dir "$ROOT" \
  --sidecar "$ROOT/rollouts/<rollout_id>.json" \
  --framework verl
```

Expected result:

- Trace and LLM artifacts are exported.
- Token segment index exists with `tokenIdsCaptured=false`.
- slime handoff manifest may be `ready` as an audit manifest.
- verl export is `blocked` unless a real captured-token artifact was provided.
- No command claims this is a trainable dataset.

## 2. Token-Capture Smoke With Policy Gateway

Purpose: prove `agent-kernel` can call a controlled policy server and capture
real tokens.

Prerequisites:

- Local or remote SGLang server with a small model and native `/generate`
  enabled.
- Tokenizer available locally.
- Implemented `policy-gateway` provider.

Commands:

```bash
export MODEL_PATH="$HOME/.cache/huggingface/hub/models--Qwen--Qwen2.5-1.5B-Instruct/snapshots/989aa7980e4cf806f80c7fef2b1adb7bc71aa306"
export ARTIFACT_ROOT=runs/token-capture-smoke

python -m sglang.launch_server \
  --model-path "$MODEL_PATH" \
  --host 127.0.0.1 \
  --port 30080 \
  --context-length 4096 \
  --mem-fraction-static 0.55

KALA_PROVIDER=policy-gateway \
KALA_POLICY_BASE_URL=http://127.0.0.1:30080 \
KALA_POLICY_ENDPOINT=native-generate \
KALA_ARTIFACT_ROOT="$ARTIFACT_ROOT" \
node packages/host/dist/bin/kala-host.js rl run-rollout-smoke \
  --prompt "Create a file hello.txt containing hello" \
  --workspace /tmp/agent-kernel-rl-smoke

node packages/host/dist/bin/kala-host.js rl inspect-rollout \
  --root-dir "$ARTIFACT_ROOT" \
  --latest
```

Expected result:

- At least one token capture artifact contains non-empty `promptIds` and
  `outputIds`.
- The SGLang call is native `/generate`, not OpenAI-compatible
  `/v1/chat/completions`, unless the latter has independently proven token-id
  output.
- `outputLogProbs.length === outputIds.length` when the backend supports
  logprobs.
- Training segment output has aligned `tokens`, `response_length`, and
  `loss_mask`.
- Event log and trace still render in the dashboard.

## 3. SWE-Bench Rollout and Clean Reward Smoke

Purpose: verify a task rollout can produce a patch and grade it in a clean
environment.

Prerequisites:

- SWE-bench task metadata or a small local SWE-style fixture.
- Docker or compatible sandbox.
- Implemented verifier runtime.

Commands:

```bash
export ROOT=runs/swebench-rl-smoke

node packages/host/dist/bin/kala-host.js rl prepare-swebench-dataset \
  --source swebench_verified \
  --output "$ROOT/tasks.jsonl" \
  --limit 1

KALA_PROVIDER=policy-gateway \
KALA_POLICY_BASE_URL=http://127.0.0.1:30080 \
node packages/host/dist/bin/kala-host.js rl run-rollout-smoke \
  --task-file "$ROOT/tasks.jsonl" \
  --artifact-root "$ROOT" \
  --verifier docker

node packages/host/dist/bin/kala-host.js rl inspect-rollout \
  --root-dir "$ROOT" \
  --latest
```

Expected result:

- A session log, trace, token capture, sidecar, patch artifact, and reward
  artifact are produced.
- Reward label is one of the canonical labels.
- Verifier logs are linked.
- The task is marked `reward-verified` and either `token-captured` or blocked
  with a precise missing artifact.

## 4. slime Training Smoke

Purpose: run a real slime rollout/training step where `agent-kernel` is the
custom generator.

The commands below are the reference/template form. **The concrete parameters
for a specific paid run (task pool, `--num-rollout`, `--n-samples-per-prompt`,
`--max-turns`, coefficients, verifier fixtures) live under
`../../experiments/rl/<date>-run-<n>/runbook.md`**. Read the run-specific runbook first
when reproducing or auditing a past run.

Prerequisites:

- `references/slime` installed in a slime-supported Python/Docker environment.
- SGLang-compatible model checkpoint.
- GPU resources adequate for the selected training recipe. The detected local
  8 GiB laptop GPU is not adequate for this full training smoke.
- Implemented `integrations.slime_agent_kernel.generate.generate`.
- `agent-kernel` host/executor reachable from the slime rollout workers.
- Sandbox/verifier configured.

Commands:

```bash
cd references/slime

export HF_CHECKPOINT=/models/Qwen2.5-0.5B-Instruct
export REF_MODEL_PATH=/models/Qwen2.5-0.5B-Instruct_torch_dist
export PROMPT_DATA=/data/agent_kernel_swe_smoke.jsonl
export KALA_HOST_URL=http://127.0.0.1:13000
export KALA_ARTIFACT_ROOT=/tmp/agent-kernel-slime-artifacts
export ADAPTER_PUBLIC_HOST=$(hostname -I | awk '{print $1}')
export ADAPTER_PORT=18001

python train.py \
  --hf-checkpoint "$HF_CHECKPOINT" \
  --ref-load "$REF_MODEL_PATH" \
  --prompt-data "$PROMPT_DATA" \
  --input-key prompt \
  --label-key label \
  --metadata-key metadata \
  --custom-generate-function-path integrations.slime_agent_kernel.generate.generate \
  --rollout-batch-size 1 \
  --n-samples-per-prompt 1 \
  --num-rollout 1 \
  --num-steps-per-rollout 1 \
  --global-batch-size 1 \
  --micro-batch-size 1 \
  --rollout-max-context-len 8192 \
  --rollout-max-response-len 2048 \
  --save-debug-rollout-data /tmp/slime-rollout-{rollout_id}.pt \
  --sglang-mem-fraction-static 0.60
```

Expected result:

- slime starts SGLang rollout serving and training components.
- `custom_generate` runs `agent-kernel` for the sample.
- `agent-kernel` model calls go through the slime/SGLang adapter.
- Returned `Sample` has non-empty `tokens`, aligned `loss_mask`, aligned
  `rollout_log_probs`, and a reward.
- slime completes at least one train step or a configured rollout-then-train
  debug step.
- Debug rollout data contains the agent-kernel artifact refs in metadata.
- The run updates `../../experiments/rl/<date>-run-<n>/final-report.md`
  with environment, commands, artifacts, sample validation, trainer logs, and
  conclusions.

## 5. rented GPU host Overnight Paid Runbook

Purpose: use rented GPU time only after confirming the repository can produce
evidence beyond container startup.

### 5.1 Local Preflight Before Renting

```bash
gpu-provider-cli show user
gpu-provider-cli show instances --raw | jq
gpu-provider-cli show ssh-keys --raw \
  | jq -r '.[0].public_key' \
  | awk '{print $1" "$2}' \
  | ssh-keygen -lf -

ssh-keygen -y -f ~/.ssh/id_rsa | ssh-keygen -lf -

rg -n "policy-gateway|run-rollout-smoke|inspect-rollout|prepare-swebench-dataset|slime_agent_kernel|custom_generate" \
  packages integrations docs \
  -g '!references/**'
```

Expected preflight result before any full-training rental:

```text
rented GPU provider API works.
rented GPU provider registered SSH key fingerprint matches ~/.ssh/id_rsa.
No running instances are leaked.
The live rollout implementation exists in source code, not only in docs.
```

If the live rollout implementation is missing, do not run the full paid E2E.
Use a 4× A100-class host with strict preflight. Only use 4× RTX 4090/3090 as a
fallback after documenting why A100/H100 was not available or failed before
preflight.

### 5.2 Create the Preferred 4× A100 Instance

```bash
export GPU_RENTAL_OFFER_ID=<fresh_4x_a100_offer_id>

gpu-provider-cli create instance "$GPU_RENTAL_OFFER_ID" \
  --template_hash 16805e12fbe5f08a3a90d6d2ec13c1cf \
  --disk 250 \
  --ssh \
  --direct \
  --label agent-kernel-rl-a100-e2e \
  --onstart-cmd 'mkdir -p /workspace/agent-kernel-runs && echo agent-kernel-rl-a100-ready'

export GPU_RENTAL_INSTANCE_ID=<new_contract_id>
gpu-provider-cli ssh-url "$GPU_RENTAL_INSTANCE_ID"
```

If using a fallback 4× RTX 4090/3090 offer, change only the offer id and label
and record in the report why the data-center GPU target was not used. Do not
change the success criteria.

### 5.3 Remote Bootstrap After SSH Login

```bash
set -euxo pipefail

nvidia-smi
python3 --version || true
node --version || true
pnpm --version || true

if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git curl jq; fi
if ! command -v node >/dev/null 2>&1; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; fi
if ! command -v pnpm >/dev/null 2>&1; then corepack enable && corepack prepare pnpm@11.3.0 --activate; fi

cd /workspace
git clone <your-remote> agent-kernel
cd agent-kernel
git rev-parse --short HEAD

pnpm install
pnpm --filter @agent-kernel/host build
pnpm --filter @agent-kernel/executor build
pnpm --filter @agent-kernel/host test
pnpm --filter @agent-kernel/executor test

rg -n "policy-gateway|run-rollout-smoke|inspect-rollout|prepare-swebench-dataset|slime_agent_kernel|custom_generate" \
  packages integrations docs \
  -g '!references/**' \
  | tee /workspace/agent-kernel-runs/readiness-rg.txt
```

### 5.4 Remote Readiness Decision

```bash
if ! rg -n "integrations\.slime_agent_kernel|policy-gateway|run-rollout-smoke" packages integrations -g '!references/**'; then
  echo "BLOCKED: live rollout implementation missing; do not run paid full training" \
    | tee /workspace/agent-kernel-runs/blocked.txt
  exit 20
fi
```

### 5.5 SGLang-Only Partial Smoke (when full training is blocked)

Must be labeled `partial` in the report:

```bash
python3 -m pip install -U pip
python3 -m pip install 'sglang[all]'

python3 -m sglang.launch_server \
  --model-path Qwen/Qwen2.5-1.5B-Instruct \
  --host 127.0.0.1 \
  --port 30080 \
  --context-length 4096 \
  --mem-fraction-static 0.55 \
  > /workspace/agent-kernel-runs/sglang.log 2>&1 &

sleep 60
curl -fsS http://127.0.0.1:30080/health || curl -fsS http://127.0.0.1:30080/get_server_info
```

Full training smoke is allowed only after the readiness decision passes. At
that point use the slime command in §4 and record the actual command and logs
in the report.

### 5.6 rented GPU host Search Commands

Marketplace candidates are volatile; search again immediately before renting:

```bash
gpu-provider-cli search offers \
  'reliability > 0.98 num_gpus=4 gpu_ram >= 40000 dph < 3.5 inet_down > 500 inet_up > 300 disk_space > 200' \
  --raw \
  | jq -r 'sort_by(.dph_total) | .[:12][] | [.id,.gpu_name,.gpu_ram,.dph_total,.reliability,.dlperf,.disk_space,.inet_down,.inet_up,.driver_version,.cuda_max_good,.geolocation] | @tsv'

gpu-provider-cli search offers \
  'reliability > 0.98 num_gpus=4 gpu_ram >= 80000 dph < 8.0 inet_down > 500 inet_up > 300 disk_space > 200' \
  --raw \
  | jq -r 'sort_by(.dph_total) | .[:12][] | [.id,.gpu_name,.gpu_ram,.dph_total,.reliability,.dlperf,.disk_space,.inet_down,.inet_up,.driver_version,.cuda_max_good,.geolocation] | @tsv'

gpu-provider-cli search offers \
  'reliability > 0.98 num_gpus=4 gpu_ram >= 24000 dph < 2.5 inet_down > 500 inet_up > 300 disk_space > 200' \
  --raw \
  | jq -r 'sort_by(.dph_total) | .[:12][] | [.id,.gpu_name,.gpu_ram,.dph_total,.reliability,.dlperf,.disk_space,.inet_down,.inet_up,.driver_version,.cuda_max_good,.geolocation] | @tsv'
```

- First query: preferred 4× A100-class target.
- Second query: H100/H200-class target if budget is increased.
- Third query: 4× 24GB consumer fallback. Use only when the report clearly
  states why A100/H100 was not used.

### 5.7 rented GPU host Templates

```text
slime official template
  template id: 362160
  template hash: ec1005e52dc071d71c5e7ef8b5f203b3
  image: slimerl/slime:latest
  recommended disk: 50 GB

SGLang template
  template id: 482283
  template hash: 16805e12fbe5f08a3a90d6d2ec13c1cf
  image: gpu-provider-cli/sglang:v0.5.13.post1-cuda-13.0
  recommended disk: 24 GB

PyTorch template
  template id: 482277
  template hash: ba25208f2c837d7f5c495e7bfe0764ac
  image: gpu-provider-cli/pytorch:@gpu-provider-cli-automatic-tag
  recommended disk: 16 GB
```

### 5.8 Local Collection and Cleanup

```bash
mkdir -p runs/gpu-host-agent-kernel-rl
scp -i ~/.ssh/id_rsa -r <ssh_host_from_gpu-provider-cli>:/workspace/agent-kernel-runs runs/gpu-host-agent-kernel-rl/
gpu-provider-cli logs "$GPU_RENTAL_INSTANCE_ID" --tail 500 > runs/gpu-host-agent-kernel-rl/gpu-host-container.log || true
gpu-provider-cli destroy instance "$GPU_RENTAL_INSTANCE_ID" -y
gpu-provider-cli show instances --raw | jq > runs/gpu-host-agent-kernel-rl/final-instances.json
```

The run is successful only if the cleanup step proves the paid instance was
destroyed. If `destroy instance` fails, retry until `show instances` no longer
lists the instance or the rented GPU provider control plane reports it as destroyed.

### 5.9 Budget Guardrails

- Do not create more than one rented GPU provider instance for the first overnight run.
- Prefer on-demand over interruptible for the first evidence-producing run;
  use interruptible only for dependency-install experiments.
- Stop and destroy the instance on dependency install failure, missing repo
  command, missing model support, missing token capture, or missing slime
  custom_generate integration.
- Keep total projected spend below the configured budget cap. Destroy the instance as
  soon as the run succeeds, reaches a stop condition, or cannot make
  progress.
- Write `gpu-provider-cli show instances --raw`, selected offer metadata, and destroy
  confirmation into the final report.

### 5.10 Secrets and Redaction

- Do not write API keys into logs, reports, issue text, or artifacts. Record
  only that the key existed and that the fingerprint matched.
- Redact concrete provider base URLs and private hostnames in any committed
  report. Local loopback addresses and public non-secret service names are
  fine.
- Full-fidelity run logs and evidence reports live under `experiments/`,
  which is `.gitignore`d. They may contain instance ids, ssh hosts, and
  internal IPs.

## 6. Future verl Training Smoke (deferred)

Purpose: run a real verl async rollout/training step where `agent-kernel` is
the custom AgentLoop. Deferred until the slime path has completed one real
trainer step.

Prerequisites:

- `references/verl` installed in a Python environment.
- vLLM or SGLang async rollout backend configured.
- Implemented `integrations.verl_agent_kernel.agent_loop.AgentKernelLoop`.
- Prepared parquet dataset with `agent_name="agent_kernel_loop"`.
- GPU resources adequate for the selected model.

Dataset preparation:

```bash
python integrations/verl_agent_kernel/dataset.py \
  --input-jsonl /data/agent_kernel_swe_smoke.jsonl \
  --train-parquet /data/agent_kernel_swe/train.parquet \
  --val-parquet /data/agent_kernel_swe/val.parquet \
  --agent-name agent_kernel_loop
```

Training launch:

```bash
cd references/verl

python -m verl.trainer.main_ppo \
  data.train_files=/data/agent_kernel_swe/train.parquet \
  data.val_files=/data/agent_kernel_swe/val.parquet \
  data.return_raw_chat=True \
  actor_rollout_ref.model.path=/models/Qwen2.5-Coder-1.5B-Instruct \
  actor_rollout_ref.rollout.mode=async \
  actor_rollout_ref.rollout.name=sglang \
  +actor_rollout_ref.rollout.agent.agent_loop_config.agent_kernel_loop.class_path=integrations.verl_agent_kernel.agent_loop.AgentKernelLoop \
  +agent_kernel.host_url=http://127.0.0.1:13000 \
  +agent_kernel.artifact_root=/tmp/agent-kernel-verl-artifacts \
  trainer.total_epochs=1 \
  trainer.test_freq=1
```

Expected result:

- verl wakes async rollout servers and syncs actor weights.
- `AgentKernelLoop.run()` is invoked for dataset rows.
- Model generation uses `LLMServerClient.generate` with token ids.
- Returned `AgentLoopOutput` has non-empty `prompt_ids`, `response_ids`, and
  aligned `response_mask`.
- `reward_score` or configured reward path produces non-null reward.
- PPO/GRPO trainer consumes the rollout and reaches at least one training step.
