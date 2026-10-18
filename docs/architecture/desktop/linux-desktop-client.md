# Linux desktop client: design and delivery plan

Design recorded before implementation, 2026-09-12.

## Architecture decision

Ship an official Tauri 2 Linux-only **remote-first client**, not another Host,
Runtime, proxy, or independently versioned copy of Dashboard. The packaged local
connection screen opens the existing React Dashboard in an isolated WebKitGTK
window. The chosen deployment serves its own matching frontend and APIs.
No listener or port is added; the current deployment remains
`http://127.0.0.1:13000`.

This is deliberate: Dashboard account authentication uses same-origin HttpOnly
cookies and numerous same-origin HTTP routes in addition to Socket.IO. Loading a
bundled SPA from `tauri://localhost` would break those routes, cookie SameSite
rules, OIDC redirects and CORS unless we changed the backend or added a privileged
proxy. Neither is appropriate. The client shares the actual deployed React
Dashboard and therefore receives frontend updates immediately. Offline operation
means only connection setup, not offline sessions. A desktop document-start flag
disables Dashboard PWA registration; native packages update via apt instead.

## Security and compatibility

* Accept an origin only: HTTPS for remote Hosts, HTTP only for explicit loopback.
  Reject embedded credentials, query, fragments, paths and non-network schemes.
  Never transport API tokens in URLs or persist passwords in native config.
* A local-only connection command creates the remote window. The rc.6 source
  permits only bounded activity/privacy-safe notification hints and successful
  connection confirmation from the selected Dashboard origin; IdP and other
  origins cannot use those commands. Remote windows
  have no connect, shell, filesystem, process, updater or HTTP-plugin privileges.
  Native GTK shortcuts provide reconnect (`Ctrl+Shift+O`), Dashboard reload
  (`Ctrl+R`) and quit (`Ctrl+Q`), independent of remote scripts. There is no
  application menu bar or browser toolbar. The official Tauri tray feature adds
  only Open Agent RunLab / Change server / Quit in the system tray. Close/minimize
  hides the application only while a native watcher reports an active host and
  our registered item. Without this support, close exits and minimize stays a
  normal OS minimize; loss of tray support restores a hidden window visibly.
  Registration handles GNOME's `bus@/path`, KDE's `bus/path`, and owned service
  aliases. A failed/slow probe is not evidence that the tray is absent: recent
  confirmation is retained briefly, then an unreachable hidden window is
  restored and close keeps it visible with a native explanation.
  Opening the AppIndicator menu does not restore or focus a hidden window.
* Remember the origin only after the authenticated Dashboard control connection
  receives its authoritative session snapshot. Reuse it automatically on normal
  startup; an explicit tray Change server stays editable. Failed attempts do not
  overwrite the last successful origin, and same-origin reconnection restores an
  already confirmed window without discarding its document or draft.
* Keep the native window title as `Agent RunLab`, without appending the endpoint
  or a remote document title. The address remains editable in Change server.
  Web/PWA and desktop share an original octopus mark: coral for web, mint with a
  small dock underline for desktop. All raster assets derive from the shared
  vector source; maskable and touch icons keep the character in the safe zone.
* Keep HTTP navigation within the selected loopback origin. HTTPS navigation to
  identity providers and external pages remains in the unprivileged WebView;
  never allow navigation into local application/file schemes. New windows are
  denied. There is no native action for exporting arbitrary pages to an external
  browser. A local, user-clicked update action may open only the selected server's
  fixed installation-instructions URL after detecting a newer valid release.
  Individual identity providers need explicit
  compatibility verification; do not claim universal OIDC support.
* Cookies remain WebKit's origin-isolated cookie storage, not copied from a
  browser. Login inside the client. Normal logout continues to call the same
  backend. No CORS configuration changes, disabled TLS checks, or backend bypass.
* Session workspace paths and terminals still address the **remote Runtime**;
  browser file upload selects local desktop files and sends through existing
  Dashboard APIs. The desktop is not a local executor.
* Linux `.deb` targets amd64 initially. The implemented Ubuntu 24.04 builder
  requires glibc >=2.39 plus GTK3/WebKitGTK 4.1; Debian 12 is not claimed compatible
  with this artifact. No unsupported macOS/Windows/Snap promise.

## Supply chain and distribution

Use official mature Tauri crates and CLI only, exact direct dependency versions
selected after reviewing release dates and RustSec/GitHub advisory evidence.
Commit Cargo.lock and pnpm-lock.yaml, build with `--locked` / frozen lockfile,
record resolved dependencies, toolchains and artifact SHA-256. Existing frontend
dependencies are reused, not silently upgraded wholesale.

Produce a real `.deb`, a dependency/build manifest and checksum file. Stage the
actual artifacts in Dashboard public downloads before showing a download link;
an absent artifact must produce an unavailable state, not a made-up URL.

The web topbar opens a first-class Dashboard dialog (a bounded bottom sheet on
mobile), never a new tab. Closing restores trigger focus without changing the
current route, session or unsent draft. The entry stays hidden in Tauri.
`/downloads/desktop/index.html` remains available for direct external links.
Both surfaces share `release-data.js` validation/strict named-package commands
and `apt-snippet.js` approved-repository validation. Download links stay absolute
under `/downloads/desktop/`; metadata or missing/HTML artifact responses fail
closed. APT commands appear only with valid published `apt-install.json`.
Unsigned/review-required advisory warnings remain visible; connection and system
explanations are accessible through contextual help. A Connect Workspace-style
terminal card exposes one Copy button for the complete readable Bash
download/verify/install block; users run it themselves in a Linux terminal.
The block accepts only canonical HTTPS origins or explicit loopback HTTP,
downloads the real package plus immutable dependency/checksum files without
following redirects, validates every pinned SHA-256 and the strict checksum
list, then invokes `sudo apt install -y` so confirmation does not abort on the
heredoc's exhausted standard input. If curl is absent, the command first uses
the system's configured APT sources with strict update-error handling to install
ca-certificates and curl; it never bypasses signature authentication.
An atomically created owner-only `mktemp` directory under `/tmp` does not use the
user's home or current directory (or an inherited `TMPDIR`). Only after checksum
verification, the public `.deb` becomes readable and its temporary directory
traversable by APT's `_apt` user; neither becomes writable by other users. The
command never disables APT sandboxing or changes home-directory permissions.
The directory is cleaned on success/failure without removing unrelated files.
The modal and command panel
resize with the available viewport; the header stays reachable while the body
scrolls in short windows. Clipboard failures
leave the full command selectable. Modal labels, warnings and contextual help
support English and Chinese; general execution explanations stay in help.
Uninstallation is separate contextual help, never part of an installation block.

Release integrity corrections (2026-09-12 UTC): the controlled builder, not the
stager, records the successful frozen pnpm/locked Cargo build, actual toolchain
output, captured lockfiles and resolved dependencies against the final `.deb`
SHA-256. Its owner-only `.build-provenance` registry is a **local trusted-build
boundary**, never an arbitrary manifest accepted from a package supplier.
Stage/sign require the local receipt and verify artifact, manifest and every
captured input digest. The publisher audits the artifact's captured Cargo/pnpm
locks, not the checkout from which publication happens. Unsigned receipts prove
neither publisher identity nor resistance to a compromised builder/same OS user.

The staged candidate's SemVer is `0.2.0-rc.4`, while the Debian control version is
`0.2.0~rc.4`; pinned Tauri has no Debian-version override. A controlled post-build
`dpkg-deb` transformation changes only control Version, normalizes timestamps
and ownership, and uses fixed single-thread xz compression. This preserves the
payload and ensures prerelease-to-final APT upgrade ordering. Previously
installed incorrectly ordered `0.2.0-rc.1` requires the explicit migration in ops.

Each release uses immutable version/artifact-digest-qualified dependency,
checksum and release-record files. Only the latest `release.json` pointer moves;
prior objects and the legacy candidate's root metadata remain unchanged.
Client instructions verify the exact named package before installation and fail
if any required checksum input is missing (never `--ignore-missing`).

Production updates use a dedicated HTTPS APT repository with `InRelease` signed
by an operator-controlled offline/restricted release key and per-repository
`Signed-By`. Implement publishing mechanics and consumer instructions; never
generate a fake production signing identity or advertise unsigned/trusted=yes
repositories. Public hosting, DNS/TLS, key ownership and independent fingerprint
distribution are operator inputs; explicitly report these blockers if absent.

## Implementation sequence / acceptance

1. Persist this design and research exact dependency versions.
2. Implement isolated launcher, origin validation, native window boundary,
   desktop PWA guard and artifact-aware web installation entry.
3. Locked build and tests: malformed endpoints, remote capability denial,
   same-origin behavior, PWA guard, artifact checksum generation.
4. Build native Linux package in an isolated builder if host libraries are
   absent; never modify the running Host container or require sudo bypass.
5. Real WebKit launch against the existing Host where feasible, verify package
   metadata and download bytes, then record evidence and genuine blockers.
