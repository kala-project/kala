# Session regression coverage

**Status:** normative release checklist
**Scope:** regressions raised during the multiplexed connection, terminal, installer, and PWA work

A release is not accepted from component rendering alone. Each row requires the narrow automated test plus the real-browser or process proof shown below.

| Regression / invariant | Automated proof | Browser / process proof |
|---|---|---|
| One physical Dashboard socket per browser tab; Session switching only changes logical channels | `dashboard-connection-manager.test.ts`, `session.test.ts`, Host dashboard namespace tests | switch repeatedly across same/different Workspaces; CDP observes one WebSocket and no connection-indicator flash |
| Reconnect restores Global/Workspace/Session channels once; stale ACK and snapshots cannot overwrite newer state | manager, projection, cache and summary-store tests | network offline/online and rapid switching while a Session is running |
| Composer must not remain `waiting for host` after the physical socket and Session subscription are ready | `Composer.test.tsx`, session tests | send after cold load, switch, reconnect, and background/foreground |
| Files and Git subscribe after Workspace/Session readiness and render success/empty/error/retry | Files, Source Control, socket RPC tests | real sandbox and real Git repository on desktop, phone and iPad drawer |
| A running Session remains running in the Session list after selecting another Session; old snapshots cannot regress it | summary/projection tests | run one Session and switch between at least two others |
| Terminal accepts keyboard/touch input, Enter, resize, Ctrl+C, hide/show and Session switching | Dashboard terminal, Host routing, Executor terminal-manager/client tests | real Chromium keyboard; coarse-pointer touch keys; real Executor PTY output |
| Connect Workspace uses stable `/install` and `/install.ps1`, no secret in URL/command, one-use setup code, no default sudo | Host installation route/store tests, Dashboard dialog tests | desktop/phone/iPad geometry and copy; claim from external shell |
| Connect Workspace never overflows horizontally and all controls remain reachable above safe areas/keyboard | dialog component and mobile browser geometry tests | 320×568, 375×667, 390×844 PWA, 430×932 and 768×1024 iPad |
| PWA never serves stale HTML that references removed chunks | SW network-first and stale-preload tests; precache budget | install SW, deploy changed hashes, navigate/reload, open lazy Terminal/Files/Settings chunks |
| JS/chunk requests have JavaScript MIME; removed chunks return 404 rather than HTML | release static-asset test | production Host requests for entry and lazy chunks |
| Browser/Host connection, Workspace presence and Session synchronization remain distinct UI states | connection/session tests | Host online with Executor offline; reconnect; Session resync |
| Deployment does not terminate an unknown user Executor | deploy guard tests | observe PID before/after Host cutover; update Executor only through its supported updater/service path |

## Mobile/PWA acceptance

Every critical modal, drawer and panel must satisfy:

- bounding rectangle remains inside `visualViewport`;
- document has no horizontal overflow;
- form controls compute to at least 16 px on coarse pointers;
- primary controls are at least 44 CSS px where touch-operated;
- safe-area padding remains effective in standalone mode;
- focusing an input or xterm helper textarea does not hide the active control;
- switching browser/PWA background state does not duplicate sockets or subscriptions;
- dynamic imports recover from a stale worker without a permanent crash page.

## Release gate

The release gate is: focused unit/integration tests → package typechecks → production build → static asset/PWA checks → real desktop/mobile/iPad browser journeys → immutable deployment → online smoke against the selected real Executor. Any skipped real-device or Executor update check is reported as an explicit blocker, not a pass.
