# Session Slash Commands

## Motivation

Operators need fast, keyboard-native controls for common session lifecycle
actions without leaving the composer. Slash commands should answer precise
product needs:

- reset a messy session while keeping its operational container;
- rename a session without hunting through Explorer controls;
- stop the active agent turn with the same semantics as the visible stop button;
- delete a session only after clear, deliberate confirmation.

These commands are dashboard controls. They must never be sent to the model as
ordinary user messages.

## Reference: Codex Slash Commands

### `/clear`

Codex CLI exposes `/clear` as a slash command with the user-facing description
"clear the terminal and start a new chat". In the current reference source:

- `SlashCommand::Clear` is declared in
  `references/codex/codex-rs/tui/src/slash_command.rs` and supports inline args.
- `/clear` dispatches `AppEvent::ClearUi { name: None }`; `/clear <name>` passes
  the name through as the new chat name.
- The app clears terminal/transcript UI state, then starts a fresh thread with
  `ThreadStartSource::Clear`.
- The `reset_app_ui_state_after_clear` path removes transcript cells, overlays,
  deferred history lines, reflow state, backtrack state, and related UI warnings.

Important distinction: Codex's TUI `/clear` is oriented around clearing the
visible terminal and starting a new chat/thread. It is not a kernel event that
mutates one pure reducer state in place.

### `/rename`

Codex exposes `/rename` with the description "rename the current thread".

- `/rename` with no args opens a prompt. The prompt is prefilled with the current
  thread name when one exists, and starts empty otherwise.
- `/rename <name>` applies the name directly through `SetThreadName`.
- Empty rename submissions are ignored.
- Rename is available while a task is running because it only changes metadata.

### `/stop`

Codex exposes `/stop` with the description "stop all background terminals" and
also accepts the alias `/clean`.

- It dispatches `CleanBackgroundTerminals`.
- Core handles that by closing unified exec background processes.
- It is available while a task is running.
- It does not mean "stop the current agent turn" in Codex; current-turn
  interruption is handled separately.

### `/delete`

Codex exposes `/delete` with the description "permanently delete this session and
exit".

- It opens a confirmation popup.
- The popup warns: "Cannot be undone. Subagent threads will also be deleted."
- Confirmation sends `DeleteCurrentThread`.
- It is not available while a task is running.
- The reference implementation uses one confirmation step, not a double confirm.

## Current Product State

This product already has most of the backend control surface needed for these
commands:

- Clear exists as `client:clear { sessionId }` plus kernel event `{ kind:
  'clear' }`.
- Clear currently cancels pending tools, aborts the in-flight LLM stream, resets
  kernel state, and preserves session id, cwd, and approval mode.
- Rename exists as `client:rename_session { sessionId, label }`; an empty label
  clears the override and falls back to `firstUserMessage`.
- Stop/cancel exists as `client:cancel { sessionId }`, dispatching a kernel
  `cancel` event through the normal runtime cancellation path.
- Delete exists as `client:delete_session { sessionId, cascade? }`. `cascade:
  true` deletes descendant fork/sub-agent sessions, and dashboard already has
  descendant cache invalidation logic.
- Background shell controls exist as `bg:list`, `bg:output`, and `bg:kill`, but
  there is no current "kill all background shells for this session" RPC.

This means `/clear` should not copy Codex's exact "new thread" semantics. Our
protocol already defines clear as an in-place session reset.

It also means `/stop` should not copy Codex's background-terminal meaning for the
first implementation. In this product, a slash command typed into the session
composer should target the active session turn. Background shell cleanup should
remain explicit in the background shell panel until we add a separately named
command such as `/stop-shells`.

## Command Registry

The composer should use a small command registry instead of one-off string
checks. Each command record should define:

```ts
type SessionSlashCommand = {
  name: '/clear' | '/rename' | '/stop' | '/delete'
  aliases?: readonly string[]
  args: 'none' | 'optional' | 'required'
  dangerous?: boolean
  available(ctx: SessionCommandContext): boolean
  run(ctx: SessionCommandContext, args: string): void
}
```

Parsing rules:

- Split the first whitespace-delimited token as the command name and preserve the
  rest as raw args.
- Suggestions may use prefix matching, but submitted commands must resolve to an
  exact name or alias. This prevents `/del` from deleting a session by accident.
- Commands with `args: 'none'` show usage if args are present.
- Commands with `args: 'optional'` decide whether to open UI or apply inline args.
- Command execution clears the composer only after the command has been accepted
  by the local command handler.

Initial command set:

| Command | Args | Effect |
|---|---|---|
| `/clear` | none | Reset current session in place after confirmation. |
| `/rename [label]` | optional | Rename current session, or open rename dialog when no label is provided. |
| `/stop` | none | Cancel the active turn for the current session. |
| `/cancel` | none | Alias for `/stop`, retained for compatibility with current composer behavior. |
| `/delete` | none | Open double-confirm delete flow for the current session. |

## `/clear`

The command resets the current session in place:

- Preserve: session id, workspace binding, cwd, model, approval mode, attached
  executor identity, and session label unless explicitly renamed elsewhere.
- Clear: transcript messages, pending tool calls, todos, memory state, token
  usage, streaming text, queued messages, compaction status, cached session view,
  attention timeline, and context usage snapshot.
- Abort: in-flight LLM stream and pending tool executions before applying clear.
- Result state: session becomes `idle` and ready for a new user message.

No new session appears in the explorer. The focused session remains focused, but
the transcript area shows the cleared empty state.

### Clear UX

When the session is idle or done, `/clear` can execute after lightweight
confirmation:

```text
Clear this session?
This removes the transcript and runtime state but keeps the session, workspace,
model, and approval mode.
```

When the session is running, executing `/clear` is destructive to current work.
It should require stronger confirmation:

```text
Clear and stop this running session?
The current LLM stream and pending tools will be cancelled before the session is
reset.
```

Inline args are rejected:

```text
Usage: /clear
```

Reason: in-place clear and rename are separate operations. Overloading
`/clear <name>` to also rename the current session makes the command less
predictable.

### Clear Implementation

Keep the existing protocol and kernel event:

```ts
type ClearEvent = { kind: 'clear' }
type ClientClear = { sessionId: string }
```

Implementation flow:

1. Composer parses `/clear` and routes it to the command handler.
2. Handler rejects non-empty args.
3. Handler opens a confirmation dialog; copy depends on whether the current
   session is running.
4. On confirm, dashboard deletes local cache for the session and emits
   `client:clear`.
5. Host cancels pending tools and stream, then dispatches `{ kind: 'clear' }`.
6. Dashboard receives `event:appended` for `clear`, clears derived UI state, and
   shows the empty transcript for the same focused session.

## `/rename`

The command targets the currently focused session.

```text
/rename
/rename new session label
```

Behavior:

- `/rename` opens a compact rename dialog prefilled with the current display
  label. If there is no explicit label, prefill with the current visible title
  but make it clear that saving creates an override.
- `/rename <label>` trims the label and emits `client:rename_session` directly.
- `/rename --clear` clears the explicit label by emitting an empty label.
- A whitespace-only label from the dialog is treated as clear-label, matching the
  existing wire semantics.
- Rename is allowed while the session is running because it only changes metadata.

No confirmation is required. A short toast or inline status should confirm the
new label after the host broadcasts the refreshed session list.

Implementation should reuse the existing `renameSession()` dashboard helper and
Explorer/session metadata rename behavior. The command must not create a second
rename code path.

## `/stop`

The command targets the currently focused session's active turn.

```text
/stop
```

Behavior:

- If the session is `thinking`, `executing_tools`, `awaiting_approval`, or waiting
  for a just-submitted message ack, `/stop` emits `client:cancel`.
- If the session is idle/done/error with no active turn, it shows a non-modal
  message such as "No running turn to stop" and does nothing.
- It should be an alias for the same handler as the visible composer stop button.
- The existing `/cancel` command can remain as an alias, but `/stop` should be the
  operator-facing command name.

This intentionally differs from Codex. Codex uses `/stop` for background
terminals, but this dashboard already has explicit background shell controls and
users expect a composer stop command to stop the active agent.

Background shell cleanup should be a later, explicit feature:

```text
/stop-shells
```

That command should require a `bg:kill_all` or repeated `bg:kill` design and is
out of scope for the initial `/stop` implementation.

## `/delete`

The command targets the currently focused session.

```text
/delete
```

Delete is destructive and must be double-confirmed. The flow should reuse the
same descendant counting used by Explorer deletion.

### Delete Preflight

Before opening confirmation UI, compute:

- session label and short session id;
- whether the session is currently active/running;
- descendant count through `parentSessionId` links;
- whether any descendant appears active/running;
- whether the target is the currently focused session.

If no active session is focused, `/delete` is unavailable and should not appear in
the command list.

### First Confirmation: Scope

The first dialog explains what will be deleted and asks for scope.

No descendants:

```text
Delete this session?
This permanently removes the session log and related runtime artifacts.
```

With descendants:

```text
Delete this session?
This session has N child sessions. Choose whether to delete only this session or
delete the full child session tree.
```

Actions:

- Cancel.
- Delete only this session.
- Delete session and N children. Only shown when descendants exist.

No action in this first dialog performs deletion. It only records the intended
scope and moves to the second confirmation.

### Second Confirmation: Irreversible Action

The second confirmation requires an explicit typed phrase:

```text
Type DELETE <short-session-id> to confirm.
```

For cascade deletes, the dialog must include the total count:

```text
This will permanently delete M sessions.
Type DELETE <short-session-id> to confirm.
```

If any selected session is active/running, the dialog must also say that active
turns will be stopped before deletion.

Only after the phrase matches exactly should the dashboard call:

```ts
deleteSession(controlSocket, sessionId, { cascade })
```

### Delete Runtime Semantics

Host-side deletion should cancel active runtime before removing storage. The
current host path deletes storage and lifecycle artifacts; the final
implementation should make runtime cancellation explicit for the root and any
cascade descendants before unlinking logs:

1. cancel active stream/tools for each target session;
2. run existing `onSessionDeleted` hook;
3. delete overflow artifacts;
4. delete session log/store record;
5. emit `server:session_deleted` for each target;
6. broadcast refreshed sessions list.

Dashboard behavior after deleting the focused session:

- clear focus to no session;
- do not auto-focus the next session;
- close metadata/cwd/dialog state;
- invalidate session-view cache for all deleted ids;
- leave Explorer visible so the user sees the updated tree.

## Shared Acceptance Criteria

- `/clear` appears in slash menu and never submits as a normal user message.
- `/clear anything` shows usage error and does not clear.
- Idle clear preserves session id, workspace binding, cwd, model, and approval
  mode.
- Idle clear removes visible transcript, pending approvals, context usage,
  attention timeline, streaming text, and cached session view.
- Running clear requires stronger confirmation and cancels active stream/tools
  before reset.
- A second dashboard tab updates to the cleared empty state after the event.
- Reloading the dashboard after clear does not show pre-clear messages as the
  active transcript.
- Event-log replay treats `clear` as a reset boundary.
- `/rename <label>` emits `client:rename_session` and updates Explorer/session
  header after host broadcast.
- `/rename` opens rename UI; empty dialog submission clears the explicit label.
- `/rename --clear` clears the explicit label.
- `/stop` reuses the visible stop button's cancellation path and never targets
  background shells in the initial implementation.
- `/stop` on an idle session shows a non-modal no-op message.
- `/delete` never runs from a prefix abbreviation such as `/del`.
- `/delete` requires two confirmations; the second requires typing
  `DELETE <short-session-id>`.
- `/delete` with descendants offers explicit scope selection before the second
  confirmation.
- Deleting the focused session leaves no session focused and does not auto-focus
  the next row.
- Multiple dashboard tabs receive delete/rename/clear updates through existing
  control/session events.

