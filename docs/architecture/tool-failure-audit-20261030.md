# Tool failure audit — 2026-10-30

This is a non-normative, privacy-preserving investigation record. The maintained behavior is specified in [the built-in tool contract](./task-search-tool-contract.md); this record does not introduce a second source of truth.

## Evidence and limits

- Read-only inspection of a running Host's persisted session projections. No restart, deployment, configuration change or credential borrowing was performed.
- Selected up to 60 latest snapshots modified within seven days, with an 8,000,000-byte per-file and 128,000,000-byte total read ceiling per pass. The initial pass read 60 snapshots / 35,848,489 bytes without skips. Later bounded passes refined failure templates and patch shapes while the service remained active.
- The final frozen refinement observed **6,258 tool-result records, including 293 unsuccessful records**. Calls/results were paired by call ID within each snapshot. A cross-snapshot fingerprint of call ID, tool name and normalized input collapsed no additional observations in this pass. This is not a guarantee of globally unique physical executions across forks/rebased IDs.
- Snapshot modification time selects the cohort; it is **not the occurrence time of every call**. Results are not a full-lifetime failure rate, an exact last-seven-days failure rate, or an unbiased production benchmark. The live cohort can include calls made by the ongoing audit itself.
- Runtime JSONL result receipts do not contain the actual result text and were not double-counted as tool outcomes. Huge JSONL logs were not read wholesale.
- No raw session history, prompts, commands, patches, filesystem paths, credentials, outputs, session IDs or fingerprints were exported into tracked artifacts. Only aggregate counts, fixed tool/error labels, input-shape flags and numeric timeout settings were retained here.
- A successful shell tool result with a nonzero command exit is not automatically a tool implementation failure.

### Frozen failure distribution

| Tool | Unsuccessful records |
| --- | ---: |
| `webfetch` | 52 |
| `apply_file_patch` | 45 |
| `todo_graph` | 44 |
| `websearch` | 28 |
| `read_files` | 24 |
| `multi_grep` | 19 |
| `shell` | 16 |
| `read_file` | 15 |
| `ls` | 15 |
| `replace_in_file` | 14 |
| Other tools | 21 |

## Findings and changes

### 1. Graph replacement contradicted its schema

Forty failed records omitted `edges` in a `replace` operation. The schema made that field optional, but the parser required it alongside `nodes`.

The parser now defaults omitted replacement edges to an empty array, never the historical edge set. Explicit malformed edges, cycles, revision conflicts and starting blocked work remain rejected. The schema description documents the distinction.

### 2. Patch parsing discarded hunk boundaries

Forty-three of the 45 failed patch records contained multiple `@@` hunks in at least one updated file. Forty-one records matched the missing-context error template. These sets can overlap; shape alone does not establish that all those calls would succeed after a fix.

The old parser skipped `@@` and concatenated disjoint old-text hunks, demanding an impossible contiguous match. A local reproduction also exposed that earlier file operations could already have been applied before a later operation failed, without a receipt.

Update operations now retain separate ordered hunks and validate them under the same file lock before writing. Exact-match, ambiguity, chained-edit and concurrent-change guards remain in place. Expected later tool/native filesystem failures return `EPARTIAL` with applied operations and the failing operation; cancellation keeps its cancellation code. This is explicitly **not a cross-file transaction or durable atomic-write guarantee**. The model is instructed not to replay the entire patch or force overwrites after a mismatch.

### 3. Batch reads lost independent successes

Twenty-four failed `read_files` records included missing/inaccessible path cases. Previously one runtime failure discarded preceding results and prevented later independent reads.

The batch now retains successful/error sections and returns overall `EPARTIAL`. Input validation still precedes all I/O; cancellation stops immediately and unknown programmer errors propagate. The existing byte budget is preserved, including UTF-8-safe truncation and tiny budgets; diagnostics distinguish attempted from not-attempted files. The error-code wrapper is outside the content budget. A truncated attempted section is not a complete read.

### 4. Long polling competed with its own ack deadline

All five failed `bash_output` records were blocking requests with a 60,000 ms business wait and a 60,000 ms ack deadline. The Host only extended ack time for the legacy `bash` handler.

Blocking output waits now receive the same bounded transport grace as foreground shell waits. Public `shell` and legacy `bash` aliases are both recognized. Nonblocking calls/background launches are not extended, business parameters are not rewritten, and reconnect retains the original absolute deadline.

Both initial and post-reconnect ack failures now retain `indeterminate`, acknowledgement-stage metadata and `retryable=false`, with explicit unknown-execution text. This prevents advertising a potentially completed mutation as safe to blindly repeat; it does not cancel the remote operation.

### 5. POSIX shell timeout killed only the parent

Thirteen shell failures matched ack-timeout text despite business timeout/grace settings. That observation alone does not prove one cause for every timeout. Source inspection and a local waiting-shell reproduction confirmed a separate execution bug: only the direct POSIX shell was killed, so descendants could continue running and hold stdout/stderr pipes open.

Foreground POSIX shells now own a dedicated process group, remain referenced/awaited, and terminate their ordinary group on timeout/cancel. The regression exercises a waiting shell with a real child, not only a shell that optimizes into directly executing `sleep`. Explicitly detached/new-session descendants and already-performed external effects remain outside this guarantee. Windows behavior was not changed or runtime-validated here.

### 6. Provider failures lacked safe diagnostic detail

All 28 frozen `websearch` failures reported HTTP 400. The retained text does not reveal whether these were invalid parameters, exhausted credits, credential problems or another provider rejection; it would be incorrect to invent a historical billing diagnosis.

Future failures now read at most 4,096 diagnostic body bytes and recognize only fixed quota/authentication reason labels. Arbitrary bodies and account details are not echoed. Unknown reasons remain generic rejections. HTTP 429 gets retryable/backoff guidance, including bounded numeric `Retry-After`, but no automatic retries, fallback provider, extra paid requests or borrowed credentials were added.

The 52 `webfetch` failures were HTTP 404 (25), 403 (16), 429 (6), 401 (4) and 400 (1). These are not uniformly tool defects. Descriptions now direct URL verification, authorized sources and backoff instead of blind repeated fetches or access bypass.

## Remaining integration concerns

- Read attempts against Host/SDK-style temporary overflow paths failed with access errors. A local path printed by the SDK is not necessarily a readable Executor-owned artifact, especially across machines/sandboxes. The exact ownership/visibility chain still needs a session-bound artifact integration design; broadening `/tmp` or root access is not a fix. Guidance now recommends narrowing original output or using an authorized artifact route, without claiming a unified new read API exists.
- Unknown execution after transport loss still requires effect reconciliation. This change improves deadline correctness and truthful feedback, not durable exactly-once execution or a new call-status/reconciliation protocol.
- Real websites/provider rejection, missing files, genuine revision conflicts and denied permissions remain visible failures rather than being suppressed.

## Verification

- Before implementation, focused local regressions reproduced four Host failures and six Executor failures covering schema mismatch, ack budgets, merged patch hunks, missing partial receipts, cancelled reads, tiny budgets and lingering shell children.
- Final focused regression: **Host 98/98 across eight files; Executor 61/61 across eight files; 159 total**. Most scenarios reuse existing coverage; 17 behavioral scenarios were added.
- Both packages passed TypeScript `--noEmit`; diff whitespace validation passed.
- HTTP tests inject responses. They do not certify live paid Serper availability, billing, provider pagination, or search quality. Shell process-group tests execute real local Linux subprocesses; they do not certify Windows or arbitrary daemon containment.
- Read-only post-check confirmed unchanged running-service PID, restart count and start timestamp, with active/running state. No in-use service was restarted or redeployed.
- Delivery is local only. Existing running processes/frozen catalogs/custom prompts do not automatically acquire these changes.
