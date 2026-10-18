# Bang Shell command: design and usage

## Product contract

Bang Shell lets an operator run one foreground command from the Session Composer without immediately sending anything to the agent.

1. Typing `!` as the first character of an empty draft enters amber **Shell · workspace** mode.
2. The Composer consumes the trigger. The input contains only the command, never the leading `!`.
3. Execute runs the command in the Session workspace and current working directory.
4. The command and its stdout, stderr, exit code, duration, and execution error are returned to the Composer as an ordinary, editable draft.
5. Execution exits Shell mode. Nothing is added to the transcript or Session message queue, and the agent is not started.
6. The operator may edit the draft and press Send. Only that second, explicit action creates a user message and gives the text to the agent.

Shell execution and user-message delivery are intentionally separate actions.

## Entering and leaving Shell mode

- The trigger is recognized only at the beginning of an empty ordinary draft. Leading whitespace keeps `!` as ordinary text.
- Pasting a value beginning with `!` also enters Shell mode and consumes exactly the first character.
- **Exit shell mode and keep as text** restores the consumed `!`, allowing literal messages such as `!important`.
- The unsent command and its Shell-mode intent are stored per Session. Switching Sessions does not reinterpret the command as ordinary text.
- Shell mode does not accept attachments or file mentions.
- Empty commands are rejected. Command input is limited to 16 KiB of UTF-8.

## Execution boundary

The Dashboard uses the existing authenticated `workspace:exec` channel. It invokes the platform shell with the command on standard input:

- POSIX workspaces: `/bin/sh -s`
- Windows workspaces: non-interactive PowerShell with `-Command -`

Passing the command on standard input also keeps its contents out of the bounded `argv` audit metadata. The workspace execution request still records its executable shape and working directory.

Execution requires a live workspace bound to the selected Session. The command runs at the Session's current `cwd` and has the same filesystem and operating-system permissions as other workspace execution. It can modify or delete workspace data and start processes. This feature adds no sandbox or transactional rollback beyond the configured Executor boundary.

The execution request uses a 30-second command timeout, a 32-second acknowledgement timeout, and a 64-KiB output budget. Truncation and execution errors are shown in the returned draft rather than converted into a sent message.

## Result draft

The returned text contains one copy of the command followed by exit status and output sections. Markdown fences expand when necessary so command or process output containing backticks cannot break the draft structure.

The result is deliberately plain user-authored draft text. There is no Shell queue card, optimistic user-message placeholder, pending delivery animation, transcript event, or automatic agent continuation. Only the normal Send action admits the final draft through the reliable message-delivery path.

## Compatibility

The Host retains parsing and recovery support for shell items already persisted by older Dashboard versions. New Dashboard execution does not create those queue records or use `intent: "shell"` message admission.
