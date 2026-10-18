# Linux desktop delivery evidence — 2026-09-12 UTC

## rc.5 public v1 candidate — built, installed, accepted and staged

The controlled locked build and installed-package acceptance are complete.
The new immutable package is staged in
`packages/dashboard/public/downloads/desktop/`; `release.json` points to rc.5.
Existing rc.4 package bytes remain unchanged. **Dashboard deployment and the
final browser-copied installer check remain the parent release owner's step.**

| Item | Value |
| --- | --- |
| Debian package | `agent-runlab-desktop_0.2.0~rc.5_amd64.deb` |
| Native source version | `0.2.0-rc.5` |
| Size | 2,175,328 bytes |
| Package SHA-256 | `668673585ce3cb3fa2d20646ca75009c82b352f1928d8a524e97d50a4cb6c512` |
| Installed executable SHA-256 | `e0898d1ba4afc80c0c184e5195e2c8ff1b265131154d9b2c5e72af6a9ba54d60` |
| Dependency metadata SHA-256 | `07640a98bd9772f122ec9d2016d1d3b1bb7b4306709578fcbef236bfe9eb8835` |
| Checksums file SHA-256 | `36e02855eb2b054766674586b7533b70d22ed742dde5e360c902c577b8d7831b` |

The owner-only controlled-build receipt and captured locks were transferred
through local LXD administration into the local `.build-provenance` registry
before staging. The actual package upgraded the builder from rc.4 using an
APT-readable `/tmp` path. This does not substitute for the parent's final
live-page copied-installer acceptance.

**9 locked release-mode Rust tests and 22 Node desktop/release tests passed.**
Both complete native acceptance scripts then passed against
`/usr/bin/agent-runlab-desktop` installed from the exact package above.
Genuine GNOME Shell 46.0 / Ubuntu AppIndicator 58 exercised the actual production
Dashboard and real isolated Host/Socket.IO, not a fake bridge. It includes
physical OS notification click routing, no document reload or lost per-session
draft, close/minimize taskbar withdrawal with process/tray retention, all three
native badge images, private notifications and sound hints, duplicate/rate/
invalid-input handling, selected and hidden-selected notification behavior,
single instance/canonical/cold links, persisted/maximized/offscreen geometry,
Dashboard-only unsigned-update UI, and all bridge methods denied on an actual
unselected HTTPS origin. Separate GTK download/cancel/shortcut/tray-loss
acceptance also passed.

The hidden-window blocker documented below is resolved by the shared
Dashboard's cancellable exactly-once frame/timeout scheduler. The final native
run explicitly reports `hiddenSelectedDashboardCompletionNotifies: true`.
Key-free evidence and screenshots are retained locally under
`packages/desktop/.artifacts/gnome-rc5-installed-final/` and
`packages/desktop/.artifacts/gtk-rc5-installed-final/`.
The builder remains **RUNNING** for the parent's installer handoff, with native
test processes stopped, no attached source devices, and temporary TLS trust
removed. No Dashboard deployment, backend restart or commit was made.

This remains **unsigned / security-review-required**. The strict glib
RUSTSEC-2024-0429 blocker and production signing/hosting requirements are
unchanged; functional acceptance is not production security approval.

## Historical public v1 preflight — hidden selected-session blocker, now resolved

The native acceptance scripts now consume the exact public
`window.__RUNLAB_DESKTOP_BRIDGE__` v1 API: `getInfo`, `setActivity`, `notify`
and `subscribe`. They no longer submit the obsolete strict `desktop_ui` payload
or require the Dashboard to consume internal native navigation events.
`packages/desktop/tests/native-dashboard-host.mjs` provides an isolated real
Host/Socket.IO fixture serving the actual production Dashboard, without
replacing the native bridge. The source executable now compiles and has been
exercised with that actual Dashboard under distribution GNOME Shell 46.0,
Ubuntu AppIndicator 58-1ubuntu24.04.1, and GNOME's actual separate freedesktop
notification daemon (`gjs`), inside the task-owned builder.

The genuine run passed close/minimize taskbar withdrawal, physical tray restore,
same-document/draft preservation, all three native badge images driven by real
Dashboard transitions, generic native approval/completion notifications,
physical notification click selecting the real Dashboard session without reload,
sound-hint controls, duplicate/rate/invalid-payload handling, repeated process
launch/canonical session links, cold-link routing, normal/maximized restart,
off-screen recovery, Dashboard-only unsigned-update dialog, and denial of all
three bridge methods on an actual unselected HTTPS origin. Separate GTK
save/cancel/shortcut and missing/unresponsive/lost tray-host probes passed.

**Failure reproduced before correction:** selected-session completion while the native
window is hidden does not notify. JavaScript timers and public native hidden
events continue running, but Dashboard `session.ts::enqueueProjection` queues
the selected session's `state:changed` behind `requestAnimationFrame`, which
WebKit suspends for the hidden document. `app.tsx` then overlays the stale
selected-session projection on the fresh control summary. The native tracker
still sees running, not completed. The fix belongs in Dashboard projection
scheduling: flush queued projection work while hidden and on transition to
hidden, without abandoning foreground frame coalescing. The acceptance script
records this as a fatal failure; it does not waive the requirement.

Builder evidence: `packages/desktop/.artifacts/gnome-v1-crossend-12/` and
`packages/desktop/.artifacts/gtk-v1-preflight/`. GNOME's test-only unsafe-mode
is used solely to inspect actor coordinates/banner identity; actual tray and
notification activation use physical X11 input. The unselected HTTPS fixture
uses a one-day test certificate trusted only in the disposable builder; its
temporary system trust entry is removed afterward. No production trust,
credentials, Host service or deployment was modified.

The operations guide now points to the one-copy automatic curl/temporary-path/
hash-verification/APT installation block, rather than requiring manual downloads
or embedding rc.4's current hash. Updates are documented as Dashboard-only.
The prior native preflight below used the old sink protocol; it is historical
and is **not** evidence that the public v1 cross-end or final rc.5 package passes.
At this preflight no rc.5 package had been built/staged; the run correctly failed
until the hidden-session correction described in the final delivery above.

## Expanded rc.5 old-protocol native preflight — historical, not a delivered package

Source/configuration is now **0.2.0-rc.5** because the rc.4 artifact is immutable.
No rc.5 `.deb` has been built or staged, and no Dashboard deployment was performed
by the native task. The latest staged native package remains rc.4 below.

The locked rc.5 preflight executable passed **9 Rust tests**, **15 targeted
Node desktop/release tests**, and two consecutive clean genuine GNOME Shell 46 /
Ubuntu AppIndicator 58 acceptance runs. These cover all original tray/taskbar
checks plus static activity badges, generic approval/completion OS notifications,
focused-session suppression, a physical notification click routing its session,
existing-instance launch/session links, cold links retained until connection,
normal/maximized placement across restart, off-screen recovery, and actual
new-version notices without repeated prompts for the same origin/version.
Unknown notification fields and remote connection/settings IPC remain denied.

The initial Dashboard is a monitor-bounded 1100×760 normal window, rather than a
nearly full-screen default that triggered Mutter's automatic maximization in
the small test display. Placement uses configure events for normal dimensions.
Cold-link routing navigates the newly created document without re-showing or
deiconifying that window, which otherwise raced restoration of maximized state.

Separate clean GTK acceptance passed native download save/cancel, existing
shortcuts, no-host fallback, temporary/prolonged tray-probe failures and real
host/item/watcher-loss recovery. No native TCP listener or Host/Runtime change
was introduced. Evidence is in
`packages/desktop/.artifacts/gnome-rc5-preflight/`,
`packages/desktop/.artifacts/gtk-rc5-preflight/`, and
`packages/desktop/.artifacts/rc5/`.

These tests exercise the native sink using a controlled remote-page fixture.
They do **not** establish that the independently developed Dashboard emitter
uses the same protocol. Combined bridge integration, final controlled package
build, installed-package rerun and staging remain required. See the exact narrow
public v1 contract in the operations document. Genuine GNOME testing is X11
in the isolated builder; Wayland placement remains best-effort, not verified.
The builder is running for coordinated installation validation, with test
processes stopped. Existing strict-audit/signing blockers are unchanged:
this remains an **unsigned / security-review-required candidate**.

## Real GNOME close-to-tray defect corrected — 2026-09-15 UTC

The user's report was reproduced with the **actual shipped rc.3 binary** in
**GNOME Shell 46.0 (Mutter 46.2) and Ubuntu AppIndicator extension
58-1ubuntu24.04.1**, installed from Ubuntu's distribution packages in the isolated
native builder. The icon was visible before close; closing exited the process
and emptied the real watcher's registered item list. This was a client bug, not
an assumption that the user's GNOME extension was missing.

**Proven cause:** the official extension's `util.js::indicatorId()` returns
`${busName}@${objectPath}` for AppIndicator path registrations. Its actual
`RegisteredStatusNotifierItems` value was
`:1.12@/org/ayatana/NotificationItem/tray_icon_tray_app_runlab`.
The rc.3 parser split at `/`, compared `:1.12@` to `:1.12`, and incorrectly treated
its visible tray as unavailable. The earlier fixture used only `bus/path`;
passing that fixture did **not** establish GNOME compatibility.

The new **0.2.0-rc.4 / 0.2.0~rc.4** handles GNOME `bus@/path`, KDE `bus/path`,
and service-only registrations resolved to the process's own bus owner. Host
confirmation is independent of optional menu-property lookup. Probe errors
retain recent confirmed support briefly instead of masquerading as absence;
prolonged uncertainty restores hidden windows and keeps close from silently
exiting, with a native explanation. Actual missing-host fallback remains safe.
No native menu bar, toolbar, remote privilege or new dependency was introduced.

* Package: `agent-runlab-desktop_0.2.0~rc.4_amd64.deb`, **1,673,420 bytes**.
* SHA-256:
  **`838ed7a40853258cc5c86606a6b7991789cd9eaeacae16224aa436630a3a010a`**.
* Dependency metadata SHA-256:
  `ec517f5af642fab34e1d22fe01b36ccce3362fdb2f8a69116d350f1362a90be6`.
* Checksum file SHA-256:
  `a9f252d5cc99c757c97a82f50b186233af9f153f1cff321d20b67cd7001b65c2`.
* Immutable metadata prefix:
  `0.2.0~rc.4-838ed7a40853258cc5c86606a6b7991789cd9eaeacae16224aa436630a3a010a`.

Controlled locked native build, actual `.deb` upgrade from rc.3, and installed
acceptance all completed. **18 Node desktop/release tests and 5 locked Rust
tests passed.** Genuine GNOME acceptance verified:

1. OS close hides the Dashboard while the process and visible tray remain.
2. The window disappears from the desktop **and Mutter's `_NET_CLIENT_LIST`**,
   the source of taskbar/window-switcher entries.
3. Physical click on the real GNOME panel icon restores the same window;
   document instance ID and edited draft are unchanged, with no page reload.
4. Actual GNOME minimize also withdraws the taskbar entry; native Open restores.
5. The real tray menu contains only Open Agent RunLab / Change server / Quit.
6. Change server opens the local launcher; Quit exits and removes the tray.
7. Disabling the real extension while hidden restores the window; re-enabling
   the extension recovers registration.

Separate installed GTK/D-Bus tests additionally cover transient/prolonged probe
errors, no-host close, host/item/watcher loss, remote IPC denial, native save/
cancel, reconnect/reload/quit shortcuts and no new TCP listener. These fixtures
supplement, rather than substitute for, the genuine GNOME test.

Reproduction: `packages/desktop/.artifacts/gnome-rc3-repro2/gnome-result.json`.
Final genuine GNOME result/screenshots:
`packages/desktop/.artifacts/gnome-rc4-installed/` (especially
`gnome-after-close.png` and `gnome-icon-restored-menu.png`).
Final fallback/error evidence: `packages/desktop/.artifacts/rc4-native-installed/`.
Build/test/staging logs: `packages/desktop/.artifacts/rc4/`.

This is a real GNOME Shell/extension running on isolated Xvfb/X11, not the user's
session and not a claim of Wayland/all-GNOME-version coverage. No Host/Runtime
service or shared installer template was modified. Rust dependencies are
identical to rc.3; existing strict-audit and signing/hosting blockers remain.
The package is still **unsigned / security-review-required**. Native staging
does not itself deploy the Dashboard; deployment is coordinated separately.
Fifteen preceding immutable package/metadata objects were checked byte-for-byte
unchanged. The task-owned native builder is stopped; no GNOME, WebKit, app or
Xvfb test processes, task mounts or test proxy remain running.

## Requested system tray follow-up — 2026-09-15 UTC

After the menu-free rc.2 candidate had been built and staged, the owner
explicitly requested minimize-to-tray. The immutable rc.2 package was therefore
preserved and the tray revision was released as **0.2.0-rc.3 / 0.2.0~rc.3**.
There is still no window menu bar, browser navigation UI or custom toolbar.

* Package: `agent-runlab-desktop_0.2.0~rc.3_amd64.deb`, **1,671,472 bytes**.
* SHA-256:
  **`6abdccc256bae6751a826e205364bd0ef13d626009be854b22850ea50885a0b7`**.
* Dependency metadata SHA-256:
  `47a65946e483542681ca32c7f1ff13d279edacc78287d4d7ff132067cfa87526`.
* Checksum file SHA-256:
  `0bbe3d7ba2c6fe06f13e9f31e3055b77e7d32159ed281238559f1bbb7fe66aff`.
* Immutable metadata prefix:
  `0.2.0~rc.3-6abdccc256bae6751a826e205364bd0ef13d626009be854b22850ea50885a0b7`.
  Existing stage script verified the controlled build receipt and staged the
  package and metadata under `packages/dashboard/public/downloads/desktop/`.
  Eleven previous immutable package/metadata objects remain byte-identical.

Official pinned **Tauri 2.11.5 `tray-icon`** provides only **Open Agent RunLab /
Change server… / Quit**. Close and native minimize hide windows only after a
session-bus watcher confirms an active host and this process's registered item.
Without tray support, close exits and minimize uses normal OS behavior. Losing
the host, watcher or item registration restores a hidden window visibly.
Native AppIndicator icon/menu activation restores the existing Dashboard without
a reload or session creation. Change server opens only the local launcher;
Quit and Ctrl+Q always terminate the process.

The existing GTK/GIO session-bus API observes only this app's native item/menu
activation (AppIndicator does not forward Linux clicks as Tauri TrayIconEvents).
No remote page IPC capability, network listener, plugin or browser bridge was
added. The icon was normalized from RGBA16 to RGBA8 as required by the official
tray implementation. Runtime packaging requires the distribution's
`libayatana-appindicator3-1`; the controlled builder additionally needs
`libayatana-appindicator3-dev` for Tauri's packaging detection.

All Rust dependency versions/checksums are identical to rc.2: the feature
activates already-locked `tray-icon 0.24.2` and `libappindicator 0.9.0`; no
downgrade or replacement GTK stack was introduced. A current strict audit reports
zero vulnerability-category entries, the same six unmaintained warnings and
**glib RUSTSEC-2024-0429 unsoundness**. Production remains blocked: the candidate
is **unsigned / security-review-required**, not production-approved APT.

**18 Node desktop/release tests and 3 locked native Rust tests passed.** The real
final `.deb` upgraded rc.2 in the isolated builder, then passed ordinary GTK/X11
and test-only native D-Bus watcher acceptance: no menu bar; local endpoint error;
remote IPC denial; save dialog/cancel; keyboard reconnect/reload/quit; no new
TCP listener; fallback close with no tray; registered close and native EWMH
minimize-state hide; icon/menu restore without reload; exactly three tray
actions; real Quit; host-loss, registration-loss and watcher-loss recovery.
No test-only native permissions or release binary flags were introduced.

Evidence/screenshots: `packages/desktop/.artifacts/rc3/` and
`packages/desktop/.artifacts/rc3-native-final/`. The test watcher uses an isolated
abstract Unix session bus, not a persistent service or public listener.
The builder is stopped and test processes are gone. Dashboard deployment
remains a separate coordinated step; this section records completed native
build, installation, testing and staging, not public deployment.

## Menu-free native candidate — 2026-09-15 UTC

The menu-free rc.2 native client had no application menu bar, Back action, external
browser action or replacement toolbar. OS window decorations remain enabled.
Native GTK input handles **Ctrl+Shift+O** (local connection screen), **Ctrl+R**
(Dashboard reload) and **Ctrl+Q** (quit). Normal close of either window exits;
there is no tray and closing the Dashboard does not resurrect the launcher.
The launcher is 560×430 with title, origin, Connect and inline validation;
security/usage explanations remain under collapsed **Help and shortcuts**.

* Source/Cargo/Tauri version: **0.2.0-rc.2**; Debian: **0.2.0~rc.2**.
* Package: `agent-runlab-desktop_0.2.0~rc.2_amd64.deb`, **1,570,816 bytes**.
* SHA-256:
  **`08a8cf916e7a1e8706c536a6c57915a9ddcead9f1bad191e74f3658a7d145fed`**.
* Dependency metadata SHA-256:
  `f2743b8768c5172e00e7b4c42be07710964565330a88dc6c7820bb5397fd1ef0`.
* Checksum file SHA-256:
  `286485b87bb5bae9432d8502dca9befa717a2b05c4fe71edb6815dd0b2678f94`.
* Metadata filenames use
  `0.2.0~rc.2-08a8cf916e7a1e8706c536a6c57915a9ddcead9f1bad191e74f3658a7d145fed`
  plus `.dependencies.json`, `.SHA256SUMS.txt` and `.release.json`.

Controlled frozen-pnpm/locked-Cargo build completed in the existing task-owned
Ubuntu builder. Trusted local provenance was transferred using local LXD
administration; the existing stage script verified it and staged the candidate
under `packages/dashboard/public/downloads/desktop/`. Five prior immutable
package/metadata files were verified unchanged. Debian ordering confirms rc.2
upgrades rc.1. Native build/stage is complete; Dashboard deployment is a
separate coordinated step, not asserted by this native evidence.

**17 Node desktop/release tests and 3 locked release-mode Rust tests passed.**
The final `.deb` was installed in the isolated builder and exercised through
ordinary real GTK/X11 input (no WebDriver-only binary). Verified: no visible
menu bar, collapsed/expanded launcher help, visible invalid-origin error,
native reconnect and reload, native save confirmation and cancel without a
file, remote IPC denial, synthetic remote keyboard events cannot reconnect,
desktop marker, no new listening TCP port, Ctrl+Q exit, and actual
WM_DELETE_WINDOW close for both Dashboard and launcher with no resurrection.
This run uses a loopback-only fixture; it does not re-claim live Host/OIDC
coverage from the earlier historical tests.

Evidence remains local in `packages/desktop/.artifacts/rc2/` and
`packages/desktop/.artifacts/rc2-native-final/`. The builder was stopped after
verification; no test processes, proxy or mount remain. No host package install,
backend restart, public signing identity or APT trust change was made.
The candidate remains **unsigned / security-review-required**; the existing
production audit, signing and hosting blockers are unchanged.

The menu references below describe historical rc.1 verification, not the current UI.

## APT bootstrap follow-up (2026-09-13 UTC)

Owner requested a single copy/paste Bash block and approved designing, but not
creating, new HTTPS hosting and signing-key custody. Design:
`docs/research/proposals/linux-desktop-apt-hosting.md`.

The installation page now supports approved `apt-install.json` configuration
and a copy button. The generated block automatically installs distribution
prerequisites, compares the downloaded key's primary fingerprint, writes a
per-source `Signed-By` entry, updates APT with failures treated as errors, and
installs the desktop. Invalid/multiple keys and update failures stop installation.
No production config, domain or key was created. Without approved configuration,
the live page keeps the APT command hidden instead of showing placeholders.

Desktop Node suites: 9 passed, including executable Bash negative paths,
actual GPG public-key inspection without modifying user keyrings, and website
copy/unavailable states. Release integrity suites: 5 passed. Real Chromium on
the deployed installation page confirmed the corrected candidate link and hidden
unconfigured APT section; a browser-only intercepted configuration then exercised
rendering and actual clipboard copying of the entire block. This fixture does
not claim a real public APT repository exists.

Dashboard-only deployment completed at generation 91, receipt
`deployment-desktop-apt-bootstrap-20260913`, release
`dashboard-830c0dae8ed4e7321b43`. Existing port 13000 remains unchanged. Native
package bytes are unchanged from the corrected candidate below.

## Corrected candidate — 2026-09-12 21:20 UTC

The release-integrity review's three required corrections are implemented:
controlled successful-build provenance, Debian `~` prerelease ordering, and
immutable release-specific dependency/checksum URLs. The earlier candidate
below is historical; its existing package/metadata URLs remain unchanged.

* Entry: `http://127.0.0.1:13000/downloads/desktop/index.html`
* Package:
  `/downloads/desktop/agent-runlab-desktop_0.2.0~rc.1_amd64.deb`
* Size: **1,574,988 bytes**; SHA-256:
  **`da297b1d838723776dc620211af64ce54e9fe9df1106c33872978ed47904093b`**.
* Dependency metadata:
  `/downloads/desktop/0.2.0~rc.1-da297b1d838723776dc620211af64ce54e9fe9df1106c33872978ed47904093b.dependencies.json`
  (SHA-256 `74728317a7801573335383646e91836cb28801ad712517e682c7f786e436b890`).
* Checksums:
  `/downloads/desktop/0.2.0~rc.1-da297b1d838723776dc620211af64ce54e9fe9df1106c33872978ed47904093b.SHA256SUMS.txt`
  (SHA-256 `bbc7a79be579d2cc1bc60db6015ce4ab370da166baf3cd2e3358013734d63903`).
* Immutable release metadata uses the same prefix and `.release.json`;
  `release.json` is the latest pointer, not an immutable object.
* Source/Tauri SemVer remains `0.2.0-rc.1`; Debian control version is now
  **`0.2.0~rc.1`**. Dependencies remain libc >=2.39, GTK3/WebKitGTK 4.1 and xdg-utils.
* Still **unsigned / security-review-required**, not production approved.

### Verification of corrected pipeline and deployment

1. Actual native build in the isolated task-owned Ubuntu 24.04 builder:
   frozen pnpm install, Cargo locked metadata and successful locked Tauri build.
   Actual Rust/Cargo/Node/pnpm/Tauri versions, resolved dependencies and original
   build lock snapshots were recorded before staging. The trusted local
   owner-only registry was transferred from that builder through local LXD
   administration, not accepted from an arbitrary package manifest.
2. **9 automated Node tests passed** across
   `scripts/release/desktop-release.test.mjs` and
   `packages/desktop/tests/desktop.test.mjs`: tampered package, altered lock,
   provenance/receipt mismatch, missing receipt, unsafe registry permissions,
   unsuccessful/unlocked provenance, wrong version, stable previous release
   links, immutable collisions, missing `.deb` checksum failure, schema/URL
   validation, and Debian rc→rc→final ordering.
   **2 locked release-mode native Rust tests passed.**
3. Debian repack verified byte-for-byte reproducible from the fresh Tauri input
   with the recorded source epoch. Installed payload file bytes and modes are
   unchanged (only archive layout/ownership/timestamps and control Version are
   normalized). Reduced `.deb` size comes from fixed xz compression, not removed
   application content. Result: `.artifacts/packaging-reproducibility.json`.
4. **Real signed APT integration passed inside the disposable builder**:
   signed local `file:` repository, isolated per-source test keyring/lists/cache,
   `apt update`, actual candidate install, normal `--only-upgrade` selection of
   final `0.2.0` over `0.2.0~rc.1`, and tampered `InRelease` rejection.
   The "final" package was an ephemeral packaging fixture with the same payload,
   not a final native release. `APT::Update::Error-Mode=any` was needed because
   ordinary APT can warn and retain old indexes while exiting zero.
   One-day **TEST ONLY** key and fixture repository were deleted; real candidate
   restored in builder. Key-free result:
   `.artifacts/apt-test-only-result.json`. No production signing identity,
   global APT trust/source, public repository or host installation was created.
5. Production publication actually rejected this artifact before signing:
   cargo-audit scanned **the captured build Cargo.lock** and failed on one
   denied warning (glib unsoundness); no output repository was created.
   Captured pnpm lock audit also retains inherited advisories. A separate
   empty-lock probe confirmed `--lockfile-dir` selects the supplied graph rather
   than the current checkout. No production audit bypass was introduced.
6. Independent Dashboard build and deployment completed:
   **generation 90**, `dashboard-fcaf086ce1de530c0b53`,
   receipt `deployment-desktop-integrity-20260912`.
   HTTP re-download verified all three new artifact/metadata digests.
   Both legacy root metadata links retain their previous exact digests.
   Real Chromium displayed the corrected version, immutable links and strict
   named-package verification commands; no `--ignore-missing`.
7. Ingress start remains **2026-09-11 06:05:40 UTC**; blue Runtime start remains
   **2026-09-11 06:07:09 UTC**. No backend restart or port change.

This is local build integrity, **not publisher-authenticated provenance**.
The same user/builder administrator is trusted. Compromised builders can forge
their own local records; production trust still requires operator-owned signing
keys and independent fingerprint verification. Existing users of the incorrectly
ordered legacy Debian version must explicitly remove/install the verified
corrected candidate as documented in operations; it is not an automatic downgrade.

## Original candidate — historical delivery

* Installation page:
  `http://127.0.0.1:13000/downloads/desktop/index.html`
* Real package:
  `http://127.0.0.1:13000/downloads/desktop/agent-runlab-desktop_0.2.0-rc.1_amd64.deb`
* Integrity/dependencies:
  `/downloads/desktop/SHA256SUMS.txt`, `/downloads/desktop/dependencies.json`,
  `/downloads/desktop/release.json`
* Local artifact:
  `packages/desktop/.artifacts/agent-runlab-desktop_0.2.0-rc.1_amd64.deb`
  (also staged in `packages/dashboard/public/downloads/desktop/`).
* Size: **2,278,488 bytes**.
* SHA-256:
  **`f1658c7b775fa2a891e80ae2b17f14fd791ed335328f2ce1a6398401edfed644`**.
* Package metadata: `agent-runlab-desktop`, version `0.2.0-rc.1`, amd64;
  dependencies `libc6 (>= 2.39), xdg-utils, libwebkit2gtk-4.1-0, libgtk-3-0`.
* Candidate is explicitly **unsigned and security-review-required** in the web
  page and both manifests. It does not claim production signed APT updates.

## Design/implementation

Design persisted before code: `docs/architecture/desktop/linux-desktop-client.md`.
Official Tauri client source/config/permissions/locked Rust graph under
`packages/desktop/`. It loads the existing React Dashboard from the chosen Host
origin, keeping all HTTP/account/Socket.IO behavior same-origin and frontend/
backend versions matched. No bundled Host/Runtime, local executor or listening
port. Packaged launcher is local; remote pages have no native capabilities.
HTTPS is mandatory except explicit loopback HTTP. Endpoint overrides and PWA
registration are suppressed inside desktop. Separate WebKit profile guarantees
the native save confirmation is not bypassed by the launcher's context handler.

Root workspace `build`/`typecheck` explicitly exclude native desktop builds so
ordinary backend development does not acquire Linux/Rust/GTK requirements.
`pnpm desktop:build` is the explicit native release command.

## Verification

1. Exact Tauri CLI 2.11.4, tauri 2.11.5, tauri-build 2.6.3, GTK 0.18.2;
   pnpm frozen lockfile; Rust 1.93.1; Cargo `--locked`; actual `.deb` built.
2. Native Rust endpoint/navigation tests: **2 passed**. Desktop Node contract/
   installation-page tests: **4 passed**. Dashboard targeted suites: **61 passed**
   after adding the two desktop-navigation tests; Dashboard `tsc --noEmit` and
   production release build passed.
3. Actual `apt install ./...deb` succeeded inside an isolated Ubuntu 24.04 LXD
   builder; application desktop entry and executable verified.
4. **Final installed binary**, ordinary X11/GTK user input:
   * remote page `connect` IPC denied;
   * desktop marker present;
   * download shows native Save dialog; cancel exercised;
   * Connection → Reconnect switched from fixture to existing live Host;
   * final native screenshot visibly shows **Connected**, rendered existing
     sessions, transcript, model selector, workspace list and composer.
   * Artifact: `packages/desktop/.artifacts/native-final-live-dashboard.png`;
     machine result: `native-final.log`.
5. Earlier same-source integration before separate WebKit profile:
   WebKitWebDriver verified `/models` 200, Socket.IO status `ready`, zero service
   workers, native IPC ACL denial, file URL navigation denied, local file input
   selection and reconnect. The final separate-context app exceeds WebDriver's
   one-context automation support; final-package acceptance uses ordinary X11
   instead. No test-only permission weakening was added.
6. Real Chromium installation-page check revealed and fixed two deployment
   compatibility issues: explicit `index.html` is required by existing static
   routing, and extensionless `SHA256SUMS` falls through to backend routes.
   Published links now use `index.html` and `SHA256SUMS.txt`; all bytes are real.
7. Independent Dashboard deployment completed at generation **89**,
   `dashboard-9f7a4fcaa32d8aa42add`, receipt
   `deployment-desktop-verified-20260912`. Existing ingress process start remained
   **2026-09-11 06:05:40 UTC**; blue Runtime process start remained
   **2026-09-11 06:07:09 UTC**. No backend restart or port change.

## Genuine remaining blockers

Read `docs/operations/linux-desktop-supply-chain.md` for exact advisory evidence.
Cargo-audit reports zero vulnerability-category entries but six unmaintained
warnings and **glib RUSTSEC-2024-0429 unsoundness**; strict
`cargo-audit --deny unsound` fails. The official Tauri GTK3 stack has no
dependency-compatible patched glib release. Do not call this advisory-free.
Existing workspace pnpm audit additionally reports 48 inherited advisories
(1 critical/17 high/25 moderate/5 low); no Tauri CLI advisory was identified.

Production APT publication requires resolving the native strict-audit blocker,
real operator-controlled signing key, independently distributed fingerprint and
HTTPS repository hosting. Publisher fails closed on strict audit and missing
key; it never invents credentials/signatures or configures `trusted=yes`.

The local deployment does not provide a working `/auth/me` route (probe aborted
after five seconds); it operates without the Private Cloud account flow.
Same-origin account design is preserved, but authenticated Private Cloud/OIDC
login/logout and each external IdP are **not end-to-end verified** here. No
provider credentials were fabricated or copied. Session creation/model calls
were intentionally not triggered merely to test a presentation-only client.
Token-only Hosts requiring query-token bootstrap URLs are not supported by the
origin-only launcher; it does not silently weaken authentication.

Native builder `runlab-desktop-builder` is task-specific, not the running Host.
It was stopped after verification, and its source mount and loopback test proxy
were removed. No native test service remains running.
Scratch binaries/logs are ignored in `.artifacts`; no sensitive session screenshot
is committed or uploaded to a third party.
