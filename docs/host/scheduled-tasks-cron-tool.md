# Agent Scheduled Task / Cron CRUD Tool (`scheduled_task`)

**Status**: Accepted & Implemented (Source of Truth)
**Scope**: `packages/host/src/extensions/scheduled-task-tool.ts`, `packages/host/src/loop-types.ts`, `packages/host/src/server.ts`, `packages/host/src/builtin-tools.ts`, `packages/host/src/extensions/builtin-registry.ts`
**Depends on**: Unit-local Scheduled Tasks (`docs/architecture/host/scheduled-tasks.md`, `packages/host/src/scheduled-tasks/`)
**References**: `references/hermes-agent/tools/cronjob_tools.py`, `references/hermes-agent/tools/cronjob_prompt_scan.py`

---

## 1. Problem Statement & Motivation

`kala` already includes an authoritative Unit-local scheduler (`UnitScheduler` and `ScheduledTaskStorage` backed by JSON+SQLite lease, Portable SQLite, or PostgreSQL) as well as REST endpoints (`/api/v1/scheduled-tasks`) and a Dashboard UI.

However, **the Agent itself has no tool to inspect, create, update, pause, resume, or delete scheduled tasks during a conversation**. When a user asks the Agent:
- *"Remind me in 45 minutes in this session to check the staging rollout"*
- *"Every weekday at 09:30 Asia/Shanghai, run a morning repository health check in this workspace"*
- *"List my active scheduled tasks and pause the afternoon report"*

the Agent previously had to tell the user to click through the Dashboard UI manually.

Providing a first-class, tenant-isolated, threat-scanned `scheduled_task` Host tool closes this loop while preserving all safety, tenancy, and misfire invariants of `UnitScheduler`.

---

## 2. Architecture & Security Invariants

1. **Single Source of Truth Storage**:
   - The `scheduled_task` tool operates directly on the Host's `ScheduledTaskStorage` (`deps.scheduledTaskStore`), sharing the exact same state, inbox notifications, and `UnitScheduler` execution pipeline as the REST API and Dashboard UI.
   - If `deps.scheduledTaskStore` is not explicitly injected in standalone/test loop harnesses, a lazy session-directory-backed fallback store (`ScheduledTaskStore`) is used per `SessionStore`.

2. **Tenant & Principal Isolation (`resolveSessionScheduleActor`)**:
   - In Organization tenancy (`record.organizationId` present), `ownerKey = "organization:" + record.organizationId` and `principal = record.principal ?? "session:" + record.sessionId`.
   - In Portable / single-user mode (`record.organizationId` absent), `ownerKey = "principal:" + (record.principal ?? "local")`.
   - Organization operations resolve the principal's **current** role via the scheduled-principal authority. A missing, denied, or unavailable authority fails closed, including for reads; the persisted Session role is not used. Current viewers are read-only.
   - Only the original `createdBy` principal may `update` or `resume` a task; `owner` and `admin` roles may additionally `pause` or `delete` (revoke) another principal's task in the same organization, matching `public-api.ts`.

3. **Sub-Agent Restriction**:
   - Sub-agent sessions (`record.parentSessionId !== undefined` or `(record.delegationDepth ?? 0) > 0`) are strictly forbidden from mutating scheduled tasks (`create`, `update`, `pause`, `resume`, `delete`) so delegated helpers cannot install persistent background jobs.

4. **Prompt Threat & Persistence Guard (`scanScheduledTaskPrompt`)**:
   - Because scheduled tasks execute unattended on future occurrences, every `prompt` supplied to `create` or `update` is scanned before persistence for:
     - Invisible Unicode spoofing characters (bidi overrides `U+202A..U+202E`, `U+2066..U+2069`, and zero-width joiners including those in emoji sequences).
     - Prompt-injection & instruction-override directives (`ignore previous/all/prior instructions`, `disregard your rules`, `system prompt override`, `do not tell the user`).
     - Credential exfiltration & backdoor commands (`curl`/`wget` with `$SECRET`/`$TOKEN`/`$API_KEY`, reading `.env`/`id_rsa`/`.pgpass`, modifying `authorized_keys` or `/etc/sudoers`, `rm -rf /`).

5. **Ergonomic Schedule Input Normalization (`normalizeScheduleInput`)**:
   - Accepts `kala`'s canonical `ScheduleSpec` (`once`, `daily`, `weekly`, `interval`, `monthly`).
   - Additionally accepts Agent-friendly shorthands that compile deterministically into `ScheduleSpec`:
     - **Relative delay**: `{ kind: "once", inMinutes: 30 }` or string `"in 30m"` / `"in 2h"` / `"in 1d"` → `{ kind: "once", at: <ISO timestamp> }`.
     - **5-field Cron expression**: `{ kind: "cron", expression: "30 9 * * 1-5", timezone: "Asia/Shanghai" }` or string `"30 9 * * 1-5"` (with top-level `timezone`, defaulting to `"UTC"`) → compiles into `daily`, `weekly`, or `monthly` `ScheduleSpec`. Cron `7` aliases Sunday, including ranges (`0-7` = all days, `6-7` = Saturday and Sunday).

---

## 3. Tool Schema & Operations (`scheduled_task`)

```ts
export type ScheduledTaskToolAction =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'pause'
  | 'resume'
  | 'delete'
  | 'history'
```

### 3.1 Operations

- **`list`**:
  - Lists tasks owned by the session's `ownerKey`.
  - Optional filters: `status` (`"active" | "paused" | "all"`, default `"all"`), `target_session_id` (filter to tasks targeting a specific session).
- **`get`**:
  - Requires `task_id`. Returns the `ScheduledTask` (without internal `ownerKey`) plus recent run history summary.
- **`create`**:
  - Requires `prompt`, `schedule`, and a caller-generated `idempotency_key` (1–128 alphanumeric/underscore/hyphen characters). Reuse it for retries; persisted owner/principal-scoped receipts make concurrent and restart retries return the existing task, reject changed inputs, and refuse reuse after deletion.
  - Receipt history is capped at **10,000 per Unit** across principals (JSON, Portable SQLite, and PostgreSQL). At capacity, new keyed creates fail closed; matching retries and deleted-key rejection still work. Receipts are never evicted automatically because that would permit historical replay. Administrative retention/rotation requires a separate migration and policy.
  - Optional `target`:
    - Defaults to `{ kind: "session", sessionId: record.sessionId }` (current session). **Session targets require `allow_session_queue: true`** to acknowledge ordinary session queue behavior; the flag is model-supplied, **not user consent and never an override for Goal isolation**. An active, paused/resumable, or model-completed-but-not-yet-user-accepted Goal blocks session-targeted creation, updates, and resume even with this flag. Complete/accept the Goal first, or choose `{ kind: "workspace" }` to spawn an isolated Session. The flag is also required when updating a target to a session. Autonomous/DAG sessions cannot be targeted.
    - If `target: { kind: "workspace" }` (or `target.workspaceId` omitted), defaults to the current session's `workspaceId`, `workspaceName`, and `state.cwd`. Creation/update requires a currently available Executor and validates `cwd` against its remote sandbox roots and directory existence, just like REST.
  - Optional `paused: true` to create the task in a paused state.
- **`update`**:
  - Requires `task_id` and at least one of `prompt`, `schedule`, or `target`.
  - Validates ownership, scans `prompt` if changed, validates `target` if changed, and increments task `generation`.
- **`pause` / `resume`**:
  - Requires `task_id`. Transitions task status to `'paused'` or `'active'` and recomputes `nextRunAt` on resume.
- **`delete`**:
  - Requires `task_id`.
  - By default (`auto_pause !== false`), atomically deletes an active or paused task without a separate pause mutation. If a claimed occurrence exists, deletion fails **without pausing** the task. `auto_pause: false` retains the REST requirement to pause first.
- **`history`**:
  - Requires `task_id`, optional `limit` (`1..100`, default `20`). Returns newest-first `ScheduledRun[]` entries (`occurrenceId`, `scheduledFor`, `status`, `sessionId`, `error`).

### 3.2 Goal interaction at firing

The Host rechecks the target Session's live Goal state before delivery, including for tasks created before the Goal became active. An occurrence targeting an active, paused/resumable, or model-completed-but-unaccepted Goal is recorded as **`failed`** with an explicit “complete the Goal first; no scheduled prompt was enqueued” error; it does not enter the Session queue or consume the Goal's budget. Recurring schedules retain their next occurrence, which is independently checked. The pre-admission recheck also maps a Goal transition during validation to a definite failed occurrence rather than an indeterminate delivery.

---

## 4. Verification & Acceptance Criteria

1. **Full CRUD Lifecycle**:
   - `create` (with `once` ISO/relative, `daily`, `weekly`, `monthly`, `interval`, and 5-field cron shorthand) → `list` → `get` → `update` → `pause` → `resume` → `history` → `delete`.
2. **Default Target Inference & Boundary Validation**:
   - Omitting `target` binds to the current `sessionId`; specifying `target: { kind: "workspace" }` binds to the current session's `workspaceId` and `cwd`. Cross-tenant targets are rejected.
3. **Security & Sub-Agent Guards**:
   - Prompts containing prompt injection, invisible Unicode bidi overrides, or credential exfiltration are blocked with clear diagnostic reasons.
   - Sub-agent sessions (`parentSessionId` set) are blocked from mutating tasks.
   - Viewer roles and non-creator principals respect RBAC rules.
