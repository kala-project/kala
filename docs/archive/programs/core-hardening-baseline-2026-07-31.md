# Core Agent Highest-Strength Hardening Baseline

**Captured:** 2026-07-31T15:31:35Z
**Repository HEAD/base:** `1e01821a46f05b703db6fc97b6cd61cb6d179dc4`
**Program entry:** Task Graph `coreHardeningBaseline`
**Benchmark input:** [`../architecture/private-cloud-enterprise-benchmark-matrix.md`](../../architecture/private-cloud-enterprise-benchmark-matrix.md)

**Historical terminology:** this frozen 2026-07-31 evidence record preserves the deployment labels used by that run. Current product names are Portable, Dedicated, and Private Cloud; see [`../architecture/deployment-mode-contract.md`](../../architecture/deployment-mode-contract.md).

## Safety and evidence rules

1. The shared working tree is authoritative and must not be reset wholesale.
2. Tests use temporary Session IDs, Workspaces, identities, ports and data roots. Existing customer/user data is read-only evidence.
3. Docker Hosted is tested before any LXD mutation. Standalone pre-release tests run on an unused Box port with temporary data.
4. LXD `13000` is changed only by `coreHardeningFinalLxdDeploy`, after every preceding quality gate passes.
5. Every discovered defect requires a deterministic test or a retained reproduction seed before closure.
6. Passing unit tests alone cannot close a user journey. Browser/network/backend/durable-state/restore evidence is required where applicable.
7. Secrets and customer payloads are not copied into reports. Session-log analysis records identifiers, event kinds and integrity findings only.

## Source and working tree

| Item | Captured value |
|---|---|
| Git HEAD | `1e01821a46f05b703db6fc97b6cd61cb6d179dc4` |
| Comparison baseline | same commit; all program work is currently uncommitted shared-tree state |
| Modified/untracked paths | 213 |
| Core product diff | 102 files, 3,620 insertions, 1,229 deletions |
| Core package distribution | Dashboard 66, Host 27, Executor 5, Kernel 4 changed tracked files |
| Node.js | `v22.16.0` |
| pnpm | `11.3.0` |
| Whitespace validation | `git diff --check` passed at capture |

The unusually large uncommitted delta is itself a release risk. Review and tests must use file-level ownership and must not infer that HEAD represents the deployed implementation.

## Runtime snapshot

| Runtime | Captured state |
|---|---|
| Standalone LXD service | active |
| Standalone process | PID `23320`, `/usr/bin/node .../kala-dashboard-with-runtime.cjs --port 13000` |
| Standalone bundle SHA-256 | `fc60146a12a275bfa266a586200ca55b4b0ddafcf455478cdc2a0cec45b4cbdb` |
| Standalone Session storage | 15 GiB, 75 JSONL Session logs |
| Docker Hosted | Docker daemon unavailable to the current execution identity (`/var/run/docker.sock` permission denied); must be recaptured before Hosted acceptance |

The Docker permission failure is an environment-access blocker, not evidence that Hosted is healthy or unhealthy. No Hosted node may be marked complete until Compose/container health is captured through an authorized path.

## Preserved real-world regression corpus

The long-running LXD Session logs are retained in place as read-only evidence. Initial integrity scanning found:

| Session | Events | Duplicate sequence numbers |
|---|---:|---:|
| `123e4567-e89b-42d3-a456-42661417000d` | 9,668 | 22 |
| `123e4567-e89b-42d3-a456-42661417000e` | 8,798 | 1 |

These duplicate sequences are confirmed historical defects, not acceptable fixtures. They motivate `sessionLogIntegrityAudit` and must be covered by:

- concurrent dispatch/cancel tests;
- authoritative replay behavior for legacy conflicting entries;
- duplicate-sequence detection and explicit repair/quarantine policy;
- proof that newly generated logs have strictly unique, monotonic event sequences.

The primary long Session also preserves examples of:

- repeated Cancel events;
- graceful restart during active Tool execution;
- multiple compactions and recovery continuation;
- large cumulative Provider usage versus bounded context snapshots;
- orphan-looking historical Tool cards caused by projection semantics.

Reports may reference event sequence numbers but must not copy prompts, file contents, credentials or LLM trace bodies.

## Known incidents entering the program

1. Direct-send Composer content was not cleared while queued-send content was cleared.
2. Queue/Steer behavior caused unexpected interruption and stuck turns.
3. Forced Compact did not reliably continue autonomous work in all threshold/failure cases.
4. Graceful restart originally lacked reliable automatic continuation.
5. Concurrent Cancel produced repeated events and duplicate sequence numbers.
6. Compact UI displayed cumulative lifetime usage as current context (`1606.3m`).
7. Compact/history projection rendered completed Tool calls as live spinners.
8. Lifetime Tool call counts produced meaningless UI such as `+4833 earlier`.
9. Hosted logout/auth failures were represented as indefinite loading.
10. Hosted routing and identity changes repeatedly regressed core product journeys.

Previously applied fixes are hypotheses until exercised by this new program's adversarial and end-to-end gates.

## Isolated evidence layout

Each run creates `/tmp/agent-runlab-core-hardening-<UTC timestamp>/` containing:

- `environment.json` — commit, diff digest, package versions and runtime endpoints;
- `tests/` — command, exit status, duration and captured non-secret output;
- `seeds/` — property/fuzz/fault-injection seeds;
- `browser/` — viewport, URL, screenshots, console errors, failed requests and created resource IDs;
- `sessions/` — generated disposable Session summaries and integrity reports, not prompt bodies;
- `hosted/` and `standalone/` — mode-specific journey evidence;
- `cleanup.json` — deleted temporary users, Organizations, Workspaces, Sessions and files;
- `risk-register.md` — unresolved issue, severity, owner, reproduction and release decision.

## Required execution order

The Task Graph is normative:

1. Invariants and fault model.
2. Change-risk and coverage map.
3. Session-log atomicity.
4. Queue/Steer/Cancel, Approval/Tool, Compact and Executor protocol audits.
5. Restart recovery and Sub-agent/Task Graph audits.
6. Dashboard projection and Composer interaction audits.
7. Hosted tenant isolation.
8. Model/property/fuzz tests and soak/fault injection.
9. Real browser, isolated Standalone, then Docker Hosted acceptance.
10. Unified quality gate.
11. Final LXD deployment and post-deployment recovery proof.

## Baseline exit criteria

This baseline is complete when:

- source/runtime/data snapshots are recorded;
- the historical regression corpus is identified without mutation;
- Docker access limitation is recorded as a later acceptance prerequisite;
- evidence and cleanup conventions are explicit;
- no LXD deployment is scheduled before the final graph node.
