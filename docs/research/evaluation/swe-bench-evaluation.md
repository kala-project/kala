# SWE-bench Evaluation: Domain Knowledge

Last updated: 2026-07-11

This document records the SWE-bench evaluation model that agent-kernel should use for product language, CLI design, benchmark orchestration, and result import. It is intentionally explicit about terms because benchmark UI becomes misleading when it collapses agent output, harness execution, and official scoring into one word such as "done" or "resolved".

All code references to the official SWE-bench repository are pinned to commit `f7bbbb2ccdf479001d6467c9e34af59e44a840f9`.

## Scope

This document covers the standard SWE-bench evaluation path:

1. A benchmark task describes a real GitHub issue in a real repository.
2. An agent receives the repository state and issue text.
3. The agent returns a source-code patch.
4. The official SWE-bench harness applies that patch inside Docker.
5. The harness applies the official task-specific test patch.
6. The harness runs repository-specific tests.
7. The harness parses logs and computes whether the task is resolved.

This document does not define a new benchmark. agent-kernel can add UX, orchestration, trace capture, and result import, but the final SWE-bench score must come from the official harness semantics.

## Terminology

| Term | Meaning | Product implication |
|---|---|---|
| Task / instance | One SWE-bench problem. It contains fields such as `instance_id`, `repo`, `base_commit`, `problem_statement`, `test_patch`, `FAIL_TO_PASS`, and `PASS_TO_PASS`. | UI may say "task" by default. `instance_id` belongs in technical details. |
| Agent | The system being evaluated. It reads the issue and repository and produces a patch. | agent-kernel is an orchestrator/runtime for the evaluated agent, not the official grader. |
| Prediction | One JSONL row submitted to the harness. It includes `instance_id`, `model_name_or_path`, and `model_patch`. | "Prediction ready" means the agent produced an answer, not that the issue is solved. |
| `model_patch` | The patch produced by the evaluated agent. | It is the agent answer. It may fail to apply or fail tests. |
| `test_patch` | The official task-specific patch bundled with the dataset instance. It modifies/adds tests used to evaluate that issue. | It must not be shown as the agent answer. It belongs to grading setup. |
| `FAIL_TO_PASS` | Test identifiers expected to fail before a correct fix and pass after a correct fix. | These are the primary resolution checks. |
| `PASS_TO_PASS` | Test identifiers expected to pass before and after the fix. | These are regression checks. |
| Resolved | The official harness says the patch fully resolved the task. | UI must only show this after official scoring/import, never after agent inference alone. |

## End-to-End Evaluation Lifecycle

The precise lifecycle is:

1. **Select tasks**. The user chooses a dataset or a subset such as SWE-bench Lite. Each selected task is a real repository issue with a pinned base commit and evaluation metadata.
2. **Prepare workspaces**. The evaluation environment is constructed from the task's repository, version, base commit, and environment/test specifications.
3. **Run the agent**. The evaluated agent receives the issue and repository state and emits a patch. agent-kernel may record the trace, tool calls, model calls, and intermediate files.
4. **Serialize predictions**. Each agent answer is written as a JSONL object with `instance_id`, `model_name_or_path`, and `model_patch`.
5. **Run the official harness**. SWE-bench `run_evaluation` loads tasks and predictions, starts Docker containers, applies the agent patch, writes an `eval.sh` script, and executes it.
6. **Apply official tests**. The generated `eval.sh` applies `test_patch` and runs repository-specific tests between start/end output markers.
7. **Parse logs**. The harness extracts test output, uses repository-specific parsers, and builds a status map of test cases.
8. **Compute result**. A task is resolved only when all required `FAIL_TO_PASS` and `PASS_TO_PASS` checks meet the official criteria.
9. **Import/report**. agent-kernel can ingest `evaluation_results` and show task/run summaries, but the source of truth for SWE-bench score remains the harness report.

## Data Model

A SWE-bench task is not just an issue string. In the official `make_test_spec` path, a task contributes at least these fields:

- `instance_id`: stable task identifier.
- `repo`: GitHub repository name.
- `version`: repository-specific version key used to look up environment/test specs.
- `base_commit`: commit used to reset the repository before evaluation.
- `problem_statement`: issue text given to the agent.
- `test_patch`: official patch that defines/modifies evaluation tests.
- `FAIL_TO_PASS`: test identifiers used for resolution.
- `PASS_TO_PASS`: test identifiers used for regression/maintenance.

The official `TestSpec` then stores the generated setup scripts, evaluation script, environment script, architecture, language, Docker specs, and the two test lists.

## Prediction Format

The official guide describes predictions as JSONL, one JSON object per line:

```json
{
  "instance_id": "repo_owner__repo_name-issue_number",
  "model_name_or_path": "your-model-name",
  "model_patch": "the patch content as a string"
}
```

agent-kernel should preserve these meanings:

- `instance_id` binds one prediction to one task.
- `model_name_or_path` identifies the evaluated agent/model for reports.
- `model_patch` is the full patch text generated by the agent.

If `model_patch` is missing or `None`, the official grader reports no resolved task. If the patch exists but cannot apply, the task is still not resolved.

## Official Harness Execution Model

For each task, the official `run_instance` function performs the following relevant operations:

1. Start a Docker container for the task image.
2. Write the agent prediction into `patch.diff`.
3. Copy `patch.diff` into the container.
4. Try applying the agent patch with `git apply --verbose`, `git apply --verbose --reject`, then `patch --batch --fuzz=5 -p1 -i`.
5. If no patch command succeeds, raise an evaluation error.
6. Write `test_spec.eval_script` to `eval.sh`.
7. Execute `/bin/bash /eval.sh` inside the container.
8. Write test output logs.
9. Call `get_eval_report(...)` and persist `report.json`.

This ordering matters. The official tests are run after the model patch is applied. A benchmark UI should therefore separate:

- Agent patch generation.
- Patch application result.
- Test execution result.
- Official resolution result.

## How `eval.sh` Is Generated

`TestSpec.eval_script` is built by joining `eval_script_list` with a bash header. `make_test_spec` reads the task's `test_patch`, `FAIL_TO_PASS`, and `PASS_TO_PASS`, then calls `make_eval_script_list(...)` with the repository specs and `test_patch`.

The dispatch layer chooses a language-specific implementation:

- Python repositories use `make_eval_script_list_py`.
- JavaScript repositories use `make_eval_script_list_js`.
- Other repositories use the common implementation.

For Python tasks, the generated evaluation script:

- Activates the conda environment.
- Changes to the repository directory.
- Optionally runs repository-specific eval setup commands.
- Resets modified/new test files affected by `test_patch`.
- Applies `test_patch` via `git apply` from a heredoc.
- Emits `START_TEST_OUTPUT` marker.
- Runs the repository/version-specific test command plus test directives derived from `test_patch`.
- Emits `END_TEST_OUTPUT` marker.
- Resets the affected test files again.

For JavaScript tasks, the common evaluation script is used and can be adjusted for repository-specific test commands. For example, `Automattic/wp-calypso` maps test patch paths to Jest/npm test commands.

## Where The Tests Come From

The most precise statement is:

> SWE-bench runs repository-native or repository-version-specific test commands inside a controlled Docker environment, after applying the agent's `model_patch` and then applying SWE-bench's task-specific `test_patch`.

This means the tests are neither simply "whatever tests already existed in the repository" nor simply "a separate external test suite".

The evaluation combines two sources:

- **Repository test runner**: the command comes from SWE-bench's repository/version specs, such as pytest, Django's runner, Jest, npm scripts, or repository-specific commands.
- **Task-specific tests**: the dataset instance includes `test_patch`; the generated `eval.sh` applies that patch before running tests. This patch may modify existing tests or add new tests for the issue.

Product copy should therefore avoid vague labels such as "Run tests" unless the detail panel explains which test command and which official test patch were used.

## Log Parsing And Scoring

The harness parses test output between `START_TEST_OUTPUT` and `END_TEST_OUTPUT`. It uses a repository-specific parser to build a map from test case identifiers to statuses.

The scoring logic then checks two sets:

- `FAIL_TO_PASS`: each listed test should pass after applying the model patch.
- `PASS_TO_PASS`: each listed test should still pass after applying the model patch.

The official grading code treats a test as passed if it is present with `PASSED` or `XFAIL`. It treats a test as failed if it is absent from the status map or has `FAILED` or `ERROR`.

The resolution status is:

- `FULL`: fail-to-pass ratio is 1 and pass-to-pass ratio is 1.
- `PARTIAL`: some but not all fail-to-pass tests pass, while pass-to-pass ratio is 1.
- `NO`: all other cases.

The final boolean `resolved` is true only for `FULL`.

## Agent-Kernel Ownership Boundary

agent-kernel should own:

- Running the evaluated agent reproducibly.
- Capturing trace, tool calls, model calls, patch artifacts, and workspace metadata.
- Producing valid `predictions.jsonl`.
- Starting or delegating the official SWE-bench harness.
- Importing official results without changing their semantics.
- Explaining the pipeline clearly in CLI and web UI.

agent-kernel should not own:

- Redefining `resolved`.
- Treating agent completion as benchmark success.
- Replacing official `FAIL_TO_PASS` / `PASS_TO_PASS` semantics with local heuristics.
- Mixing `model_patch` and `test_patch` in UI language.

## Product And UI Implications

The benchmark product should use a page-level workflow rather than a modal when users need to inspect runs, compare tasks, import results, and review artifacts.

Recommended top-level pipeline labels:

| UI label | Internal/official concept | Default visible output |
|---|---|---|
| Choose Tasks | dataset selection / instance filtering | number of tasks selected |
| Run Agent | prediction generation | prediction count, agent failures, patch artifacts |
| Official Score | SWE-bench harness execution | patch apply status, test status, harness logs |
| Import Results | ingest `evaluation_results` | resolved count, unresolved count, report path in details |
| Review | human analysis and bad-case mining | failure categories and selected examples |

Hard UI rules:

- Do not show `resolved` before official results have been imported.
- Do not call a task "passed" when only the agent prediction exists.
- Do not expose `patchesDir`, `predictionsPath`, absolute filesystem paths, or raw artifact hashes in the primary workflow.
- Keep `instance_id`, raw JSONL, raw report JSON, and file paths in technical details or an artifact inspector.
- Always distinguish `model_patch` from `test_patch` in raw views.
- Show patch application, test execution, and official resolution as separate states.

## CLI Implications

CLI output should mirror the same semantic boundaries:

- `choose-tasks`: reports task count and dataset/source.
- `run-agent`: reports predictions written and agent failures.
- `score-official`: reports harness completion, patch apply failures, timeouts, and log location.
- `import-results`: reports official resolved/unresolved counts.
- `review`: reports failure categories and exportable bad cases.

The CLI should not print "resolved" in the `run-agent` step.

## Caveats

- SWE-bench supports multiple datasets and subsets; this document focuses on the official evaluation semantics common to standard SWE-bench/SWE-bench Lite style runs.
- The official repository evolves. Code links here are pinned to a specific commit to keep the cited behavior stable.
- Some language/repository-specific test command generation has special cases; product UI should expose raw `eval.sh` and logs for advanced debugging.

## Reference Chapter

| Claim | Source |
|---|---|
| SWE-bench evaluates language models on real GitHub software issues and asks them to generate patches from a codebase and issue. | Official README, lines 41-44: [1]. ICLR 2024 paper page: [2]. |
| Official setup uses Docker for reproducible evaluations. | Official README, lines 53-56: [3]. Official harness reference: [4]. |
| Canonical local evaluation command uses `python -m swebench.harness.run_evaluation`, `--dataset_name`, `--predictions_path`, `--max_workers`, and `--run_id`. | Official README, lines 78-89: [5]. Evaluation guide, lines 11-19: [6]. |
| Evaluations generate build/evaluation logs and final results under `evaluation_results`. | Official README, lines 91-93: [7]. Evaluation guide, lines 131-145: [8]. |
| Official prediction JSONL rows contain `instance_id`, `model_name_or_path`, and `model_patch`. | Evaluation guide, lines 45-60: [9]. `run_instance` docstring also expects these fields, lines 84-87: [10]. |
| `TestSpec` stores `instance_id`, `repo`, `version`, script lists, architecture, `FAIL_TO_PASS`, `PASS_TO_PASS`, language, and Docker specs. | `test_spec.py`, lines 27-44: [11]. |
| `make_test_spec` reads task fields including `instance_id`, `repo`, `version`, `base_commit`, `problem_statement`, and `test_patch`; it parses `PASS_TO_PASS` and `FAIL_TO_PASS`. | `test_spec.py`, lines 187-205: [12]. |
| `make_test_spec` passes `test_patch` into `make_eval_script_list` and returns a `TestSpec` carrying `FAIL_TO_PASS` and `PASS_TO_PASS`. | `test_spec.py`, lines 212-235: [13]. |
| `run_instance` applies the agent `model_patch` before writing/running `eval.sh`. | `run_evaluation.py`, patch write/copy/apply lines 158-186 and eval script execution lines 198-208: [14]. |
| The official harness attempts multiple patch application commands: `git apply --verbose`, `git apply --verbose --reject`, and `patch --batch --fuzz=5 -p1 -i`. | `run_evaluation.py`, lines 64-68: [15]. |
| `make_eval_script_list` is described as applying the test patch and running tests; it dispatches Python, JavaScript, or common implementations. | `create_scripts.py`, lines 41-53: [16]. |
| Python `eval.sh` generation applies `test_patch`, runs the repository/version-specific test command plus directives, and wraps output in start/end markers. | `python.py`, lines 405-462: [17]. |
| Python test directives are derived from `test_patch`, with Django-specific path transformation. | `python.py`, lines 230-261: [18]. |
| JavaScript evaluation can adjust common commands with repository-specific test commands such as Jest/npm commands for `Automattic/wp-calypso`. | `javascript.py`, lines 13-67 and 88-105: [19]. |
| The harness parses logs between `START_TEST_OUTPUT` and `END_TEST_OUTPUT` and uses repository-specific parsers. | `grading.py`, lines 39-91: [20]. |
| Pass/fail helper semantics treat `PASSED` and `XFAIL` as passed, and absent/failed/error statuses as failed. | `grading.py`, lines 27-35: [21]. |
| `FAIL_TO_PASS` is resolution success and `PASS_TO_PASS` is maintenance/regression success. | `grading.py`, lines 94-121: [22]. |
| Resolution status is `FULL` only when fail-to-pass ratio and pass-to-pass ratio are both 1; final boolean `resolved` is true only for `FULL`. | `grading.py`, lines 194-232 and 276-290: [23], [24]. |
| If the model patch is missing, or logs cannot be parsed/found, the report does not mark the task as resolved. | `grading.py`, lines 255-274: [25]. |
| SWE-bench evaluation has substantial local resource requirements. | Official README, lines 95-102: [26]. |
| SWE-bench was accepted as an ICLR 2024 oral presentation. | Official README, lines 140-149 for citation metadata: [27]; OpenReview page: [2]. |

## References

[1] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/README.md#L41-L44

[2] https://openreview.net/forum?id=VTF8yNQM66

[3] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/README.md#L53-L56

[4] https://www.swebench.com/SWE-bench/reference/harness/

[5] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/README.md#L78-L89

[6] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/docs/guides/evaluation.md#L11-L19

[7] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/README.md#L91-L93

[8] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/docs/guides/evaluation.md#L131-L145

[9] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/docs/guides/evaluation.md#L45-L60

[10] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/run_evaluation.py#L84-L87

[11] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/test_spec/test_spec.py#L27-L44

[12] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/test_spec/test_spec.py#L187-L205

[13] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/test_spec/test_spec.py#L212-L235

[14] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/run_evaluation.py#L158-L208

[15] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/run_evaluation.py#L64-L68

[16] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/test_spec/create_scripts.py#L41-L53

[17] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/test_spec/python.py#L405-L462

[18] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/test_spec/python.py#L230-L261

[19] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/test_spec/javascript.py#L13-L105

[20] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/grading.py#L39-L91

[21] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/grading.py#L27-L35

[22] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/grading.py#L94-L121

[23] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/grading.py#L194-L232

[24] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/grading.py#L276-L290

[25] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/swebench/harness/grading.py#L255-L274

[26] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/README.md#L95-L102

[27] https://github.com/princeton-nlp/SWE-bench/blob/f7bbbb2ccdf479001d6467c9e34af59e44a840f9/README.md#L140-L149
