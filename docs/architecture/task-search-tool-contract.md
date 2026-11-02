# Built-in planning, search and failure contracts

This contract describes the maintained built-in tool definitions and their Host/Executor implementations. It does not claim that a running session's frozen tool catalog or custom system prompt has been replaced automatically.

## Model-facing failure feedback

A machine error code is not an explanation. Returned tool failures in the classic agent loop and SDK runtime use the same shared formatter at their respective model-input boundaries:

- **What happened:** a plain-language statement based on the observed error/outcome, not a guessed cause. If the cause is unknown, retain that uncertainty and the available diagnostics.
- **State, when relevant:** distinguish confirmed completion, partial item outcomes and unknown execution. Failure does not imply no effects or rollback. Partial failure does not imply that every item failed or that any particular unreported item succeeded.
- **Next step:** a concrete, safe recovery or an explicit blocker. Invalid requests require correction; missing targets require verification; stale edits require reading current state; denied access/approval must not become instructions to bypass restrictions. Unknown outcomes require effect inspection, not blind duplicate execution.
- **Details:** preserve the original diagnostic/body and any applied-operation receipt. Codes remain optional machine identifiers alongside the explanation, never the only model-facing information.

The shared formatter uses structured outcome metadata when available and otherwise recognizes a leading diagnostic code, not codes quoted inside arbitrary output. Unknown/custom codes retain their original details and conservative inspect/report guidance. It neither changes execution, automatically retries, invents a detailed cause, nor treats `retryable=true` as proof that repeating side effects is safe.

The explanation/recovery envelope precedes the diagnostic body and is outside per-tool file-content budgets. Thus even a tiny `read_files.max_bytes` cannot reduce the entire model-facing failure to an opaque code or a dot. The normal model-context cap still applies; the classic loop retains the leading guidance when it caps a large result. Missing/truncated item details require narrower reads or a supported larger output budget, not guessing which operations completed. Existing SDK temporary-artifact access limitations are not solved by this presentation change.

Successful text/JSON/image results remain unchanged. The SDK's failure text, error field and persisted returned-failure body agree; classic failure metadata is preserved. Approval denial/cancellation explicitly advise against bypass or automatic restart. This contract covers failures returned through these maintained tool-result boundaries, not arbitrary out-of-band provider/SDK exceptions. Tool authors must still supply specific, privacy-safe diagnostics at the source: a generic fallback is not permission to hide the cause.

Verification inspects actual classic model-call messages and SDK `textResultForLlm`, including long-result capping, tiny partial-read bodies, metadata-only unknown outcomes, unchanged success/image paths and cancellation gating. This verifies delivered text and runtime wiring, **not a guarantee that every real model understands or follows the guidance**. No live model invocation or running-instance deployment is implied.

## Planning lifecycle

- A task graph is the current goal's execution plan, not a session-wide project backlog or an evidence ledger. Simple questions and one-step actions need no graph.
- Within one goal, update incrementally and add only genuine dependency edges. Do not equate ordering preference with dependency.
- On an explicit independent-task switch, first account for unfinished work in the new plan, an explicit handoff or a durable note, then `replace` the active graph. Do not silently drop commitments, infer cancellation from a topic change, or carry unrelated historical branches into every new task.
- After verification, record outcomes in the conversation/artifacts and remove finished branches. `remove_node` with `cascade=true` removes incident edges, **not descendant tasks**. Check any surviving dependent tasks still have the prerequisites they need.
- When the goal is complete and no current work remains, `clear`. This clears the current graph, not historical tool events or evidence. Never automatically delete pending work just because a graph is large.
- Keep node descriptions concise. Store logs, commit inventories and acceptance history outside the graph.
- `replace` requires the full next `nodes` array. Omitted `edges` means `[]`, never inherited edges. Explicit non-array edges remain invalid; revision, cycle and blocked-work guards are unchanged.
- Compaction preserves the latest graph, including an empty/cleared graph. A later clear/replace supersedes old snapshots; summaries must not resurrect removed historical branches. Legacy todo state is preserved only as the latest unfinished plan when not superseded.

These rules are reflected in the default agent prompt, planning tool description and compaction prompt. Custom prompts and frozen session catalogs retain their own lifecycle until explicitly refreshed.

## Web search

`websearch` remains Host-executed and uses the configured Serper provider, existing network-policy enforcement, audit events and per-request timeout. No fallback provider or implicit credential source is added.

| Field | Meaning | Default / bounds |
| --- | --- | --- |
| `query` | One query; mutually exclusive with `queries` | Non-empty string |
| `queries` | Independent, unique queries sharing pagination/count settings | 1–5 strings |
| `limit` | Requested organic results **per query per provider page** | 5; integer 1–100 |
| `page` | First provider page, 1-based | 1; integer 1–10 |
| `pages` | Consecutive pages to fetch in this call | 1; integer 1–5 |

Cross-field budgets: `query_count × pages <= 5`, `query_count × pages × limit <= 100`, and `page + pages - 1 <= 10`. Every request is validated before credentials/network access; invalid input is rejected rather than silently clamped. A valid batch issues at most five bounded concurrent requests. `num` and `page` are sent to Serper on every request; multiple pages are real separate provider requests, not local slices of page one.

For example, one query with `limit: 20, page: 2, pages: 3` requests pages 2/3/4 and at most 60 results. Two queries with `limit: 20, pages: 2` request four provider pages and at most 80 results. Existing `{query: "..."}` calls retain the quick-lookup default of five results from page one.

Output identifies each query/page, its requested and actual returned count, and continuation guidance. Ordered batch sections preserve successes even when another request fails; the overall result is unsuccessful and exposes the failure rather than pretending the failed section had zero matches. Empty/short pages and exhausted local budgets do not prove exhaustive coverage. Provider rankings/pages can change or overlap; deduplicate URLs and verify important sources with `webfetch`. Limits above are **product request budgets**, not guarantees of provider availability, result count or credit pricing.

Use a single query for a narrow lookup. For broad research, choose independent angles and explicit counts (often 10–20), and inspect additional pages or reformulate when evidence is insufficient. Neither stopping automatically after one page nor always fetching every possible page is a quality rule. Stop when the question has adequate verified evidence, not when a quota is filled.

Provider HTTP failures are not empty results. Recognized fixed quota/authentication reason labels produce non-retryable `ESEARCH_QUOTA` / `ESEARCH_CREDENTIAL` preconditions; diagnostics read at most 4,096 body bytes and never echo arbitrary provider bodies. Unknown HTTP 400 remains an explicit rejection, not a guessed billing diagnosis. HTTP 429 is retryable with backoff guidance (numeric `Retry-After` seconds up to 86,400 are reported); the tool itself performs no automatic retry or credential/provider fallback.

## Workspace search

`glob` and each `multi_grep.searches[]` item accept:

- `limit`: integer 1–1000, default 1000.
- `offset`: non-negative safe integer, default 0.

The returned `next_offset` identifies the next result page when an extra matching row was actually observed. Continue with the same scope/pattern/mode and unchanged workspace. Pagination is not a filesystem snapshot.

`multi_grep` supports up to 20 independent searches. Its default mode is `files_with_matches`; `content` returns matching lines, and `count` returns per-file matching-line counts. `limit` counts matching lines in content mode and file rows otherwise. Ordering is stable path/line order. Runtime failures preserve earlier and later successful sections and report overall `EPARTIAL`; schema errors reject the whole batch before searching and cancellation stops it. Each child retains its own page budget and complete section; there is no shared inline truncation that discards later searches.

`glob.path` is the actual search directory and defaults to workspace cwd. Historical internal `cwd` remains a compatibility alias; conflicting `path`/`cwd` values are rejected. Results sort by descending mtime with a path tie-breaker, and metadata requests run in bounded groups of 64.

Traversal is separately bounded: grep collects at most 10,000 selected files and examines at most 100,000 directory entries; glob examines at most 100,000 entries. Traversal limits and unreadable files/directories produce an **incomplete scan** warning. Further offsets cannot recover unscanned scope: narrow the directory/pattern instead. Small complete legacy calls retain their plain result format; explicit pages and incomplete/truncated results add metadata. Finding no rows in an incomplete scan is not proof of no matches.

## Batched reads and mutations

`read_files` validates all input entries before I/O, preserves independent runtime successes/errors in order and returns overall `EPARTIAL` when an attempted file fails. Cancellation stops immediately rather than becoming partial success; unexpected programmer errors are not swallowed. The shared `max_bytes` budget covers rendered sections and diagnostics, excluding the error-code wrapper and concise model-facing recovery envelope. Output is UTF-8 bounded even for tiny budgets. Exhausting the budget stops further reads; the truncation footer distinguishes attempted from not-attempted files. Attempted does not mean fully rendered. Tiny budgets can truncate the diagnostic body, but the model-facing outcome/recovery envelope remains outside that budget; increase the supported budget or narrow the request to recover missing item details. Retry only failed/omitted files or ranges.

`apply_file_patch` separates noncontiguous update hunks at `@@`, rather than concatenating their old text. An individual Update File operation checks all ordered exact replacements under one file lock before writing and retains ambiguity/chained-edit and concurrent-change guards. This is not a durable filesystem transaction or a cross-operation rollback guarantee. When a later file operation fails after earlier operations completed, expected tool/filesystem failures return `EPARTIAL` with an already-applied receipt and the failing operation; cancellation retains `ECANCELED` with the receipt when available. Do not replay an entire partially applied patch. On any context/revision mismatch re-read current content; do not disable revision checks, broaden `replace_all`, or overwrite to force success.

## Shell and acknowledgement timeouts

For foreground `bash`/`shell` with an explicit business timeout and blocking `bash_output`, the Host ack budget is at least the business wait plus 10% grace (minimum 5 seconds, maximum 60 seconds of grace). Nonblocking/background launch calls retain the normal ack budget. Inputs and executor business timeouts are not rewritten. Reconnect preserves the original absolute deadline, not a fresh timeout window.

An ack timeout means **unknown execution**, including after reconnect: structured failure is `indeterminate`, `retryable=false`, with acknowledgement-stage attribution and explicit inspect-before-retry guidance. This does not cancel the underlying process or prove side effects did not occur.

POSIX foreground shells own a dedicated process group, remain referenced/awaited, and kill their ordinary process group on timeout/cancel so descendants cannot keep output pipes alive merely because only the parent died. Explicitly daemonized/new-session descendants can escape; this is not full containment or a guarantee about external side effects. Existing Windows tree-kill behavior is unchanged. Prefer background mode and blocking, offset-based polling for long work, not rapid empty polls.

Host/SDK temporary overflow paths are not necessarily Executor-readable artifacts. An access error is not permission to widen the sandbox or read arbitrary Host files; narrow the original output or use an authorized session artifact route. A unified session-bound SDK artifact read channel remains a separate unresolved integration concern.

## Root causes addressed and verification boundary

The previous web tool exposed only `query` and a 1–10 result limit; the transport silently clamped larger values to 10 and never sent a provider page. Descriptions gave no breadth/continuation strategy. Local grep capped output without a continuation offset, glob silently bounded traversal, and glob's public `path` parameter was ignored in favor of its undocumented `cwd` input. Planning rules favored incremental growth while compaction emphasized preserving task history without supersession rules.

Regression tests cover provider request serialization (including a single multi-page call), batch partial failure/order/budgets, count and page validation, old single-query and HTTP credential-test compatibility, local pagination past the former ceiling, glob scope/tie ordering, remove/replace/clear semantics, prompts and compaction. Provider transport tests use injected responses: they do not certify live paid Serper pagination, provider search quality, or agent behavior on every model. No live service or in-use instance is redeployed by this change.
