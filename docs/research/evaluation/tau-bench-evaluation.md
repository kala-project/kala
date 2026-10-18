# Tau-Bench / Tau3-Bench Evaluation: Domain Knowledge

Last updated: 2026-07-11

This document records the Tau-Bench family evaluation model that agent-kernel should use for a general tool-use / user-interaction benchmark adapter. Code references for the current implementation are pinned to `sierra-research/tau2-bench` commit `1901a301961cbbe3fd11f3e84a2a376530c759e3`.

## Scope

Tau-Bench evaluates conversational agents that interact with simulated users and domain-specific tools under domain policies. It is a strong fit for agent-kernel's general-agent lane because it tests tool choice, tool arguments, policy compliance, user interaction, and outcome-based scoring.

The original `sierra-research/tau-bench` repository states that its tasks are outdated and points users to the newer `sierra-research/tau2-bench` repository, now branded as Tau3-Bench. Therefore agent-kernel should use the Tau3-Bench implementation as the engineering target while citing the original Tau-Bench paper as historical/domain context.

## Terminology

| Term | Meaning | Product implication |
|---|---|---|
| Domain | A business-like environment such as airline, retail, telecom, or banking knowledge. | Benchmark picker should expose domain selection. |
| Policy | Domain rules the agent must follow. | Show as task context, not as hidden prompt magic. |
| Tools | Domain APIs available to the agent. | Tool calls and arguments are first-class review artifacts. |
| User simulator | Model or strategy that plays the user. | The run has two model roles: agent and user. |
| Task | Scenario with evaluation criteria. | UI should show task ID, user instruction, domain, and reward basis. |
| Reward basis | Components that gate final reward. | Do not treat reference actions as mandatory unless `ACTION` is in reward basis. |
| Reward | Final scalar product of selected reward components. | Score is outcome-based and componentized. |

## End-to-End Lifecycle

1. Select a domain and task split/subset.
2. Configure the evaluated agent model and the user simulator model/strategy.
3. Load domain policy, tools, tasks, and optional user tools.
4. Run a half-duplex turn-based conversation or, for voice experiments, full-duplex interaction.
5. Let the agent call tools and communicate with the simulated user.
6. Terminate when the agent or user stops, or when orchestration guards fire.
7. Evaluate the final simulation using task evaluation criteria.
8. Compute reward components such as DB state match, required communication, environment assertions, natural-language assertions, or action match when enabled.
9. Multiply reward components listed in `reward_basis` into the final reward.
10. Aggregate runs into average reward and pass@k-style metrics.

## Task And Reward Model

Tau3-Bench task evaluation criteria include:

- `actions`: one reference trajectory of tool calls that solves the task.
- `env_assertions`: assertions over predicted environment state.
- `communicate_info`: strings the agent must communicate to the user.
- `nl_assertions`: natural-language assertions judged by an LLM.
- `reward_basis`: list of reward components that determine the final reward.

Critical semantic rule: `actions` is usually not a hard requirement. For airline, retail, and telecom, the default reward basis is `DB + COMMUNICATE`. The reference actions are replayed on a fresh gold environment to compute the target DB state, but the agent can take a different valid tool-call path if the final DB state and communication requirements match.

`ACTION` becomes a hard trajectory requirement only when `RewardType.ACTION` appears in `reward_basis`, which is rare and mainly used when path correctness itself is being evaluated.

## Scoring Semantics

The final reward is the product of reward components selected by `reward_basis`.

Examples:

- If `reward_basis = [DB, COMMUNICATE]`, final reward is `db_reward * communicate_reward`.
- If a component is absent from `reward_basis`, it can still be displayed diagnostically but should not gate the official reward.
- A premature termination that is not a normal agent/user stop receives zero reward before component evaluators run.

This means a task can be solved by a different sequence of tool calls than the reference `actions`, as long as it reaches an equivalent outcome and satisfies required communication.

## Agent-Kernel Ownership Boundary

agent-kernel should own:

- Running a tool-use agent against Tau3-Bench domains.
- Capturing agent/user messages, tool calls, tool outputs, reward breakdown, policies, and task metadata.
- Showing user simulator model and evaluated agent model separately.
- Importing final reward and reward breakdown without redefining `reward_basis`.

agent-kernel should not own:

- Treating reference `actions` as mandatory by default.
- Collapsing DB mismatch, missing communication, wrong tool argument, and user-simulator issue into one failure.
- Using the outdated original tau-bench tasks as the default engineering target.

## Product Implications

Tau-Bench should be the `Tool/User Interaction` lane in the benchmark picker.

Recommended pipeline labels:

| UI label | Tau3-Bench concept |
|---|---|
| Choose Tasks | domain, split, task IDs, trial count |
| Configure Roles | evaluated agent model and user simulator model/strategy |
| Run Simulation | conversation + tool-use orchestration |
| Compute Reward | reward basis and component evaluators |
| Import Results | simulation files, reward info, metrics |
| Review | conversation, tool calls, policy, reward breakdown |

The UI must explicitly label `Reference trajectory` as diagnostic unless `ACTION` is in `reward_basis`. Otherwise users will incorrectly assume the agent must exactly reproduce the listed actions.

## Reference Chapter

| Claim | Source |
|---|---|
| Original Tau-Bench proposes dynamic conversations between simulated users and language agents with domain-specific API tools and policy guidelines. | Original README lines 1-10: [1]; original paper: [2]. |
| The original tau-bench repo warns that its tasks are outdated and points to the newer tau2/tau3 repository. | Original README lines 3-5: [3]. |
| Tau3-Bench includes text/voice modes, knowledge domain, task fixes, and an updated leaderboard. | Tau3 README lines 15-35: [4]. |
| Tau-Bench is a simulation framework for customer service agents across domains; each domain specifies policy, tools, tasks, and optional user tools. | Tau3 README lines 37-48: [5]. |
| Quick start uses `tau2 run` with domain, agent LLM, user LLM, number of trials, and number of tasks; results are saved under `data/simulations`. | Tau3 README lines 83-91: [6]. |
| Documentation identifies task schema/evaluation as the source for `evaluation_criteria.actions`, `reward_basis`, and action correctness. | Tau3 README lines 103-111: [7]. |
| A task's final reward is the product of components in `evaluation_criteria.reward_basis`; default airline/retail/telecom basis is `[DB, COMMUNICATE]`. | `docs/evaluation.md` lines 8-20 and 34-62: [8]. |
| `evaluation_criteria.actions` is one reference trajectory, not necessarily the only correct action sequence. | `docs/evaluation.md` lines 14-29 and 63-87: [9], [10]. |
| Reward components include DB, ENV_ASSERTION, COMMUNICATE, NL_ASSERTION, and ACTION; the final reward is multiplicative. | `docs/evaluation.md` lines 40-62: [11]. |
| `ACTION` is only used in reward basis for a small subset of banking knowledge tasks; airline, retail, and telecom do not use it. | `docs/evaluation.md` lines 172-186: [12]. |
| Evaluator notes state reward is multiplicative, missing criteria are not failures, premature termination gets zero reward, and actions are not per-action requirements unless reward basis says so. | `src/tau2/evaluator/AGENTS.md` lines 36-60: [13]. |
| Core Tau-Bench and Tau2-Bench papers are cited in the current repo. | Tau3 README lines 179-201: [14]. |

## References

[1] https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/README.md#L1-L10

[2] https://arxiv.org/abs/2406.12045

[3] https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/README.md#L3-L5

[4] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/README.md#L15-L35

[5] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/README.md#L37-L48

[6] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/README.md#L83-L91

[7] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/README.md#L103-L111

[8] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/docs/evaluation.md#L8-L62

[9] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/docs/evaluation.md#L14-L29

[10] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/docs/evaluation.md#L63-L87

[11] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/docs/evaluation.md#L40-L62

[12] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/docs/evaluation.md#L172-L186

[13] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/src/tau2/evaluator/AGENTS.md#L36-L60

[14] https://github.com/sierra-research/tau2-bench/blob/1901a301961cbbe3fd11f3e84a2a376530c759e3/README.md#L179-L201
