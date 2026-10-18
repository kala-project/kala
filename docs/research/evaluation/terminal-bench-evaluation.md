# Terminal-Bench Evaluation: Domain Knowledge

Last updated: 2026-07-11

This document records the Terminal-Bench evaluation model that agent-kernel should use when adding a terminal-agent benchmark adapter. Code references are pinned to commit `1a6ffa9674b571da0ed040c470cb40c4d85f9b9b`.

## Scope

Terminal-Bench evaluates agents in real terminal environments. It is a strong fit for agent-kernel because it exercises the executor path directly: shell commands, file edits, long-running setup, test execution, terminal recordings, and failure classification.

Terminal-Bench is not a patch-submission benchmark like SWE-bench. The evaluated agent acts inside a terminal sandbox, and the benchmark verifies the final state by running task-provided tests.

## Terminology

| Term | Meaning | Product implication |
|---|---|---|
| Task | One terminal work item with `task.yaml`, Docker config, tests, and an oracle/reference solution. | UI should show instruction, category, difficulty, timeout, and artifacts. |
| Instruction | Natural-language goal passed to the agent. | This is the primary prompt, not a GitHub issue. |
| Terminal sandbox | The containerized shell environment where the agent works. | agent-kernel executor maps naturally to this layer. |
| Test script | `run-tests.sh`, optionally with a `tests/` directory. | Success is determined after tests run, not when the agent stops. |
| Parser result | Parsed status of task tests. | A task is resolved only if every parsed unit passes. |
| Recording | Asciinema terminal recording for the agent session. | Useful for teaching/debugger playback. |

## End-to-End Lifecycle

1. Select a Terminal-Bench dataset and task subset, such as `terminal-bench-core` with a version.
2. For each task, load `task.yaml` and task paths.
3. Start the Docker/terminal environment.
4. Run the configured agent with the task instruction.
5. Capture terminal panes and command history.
6. Copy `run-tests.sh` and optional `tests/` into the container test directory.
7. Run `bash run-tests.sh` under the test timeout.
8. Parse the post-test terminal pane with the task's configured parser.
9. Mark the trial resolved only if all parsed test statuses are passed.
10. Aggregate results into accuracy and pass@k metrics.

## Task Model

The core task schema includes:

- `instruction`: the task goal.
- `difficulty`: easy, medium, hard, or unknown.
- `category` and `tags`: coarse task grouping.
- `parser_name`: parser used to interpret test output.
- `max_agent_timeout_sec` and `max_test_timeout_sec`.
- `run_tests_in_same_shell`: whether tests run in the same shell as the agent.
- `disable_asciinema`: whether terminal recording is disabled.

The task directory convention includes:

```text
task.yaml
solution.sh or solution.yaml
run-tests.sh
docker-compose.yaml
tests/
```

## Scoring Semantics

Terminal-Bench treats parser output as the source of truth. If parser results are missing, the task is unresolved. If parser results exist, the task is resolved only when every parsed test has status `PASSED`.

Run-level metrics include:

- `n_resolved`: count of resolved trials.
- `n_unresolved`: count of unresolved trials.
- `accuracy`: `n_resolved / total_results`.
- `pass@k`: estimated probability that at least one of $k$ attempts solves the task.

## Agent-Kernel Ownership Boundary

agent-kernel should own:

- Mapping agent-kernel sessions/executors onto Terminal-Bench task execution.
- Capturing command history, panes, terminal recordings, tool calls, and model calls.
- Importing Terminal-Bench result JSON without changing `is_resolved` semantics.
- Showing test timeout, parse error, agent timeout, and unresolved as separate failure categories.

agent-kernel should not own:

- Replacing task `run-tests.sh` with local heuristics.
- Treating an agent stop as success.
- Collapsing parser failure, test failure, and agent failure into one generic failure.

## Product Implications

Terminal-Bench should be a first-class benchmark type under `Benchmarks`, not a SWE-bench subtype.

Recommended pipeline labels:

| UI label | Terminal-Bench concept |
|---|---|
| Choose Tasks | dataset name/version, task IDs, filters |
| Run Agent | terminal sandbox + agent command loop |
| Run Verifier | task `run-tests.sh` execution |
| Import Results | `TrialResults` / `BenchmarkResults` import |
| Review | panes, command history, parser output, recording |

Default view should show task instruction, resolved/unresolved, timeout/failure mode, and links to recording and parser output. Raw `task.yaml`, `run-tests.sh`, and panes belong in the inspector.

## Reference Chapter

| Claim | Source |
|---|---|
| Terminal-Bench tests AI agents in real terminal environments and evaluates real-world end-to-end terminal tasks. | README lines 21-29: [1]. |
| Terminal-Bench has two parts: a task dataset and an execution harness connecting a model to a terminal sandbox. | README lines 27 and 65-73: [2]. |
| Each task includes an English instruction, a test script, and an oracle/reference solution. | README lines 55-63: [3]. |
| Leaderboard-style execution uses `tb run`, dataset name/version, agent, model, and concurrency. | README lines 75-90: [4]. |
| Task schema includes instruction, metadata, parser, timeouts, same-shell tests, and recording control. | `trial_handler.py` lines 29-83: [5]. |
| Task directory convention includes `task.yaml`, solution, `run-tests.sh`, Docker config, and `tests/`. | `trial_handler.py` lines 124-169: [6]. |
| The harness copies `run-tests.sh` and optional tests into the container, then runs `bash run-tests.sh`. | `harness.py` lines 544-585: [7]. |
| Parser results are resolved only if every parsed unit status is `PASSED`. | `harness.py` lines 536-542 and 808-824: [8], [9]. |
| Results model includes `is_resolved`, `failure_mode`, parser results, recording path, timestamps, accuracy, and pass@k. | `models.py` lines 43-139: [10]. |
| Supported parser names include pytest, SWE-bench, SWELancer, MLE-bench, and SWEPerf parser classes. | `parser_factory.py` lines 11-37: [11]. |

## References

[1] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/README.md#L21-L29

[2] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/README.md#L27-L73

[3] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/README.md#L55-L63

[4] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/README.md#L75-L90

[5] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/terminal_bench/handlers/trial_handler.py#L29-L83

[6] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/terminal_bench/handlers/trial_handler.py#L124-L169

[7] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/terminal_bench/harness/harness.py#L544-L585

[8] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/terminal_bench/harness/harness.py#L536-L542

[9] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/terminal_bench/harness/harness.py#L808-L824

[10] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/terminal_bench/harness/models.py#L43-L139

[11] https://github.com/harbor-framework/terminal-bench/blob/1a6ffa9674b571da0ed040c470cb40c4d85f9b9b/terminal_bench/parsers/parser_factory.py#L11-L37
