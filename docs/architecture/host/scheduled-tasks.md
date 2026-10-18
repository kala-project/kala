# Scheduled tasks: design and usage

Status: implemented on `feature/bang-shell-command-20261002`; this document describes the current Unit-local scheduler, public API, and Dashboard UI.

## Ownership and process model

Scheduled tasks are owned by a runtime **Unit**. `UnitScheduler` starts inside the same Host process as the Unit's Session registry, durable message queues, agent loop, and Executor registry. It is:

- not owned by the Runtime Ingress Gateway;
- not system `cron`;
- not a new scheduler service or control-plane worker.

This placement lets each occurrence re-check the same authoritative Session and tenant boundary used for ordinary messages. It also means a trigger is available only while that Host is running. If the Host is down at the scheduled instant, nothing triggers then; bounded misfire handling runs after that Unit starts again.

## Targets

A task contains a prompt and one target.

### Existing Session

A Session target enqueues the prompt into that Session with **QUEUE** semantics and a stable operation ID. It uses the same durable queue as operator messages. If the Session is busy, the occurrence waits behind existing work; it does not interrupt or STEER the active turn.

Deleting a Session automatically pauses active tasks targeting that Session. The task can then be retargeted, resumed, or deleted.

### Workspace

A workspace target creates a fresh chat Session for each occurrence, bound to that workspace and optional validated `cwd`, then queues the prompt in that new Session. The occurrence ID deterministically derives the Session ID, which makes local recovery converge on the same Session.

**Current prerequisite:** the workspace must already have an authoritative Session registry binding visible to the task owner. An Executor announcement alone is not ownership authority. Create or open a Session in that workspace first. At create/edit time and again at execution time, the Host also requires an online Executor for that workspace and validates any requested `cwd`. A missing binding is reported as `workspace not found`; an unavailable Executor is `workspace offline`.

## Schedules and time zones

Three schedule forms are supported:

- `once`: one absolute ISO timestamp in the future. The Dashboard accepts a browser-local date/time and converts it to an ISO instant.
- `daily`: an hour and minute in a valid IANA time zone, such as `America/New_York`.
- `weekly`: one or more unique weekdays (`0` Sunday through `6` Saturday), an hour and minute, and an IANA time zone.

Daily and weekly definitions are wall-clock schedules, not fixed UTC intervals. Across daylight-saving transitions:

- a local minute that does not exist during a spring-forward gap is skipped;
- a local minute repeated during a fall-back overlap is one occurrence, not two.

The next occurrence is always strictly after the instant from which it is calculated.

## Persistence, writer lock, and tenant boundary

The Unit keeps scheduler-private state under:

```text
<sessionsDir>/.scheduled-tasks/state.json
<sessionsDir>/.scheduled-tasks/lease.sqlite
```

`state.json` contains task definitions and bounded run history and is written through the Host's atomic JSON-file path. This is private Unit state, not a workspace file and not a Gateway database. Run history retains at most 10,000 records, preserving still-claimed records when trimming.

Startup holds a SQLite `BEGIN EXCLUSIVE` transaction on the dedicated lease database for the writer's lifetime. A competing local process fails readiness, while graceful close or process death releases the operating-system lock without lock stealing or stale-file cleanup. Corrupt scheduler state still prevents readiness and closes the lease acquired during failed startup. The directory must be Unit-private local storage; SQLite locking here is not a multi-host or NFS coordinator. Follow [scheduled-task writer lock recovery](../../operations/scheduled-task-writer-lock.md) for cutover, crash recovery, and storage constraints.

Management access is owner-scoped:

- in organization tenancy, the owner key is the organization ID;
- otherwise, it is the authenticated principal.

List, get, update, pause/resume, delete, and history lookups cannot cross that owner key. Workspace targets additionally require a Session binding authorized through the same Unit/organization boundary. Viewers may read but cannot mutate. The internal owner key is not returned by the public API. Scheduled messages and newly created workspace-run Sessions also pass the Unit's organization queue and Session quota checks when configured. Portable Sessions have no durable per-principal owner: principals share the same local Unit's Sessions, even though their task definitions remain principal-scoped.

This is a logical multi-tenant boundary in the Unit's Host process; it is not a claim of process- or VM-level tenant isolation.

## Claim, recovery, misfire, and run states

For each scheduled instant, the store derives stable occurrence and operation IDs. Claiming an occurrence and advancing `nextRunAt` are persisted together, with an immutable snapshot of the prompt, owner, creator, and target used by that run. Later edits do not rewrite an already claimed occurrence.

After restart, a persisted `claimed` run is reconciled before replay:

- receipt `committed`: mark it `enqueued` without replay;
- receipt `absent`: retry once using the same operation ID and, for a workspace target, the same deterministic Session ID;
- receipt `unknown` or receipt lookup failure: do **not** replay; mark it `needs_review`.

Execution-time target or policy validation failure before admission marks the run `failed`. If admission throws after it may have durably accepted a message, a committed receipt marks it `enqueued`; otherwise the outcome is `needs_review` and is not automatically replayed. A normal claim that reaches its Session queue is `enqueued`—that status means queue admission, not that the agent finished the prompt successfully.

Misfire handling is deliberately bounded. After downtime, each due task executes at most one overdue occurrence. Later overdue recurring slots are recorded as `skipped` (at most nine explicit skipped records for that claim), and `nextRunAt` advances to the first future wall-clock slot. The scheduler does not unleash an unbounded backlog.

These mechanisms reduce duplicate local admission; they do not promise exactly-once arbitrary effects. A prompt can invoke external systems whose effects occur before a receipt becomes durable. Ambiguous recovery is surfaced as `needs_review` instead of being replayed optimistically.

## Dashboard usage

1. Open **Scheduled tasks** for a Session or workspace. The trigger is disabled until there is a validated target.
2. Enter the prompt.
3. Choose **Once**, **Daily**, or **Weekly**. For recurring schedules, confirm the IANA time zone and, for weekly, at least one weekday.
4. Select **Create task**.
5. Use **Edit**, **Pause/Resume**, **History**, and **Delete** on the task card.

The dialog explains target routing: Session tasks join the existing queue; workspace tasks create a fresh Session. History shows `claimed`, `enqueued`, `failed`, `needs review`, or `skipped`, the scheduled time, an error when present, and a link to the occurrence Session when one is known.

A task must be paused before deletion and cannot be deleted while it has a claimed occurrence. Pause prevents future claims; it does not revoke an occurrence already admitted to a Session queue.

## Public API

All routes are under `/api/v1` and use the Host's normal authentication and tenant attribution.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/scheduled-tasks` | List tasks visible to the owner |
| `POST` | `/scheduled-tasks` | Create a task |
| `GET` | `/scheduled-tasks/{id}` | Get one task |
| `PATCH` | `/scheduled-tasks/{id}` | Update prompt, target, and/or schedule |
| `POST` | `/scheduled-tasks/{id}/pause` | Pause |
| `POST` | `/scheduled-tasks/{id}/resume` | Resume |
| `DELETE` | `/scheduled-tasks/{id}` | Delete a paused, unclaimed task |
| `GET` | `/scheduled-tasks/{id}/history` | List newest-first run history |

Example Session task:

```json
{
  "prompt": "Review the current work and summarize blockers.",
  "target": { "kind": "session", "sessionId": "session-123" },
  "schedule": {
    "kind": "daily",
    "timezone": "Europe/Berlin",
    "hour": 9,
    "minute": 30
  }
}
```

Example workspace task:

```json
{
  "prompt": "Run the morning repository health review.",
  "target": {
    "kind": "workspace",
    "workspaceId": "workspace-123",
    "workspaceName": "payments",
    "cwd": "/workspace/payments"
  },
  "schedule": {
    "kind": "weekly",
    "timezone": "UTC",
    "daysOfWeek": [1, 3, 5],
    "hour": 8,
    "minute": 0
  }
}
```

## Current verification status

On 2026-10-02, the focused scheduler/store suite (13 tests), scheduled-task API test, Dashboard dialog suite (5 tests), and Dashboard client suite (2 tests) passed in this workspace. These runs validate the current branch state but are not release or deployment evidence.

Automated coverage present in the branch includes:

- daily/weekly IANA-zone calculation, stable claiming, atomic recurrence advance, bounded catch-up, and skipped history;
- owner-scoped store/API reads, viewer write denial, cross-organization workspace rejection, pause-before-delete, automatic pause on Session deletion, and writer fencing;
- Session queue versus deterministic fresh-workspace-Session dispatch;
- restart reconciliation for committed/absent/unknown receipts, immutable claimed snapshots, execution-time authorization failure, corrupt-state startup failure, transient poll recovery, and graceful waiting for an active occurrence;
- Dashboard component flows for create, edit, pause, resume, delete, history links, loading/error retry, target explanations, and disabled unvalidated workspace scheduling.

These are unit, component, and in-process Host/API tests. Explicit DST gap/overlap cases, long real-time soak, Host crash at every persistence boundary, multi-node shared-filesystem failover, production Supervisor cutover, and exactly-once behavior of arbitrary downstream effects are not established by those tests. A stopped Host has no independent trigger source.
