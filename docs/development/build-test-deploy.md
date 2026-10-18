# Build, Test, And Deploy

This runbook keeps common local and remote operations fast without adding many package scripts.

## Targeted Tests

Use `pnpm exec` inside the selected package when running a single Vitest file:

```bash
pnpm --filter @agent-kernel/host exec vitest run src/loop.test.ts
```

Avoid passing a file after the package `test` script:

```bash
pnpm --filter @agent-kernel/host test -- src/loop.test.ts
```

That form invokes the package script and can still run the full suite depending on how the script forwards arguments.

## Production UI Prototype

The Dashboard prototype runs the production `App` and production components.
Only HTTP and Dashboard socket transports are replaced with deterministic,
fictional fixtures. Keep this boundary intact: do not duplicate the app shell,
chat transcript, composer, sidebars, dialogs, or feature components inside
`src/prototype`.

```bash
pnpm --dir packages/dashboard run dev:prototype
pnpm --dir packages/dashboard run build:prototype
PROTOTYPE_URL=http://127.0.0.1:4179/ \
  pnpm --dir packages/dashboard run verify:prototype
```

Add reusable review states to `src/prototype/mock-dashboard-socket.ts` using
placeholder identifiers, domains, paths, and content. The browser matrix in
`scripts/prototype-interaction.mjs` must verify production behavior and
responsive geometry rather than snapshotting a parallel implementation.
`dist-prototype` and `review-screenshots` are generated review artifacts and
must remain untracked.

## TypeScript Builds

Package `tsconfig.json` files use incremental compiler metadata at `dist/.tsbuildinfo`. The cache is local build output and is ignored by git.

## Release Assets

Full local release build without native SEA assets:

```bash
pnpm run build:release-assets -- --repo <owner>/<repo> --no-native
```

Fast release rebundle after package and dashboard builds are already current:

```bash
pnpm run build:release-assets -- --repo <owner>/<repo> --no-native --skip-dashboard-build --skip-package-build
```

`--skip-dashboard-build` still requires `packages/dashboard/dist/index.html` to exist. If it is missing, the release script fails before producing a host bundle.

## Transactional Deploy

The normative restart and deployment contract is [`../architecture/graceful-restart-and-deployment.md`](../architecture/graceful-restart-and-deployment.md). This runbook must not weaken that contract.

Platform Dashboard releases are independent of Runtime releases. For Dedicated, use
`pnpm run deploy:dashboard -- stage` followed by `wait`, `status`, or `inspect`; the
Supervisor verifies the immutable archive and advances only Dashboard route state. For
Private Cloud, use `pnpm private-cloud:deploy-dashboard`; it replaces only the Dashboard
container and fails if Runtime or Ingress container identity changes. Portable continues to
ship and update one combined executable.

### Portable single-service deployment

`deploy:remote` is the legacy/Portable single-service transaction. It supports LXD
and SSH transports, but it fails closed when `/runtime/capabilities` reports a
Dedicated or Private Cloud Platform target:

```bash
pnpm run deploy:remote -- --help
pnpm run deploy:remote -- --lxd <portable-container>
pnpm run deploy:remote -- --ssh <portable-target> \
  --host-url <portable-host-url> \
  --remote-bin <remote-bin-dir> \
  --service <portable-systemd-unit>
```

It stages an immutable generation and hands activation to the Portable external
finalizer. Do not use it for a Dedicated blue/green Runtime or Private Cloud.

### Dedicated Runtime and control plane

Dedicated uses the versioned Deploy Supervisor request/receipt protocol:

```bash
pnpm run deploy:dedicated -- stage --lxd <container>
pnpm run deploy:dedicated -- stage --ssh <target>
pnpm run deploy:dedicated -- status <deployment-or-operation-id> --lxd <container>
pnpm run deploy:dedicated -- wait <deployment-or-operation-id> --lxd <container>
pnpm run deploy:dedicated -- inspect --lxd <container>
```

`abort` and Supervisor-owned `rollback` are also supported. A Dedicated deployment
starts and privately verifies the inactive slot, fences admission, commits route
generation atomically, and records planned continuation. It must never fall back to
`deploy:remote`, `/runtime/restart`, direct live-file replacement, or direct
`systemctl restart`.

### Self-deployment from a running Session

A deployment started by a Session must use a command channel that survives the
target Runtime cutover:

```text
Portable Session -> external Executor -> deploy:remote -> external finalizer
Dedicated Session -> external Executor -> deploy:dedicated -> Deploy Supervisor
```

The LXD command normally runs on a Box Executor with access to the LXD daemon.
When either command prints `accepted: true`, the initiating Tool call must end
immediately. Do not poll from that same Tool call: its durable Tool result may be
the origin barrier. Verify completion from a later turn or independent operator.
Fixed sleeps are not deployment barriers.

Final acceptance records the authoritative receipt, exact release digest, route or
generation change, readiness, Executor reconnection, Session cursor monotonicity,
continuation outcome, and absence of new structured interrupted responses.

Do not commit personal SSH targets, public domains, ports, container names, credentials, or machine paths into package scripts or docs.
