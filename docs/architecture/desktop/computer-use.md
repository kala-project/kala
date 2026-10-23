# Real-desktop computer use

## Scope and trust boundary

The Computer tab shares the Executor machine's **existing, logged-in desktop**.
It does not create a replacement display, browser sandbox, or HTML reverse proxy.
Opening an installed browser therefore uses that machine's network, cookies and
browser profile. Other desktop applications are equally accessible.

The native backends are Windows x64 (Windows PowerShell 5.1, .NET, UI Automation
and user32) and Linux X11 (OS-vendor `xdotool`, `scrot >= 1.7` and optional
`python3-pyatspi`). Wayland, macOS, mobile
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

The `computer_use` Agent tool exposes `status`, `observe`, `act`, `batch`,
`screenshot`, and `input`. Prefer structured workspace tools for file, Git and
terminal tasks. For GUI tasks, choose the appropriate observation backend:

| Backend | Observation and control | Availability |
| --- | --- | --- |
| `browser` | Chromium accessibility snapshots and element actions using pinned upstream Puppeteer/CDP | Explicit owner-configured local browser attachment |
| `desktop` on Windows | Foreground-window UIA tree and Invoke/Value/Toggle/SelectionItem patterns | Unlocked interactive user session |
| `desktop` on Linux | Active-window AT-SPI controls and Action/EditableText/Selection interfaces | Same X11 session and session bus; OS-vendor `python3-pyatspi` |
| Visual | PNG snapshots and native physical keyboard/mouse | Existing Windows/X11 native requirements |

`observe` returns at most 64 elements, each with a scoped `ref`, role, name,
enabled state and supported actions. Names are bounded; form values are not
returned. An optional `query` filters names. `truncated` explicitly signals
incomplete observations; Linux/Windows tree traversal also stops after 512
controls. Inaccessible/custom controls require visual observation rather than
guessed element references. An unavailable semantic backend reports an error,
never silently switches desktops or launches another browser.

`act` requires the latest `snapshotId` and 1..8 actions. References expire after
30 seconds and are invalid after a new observation, document navigation,
physical panel input, takeover or revocation. Native actions verify the current
foreground window and control identity/state; browser actions resolve the
original DOM node and recheck its accessible name, role and availability.
Ambiguous Linux active windows fail explicitly, rather than selecting a window
manager's active decoration. Password controls cannot be filled semantically.
The operations are not transactions: completed side effects are not rolled back.
On the first error the batch stops and reports the failed index and skipped
count. Do not retry an unknown external side effect blindly.

A successful semantic batch returns a fresh observation in the same tool call.
A visual `batch` executes 1..8 native actions and returns a single final
screenshot. Small batches reduce model round trips without hiding failures.
Fresh state is evidence for the model to inspect, not a guarantee that an
application completed an asynchronous server-side operation.

Windows runs one warm native PowerShell/.NET worker per interactive driver,
compiling its fixed bridge once, rather than once per screenshot or keypress.
Accessibility uses the native UI Automation COM interfaces. Their interop
metadata is generated in memory from the inbox `UIAutomationCore.dll` type
library; no downloaded interop assembly or extra SDK is required. This avoids
the incomplete control patterns observed with the older managed UIA client
on the isolated Windows target.
Requests and responses use bounded JSON-line framing, not generated scripts.
The bundled bootstrap is sent separately from request data to avoid the Windows
command-line length limit. Linux starts a warm AT-SPI worker on demand.
Cancellation/timeouts terminate the exact worker and await its exit before
allowing another native call; interrupted inputs are released separately.
Workers never replay an interrupted action after restart.

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

### Attaching an existing browser

The machine owner sets `KALA_COMPUTER_BROWSER_ENDPOINT` in the **interactive
Executor or companion** environment before starting it. It accepts an HTTP root
such as `http://127.0.0.1:9222/`, or an explicit
`ws://127.0.0.1:<port>/devtools/browser/<id>` endpoint. Only canonical IPv4
loopback endpoints are accepted. There is no remote-CDP, wildcard binding,
port scanning, profile copying or automatic browser launch.

The browser must already expose that endpoint through an owner-approved
debugging setup. Kala attaches to its existing pages and does not replace its
profile, cookies or network context. The Agent first calls
`{"operation":"observe","backend":"browser"}` to list up to 32 tabs, then
observes a chosen `tabId`. Disconnect/Stop detaches automation without closing
the user's browser. All browser operations pass through the same desktop lease,
Agent-consent and companion-claim gates; Windows lock checks also apply.

This is not a browser security sandbox: a debugging endpoint can grant broad
profile access to other local processes. Do not expose it to the network.
Modern Chrome restricts command-line remote debugging of its default user-data
directory. This implementation does not bypass that restriction, implement the
Playwright extension, or implement Chrome's permission-dialog `autoConnect`
protocol. An arbitrary regular browser is not automatically attachable.

The user's panel preview remains a separate bounded snapshot channel. Agent
semantic observations do not require preview screenshots. This release does not
introduce video/WebRTC streaming or claim that AT-SPI solves Wayland capture.

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
- [Anthropic browser-use documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)
- [Chrome DevTools existing-browser attachment](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md)
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Microsoft UFO hybrid desktop architecture](https://github.com/microsoft/UFO/blob/main/ufo/README.md)

Browser CDP supplements native desktop control; it does not substitute for
controlling other real desktop applications.

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

### Hybrid backend checks

`scripts/product-e2e/fixtures/hybrid-desktop/` contains GTK3 and WinForms
fixtures and a platform-neutral TypeScript probe. Use only an explicitly
acknowledged disposable desktop (`KALA_HYBRID_ISOLATED=1`) and a new
`kala-clean-hybrid-*` directory. Start the fixture as the logged-in desktop user,
then bundle/run `probe.ts` with that directory as its argument. On Linux the
fixture additionally needs the OS-vendor `gir1.2-gtk-3.0` package and both
processes must share the desktop's session bus. Windows fixture/probe acceptance
must also run with a normal interactive token, not Session 0.

The probe checks actual native semantic text entry and button invocation by
reading the exact UTF-8 output written by the application, plus real private
companion IPC, denied pre-consent access, stale refs, halt-on-error batches,
manual takeover, Stop and visual fallback. It records cold/warm status,
observation, action and screenshot timings in `report.json` and captures
`desktop.png`. These timings exclude model inference and are not general
performance guarantees.

The 2026-10-24 isolated Linux X11/GTK and Windows 11/ordinary WinForms runs
passed these native, companion and consent checks, including exact Unicode file
effects. Windows ran with a normal Medium-integrity interactive token. A
separate genuine Windows lock/unlock check warmed the same native worker and
UIA client before locking: status, capture, physical input, desktop observation,
cached UIA actions and browser attachment were denied while locked. Normal
test-user console unlock restored observation on that same driver/client, and
worker cleanup completed. This is not a mock lock-state test.

In those fixture runs, Linux observation/action/capture took 121/48/83 ms.
Windows took 1541/1272/105 ms, with a 3383 ms cold status followed by 4..5 ms
warm status calls. Action timings include the returned fresh observation.
These are single-target measurements, not latency thresholds or model reasoning
benchmarks. The hybrid checks do not replace the full Host transport and
Dashboard acceptance described above.

The real-browser regression in `browser-driver.test.ts` runs when `CHROME_PATH`
names the approved test browser. It starts an independent fixture browser,
establishes an existing cookie/session before Kala attaches, verifies real AX
actions and an HTTP submission, and checks stale refs and non-destructive
detach. Without `CHROME_PATH` that real-browser case is explicitly skipped.
