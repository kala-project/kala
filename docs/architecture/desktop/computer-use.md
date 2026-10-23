# Real-desktop computer use

## Scope and trust boundary

The Computer tab shares the Executor machine's **existing, logged-in desktop**.
It does not create a replacement display, browser sandbox, or HTML reverse proxy.
Opening an installed browser therefore uses that machine's network, cookies and
browser profile. Other desktop applications are equally accessible.

The native backends are Windows x64 (Windows PowerShell 5.1, .NET and user32) and
Linux X11 (OS-vendor `xdotool` and `scrot >= 1.7`). Wayland, macOS, mobile
platforms, locked Windows desktops, secure/UAC desktops and direct Windows
Session 0 capture are unavailable, with explicit errors. There is no fallback
to a different desktop or pipe-backed substitute.

Computer access has two independent gates:

1. The machine owner opts in locally with `KALA_COMPUTER_USE_ENABLED=1`.
2. An authenticated Dashboard user explicitly consents in the Computer panel.

The Host checks tenant, workspace and session access, channel subscriptions,
read-only policy and active Runtime ownership. The Executor issues a random
30-second lease bound to that session and the actual Dashboard socket ID.
Only the Dashboard can renew it; screenshots and Agent calls cannot.
Authenticated renewal does not wait behind native capture/input work, so a slow
desktop cannot starve a visible controller's heartbeat.
Competing sessions/connections cannot share a controller lease.

Agent control is a separate, initially unchecked permission. The Agent tool cannot
grant, renew or restore permission. The internal management RPC requires a
Host-origin marker constructed by the Host, never model arguments. Normal tool
approval policy still applies. Granting desktop control does not authorize
purchases, destructive actions, credential entry or other external side effects.
These are protocol controls, not an operating-system sandbox. Desktop access can
operate terminals and other applications with the logged-in user's authority;
workspace filesystem restrictions do not isolate that desktop.

## Input, observation and revocation

The panel refreshes screenshots only while sharing is active and visible.
Observation uses bounded PNG snapshots at most once per second; native capture
can be slower. This is not a video stream. The expanded view is a separate
accessible dialog, including when opened from the mobile inspector drawer.
It supports mouse movement, clicks, double clicks, right clicks, drags, wheel
scrolling, keyboard shortcuts and a Unicode/IME-safe text entry field.
Each text request is limited to 512 UTF-16 code units so paced X11 Unicode input
fits within the native operation timeout; text travels on stdin, not process argv.
Coordinate conversion accounts for image scaling and negative monitor origins.
Remote Tab has an explicit button so local keyboard navigation remains possible;
Enter and Escape reach the desktop rather than dismissing the enclosing drawer.

Manual input from the Computer panel pauses Agent control and takes over the
existing lease without cancelling the user's in-flight screenshots. Agent and
user operations have separate cancellation scopes; local physical input is not
automatically monitored. Stop,
disconnect, tab changes, backgrounding the page and lease expiry revoke access.
Revocation aborts active operations and releases held input. Cleanup failures
make the connection unavailable instead of reporting success.
Graceful shutdown releases synthesized input. Abrupt OS/process termination
cannot guarantee cleanup; local input or restarting the desktop may be needed.

The Executor serializes native operations and bounds its queue. Native commands
use argv/stdin, never user-generated shell command strings, with timeouts and
bounded output. Requests have bounded schemas and replay detection. A repeated
input request is not executed twice, and reuse of an ID with different arguments
is rejected. Screenshot payloads are capped below the existing Socket.IO packet
limit; oversized images fail explicitly.

The `computer_use` Agent tool exposes `status`, `screenshot`, and `input`.
Native PNG observations are converted into actual image blocks for Anthropic,
OpenAI and Copilot SDK adapters, not base64 text. OpenAI image observations follow
all contiguous parallel tool results so call/result ordering remains valid.
Screen content is untrusted data, not authority to issue instructions.
Context estimates account for image dimensions; compaction omits old image bytes
and requires a fresh authorized screenshot before further input.

Manual screenshots are transient: no desktop screenshot files, clipboard
transport or completed-call cache. Operational audit records contain operation,
input type and authorization state, not typed text or screenshot bytes.
Agent screenshots and input remain conversation/tool data and can be retained
in session history and Executor receipts; the consent text explicitly explains
model transmission and conversation retention. Never share a desktop containing
unrelated private information.

## Windows services

A Windows service is not the user's desktop. Running capture in Session 0 or
silently changing the service account is not a solution. A per-user companion
must run in the explicitly consenting user's interactive desktop session.
The native backend also requires WTSInfoEx to identify that same session as
active and explicitly unlocked. Checking only WTSActive or the input desktop's
name is insufficient: Windows can keep both unchanged after locking. Unknown
or unreadable lock state fails closed; the existing input-desktop checks still
reject secure and non-default desktops.
The service uses authenticated, local-only IPC to that companion; it does not
receive a generic command execution endpoint or launch an elevated user desktop.
Windows uses TCP bound explicitly to `127.0.0.1:0`, publishing only the assigned
`tcp://127.0.0.1:<port>` endpoint in its private config. The proxy accepts only
that canonical IPv4 loopback form; remote/wildcard addresses, hostnames and old
named-pipe endpoints fail closed. There is no SMB named-pipe fallback. Linux
continues to use its private owner-only Unix-domain socket. All responses require
the random token; screenshots and input additionally require the exclusive
connection-bound claim. Loopback reachability alone does not authenticate a client.
The companion secret is restricted to that user and SYSTEM, and separate
Executors cannot simultaneously claim the same companion.

## Prior art

The design follows the observation/action/verification loop of public computer
use implementations, without copying unofficial Claude source collections:

- [Anthropic computer-use documentation](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool)
- [OpenAI computer-use guide](https://platform.openai.com/docs/guides/tools-computer-use)
- [Browserbase Live View](https://docs.browserbase.com/features/session-live-view)

Browser-only CDP and embedded proxy WebViews remain distinct features: they
cannot substitute for controlling an existing real desktop.

## Acceptance requirements

Run platform acceptance on disposable, clean Linux and Windows machines, never
on the deployed production Executor. Verify actual desktop screenshots and
physical application input, Unicode, Enter/Escape, pointer scaling, drag/scroll,
consent, competing controllers, pause/takeover, timeout and disconnect cleanup.
Also exercise the complete Host/Executor transport and browser UI. Unit tests,
mocked native command runners and PowerShell-on-Linux are not evidence of
Windows desktop or Windows service support.

### Reproducible product checks

Provision an isolated Host and an actual desktop Executor first, using a fresh
`kala-clean-*` Workspace. Keep the Host bearer token and origin in a private
JSON file with `token` and `origin` fields; never commit that file. Enable desktop
access locally as described in the Executor README. Windows service testing
must use the real WinSW service and a separate interactive companion, not a
service-account desktop substitute.

Run `scripts/product-e2e/verify-computer-use.mjs` with these environment variables:

| Variable | Purpose |
| --- | --- |
| `PRODUCT_E2E_COMPUTER_ISOLATED=1` | Explicitly acknowledges the disposable target |
| `PRODUCT_E2E_COMPUTER_CONFIG` | Private credentials JSON path |
| `PRODUCT_E2E_COMPUTER_WORKSPACE` | Fresh `kala-clean-*` Workspace name |
| `PRODUCT_E2E_COMPUTER_CWD` | Target-machine fixture directory |
| `PRODUCT_E2E_COMPUTER_ACTIONS` | Optional JSON array of real native actions and file assertions |
| `PRODUCT_E2E_EVIDENCE_ROOT` | Private evidence output directory |

Physical acceptance must use freshly created fixture output paths. In addition
to native input actions, the action file accepts
`{"kind":"assert-file","path":"...","base64":"..."}` for exact bytes or
`{"kind":"assert-file","path":"...","contains":["..."]}` for event logs.
These assertions read the actual target files through the Executor; echoed
commands and successful input acknowledgements are not proof of application input.

The reusable Windows fixture is in
`scripts/product-e2e/fixtures/windows-desktop/`. Copy that directory to the
disposable Windows target and use `manage-fixture.ps1 -Action start` with
`-ExpectedComputerName` explicitly pinned to that VM, `-AllowIsolatedDesktopTest`,
and a new private `-Root` inside the test Executor's workspace. It launches the
WinForms application with the logged-in user's Medium integrity token, not the
service's SYSTEM token. On the controller, generate the UTF-8 action JSON with
`node scripts/product-e2e/fixtures/windows-desktop/physical-actions.mjs`.
Set `PRODUCT_E2E_COMPUTER_ACTIONS` to that JSON and
`PRODUCT_E2E_COMPUTER_CWD` to the fixture's Windows `-Root`.
Immediately after the transport check stops its lease, run the fixture manager
with `-Action verify` and the same target/root arguments. The last action
intentionally holds the left mouse button: verification requires actual release,
balanced mouse events, exact 512-unit Unicode text, and Enter/Escape events.
Use `-Action stop` afterward; `-Action clean` additionally removes only the
recognized, private fixture files.

After completing the positive checks, lock the disposable target through its
normal console. Run the native checker in `locked` mode from its existing
interactive session: it must reject status availability, screenshot capture,
and pointer input. Unlock normally with the test user's credentials and repeat
the `status` check. Do not substitute a mock connection state or a non-default
test desktop for a genuine Windows lock.

For the image-provider check, point the isolated Host's Anthropic-compatible
endpoint at `scripts/product-e2e/fixtures/computer-use-provider.mjs` and set
`PRODUCT_E2E_COMPUTER_MODEL=1`. This controlled provider verifies an actual PNG
image block, including payloads above the ordinary text-result cap. It does not
assert real-model reasoning quality.

After a successful transport run, run
`scripts/product-e2e/verify-computer-use-browser.mjs` with the same credentials,
`CHROME_PATH` pointing to the approved test browser, and
`PRODUCT_E2E_COMPUTER_TRANSPORT_REPORT` pointing to `transport-report.json`.
The browser check exercises explicit consent, decoded images, physical
coordinate mapping, manual takeover, revocation and nested desktop/mobile
dialogs without mocked backend responses. CDP composition checks elsewhere
do not establish native operating-system IME support.
