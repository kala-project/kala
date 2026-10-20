# Portable single-machine lifecycle

Release builds publish two management entry points beside the existing `run.sh` and Portable Host CJS asset:

- `kala-portable.sh`: Linux x64 and macOS x64; other architectures fail closed.
- `kala-portable.ps1`: Windows x64 with Windows PowerShell 5.1 or PowerShell 7.

Download the entry point from the same signed GitHub Release whose Host is being installed, inspect it, then run `install`. The installed copy is `.../bin/kala-portable` or `...\bin\kala-portable.ps1`. Both entry points expose:

```text
install  start  status  logs  stop  upgrade  uninstall
```

`install` downloads `SHA256SUMS`, verifies its Sigstore bundle for public HTTPS releases, and verifies both `kala-dashboard-with-runtime.cjs` and the platform's manager asset before activation. It does not start the Host. Loopback HTTP is permitted only when structural URL parsing finds the exact host `localhost`, `127.0.0.1`, or `::1`; credentials, malformed URLs, host suffixes, and non-loopback plaintext HTTP are rejected. Node.js 22 or newer is required because Portable Host is currently distributed as CJS rather than an OS-native Host executable.

`start` supplies `KALA_BIND_HOST=127.0.0.1` and port `3000` by default. Set `KALA_PORTABLE_BIND` and `KALA_PORTABLE_PORT` explicitly to change those values. Exposing a listener beyond loopback also requires the product's public-origin/auth configuration; these scripts do not weaken that application-level gate.

Runtime files and user data are separate. Filesystem roots, the user's home directory, and overlapping runtime/data directory selections are rejected before lifecycle operations. `uninstall` removes runtime files but retains sessions, artifacts, audit data, state, and executor identities by default. Use `uninstall --purge-data` on POSIX or `uninstall -PurgeData` on Windows for explicit deletion.

## Upgrade and process safety

`upgrade` defaults to the release repository's `latest` download. Use `--tag TAG` on POSIX or `-Tag TAG` on Windows to pin a release. The Host and corresponding manager are fetched and authenticated before the installed process is touched. On POSIX, the previous runtime, manager, release tag, and base URL remain available through activation; if the replacement cannot start, the manager restores and attempts to restart the previous installation. Failed staging directories are removed by an exit trap.

POSIX PID files bind a positive PID to its operating-system start fingerprint. Malformed records fail closed, and stale or reused PIDs are treated as stopped rather than signaled. This prevents an old PID file from targeting an unrelated process.

Windows does **not** claim graceful process control. `Stop-Process` is not a cooperative shutdown mechanism, and the Portable Host does not yet expose a manager-authenticated shutdown channel. Therefore:

- `stop` refuses while the managed process is running.
- `upgrade` and `uninstall` refuse while it is running.
- Stop the Host from its owning console or another operator-controlled cooperative mechanism, then rerun the command.

The Windows PID record binds the PID to process start time and Node executable path. Paths passed to process launch and file operations are quoted/literal so installations under directories containing spaces are supported.

## Platform behavior and limitations

These are **per-user process managers**, not boot-service installers:

- Linux: background process with identity-bound PID and log files; no systemd unit is installed.
- macOS: background process with identity-bound PID and log files; no launchd plist is installed and no notarized app is implied.
- Windows x64: detached per-user Node process; it is not a Windows Service. The existing WinSW-based Windows service assets are for the Executor, not the Portable Host.

A reboot does not automatically restart Portable. Run `start` after login or build an operator-owned service definition around the installed entry point. The managers do not install Node.js, `cosign`, or OS packages. Public release install/upgrade requires `cosign`; POSIX additionally requires `wget`. Windows PowerShell execution policy may require an operator-approved invocation policy.

Local automated coverage executes the full POSIX lifecycle against fixture releases, including adversarial URLs, destructive path guards, PID reuse, pre-stop verification, authenticated manager replacement, staging cleanup, and rollback/restart. PowerShell (`pwsh`) was unavailable in the current verification environment, so Windows parser and runtime behavior remain unverified here; generated-script contract assertions cover refusal semantics and quoting only. macOS path and shell semantics are shared with POSIX but require a real macOS run before being considered platform-verified.
