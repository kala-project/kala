# WebArena Evaluation: Domain Knowledge

Last updated: 2026-07-11

This document records the WebArena evaluation model that agent-kernel should use when adding a web-agent benchmark adapter. Code references are pinned to commit `dce04686a56253aefba7b18a4fa0937cf1dc987b`.

## Scope

WebArena evaluates autonomous web agents in a reproducible, self-hostable web environment. It is a strong fit for agent-kernel as the browser benchmark lane: the agent observes a web page, decides browser actions, executes them through Playwright-like primitives, and is scored by task-specific evaluators.

WebArena should be treated as a web-navigation benchmark, not a coding benchmark and not a desktop-control benchmark.

## Terminology

| Term | Meaning | Product implication |
|---|---|---|
| Test example | One WebArena task config JSON. | UI can call it a task but should expose config ID in technical details. |
| Intent | Natural-language user goal. | This is the task instruction shown to the agent. |
| Config file | JSON file containing sites, login state, start URL, intent, and eval config. | Deep-linkable raw artifact. |
| Trajectory | Alternating observations/actions collected during browser execution. | Useful for replay and teaching. |
| Evaluator | Task-specific scorer, selected from `eval_types`. | Success is evaluator score, not agent stop. |
| Score | Float returned by evaluator; run summary uses average score. | UI should show score and evaluator breakdown. |

## End-to-End Lifecycle

1. Set up the self-hosted WebArena websites and environment variables for each site.
2. Generate per-example config files.
3. Obtain login cookies for tasks that require authenticated websites.
4. Create a `ScriptBrowserEnv` with observation type, viewport, trace options, and timing settings.
5. For each config file, read `intent` and `task_id`.
6. Reset the browser environment with the config file.
7. Repeatedly ask the agent for the next browser action until stop, termination, or early-stop guard.
8. Route the config file to the appropriate evaluator(s).
9. Evaluate the final trajectory/page state and append the score.
10. Save optional Playwright traces and report average score.

## Task Config Model

WebArena config files include fields such as:

- `sites`: websites used by the task.
- `task_id`: numeric task identifier.
- `require_login` and `storage_state`: authentication requirements.
- `start_url`: initial page URL.
- `intent_template`, `instantiation_dict`, and `intent`: templated and concrete task instruction.
- `eval`: evaluator config including `eval_types`, reference answers, reference URL, and programmatic HTML checks.
- `reference_action_sequence`: reference Playwright action sequence for examples/debugging.

## Scoring Semantics

WebArena combines one or more evaluators multiplicatively. Supported evaluator types in the canonical implementation include:

- `string_match`: evaluates the answer in the final stop action using exact, must-include, fuzzy, or unachievable-task matching.
- `url_match`: evaluates the final page URL against a reference URL.
- `program_html`: navigates/selects page content and checks exact/must-include content.

The result of a task is the product of the selected evaluator scores. A run reports average score across tasks.

## Agent-Kernel Ownership Boundary

agent-kernel should own:

- Running a web-capable agent against WebArena config files.
- Capturing observations, actions, screenshots, traces, model calls, and final evaluator scores.
- Importing WebArena task results without redefining evaluator scores.
- Showing auth/setup failures separately from agent failures and evaluator failures.

agent-kernel should not own:

- Treating browser action completion as success.
- Replacing WebArena evaluator logic with local heuristics.
- Hiding the evaluator type; users need to know if a task was scored by answer string, URL, or page content.

## Product Implications

WebArena should be the `Web Agent` lane in the benchmark picker.

Recommended pipeline labels:

| UI label | WebArena concept |
|---|---|
| Choose Tasks | config file subset / task IDs |
| Prepare Environment | hosted websites, env vars, auth cookies |
| Run Agent | browser observation-action loop |
| Run Evaluator | string/url/html evaluator execution |
| Import Results | score, traces, trajectory, screenshots |
| Review | replay trajectory, inspect final page, evaluator details |

The default page should not show raw URLs and auth file paths as primary content. It should show site family, intent, evaluator type, score, and trace availability.

## Reference Chapter

| Claim | Source |
|---|---|
| WebArena is a standalone, self-hostable web environment for autonomous agents. | README lines 1-6: [1]. |
| The canonical repo recommends AgentLab/BrowserGym for enhanced infrastructure but remains the canonical implementation for reproducing paper results. | README lines 26-29: [2]. |
| WebArena uses a browser environment similar to OpenAI Gym with `env.reset(options={"config_file": ...})` and `env.step(action)`. | README lines 54-76: [3]. |
| Correct evaluation requires self-hosted WebArena websites; generated config files represent individual test examples. | README lines 77-102: [4]. |
| Official end-to-end evaluation uses `run.py` with instruction prompt, test range, model, and result directory; trajectories are saved as HTML. | README lines 110-120: [5]. |
| The run loop creates `ScriptBrowserEnv`, loads `intent` and `task_id`, resets the environment, asks the agent for actions, executes `env.step`, and then calls `evaluator_router`. | `run.py` lines 220-365: [6]. |
| String evaluator supports exact match, must include, fuzzy match, and unachievable-task matching. | `evaluators.py` lines 71-170: [7]. |
| URL evaluator compares final page URL against task reference URL. | `evaluators.py` lines 173-241: [8]. |
| HTML content evaluator checks selected page content with exact or must-include rules. | `evaluators.py` lines 244-333: [9]. |
| Multiple evaluators are combined multiplicatively and selected by `eval_types`. | `evaluators.py` lines 336-374: [10]. |
| Example config files include sites, task ID, login state, start URL, intent, eval config, and reference action sequence. | Example configs: [11], [12]. |
| Paper citation identifies WebArena as a realistic web environment for autonomous agents. | README citation lines 153-161: [13]; arXiv: [14]. |

## References

[1] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/README.md#L1-L6

[2] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/README.md#L26-L29

[3] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/README.md#L54-L76

[4] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/README.md#L77-L102

[5] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/README.md#L110-L120

[6] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/run.py#L220-L365

[7] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/evaluation_harness/evaluators.py#L71-L170

[8] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/evaluation_harness/evaluators.py#L173-L241

[9] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/evaluation_harness/evaluators.py#L244-L333

[10] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/evaluation_harness/evaluators.py#L336-L374

[11] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/config_files/examples/1.json#L1-L31

[12] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/config_files/examples/2.json#L1-L30

[13] https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/README.md#L153-L161

[14] https://arxiv.org/abs/2307.13854
