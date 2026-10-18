# Historical Prompt for the External Dedicated Platform Migration Agent

**Status:** archived pre-migration prompt; do not copy or execute as a current procedure. Use [`dedicated-operator-cli.md`](../../operations/dedicated-operator-cli.md) and [`dedicated-platform-runtime-unit-cutover.md`](../../operations/dedicated-platform-runtime-unit-cutover.md).

Copy the block below verbatim into the external Agent Session.

---

You are taking over the production migration of Kala Dedicated from the legacy single-process Host service to the real systemd topology with Stable Ingress, blue/green Runtime Unit slots, Deploy Supervisor, and Migration Finalizer.

Repository root: `/home/example/agent-kernel`

Your mandatory runbook is:

`docs/archive/programs/dedicated-platform-systemd-external-agent-handoff.md`

The normative architecture is:

`docs/architecture/dedicated-platform-runtime-unit.md`

Read both completely before making any change. Inspect the actual current source and target machine; do not trust this prompt as a substitute for the runbook or runtime evidence.

Critical control-boundary rule:

- The existing Kala Sessions run inside the Dedicated Host being migrated.
- Do not execute production stop/start/cutover through a Tool call, Executor, browser Session, or process that depends on that Host.
- Production cutover and all polling must run from an independent SSH/console/operator process that remains alive when `agent-runlab-host.service` and port 13000 disappear.
- Do not use force restart or fixed sleeps.

Source-level fixes already completed and expected to remain present:

- cutover, rollback, architecture, and systemd templates consistently use the production blue/green Runtime Unit model;
- packaging tests cover dynamic slot ports, shared logical Unit state, slot environment files, and current restart policy;
- related Dedicated tests and release build/verification pass.

First re-run and review those gates against the exact source revision. Fix any real defect you find, but do not revert unrelated shared-worktree changes.

This assignment is not limited to installing the existing units. Before any production cutover, you must complete and prove all remaining graceful-update infrastructure specified in section 5 of the runbook:

1. Implement a supported `deploy:dedicated` command, or an explicit Dedicated-slot mode in `deploy:remote`, with `stage`, `status`, `wait`, `inspect`, safe `abort`, and Supervisor-owned `rollback` operations.
2. Implement a validated, versioned, idempotent Supervisor request/receipt protocol with atomic request submission, route-generation fencing, immutable release verification, monotonic receipts, restart recovery, and redacted diagnostics.
3. Integrate the existing planned-restart continuation protocol into blue/green slot cutover so active Sessions checkpoint and automatically continue exactly once on the candidate slot. Cover LLM, Tool, Tool-result-before-LLM, Queue, Approval, Compaction, parent/child Agent, and the Session that initiated its own deployment. Planned cutover must not create `[interrupted]`.
4. Implement a durable Stable Ingress admission queue for accepted user messages during slot handoff. Bind principal/unit/Session/operation ID, acknowledge only after durable append, use per-Session ordered leases and generation fencing, reconcile into Session JSONL exactly once, and expose backpressure/metrics. Ingress must not become a second Agent state machine.
5. Separate process readiness from runtime readiness. Mutable routing is allowed only after write-lease ownership, state load, planned continuation, admission reconciliation, release/capability verification, and persisted Supervisor readiness.
6. Add operator/Dashboard observability for slots, PIDs, deployment phase, digests, blockers, queue depth, participant checkpoints, continuation outcomes, route generation, and rollback.
7. Add process-level, fault-injection, clean-systemd Shadow, Browser, Executor, and self-deployment tests that prove no deadlock, no lost/duplicate accepted operation, no duplicate Tool side effect, monotonic cursors, reconnect, exact hash, automatic rollback, and Supervisor crash recovery.

Do not use the legacy single-service `deploy:remote` generation/finalizer path after slot topology is active. Future updates must enter through the new Supervisor request/receipt protocol and one standard command/API.

Then execute the runbook in topology order:

1. Perform read-only production inventory and privately record the legacy service, MainPID, actual mutable roots, owners/modes, filesystem devices, active release digest, provider config locations, connected Executors, Session cursors, queues, and structured interrupted baseline.
2. Build one immutable release and record its source revision and SHA-256.
3. In a clean disposable systemd Shadow VM/container with independent ports and data, prove:
   - staged install leaves new services disabled/inactive;
   - realistic legacy state migrates atomically;
   - Browser and Executor reconnect through Stable Ingress;
   - File/Git/Shell/Artifacts and full Dedicated Operations/Pipeline/Evaluation capabilities work;
   - successful blue/green cutover completes with a receipt;
   - a deliberately broken candidate automatically rolls back;
   - Supervisor restart resumes persisted rollback;
   - initial migration failure restores the legacy service and state path;
   - Session cursor, queue identity, approvals, and user operations remain unique;
   - no new structured planned-restart `[interrupted]` appears.
4. Create a production backup/snapshot and prove restoration into a disposable location. A backup file existing is not sufficient.
5. Create private target environment files outside Git. Do not expose domains, IPs, tokens, keys, passwords, provider endpoints, real paths, Session logs, receipts, or screenshots with private data.
6. Stage the generated release disabled using `install-dedicated-systemd.mjs`; verify all new services remain inactive and disabled, run `systemd-analyze verify`, and inspect the `installed_disabled` receipt.
7. Re-run the final go/no-go gate. If exact active-Session continuation was not proven in Shadow, require every Session to be resting, all queues empty, and no required child active.
8. Start `kala-dedicated-migration-finalizer.service` with `--no-block` from the independent control channel. Poll systemd, logs, and receipts externally. Never force the old Host down because waiting is slow.
9. Perform full production acceptance, not only HTTP 200:
   - separate Ingress/Unit/Supervisor PIDs and cgroups;
   - route state and active slot;
   - exact bundle digest;
   - Dedicated capability profile;
   - Browser and Executor Socket.IO reconnect;
   - same Workspace identity;
   - existing and new Sessions;
   - harmless File/Git/Shell flow;
   - Artifact/Operations flow;
   - Session cursors, queues, approvals, no duplicate messages/effects, and no new structured interrupted event;
   - provider/model settings fingerprint unchanged;
   - migration receipt `cutover_completed`;
   - legacy predecessor retained for rollback.
10. Keep the predecessor service, release, backup, and receipts throughout an observation window. Do not clean them up in the cutover change.

Use a task graph. Production cutover must be the final branch after source gates, Shadow success, Shadow rollback, backup restore, and disabled staging. Mark nodes complete only with tool/command evidence.

If any mandatory check fails, follow the runbook rollback rules. If data ownership or migration state is uncertain, fail closed and do not start old or new Hosts against an uncertain state root.

At the end, report concrete evidence: revision, release digest, test results, Shadow scenarios, backup restore, operation IDs and receipt phases, old/new PIDs, route generation, active slot, HTTP/Socket/Browser/Executor results, Session cursor/interrupted deltas, data ownership, rollback readiness/outcome, remaining risks, and observation-window plan.

Do not claim completion if only installation or staging succeeded.

---
