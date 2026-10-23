# @agent-kernel/executor

The **tool runner**. A Node daemon that dials *out* to Host over Socket.IO; no inbound port required.

---

## Why "reverse-WebSocket"?

The Executor runs where the *files* live — usually behind a home router or corporate firewall — while Host lives in the cloud. So the Executor initiates the connection *outward* to Host. See [ADR 0002](../../docs/architecture/adr/0002-reverse-websocket.md).

Consequence: no port forwarding, no ngrok, no VPN. Just:

```bash
kala-executor --host=http://localhost:3000 --sandbox-root <workspace-root>
```

By default, one local executor profile maps to one workspace identity and one
single-instance lock. Use an explicit profile when a development machine must run
a test executor beside a release executor:

```bash
kala-executor --host=http://localhost:3000 --profile dev --sandbox-root <workspace-root>
```

Named profiles store their lock, `workspace-id`, and executor token under
`~/.kala/profiles/<profile>/`. The default profile continues to use the
legacy `~/.kala/` files.

## Responsibilities

1. **Tool registry** (`src/tools/`) — one file per tool from [`docs/reference/executor/tools.md`](../../docs/reference/executor/tools.md): `read_file`, `read_files`, `ls`, `glob`, `grep`, `write_file`, `replace_in_file`, `replace_many_in_file`, `apply_file_patch`, `bash`, `memory`, `websearch`, `webfetch`, `bash_output`, `kill_shell`.
2. **Sandbox** (`src/sandbox.ts`) — workspace whitelist. Every path is resolved and rechecked to prevent escape via `..`, absolute paths, or symlinks.
3. **Background shell registry** (`src/background.ts`) — `bash --run-in-background` → `taskId`; `bash_output`; `kill_shell`.
4. **Socket.IO client** (`src/client.ts`) — dials Host's `/executor` namespace; announces `workspaceId` / `workspaceName` / `os` / `runtime` / `sandboxRoots` / tool names; handles `tool:call` / `fs:list_dirs` / cancel; auto-reconnects and re-announces.

## What it does NOT do

- Contact any LLM.
- Persist session state — Host owns the JSONL log.
- Decide whether a tool call needs user approval — that's Host + Dashboard's decision; Executor just runs what Host dispatches.
- Host the `agent` builtin — that's host-side (see [ARCHITECTURE.md](../../docs/architecture/overview.md)); it does not appear in the executor tool registry.

## Public entry points

```typescript
import { startExecutor } from '@agent-kernel/executor'

await startExecutor({
  host: 'http://localhost:3000',
  sandboxRoots: ['<workspace-root>'],
  token: process.env.EXECUTOR_TOKEN,
})
```

## Real-desktop computer use

Desktop access is disabled by default. It requires local machine opt-in **and**
explicit Dashboard consent for a short-lived, session-bound lease. Agent control
is a separate permission. Stop sharing or close the Computer tab to revoke it.

For an Executor already running in the logged-in Linux X11 desktop, install
`xdotool` and `scrot >= 1.7` from the operating-system vendor, then start that
Executor with `KALA_COMPUTER_USE_ENABLED=1`. Preserve the user's `DISPLAY` and
`XAUTHORITY`; do not start a substitute display. Wayland is not supported.
For semantic native controls, also install the OS-vendor `python3-pyatspi`
package and preserve the logged-in desktop's `DBUS_SESSION_BUS_ADDRESS` and
`XDG_RUNTIME_DIR`. Missing accessibility support produces an explicit error;
visual control remains available.

Windows service processes run in Session 0 and cannot directly control a user's
desktop. Start the local companion as the **normal logged-in desktop user**, not
as a service or another elevated account:

```powershell
kala-executor desktop serve
```

The command prints the location of its private connection file, not its secret.
Configure the service's environment with `KALA_COMPUTER_USE_ENABLED=1` and
`KALA_COMPUTER_USE_COMPANION_CONFIG=<that absolute file path>`, then restart the
service. Keep the companion running in the interactive user session. A custom
`--config` path must be inside a dedicated private directory, not an existing
general-purpose folder. Its ACL grants access only to that user and SYSTEM.
The same companion command can bridge a Linux service to a user's X11 desktop.

Never send the connection file to another person or include it in diagnostics.
Local IPC only exposes validated desktop operations, not arbitrary shell commands.
On Windows the companion binds an ephemeral TCP port exclusively on IPv4
`127.0.0.1`; its private connection file contains `tcp://127.0.0.1:<port>` and
a random authentication token. Wildcard/remote addresses, hostnames, IPv6 aliases
and named-pipe endpoints are rejected, with no pipe fallback or SMB transport.
Every response requires token authentication; screenshots/input also require the
exclusive socket-bound claim. Other local processes can reach the TCP port but
cannot use it without the secret. Linux retains its owner-only Unix socket.
Gracefully closing the companion, losing its client connection, or expiring its claim releases
input and prevents further control. A locked/secure Windows desktop is rejected.
Abruptly terminating the companion cannot guarantee synthesized input cleanup.
User screenshots may contain secrets; Agent observations are sent to the model
and retained as conversation/tool data. Do not share unrelated private windows.

Agents can use bounded native accessibility observations/actions (Windows UIA
or Linux AT-SPI), with screenshots/native input for inaccessible controls.
Windows keeps its native bridge warm instead of starting/compiling it per action.
Semantic and visual action batches stop at the first error and return a fresh
observation after success. Existing workspace tools remain preferable for
non-GUI tasks.

For an explicitly approved, already-running Chromium browser, set
`KALA_COMPUTER_BROWSER_ENDPOINT=http://127.0.0.1:<debug-port>/` or its canonical
loopback browser WebSocket endpoint in the interactive Executor/companion
environment. Kala uses pinned upstream Puppeteer/CDP, never downloads a browser
or launches a replacement profile, and detaches without closing existing tabs.
The browser must already permit debugging; default-profile restrictions are
not bypassed. There is no browser extension or automatic port discovery.
Keep debugging local: other local processes may control a browser exposing an
unauthenticated debugging endpoint. Browser observations/actions require the
same active desktop lease and separate Agent consent as native control.

See [computer-use architecture](../../docs/architecture/desktop/computer-use.md)
and [wire protocol](../../docs/protocol/wire-protocol.md).

## References

- Tool contracts: [`docs/reference/executor/tools.md`](../../docs/reference/executor/tools.md)
- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)
- Architecture: [`docs/architecture/overview.md`](../../docs/architecture/overview.md)
- Spec: [`docs/reference/kernel/spec.md`](../../docs/reference/kernel/spec.md)

## Test coverage target

≥90% (per [`docs/standards/release-quality/testing.md`](../../docs/standards/release-quality/testing.md) §4). Each tool has a test file covering happy path, missing file, permission denied, invalid schema, idempotency where relevant, and tool-specific edge cases. Sandbox has its own dedicated test suite for path-escape attempts.
