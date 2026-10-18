# Linux desktop build, install and signed APT publication

See [the recorded design](../architecture/desktop/linux-desktop-client.md). This is a
remote-first Tauri client, not a bundled/offline Dashboard or local Runtime.
Read the [supply-chain assessment and unresolved strict-audit blocker](linux-desktop-supply-chain.md)
before distributing this unsigned candidate.

## Locked build

Build on Ubuntu 24.04 amd64 (GTK3/WebKitGTK 4.1); the generated `.deb` declares
the actual libc dependency. Do not claim Debian 12 compatibility for an Ubuntu
24.04-built binary. Use an isolated builder, not the live Host container.

Prerequisites: `build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev
libssl-dev librsvg2-dev patchelf libayatana-appindicator3-dev`, Node 22,
pnpm **11.3.0**, Rust **1.93.1**.
The CLI is pinned to **2.11.4**, tauri to **2.11.5**, tauri-build to **2.6.3**.

```sh
pnpm --filter @agent-kernel/desktop test
pnpm --dir packages/desktop/src-tauri exec cargo test --locked
# Runs frozen pnpm install, locked Cargo metadata/build, packaging and local receipt.
pnpm --filter @agent-kernel/desktop build
node scripts/release/stage-desktop-release.mjs \
  'packages/desktop/.artifacts/kala-desktop_0.2.0~rc.13_amd64.deb' \
  packages/dashboard/public/downloads/desktop
pnpm --filter @agent-kernel/dashboard build
```

Use the **normalized `.artifacts` package**, not raw Tauri bundle output.
`build-desktop-release.mjs` accepts no prebuilt artifact/manifest. Only after a
successful build and unchanged captured inputs does it atomically create the
owner-only `.build-provenance/<deb-sha256>/` receipt, dependency metadata and
Cargo/pnpm lock snapshots. Actual commands supply compiler/CLI/toolchain
versions; no checkout-derived metadata is invented during staging.

Stage and sign require this local registry, validate its receipt/manifest/lock
digests and exact `.deb` identity, size and SHA-256. The CLI intentionally has
no "trust this manifest" or registry-import option. Keep the registry on the
controlled builder; if moving between your own isolated builder and publisher,
transfer it only through your existing trusted local administrative transport,
preserve owner-only permissions, and independently verify the transferred bytes.
Never copy a supplier's registry into this trusted location. The same OS user,
builder administrator and builder toolchain are trusted: these unsigned local
records **are not cryptographic publisher authentication**. A compromised
builder can forge them. Production publisher identity comes from independently
verified release-key ownership. Artifacts/registry are ignored by Git.

The public metadata is schema 2: `release.json` names the exact immutable
`<version>-<deb-sha256>.dependencies.json` and `.SHA256SUMS.txt`, including their
digests. A matching immutable `.release.json` is also retained. Staging refuses
same-name/different-byte collisions. Preserve these objects and old packages
across Dashboard deployments; never prune files still referenced by cached
pages. Legacy root `dependencies.json` / `SHA256SUMS.txt` remain frozen to the
original legacy candidate, **not aliases for latest**.

Dashboard `/downloads/desktop/index.html` exists even without a package; download buttons
appear only after metadata and the package/manifest/checksum files are present.
Deploy the built Dashboard using the existing independent Dashboard deployment
mechanism; do not restart Host/Runtime or change any port.

## Client usage

Open the trusted Dashboard's **Download desktop** dialog or
`/downloads/desktop/index.html`, copy its complete installation command once,
and paste it into a terminal. **No manual download or hash comparison is
required.** The generated block uses `curl` to download the exact immutable
package and release-specific metadata into a temporary directory, automatically
verifies the embedded package/checksum digests and every checksum entry, then
installs the verified package with APT. Failed downloads or mismatched hashes
stop before installation. Its temporary installation path is readable by
APT's `_apt` sandbox user and is cleaned afterward. Always copy the current
page-generated command; this document intentionally does not pin a stale
candidate hash or a working-directory-dependent command.

If the browser has already saved the `.deb`, use **Install an already downloaded
.deb** in the same dialog (also available on the standalone page). This command
finds the exact version in the configured Downloads directory or current
directory, including the observed underscore filename variant. For another
path, set `KALA_DESKTOP_PACKAGE` explicitly. It verifies a private temporary
copy before making that copy readable to `_apt`, installs it and removes the
temporary directory. It does not re-download the package or change permissions
on the original file or home directory. Direct `sudo apt install
~/Downloads/...deb` can still produce APT's unsandboxed notice when `_apt`
cannot traverse the home directory; a package cannot fix access before APT
reads it. Do not disable the APT sandbox to suppress that notice.

**Legacy version migration:** the earlier `0.2.0-rc.1` Debian version sorts
*after* final `0.2.0`; it cannot automatically upgrade to the corrected rc or
that final. If `dpkg-query -W -f='${Version}' agent-runlab-desktop` shows that
exact legacy version, run `sudo apt remove agent-runlab-desktop`, then use the
current page's complete automatic installation command.
Do not purge the WebKit profile or broadly enable downgrade allowances.
All corrected `~rc` versions sort before their final version.

Open Kala and enter the Dashboard **origin**, not an API path or a URL
with a token. HTTPS is required except explicit loopback HTTP. A remote machine's
`127.0.0.1` is not your desktop's loopback: use its HTTPS domain or your existing
secure tunnel. Login in the WebView (no cookie import from Chrome/Firefox).
After the actual Dashboard control connection and authoritative session snapshot
succeed, the native client remembers that origin and reconnects automatically on
the next launch. Opening **Change server** does not immediately reconnect;
an unsuccessful attempt does not replace the last successful origin.
Account cookies stay same-origin; HTTPS IdP redirects are allowed. In rc.6,
only the selected Dashboard may submit bounded activity/notification hints and
confirm its successful connection; IdP pages and other origins receive no such permission. Connect, update
instructions, filesystem/process access and general native APIs remain
unavailable to remote pages. External links navigate in the
unprivileged WebView. There is no native menu bar or browser toolbar.
The native Dashboard window title is always `Kala`; it does not expose
the endpoint or adopt remote page titles. Use **Change server** to view or edit
the saved address. The desktop's mint octopus and dock underline distinguish it
from the coral web/PWA icon.
Press **Ctrl+Shift+O** to open the local connection screen, **Ctrl+R** to reload
the Dashboard, **Ctrl+Shift+R** (or the native title-bar recovery button) to
clear cached interface data and force-reload without deleting authentication
cookies, or **Ctrl+Q** to quit. The native shell automatically attempts this
recovery once when it detects the Dashboard's fatal interface screen, then
leaves the recovery button available instead of entering a reload loop. With a
supported system tray, closing or
minimizing a native window hides the app in the tray. Click its icon or choose
**Open Kala** to restore the existing window without a reload;
**Change server…** opens the local launcher and **Quit** exits the process.
On AppIndicator desktops, clicking the icon opens its native tray menu without
restoring or focusing the hidden window. Select **Open Kala** to restore
it. No window menu bar is added.

Hiding requires both a registered native item and an active StatusNotifier host.
Without them, close exits and minimize remains a normal OS minimize. If the tray
host, watcher or item registration disappears while hidden, the window returns
visibly. The compact connection screen keeps security and usage explanations
under **Help and shortcuts**. Linux packaging requires
`libayatana-appindicator3-1`; a desktop without a tray extension remains usable.
GNOME's visible AppIndicator icon is supported, including its `bus@/path`
registration format (corrected in rc.4). Close/minimize withdraws the window
from the desktop and taskbar; it does not just iconify a still-listed window.
Transient tray probe failures do not erase recent confirmation. If probing
remains unresponsive, the app stays reachable and explains the problem in a
native dialog instead of silently quitting. Explicit tray Quit / Ctrl+Q exits.
Token-only deployments whose only login mechanism is a `?token=...` bootstrap URL
are not supported by this launcher: it deliberately rejects query credentials
and does not create a native token vault or copy browser secrets. Use an existing
same-origin authenticated deployment; do not disable Host authentication to
work around this limitation.

File uploads select local desktop files; terminals, workspace directories and
session artifacts belong to the remote Runtime. No native terminal, filesystem
plugin, arbitrary shell command, updater plugin or proxy is exposed to JavaScript.
Desktop disables PWA registration; system packages update the shell, and the
selected Host updates its own shared React Dashboard.

The Dashboard has a **separate WebKit context/profile** under the application's
XDG data directory (`dashboard-profile`). This is also required for download
safety: WebKit's download handler is context-wide, so sharing the launcher's
default context would let its automatic handler bypass the Dashboard save
confirmation. Native downloads now require a save dialog and overwrite
confirmation, verified with ordinary X11 input.

Remove with `sudo apt remove agent-runlab-desktop`. This does not delete remote
sessions, your account, or WebKit profile data. For shared machines, sign out in
Dashboard before removal; remove the application-specific WebKit profile only
after locating it under your user's XDG data/cache directories.

## Signed APT repository: operator inputs required

The proposed hosting, key custody and single-paste installation contract are in
[the APT infrastructure design](../research/proposals/linux-desktop-apt-hosting.md).
The owner requested a complete Bash block, not manual source-editing steps.
The implemented generator automatically checks the literal primary fingerprint
before writing a `Signed-By` source, updating APT and installing the package.

**Not provisioned automatically.** Real production signing-key custody,
independent fingerprint publication, HTTPS hosting and DNS/TLS are required.
No signing identity or public repository is fabricated by this project.
Checksums alone are not authenticity signatures.

1. Use a dedicated existing release-signing key (prefer hardware/offline primary
   with restricted signing subkey), with documented rotation/revocation owners.
2. Set its full fingerprint and create a fresh staging repository:

   ```sh
   export KALA_APT_SIGNING_FINGERPRINT='FULL_EXISTING_KEY_FINGERPRINT'
   export KALA_APT_PUBLIC_URL='https://YOUR_APPROVED_REPOSITORY_ORIGIN/path'
   node scripts/release/publish-desktop-apt.mjs path/to/package.deb release/apt-staging
   ```

   The publisher requires `dpkg-deb`, `apt-ftparchive`, `gpg`, `gpgv`, `cargo-audit`;
   it first verifies the local build receipt, then requires
   `cargo-audit --file <build-record>/Cargo.lock --deny unsound` and
   `pnpm audit --lockfile-dir <build-record> --audit-level low` to pass.
   Both use the actual build's captured locks, not current checkout locks.
   These are currently blocked by the upstream glib advisory and inherited
   workspace JS findings, respectively. There is no candidate/audit bypass.
   The publisher fails
   without a real secret key. It signs InRelease and Release.gpg, exports only
   the public key, sets 14-day metadata expiry, and verifies the signature.
   Refresh/re-sign at least weekly. Preserve old package pools during promotion
   so concurrent clients do not encounter disappearing downloads; deploy the
   complete verified staging tree atomically on the HTTPS server.
   The fingerprint must identify the primary key exported to clients, not only
   its signing subkey. Successful staging also emits `apt-install.json` and
   `install-desktop.txt`. The latter is the complete copy/paste Bash block.
   After the real HTTPS install/upgrade acceptance, copy `apt-install.json` to
   Dashboard `public/downloads/desktop/` and deploy its installation page; this
   enables the copy button. Do not publish this configuration while the source
   is only staged or the security gate remains blocked.
3. Independently publish the key fingerprint (not only on the same download
   endpoint), test package install and a monotonically higher package version
   upgrade on a clean supported VM, and publish that evidence.
4. Users receive the generated block with actual URL/fingerprint values, not
   placeholders or a request to compare keys manually. It installs distribution
   prerequisites automatically, aborts on key mismatch, adds the source, then
   updates and installs. Existing source/key files are replaced idempotently.
   The following is reference anatomy for operators only, **not the live
   installation snippet or currently working repository URLs**:

   ```sh
   curl --proto '=https' --tlsv1.2 -fSLo agent-runlab-desktop-archive-keyring.gpg \
     https://YOUR_VERIFIED_APT_ORIGIN/agent-runlab-desktop-archive-keyring.gpg
   gpg --show-keys --with-fingerprint agent-runlab-desktop-archive-keyring.gpg
   # STOP unless the full fingerprint matches the independently obtained value.
   sudo install -m 0644 agent-runlab-desktop-archive-keyring.gpg \
     /usr/share/keyrings/agent-runlab-desktop-archive-keyring.gpg
   printf '%s\n' \
     'Types: deb' \
     'URIs: https://YOUR_VERIFIED_APT_ORIGIN/' \
     'Suites: stable' \
     'Components: main' \
     'Architectures: amd64' \
     'Signed-By: /usr/share/keyrings/agent-runlab-desktop-archive-keyring.gpg' \
     | sudo tee /etc/apt/sources.list.d/agent-runlab-desktop.sources
   sudo apt update
   sudo apt install agent-runlab-desktop
   # Subsequent normal system updates:
   sudo apt update && sudo apt upgrade
   ```

Never use `apt-key`, `trusted=yes`, `--allow-unauthenticated`, disable TLS
verification, embed private keys in CI logs/artifacts, or imply that the unsigned
standalone package already benefits from signed APT updates.

### Isolated test-only signed APT integration

`scripts/release/verify-desktop-apt-test-only.mjs` refuses to run outside the
task-owned `runlab-desktop-builder` or without
`KALA_TEST_ONLY_APT=isolated-builder`. Run as root **only in that disposable
builder**, passing its controlled candidate `.deb`. It installs/removes the app,
so it must never target a live Host or a user's workstation.

The test creates a one-day **TEST ONLY** key in an ignored project-local
directory, uses a `file:` repository with explicit per-source `Signed-By`,
isolated source/list/cache/keyring options, and exercises actual APT install
then final-version upgrade. The final package is an ephemeral repack of the
candidate for package-manager testing, **not a built/approved final release**.
It shares signing mechanics but intentionally does not claim production audit
approval. `APT::Update::Error-Mode=any` prevents stale cached lists hiding the
tampered-signature negative test. Private/public test keys, repository and
final-version fixture are deleted in cleanup; only a key-free JSON result
remains. The real candidate is restored in the builder. No global APT source
or trust store, production keys, public hosting or backend ports are changed.

## Native verification

### rc.7 public native integration contract

The current immutable published candidate is rc.7. Its public v1 bridge retains
compatibility with rc.5 and the optional successful-connection confirmation
introduced in rc.6. The rc.7 native changes are the endpoint-free window title
and mint octopus identity; session-connection and CPU fixes ship in the shared
Dashboard, not a bundled local backend.

The selected Dashboard alone may call:

```js
const bridge = window.__KALA_DESKTOP_BRIDGE__
// bridge.version === 1
await bridge.getInfo() // { version, focused, visible, notificationsAvailable?, trayAvailable? }
// Only after the authenticated control connection and server:sessions snapshot:
await bridge.confirmConnection?.()
await bridge.setActivity({ status: 'running', running: 1, attention: 0, completed: 0 })
await bridge.notify({
  id: 'completion:123', sessionId: 'session-123',
  title: 'Kala', body: 'A session completed.', silent: true,
})
const unsubscribe = bridge.subscribe(event => {
  // { type: 'window-state', focused, visible }
  // or { type: 'open-session', sessionId }
})
unsubscribe()
```

Activity status is `idle`, `running`, `attention` or `completed`. Session IDs
must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; notification IDs use the same
character set with a maximum of 256 characters. Unknown fields are rejected.
The title is always `Kala`; body is bounded plain text of at most 512
characters. The shared Dashboard defaults to generic private text and owns
explicit detail opt-in, viewed-session suppression and notification preferences.
Capability URLs are restricted
to the locally selected origin, and the native command independently checks the
actual window label and origin. Existing connect permission remains local-only.
`confirmConnection` takes no caller-supplied URL: the native side persists only
its current selected origin. Merely opening a WebView never promotes an attempted
address to the last successful server. Startup bootstrap is local-launcher-only
and permits automatic connection just once per application process.
Native notifications are deduplicated and rate-limited, use actual
`org.freedesktop.Notifications.Notify`, propagate delivery errors, and map
`silent` to the native `suppress-sound` hint. Static blue/amber/green tray dots indicate running/attention/completed without
blinking or adding a window menu bar.

The Dashboard subscribes to public `open-session` events, not private native
transport events or query parameters. The native wrapper queues cold links
until subscription and handles its internal startup transport itself.
Canonical OS links are `agent-runlab://session/<id>` only: no server
selection, credentials, query, fragment or arbitrary external URL. A link that
cold-starts the app remains pending until the user connects the local launcher.
Notification actions retain their original selected origin and do not silently
switch servers.

GIO registers one application on the OS user's existing session bus. Repeat
launches activate the existing instance before any Tauri window/profile setup.
The installed D-Bus service is **on-demand activation**, not login autostart.
No custom global shortcut, screenshot API or new network listener is added.

Geometry uses owner-private, atomically replaced native configuration:
normal dimensions/maximized state, plus supported X11 position. Initial bounds
fit the current monitor; off-screen saved positions and changed monitor layouts
are recovered. Wayland position is deliberately best-effort/compositor-owned.
Configure-event dimensions and current GTK state are used instead of preceding-frame size getters,
and creation-time events cannot overwrite saved placement before restoration.

Updates belong exclusively to the shared Dashboard, using the selected origin's
validated release metadata and existing installation dialog. There is no second
native updater or OS update notification. Unsigned candidates remain labelled
review-required. Native code never invokes sudo, apt or an updater privilege
helper; browser credentials are not extracted or bypassed.

Set `KALA_DESKTOP_TEST_FEATURES=1` for the genuine GNOME test below to additionally
exercise real native notifications and their physical click action, active-view
suppression, repeat launch/session links, persisted geometry across restarts,
off-screen recovery and absence of duplicate native update notices.
Set `KALA_DESKTOP_REAL_DASHBOARD=1` as well for release acceptance: the script
starts `tests/native-dashboard-host.mjs` using the existing Host/tsx runner,
serves the actual production Dashboard from `packages/dashboard/dist`, and
drives real Host/Socket.IO session transitions through the installed bridge.
Its injected observation script never replaces the bridge. A physical GNOME
notification click must select the correct real Dashboard session without
reloading. Fixture-only native probes do not establish this cross-end result.
The selected-session and control-summary projection queues must keep advancing
while WebKit is hidden: the shared Dashboard uses a cancellable frame/timeout
race rather than relying only on suspended background animation frames.

`packages/desktop/scripts/verify-native-gnome.py` tests a **genuine distribution
GNOME Shell and Ubuntu AppIndicator extension**, not the local watcher fixture.
Use only an isolated native builder with `gnome-shell`, `gjs`,
`gnome-shell-extension-appindicator`, Xvfb, `wmctrl` and the native probe prerequisites.
It uses its own X11 display/session bus/settings, physically clicks the GNOME
panel icon, checks Mutter's `_NET_CLIENT_LIST` for taskbar withdrawal, verifies
the same document/draft survives restoration, and disables/re-enables the real
extension to exercise recovery. `KALA_DESKTOP_EXPECT_BUG=1` reproduces the
shipped rc.3 GNOME close-and-exit bug; normal mode verifies the installed fixed
candidate. Set `KALA_DESKTOP_EVIDENCE` to a project-local evidence directory.
Coverage is GNOME Shell 46 / Ubuntu AppIndicator 58 on X11, not a claim about
every GNOME release, Wayland, or the user's exact desktop environment.
The isolated Shell uses `--unsafe-mode` only for test-driver inspection of
actor coordinates and banner identity; physical X11 input performs activation.
The HTTPS unselected-origin fixture temporarily trusts a one-day test certificate
inside the disposable builder and removes that trust entry during cleanup.
These test-session settings are not packaged or applied to users' desktops.

`packages/desktop/scripts/verify-native-download.py` tests the **installed final
binary** using ordinary GTK/X11 keyboard/mouse input: isolated remote page IPC
denial, desktop marker, native save/cancel, menu-free windows, native keyboard
reconnect/reload/quit, and no-tray normal close. With
`KALA_DESKTOP_TEST_TRAY=1`, a test-only session-bus watcher additionally verifies
native registration, hide/restore without reload, minimal tray actions, actual
Quit, and recovery when the host, registration or watcher disappears.
The fixture uses the existing Python GObject introspection package (`python3-gi`).
Its small loopback fixture is ephemeral
and exists only inside the builder. Set `KALA_DESKTOP_LIVE_ORIGIN` to additionally
reconnect to an already accessible live Host; the probe does not create a tunnel.
It requires the existing Ubuntu packages `xvfb xdotool imagemagick dbus-x11`.
Set `KALA_DESKTOP_EVIDENCE` to a project-local output directory.

`verify-native.py` records additional WebKitWebDriver checks (same-origin API,
Socket.IO health, local file input, PWA suppression, reconnect, file navigation
denial) made before profile isolation. WebKit only exposes one automation context;
the final production app correctly isolates the Dashboard context, so that probe
reports a skip rather than weakening production isolation for testing. The
ordinary GTK/X11 test is the final-package acceptance check.
