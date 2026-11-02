# Dedicated Aspire new-installation evaluation

This directory supplies a runnable, isolated new-installation AppHost evaluation, not a signed or supported production Dedicated release. It does not replace or upgrade `deploy/dedicated-systemd` or `deploy/private-cloud`, and it is deliberately not a self-deployer.

The authoritative deployment and ingress rules are in the [Product Deployment Contract](../../docs/architecture/deployment-mode-contract.md). This AppHost models two operator-selected ingress profiles:

- `bundled-caddy` (the backward-compatible default): six core services, including public HTTPS `ingress` (Caddy) in front of the private Gateway;
- `external`: five core services, no Caddy image/resource/configuration/volumes, and Gateway published only as `127.0.0.1:${KALA_GATEWAY_LOOPBACK_PORT:-13001}:13001` for an existing operator-owned TLS proxy/load balancer. That proxy must forward HTTP and WebSocket traffic and perform its own admission fencing.

Both profiles contain one Gateway, one Runtime, one independently replaceable Dashboard, same-host PostgreSQL and PGSTY SILO, operator-owned PG/SILO bind mounts, and immutable `name@sha256:digest` images. `KALA_PUBLIC_ORIGIN` is one HTTPS origin and remains the authentication, cookie, and Origin-validation authority in every profile; it is not a certificate-issuer setting or an identity-provider application-registration mechanism. Aspire 13.6.3's `Aspire.Hosting.Docker` integration publishes Compose with its implicit diagnostic Dashboard disabled. An explicitly enabled [telemetry profile](telemetry/README.md) adds two daemons and one finite readiness job, producing nine resources (eight daemons plus one job) with bundled Caddy or eight (seven daemons plus one job) with external ingress. Root-operator [cold lifecycle tools](lifecycle-operator.md) and [Owner credential commands](owner-credential-lifecycle.md) remain outside Runtime.

## Publishing shape

The official Aspire workflow starts with `aspire publish`, which generates the **raw** `aspire-output/docker-compose.yaml` template and a parameterized `.env`. Current `bounded-v2` output is deliberately not directly deployable: Aspire 13.6.3 has no typed PID-limit surface, so the reviewed offline finalizer must create a separate PID-bounded Compose plus receipt before admission. Official Aspire publication plus static topology checks have passed for all four selected shapes: bundled core `6`, bundled telemetry `9`, external core `5`, and external telemetry `8`. Publication itself is model/topology evidence only. A separate [frozen external five-service acceptance](external-ingress-acceptance.md) now proves independent synthetic TLS/WebSocket ingress and real three-root v3 recovery; it does not certify external eight-resource operation, public TLS renewal or real model/Executor work. Earlier isolated bundled-Caddy runs remain bounded evidence in the [evidence ledger](../../docs/architecture/three-mode-aspire-migration-plan.tmp.md); their Linux-only Runtime images are unsigned test artifacts, not accepted cross-platform releases. Aspire replaces absolute bind-mount paths with `.env` placeholders, so verify every path, permission, value, and secret before deployment.

Before publishing, the outside deployer must provide:

- `KALA_INGRESS_MODE=bundled-caddy|external`; omission selects `bundled-caddy`;
- immutable digest references in `KALA_GATEWAY_IMAGE`, `KALA_RUNTIME_IMAGE`, `KALA_DASHBOARD_IMAGE`, `KALA_POSTGRES_IMAGE`, and `KALA_SILO_IMAGE` (`docker.io/pgsty/silo@sha256:...`, not retired `pgsty/minio`). Bundled mode additionally requires `KALA_EDGE_IMAGE`; external mode does not;
- one pathless HTTPS `KALA_PUBLIC_ORIGIN` in both modes. Bundled mode additionally requires `KALA_PUBLIC_HOSTNAME`, accepts `KALA_PUBLIC_PORT` (default `443`), and accepts `KALA_CADDY_CONFIG_FILE` as an existing absolute regular non-symlink configuration file (default [Caddyfile](Caddyfile)). External mode requires none of those Caddy/hostname settings and accepts `KALA_GATEWAY_LOOPBACK_PORT` (default `13001`);
- `KALA_DEPLOYMENT_CONFIG_FILE`, if set, as an existing absolute regular non-symlink file; otherwise [deployment.json](deployment.json) is used. It must retain exactly the critical Dedicated values `schemaVersion: 1`, `architecture: "platform"`, `tenancy: "single-tenant"`, and `runtimeProfile: "full"`. This descriptor is not a secret, OAuth application, customer identity, or alternate storage authority;
- `KALA_RUNTIME_LLM_MODEL` and `KALA_RUNTIME_LLM_BASE_URL`; they must identify a real supported LLM service for Agent turns (a placeholder proves infrastructure startup only);
- existing absolute `KALA_POSTGRES_DATA_DIR` and `KALA_SILO_DATA_DIR` canonical, non-symlink, disjoint directories (neither root nor nested), plus existing absolute `KALA_RUNTIME_STATE_MASTER_KEY_FILE` and `KALA_INSTALLATION_ID_FILE` paths readable by Runtime. The UUID and key fingerprint must match the authority claims/checkpoint; publication does not provision them;
- every Aspire parameter emitted to `.env`, including separate Gateway/control, Runtime/writer, and SELECT-only Runtime-reader PostgreSQL URLs; shared/session secrets; SILO root and bucket-scoped Runtime credentials; an LLM key; and `oidc-client-id` / `oidc-client-secret`;
- `KALA_OIDC_ISSUER` (an HTTPS issuer Origin), optionally `KALA_OIDC_IDENTITY_ORIGIN` for private discovery transport, and an explicitly registered `${KALA_PUBLIC_ORIGIN}/auth/callback`. Dedicated uses the same OIDC client, PKCE, provider login UI and revocable PG sessions as Private Cloud. The IdP is independently operated; the repository's existing ZITADEL composition is reusable, not a mandatory public identity service.

### Dedicated OIDC Owner

Set `KALA_DEDICATED_OWNER_OIDC_SUBJECT` to the exact subject returned by the selected issuer, not an email or username. Fresh `initialize.sh` uses `bootstrap-dedicated-oidc-owner` to provision the single Organization and canonical Owner and explicitly bind that external identity. No Kala password is created. `--resume-initialized` verifies this exact existing binding instead of provisioning another Owner.

Existing password-based installations require an explicit operator transition, not a normal startup fallback: fence Gateway admission, retain a protected control database backup, apply control migration 10 and its read-only Gateway binding privileges using the migration owner, then invoke the new Gateway image's CLI with the existing Organization and principal IDs:

```sh
# Supply the existing control database owner URL through its protected *_FILE
# input, plus deployment/migration paths, OIDC_ISSUER and the verified subject.
node packages/runtime-ingress-gateway/dist/src/bin/bootstrap-dedicated-oidc-owner.js \
  --bind-existing ORGANIZATION_ID PRINCIPAL_ID
```

The transaction adds an exact `(issuer, subject)` binding without modifying the immutable canonical principal, membership, Organization, Runtime Unit or business data. It disables the legacy verifier, revokes old browser sessions and appends an audit event atomically. It refuses ambiguous tenants, wrong IDs, account merging and replacement of a different existing OIDC binding. Gateway can read but cannot change the binding. Password bootstrap/rotation/reset CLIs remain legacy operator tools, not an alternate browser login or lost-OIDC fallback.

Both tenancy modes now require the current control schema; migrate Private Cloud before starting a Gateway containing migration 10. The previously accepted cold-upgrade 7→9 lane is not an approval for arbitrary 9→10 production upgrades. Identity database, login-service credentials and client registration have their own backup/upgrade lifecycle; the existing PG/SILO application backup is not an IdP backup. HTTP loopback evaluation requires an explicit insecure-HTTP opt-in and matching browser-reachable application/issuer ports; it does not change the HTTPS publication contract.

For a single-port HTTP loopback evaluation, the optional [single-origin Caddy configuration](../private-cloud/identity-local/single-origin.Caddyfile) routes the provider's reserved login/OIDC/API paths to ZITADEL and everything else, including Kala assets, WebSockets and Executor discovery, to `KALA_GATEWAY_ORIGIN`. Publish only this proxy's loopback port and set `KALA_IDENTITY_HOST`, ZITADEL's external port/login URLs, Login's request Host and Gateway's `OIDC_ISSUER` to that same browser-reachable origin. Keep the provider's private discovery transport separate. Moving an existing issuer address is an operator transition: fence ingress, back up control and identity state, verify the same provider instance and exact subject, update only that explicit external binding, revoke old application sessions and audit the move. Never rewrite the canonical Owner or weaken issuer validation. This optional HTTP router is not a change to the HTTPS publication contract.

The Platform Dashboard uses OIDC identity and identity-scoped caches for both Dedicated and Private Cloud. Portable Executor pairing is not polled in either Platform mode. Runtime status remains available without the Portable restart coordinator; externally managed Runtime replacement is an operator action. Platform storage shows organization-bound PostgreSQL object allocation and quota with S3 object authority, not a global filesystem inventory or whole-database size. Organization Owner is the tenant administrator, not an unrestricted host administrator.

After setting publication inputs, finalize the raw template **without resolving secrets or contacting Docker** (Python/PyYAML required):

```sh
python3 deploy/aspire/finalize_published_compose.py \
  --source aspire-output/docker-compose.yaml \
  --output aspire-output/docker-compose.ready.yaml
# Fill and protect aspire-output/.env separately; do not rewrite either YAML file.
python3 deploy/aspire/verify-published-compose.py \
  aspire-output/docker-compose.ready.yaml aspire-output/.env
```

Keep the unchanged raw template, final Compose and `docker-compose.ready.yaml.publication.json` **together in the same directory**, including inside the private recovery root. The finalizer adds only the service-level `pids_limit` and matching `deploy.resources.limits.pids`; it retains every other graph value semantically. It creates private files atomically without overwriting existing output/receipt. An interrupted pair is not deployable: preserve it for diagnosis and select a fresh output name; never delete/recreate a receipt to bypass review. Admission verifies both hashes and re-derives the exact PID-only transformation, but this is not a signature, release provenance or authorization against a hostile root operator. `.env` remains separately protected and admitted. Use the **ready** file for initialization, all lifecycle commands and deployment, never the raw v2 template. Older examples naming `docker-compose.yaml` mean their reviewed historical/frozen input, not a bypass for new v2 output.

Review finalized Compose before an outside terminal or CI system deploys it. Run the topology gate with Docker Compose available after filling protected bind-mount paths. For bundled mode it must find only Caddy's configured public HTTPS port (plus an optional loopback telemetry UI); for external mode it must find only the Gateway's IPv4-loopback handoff (plus that optional UI), with no ingress resource or application-owned named volume. In every mode it rejects unfilled paths, unreviewed services, public data ports, application-data mounts, mutable image references, and the implicit Aspire debug Dashboard without printing resolved secrets. This static gate cannot attest image provenance, role/bucket policy, credential strength, external proxy/TLS correctness, fencing, or recoverability.

## Explicit Copilot authentication and native control proof

The maintained AppHost defaults to `KALA_COPILOT_AUTH_MODE=unconfigured`. This adds no Copilot credential/auth-mode variables. The separately versioned `bounded-v2` execution profile adds the immutable CLI path and isolation settings; an old frozen graph is not silently rewritten. Opt in with `KALA_COPILOT_AUTH_MODE=github-token` **before publication** to declare the secret Aspire parameter `dedicated-copilot-github-token` (a Dedicated-specific Compose placeholder, not a standard SDK token variable). Fill its emitted `.env` binding from an independently provisioned private credential file, keep that resolved file root-owned/private, and run the normal topology/initialization admission before starting containers. Do not put a token in command arguments, chat, source control or public receipts. No host `GH_TOKEN`/`GITHUB_TOKEN`, SDK HOME or browser state is inherited. Only Runtime receives `COPILOT_GITHUB_TOKEN` and the selected-mode marker; missing/blank tokens, unknown selected modes, ambiguous fallback tokens and forwarding credentials to other services are refused. This checks configuration, **not token validity or model availability**.

Copilot authentication does not currently remove the separate native Runtime service's mandatory Kernel LLM model/base-URL/key prerequisites. A real Agent installation must supply the required independent provider configuration as well; the control-only fixture below deliberately uses a clearly labelled placeholder Kernel key and an unreachable loopback provider endpoint and never requests a model turn. Such a fixture is not a usable model installation. Enabling/changing Copilot identity is not a Dashboard-only or schema-7→9 image change: those lanes must retain frozen configuration. Copilot identity is included in deployed/backup authority fingerprints; old unconfigured fingerprints remain unchanged. Rotation, account migration and per-user OAuth need a separate reviewed ceremony and are not implemented here.

[`native-control-acceptance.py`](./native-control-acceptance.py) runs the actual AppHost publication, fresh PG/SILO initialization and Owner claim, native Gateway/Runtime/UI, verified local TLS, authenticated `client:list_sessions`/`server:sessions` roundtrip plus runtime catalog, user memo/tab writes with stale-revision/untrusted-write rejection, and application-container recreation with the same Owner cookie and PG documents. It also separately publishes and checks the opt-in authentication shape without starting it with the synthetic token. It uses no existing instance, model service, Executor or subagent. The current driver runs the published resource/isolation settings unchanged; no resource override, application command, health probe or entrypoint is substituted. It also checks live Docker/cgroup limits, capability/no-new-privileges state, real root-write/direct-execution refusal, private bounded Runtime scratch, actual immutable SDK-pair startup and scratch disappearance after recreation.

Run from an isolated worktree with local immutable images, matching `dotnet/` and `aspire-cli/aspire` under the tool directory, Python/PyYAML, host Node dependencies, passwordless scoped Docker/root operations and at least 4 GiB available memory:

```sh
python3 deploy/aspire/native-control-acceptance.py \
  --tools-dir /private/acceptance-tools \
  --image-record /private/acceptance-images.json \
  --result /private/new-native-control-result.json
```

The [2026-10-30 bounded native-control receipt](./native-control-acceptance-2026-10-30.json) records the real control-chain pass and the separate final authentication-publication pass, including the earlier failed attempts and the still-blocked overall business gate. `--publish-only` repeats just the default/opt-in publication and ambient-token interference checks without starting application services.

The image record must contain `images` for exactly `runtime`, `gateway`, `dashboard`, `postgres`, `silo` (all local `@sha256:` references), `runtimeSource`, `dashboardSource` and an honest `gatewayProvenance` description. The script checks cached Runtime/UI source equivalence; this is not release provenance verification. Receipts deliberately retain `overallAcceptance: blocked` and a separate Agent/Executor gate even if `nativeControlGate: passed`. Private credentials/diagnostics/data remain in the newly printed owned fixture for inspection; after confirmed Compose cleanup remove **only that fixture**, never shared data or SDK state. A real authenticated model turn, independent Executor/file-tool receipts and continuation across reconstruction remain required for full Dedicated business acceptance.

## Bounded execution profile

The historical [2026-10-30 bounded-v1 execution receipt](./bounded-execution-acceptance-2026-10-30.json) records that version's real native/container/kernel/SDK checks, recreation persistence, four actual publication shapes and 44 lifecycle regressions. It supersedes only the earlier control fixture's resource-override evidence; it does not turn its blocked Agent/Executor gate into a pass.

The [bounded-v2 PID execution receipt](./pid-bounded-execution-acceptance-2026-10-30.json) binds implementation `8d5d30fb`, real five-service Docker/kernel PID ceilings before/after recreation, four actual finalized publication shapes, and 46-scenario regression coverage (45 unchanged scenarios plus the final isolated control-upgrade/recovery rerun). It retains earlier failed attempts and the real-CLI fixture budget correction; it does not claim a single combined green suite run or full authenticated Agent/Executor acceptance.

The maintained AppHost marks `KALA_DEDICATED_EXECUTION_PROFILE=bounded-v2` on Gateway. In addition to the v1 baseline, every service must have its exact reviewed positive container PID budget in both standard Compose fields and an intact PID-only publication bundle; raw templates, unlimited/mismatched budgets and shared-UID `ulimits.nproc` are refused. Frozen bounded-v1 inputs remain that version, not v2 conformance. The topology gate reports this profile explicitly, rejects unknown versions and refuses weakened app roots/users/capabilities/privileges, executable/unbounded/unreviewed scratch, mutable CLI selection and missing/non-positive/non-finite CPU/memory limits. Old unmarked frozen graphs are reported as `legacy-unmarked`; accepting them preserves historical operator compatibility, **not** new-profile conformance. Switching an existing installation to this profile requires a reviewed **full cold configuration transition**, not a Dashboard-only or schema-7→9 image-only operation.

Default core ceilings (not capacity reservations):

| Service | CPU | Memory | Container tasks/PIDs |
| --- | ---: | ---: | ---: |
| Runtime | 2 | 2048 MiB | 512 |
| Gateway | 1 | 512 MiB | 128 |
| PostgreSQL | 1 | 512 MiB | 256 |
| SILO | 1 | 512 MiB | 512 |
| Product Dashboard | 0.5 | 256 MiB | 64 |
| Bundled ingress, if selected | 0.25 | 128 MiB | 128 |
| Telemetry Dashboard, if selected | 0.5 | 384 MiB | 256 |
| Collector, if selected | 0.5 | 256 MiB | 128 |
| Finite readiness job, if selected | 0.1 | 32 MiB | 32 |

PID budgets count **threads as well as processes**, are container cgroup limits (not a shared host-UID process quota), and are not proven production concurrency capacity. The maintained central map is [execution_profile.py](./execution_profile.py); changing this version's defaults is not an implicit tuning operation. A new reviewed profile/configuration transition is required rather than silently changing old v2 semantics. No fork bomb or process-exhaustion experiment is needed to verify the configured kernel ceilings.

Telemetry retains Dashboard384MiB/0.5CPU, Collector256MiB/0.5CPU and one-off readiness32MiB/0.1CPU. Runtime/Gateway/UI each have a 64MiB `/tmp`; Runtime additionally has private UID/GID65532 mode0700 scratch at `/app/packages/host/.runtime-tmp`, capped at 512MiB. All those mounts are noexec/nosuid/nodev; Runtime uses the root-owned immutable `/app/copilot-runtime/copilot-runtime` plus adjacent `runtime.node`. Used tmpfs pages count against the container memory limit; the size is a maximum, not allocated RAM. `noexec` prevents direct execution on that mount, not arbitrary interpretation by an already-running trusted interpreter, and this is not VM isolation.

Fenced one-off PostgreSQL/claim/schema/Owner jobs remain a separate initialization boundary: root-owned private secret projections, all ambient capabilities dropped and only `DAC_OVERRIDE` to read application-owned packaged files. They inherit the new profile's read-only root/no-new-privileges. This capability is never added to steady-state Runtime/Gateway/UI; SILO provisioning retains its existing restricted separate service. PG/SILO data are not disposable tmpfs and their initialization privileges/read-write roots are not claimed fully hardened.

The limits bound this graph, not other projects, builds or the entire host. Reserve target-host headroom, review custom sizing and accept real model/concurrent workload capacity separately. Resource exhaustion is not a replay permission. Public TLS, production HA, real concurrent-workload sizing, data-service least privilege, signed artifacts and the full independent-authenticated Agent/Executor gate remain open.

## Isolated Linux x64 image acceptance

`Dockerfile.runtime-linux-e2e` builds the real Runtime/Executor packages and the CJS-only release assets without fabricating missing Windows native Executor files. It runs the standard unsigned release-asset verifier; its resulting image is **Linux x64 test-only**, not a signed or cross-platform release. The AppHost serves its verified `/app/release` assets for public Executor installation requests; that read-only installer route is separate from Dedicated's single authority-bearing Unit. Gateway and Dashboard use their existing Private Cloud image Dockerfiles. A locally built image ID can be used by a separately reviewed, isolated test override, but it is not a registry digest and must never be substituted for the AppHost's immutable `name@sha256` release-image contract. No image is published or pushed by these instructions.

For a clean, gitless **test-image** context, export a committed snapshot and the existing release builder's tracked-docs manifest together. Do not copy the working directory, `node_modules`, local captures or Session data:

```bash
revision=$(git rev-parse HEAD)
context=$(mktemp -d)
git archive "$revision" | tar -xf - -C "$context"
git ls-tree -rz --name-only "$revision" -- docs/ > "$context/docs/.tracked-release-docs"
# Build using the Dockerfile and files inside "$context", with SOURCE_REVISION="$revision".
# Supply RELEASE_TAG matching package.json’s product version and RELEASE_REPOSITORY explicitly; retain the normal unsigned asset verifier.
```

The one-shot SILO provisioning job retains a read-only root, dropped capabilities, no-new-privileges and a bounded 256 MiB budget with `GOMEMLIMIT=128MiB`; the former 128 MiB limit caused a real OOM during policy attachment on the pinned image. This is a provisioning-client budget, not server capacity sizing.

This intentionally excludes uncommitted changes. The manifest is Git-derived and NUL-delimited; never replace it with a directory walk to bypass the release builder's privacy boundary. Clean Runtime/Dashboard builders use a bounded five-minute `PNPM_FETCH_TIMEOUT` (milliseconds; override only as a reviewed build argument) for large editor/diagram packages. This changes neither frozen-lockfile integrity nor TLS verification, and is unrelated to the five-second runtime secret-resolution deadline. These steps produce local test images, not signed supported releases.

## Fresh single-host initialization

`initialize.sh` is the only modeled path from empty PG/SILO authority to the selected five- or six-service core graph. Do not run `docker compose up` first. The script rejects running application containers, runs the static topology gate, compares resolved Compose credentials to protected files without printing values, starts only PostgreSQL and SILO, then performs:

1. fail-closed PostgreSQL provisioning with an installation marker in the maintenance database, separate `runlab_control` and `kala_runtime` databases, and fixed owner/writer/reader roles;
2. `kala-runtime` bucket creation, versioning, anonymous-access denial, and a bucket-only Runtime policy through a separate one-shot container with a reviewed immutable mc-capable image (the pinned PGSTY SILO image includes its matching `mc` client);
3. the real `kala-fresh-storage-claim` CLI, which claims empty control PG, Runtime PG, and SILO and creates the initial coordinated recovery checkpoint;
4. the real Gateway control-plane initializer and `kala-postgres-migrate`, granting DML to Runtime and only the reviewed query tables to Gateway's distinct Runtime reader;
5. the real `bootstrap-dedicated-oidc-owner` CLI with the explicitly selected issuer/subject; only after it succeeds are application services started.

Run `initialize.sh` as the root operator. Create a root-owned directory with mode `0700`; every file below must also be **root-owned**, regular, non-symlink and mode `0600`. The capability-restricted provisioning job cannot read another UID’s private files, even when its container user is zero; ownership/permissions are checked before mutation:

| file | required content |
| --- | --- |
| `postgres_admin_url` | `postgresql://postgres:<unique-password>@postgres:5432/postgres` |
| `control_owner_url` | `postgresql://kala_control_owner:<unique-password>@postgres:5432/runlab_control` |
| `gateway_database_url` | `postgresql://kala_gateway:<unique-password>@postgres:5432/runlab_control` and exactly the published Gateway URL |
| `runtime_owner_url` | `postgresql://kala_runtime_owner:<unique-password>@postgres:5432/kala_runtime` |
| `runtime_database_url` | `postgresql://kala_runtime:<unique-password>@postgres:5432/kala_runtime` and exactly the published Runtime URL |
| `runtime_reader_database_url` | `postgresql://kala_runtime_reader:<unique-password>@postgres:5432/kala_runtime` and exactly the published Gateway reader URL |
| `silo_root_access_key`, `silo_root_secret_key` | exactly the published SILO root pair; never used by Runtime |
| `runtime_s3_access_key`, `runtime_s3_secret_key` | distinct bucket-scoped pair, exactly the published Runtime pair |
| `installation_id` | canonical UUID, identical to the published installation-ID bind mount |
| `runtime_state_master_key` | identical bytes to the published Runtime state-master-key file |
| `owner_password` | initial Dedicated Owner password (at least 14 characters) |

With the telemetry profile, also prepare root-private `observability_postgres_password` and `observability_silo_metrics_token` via [the offline monitoring preparation step](telemetry/README.md#enable-and-publish), before binding the corresponding Aspire parameters. The initializer infers this requirement from the reviewed service graph; no business/root credential is reused for collection.

Percent-encode URL credentials. All six PostgreSQL passwords must differ. Set `KALA_MC_IMAGE` to a reviewed immutable mc-capable image such as the same `pgsty/silo@sha256:...` digest used by the SILO service, `KALA_DEDICATED_ORGANIZATION_NAME`, and optionally `KALA_DEDICATED_OWNER_EMAIL`, then run:

```bash
KALA_MC_IMAGE='pgsty/silo@sha256:<reviewed-digest>' \
KALA_DEDICATED_ORGANIZATION_NAME='Example' \
./initialize.sh aspire-output/docker-compose.ready.yaml aspire-output/.env /absolute/protected/init-secrets
```

The full syntax is `initialize.sh <compose> <env> <protected-secrets> [--initialize-only|--resume-initialized] [--acknowledge-external-ingress-fenced]`; optional flags are order-independent. External mode requires explicit independent admission fencing before mutation. `--initialize-only` leaves applications stopped after bootstrap. Partial cross-authority claims or ambiguous Owner bootstrap results require investigation, never implicit success or credential reset. With applications stopped and the same reviewed configuration, `--resume-initialized` skips PG/SILO provisioning, claims, migrations and Owner creation; `bootstrap-dedicated-oidc-owner --verify-existing` verifies the explicit issuer/subject binding, single active Organization/Owner and contract. Runtime/Gateway retain installation/checkpoint/state-key checks. This is continuation, not OIDC recovery, a password-to-OIDC upgrade or an accepted backup/restore point.

### Bounded startup and restart

Republish with the current AppHost and finalize its raw template before using the updated initializer. All selected long-running services have executable Compose health checks (5-second interval, 4-second timeout, 12 retries, 20-second start period) and `unless-stopped` restart policy. The topology gate rejects missing/disabled probes and missing, symlink/alias, equal or nested authority roots **before mutation**. `initialize.sh` treats running, restarting or paused application containers as active writers; a failed inspection does not mean stopped. It waits for PG/SILO health before initialization/verification and uses `docker compose up -d --wait --wait-timeout` before reporting a healthy application graph. Requires a Compose version supporting these flags. `KALA_ASPIRE_START_TIMEOUT_SECONDS` is an explicit 1–900-second bound, default 180.

Runtime's probe uses the existing internal service credential and requires state `ready`, so a draining Runtime is not healthy. Gateway/Dashboard use their health endpoints; the Gateway probe uses native HTTP with the configured public Host (Node fetch does not preserve that override here), so the public Host allowlist is not relaxed; PG uses `pg_isready`; SILO uses its readiness endpoint. In bundled mode, Caddy has a **container-loopback-only** HTTP liveness listener on 8081; it is not published, does not disable certificate checks, and does not replace public HTTPS. External mode has no Caddy probe; the operator separately verifies the external TLS/proxy path. These probes are process/graph health, not proof of real Agent work, ongoing database/object authorization, public TLS or a complete transaction. Initialization/Owner and application claim/schema gates remain separate requirements.

On timeout/failure, the script returns nonzero and does not print readiness success. Containers and data are left intact for inspection; it does not prune, reset claims or automatically roll back unknown work. Stop/isolate application writers before an explicit continuation. After a successful install, ordinary restarts do not rerun bootstrap; use the same verified Compose graph and bounded `up --wait`. Do not use `--resume-initialized` to bypass a version upgrade/migration or recover an unknown password.

## Isolated replaceable-Runtime and parallel-protocol acceptance

This source-level acceptance explicitly opts into the existing PostgreSQL `parallel-v1` gate; it does **not** change the default single-Runtime Aspire publication or operate an existing installation:

```bash
KALA_RUN_PRIVATE_CLOUD_STORAGE_INTEGRATION=1 \
KALA_PARALLEL_ACCEPTANCE_PRODUCT=dedicated \
KALA_RUN_REAL_BROWSER_INTEGRATION=1 \
pnpm --dir packages/host exec vitest run \
  src/tenant-runtime/private-cloud-parallel-v1.integration.test.ts
```

Run from the repository root with the reviewed digest-pinned images available and permission for `sudo -n docker`. The harness owns fresh UUID-named containers/network/Workspace volume and temporary keys, uses separate newly claimed PG authorities, real Dedicated Owner authentication, two independently disposable Runtime directories, and a real external Executor. It removes its own resources afterward. Application code is mounted read-only from the selected worktree, so this is not immutable-release-image or production-deployment acceptance. Omitting the product selector retains Private Cloud coverage; genuine Chromium is separately opt-in, not implied by the Node fault driver.

The five Dedicated cases cover real tool execution, genuine Chromium history, kill/takeover, cold container replacement plus PG partition/stale-writer rejection, and S3 outage/publication refusal/recovery. All returned export objects, including persisted inline LLM request/response artifacts, are hash-checked after failover. PG exports no longer depend on a Runtime output directory. External shell crash/receipt behavior is separately covered by the Executor's genuine SIGKILL suite; queue/native/DAG/scheduler owner and recovery semantics use the isolated PG suites.

One bounded measurement on the shared test host used 80 committed preference writes across two owner-routed Sessions per window:

| Window | Writes/s | p50 / p95 ms | Combined projection JSON bytes | Delta audit bytes added | Cluster WAL bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Two Runtime, short history | 148.37 | 13.30 / 16.78 | 114,928 | 14,141 | 2,202,120 |
| Two Runtime, extended history | 116.74 | 16.13 / 21.18 | 261,686 | 14,240 | 3,054,656 |
| One Runtime, same extended history | 90.05 | 21.48 / 28.56 | 261,686 | 14,240 | 2,654,360 |

The extended fixture adds eight actual deterministic tool turns and about 8 KiB synthetic user context per turn to each Session. This run observed approximately 1.30x two-vs-one throughput, not 2x. Its 11/13/14 online lock-waiter samples saw no waiter; sampling can miss short waits and does not measure cumulative wait time. WAL covers the whole cluster during each window, including leases/control/checkpoints; the larger two-node window is not per-request WAL attribution. Initial export emitted 14 objects / 159,404 bytes and 14 actual SILO PutObject requests, with no GetObject requests in that publication window. Subsequent authenticated reads and retries are separate costs. Metrics are bounded fixture evidence, not provider-token throughput, billing prices, a soak test or a production capacity SLA.

The measured long-history penalty is not hidden: Session projections are still full-document JSONB writes, while audit events are structural deltas and native SDK appends use immutable chunks. Splitting hot metadata from large Session state is a separate schema/compatibility change, not a reason to batch away committed acknowledgements or weaken owner checks. Default publication, release images, HA and operator-lifecycle limitations below remain in force.

## Known omissions and blockers

This is a runnable **experimental single-host installation**, not a supported Dedicated release. Earlier schema-7 builds passed fresh PG/SILO provisioning, three-authority claims, Owner login, real Copilot/Executor tool execution and the isolated coordinated cold-recovery subset (see below). Those historical results do not certify the current schema-9 source or its complete image set. Ordinary same-schema and Dashboard tools still refuse migrations; a separate reviewed cold [control-schema 7→9 lane](lifecycle-operator.md) binds exact packaged migrations, atomic SQL/grants and original-predecessor recovery to durable receipts. Its real PG/S3/Owner component evidence is not current full business acceptance. A supported cross-platform release and complete production lifecycle have not passed. Remaining boundaries are:

1. **Owner credentials now have explicit operator lifecycle commands.** Normal change verifies the original password; deliberate local-root recovery uses protected new/confirmation files. Both preserve canonical identity, deny inactive authority, and revoke prior PG browser sessions atomically. See [Owner lifecycle](owner-credential-lifecycle.md). These are CLI operations, not a new end-user settings UI.
2. **Initialization is an external operator transaction, not an Aspire startup resource.** `initialize.sh` enforces health/claim/schema/Owner ordering, while generated Compose contains six bundled or five external core services, or respectively eight or seven long-running services plus one completed readiness job when the explicit observability profile is enabled. Bypassing it is unsupported; application claim and schema checks fail closed but cannot prove the operator followed the whole ceremony.
3. **SILO acceptance remains limited.** Initialization creates a versioned private bucket and bucket-scoped identity and the real claim exercises listing/version listing/conditional marker creation. The cold-restore drill additionally preserved object versions and tested replacement credentials with former identities rejected. Licensing, retention/object-lock policy, full multipart compatibility, online rotation and fault-injected partial-claim recovery remain unverified.
4. **Security hardening is incomplete.** The maintained finalized `bounded-v2` graph has CPU/memory/container-PID limits and bounded logs for every selected service. Runtime/Gateway/product Dashboard have explicit UID65532, read-only roots, all capabilities dropped, no-new-privileges and reviewed bounded noexec/nosuid/nodev tmpfs. Runtime scratch is no longer an image-overlay writable tree; PG/S3 remain the only durable authorities. Data-service privilege/read-write-root reduction, real target-host capacity/soak and stronger network partitioning remain open. `WaitFor` still expresses model ordering, not migration readiness; explicit Compose probes/wait now add graph-health gating, not complete application acceptance. Aspire build currently emits `ASPIRE010` because this AppHost does not opt into the CLI bundle; publication succeeded with a matching temporary CLI, but supported long-term toolchain pinning is pending.
5. **Public edge acceptance is unverified.** A bundled `localhost` Caddy run issued a local CA certificate and served HTTPS; publicly trusted ACME/DNS/renewal were not tested. A local independent synthetic proxy has passed verified TLS, authenticated WebSocket, admission fencing and application-only recovery; that is not a production load-balancer or public-certificate ceremony. Caddy and automatic certificate issuance are profile choices, not product requirements.
6. **Supported images are not supplied.** Locally built unsigned Linux acceptance images do not substitute for a provenance-verified Kala release and an accepted SILO digest. Successful marker/checkpoint conditional writes and an offline whole-tree restore are only the recorded subsets, not acceptance of all SILO compatibility, backup retention, licensing, multipart or failure modes.
7. **Backup/recovery/full-upgrade remain cold and restricted, not fully production-qualified.** Those operator lanes stop ingress/application writers, prove clean authority shutdown, archive complete PG/SILO/private recovery roots and restore to new empty destinations. The separate [independent Dashboard lane](lifecycle-operator.md) permits only a reviewed Dashboard image change and explicit receipt-bound rollback, without restarting Runtime, Gateway or data services; its controlled Docker protocol acceptance is not real Agent continuation or production UI compatibility acceptance. Exact reviewed same-schema/same-PG-major full-upgrade policies require a completed backup and still refuse migrations. The separate control-schema lane permits only 7→9, fixes Runtime/data/observability images and configuration, and restores an original receipt-bound backup to fresh roots rather than downgrading SQL. Observability now has real authenticated Dashboard/Collector acceptance, but basic real PG/SILO metrics and product-UI availability are now collected, while native Agent/Executor end-to-end tracing, host/container lifecycle metrics, alerting and durable telemetry history remain open. The subsequent online-client/ingress follow-up adds actual PG/S3 CLIENT spans and Caddy aggregates. Provider-specific credential rotation, additional migration ranges, real application failure recovery and latest-image full business acceptance still require evidence. There is intentionally no Supervisor, blue/green pair, or Runtime self-deploy path.

Do not run `docker compose down -v`, broad prune commands, or any legacy migration against these paths. Remaining release, hardening and lifecycle gates require their own isolated acceptance; the cold restore already recorded below is not a blanket sign-off.

## Operator lifecycle entry points

See [cold backup, restore and upgrade](lifecycle-operator.md), [Owner password change/recovery](owner-credential-lifecycle.md), and [protected observability](telemetry/README.md). These are independent, explicit operations; initialization must not be used as an upgrade or password-recovery command. Initialization and lifecycle tools share the host lock. For backup, stage the reviewed Compose, private `.env`, identity/key files and **all** non-data bind configuration files under one private root-owned recovery-material directory; data roots must be outside it. The exact mounted identity/key and authority credentials are verified, not a similarly named copy. Backup artifacts contain secrets and must be kept private with a separate off-host custody policy. New backups use artifact schemaVersion 3 and bind `ingressMode` and ingress-identity custody. Bundled artifacts contain exactly five roots—PostgreSQL, SILO, protected recovery material, and Caddy `/data` and `/config`—with custody included. External artifacts contain exactly three—PostgreSQL, SILO, and recovery material—and report `external-not-in-app-backup`; external proxy certificates, keys, issuer state, and trust distribution remain outside application custody. External backup, restore, and upgrade apply require `--acknowledge-external-ingress-fenced`. External restore also retains `--acknowledge-source-fenced`, rejects `--create-fresh-caddy-volumes`, and reports `ingressIdentity: external-not-restored`. Restore and upgrade are same-mode only; cross-mode operations are rejected. Bundled restore still requires `--create-fresh-caddy-volumes` with two reviewed nonexistent names. Bundled five-root v2 and bundled trust-reset v1 read compatibility remain as documented in the lifecycle guide. Preserved Caddy state is not public ACME/DNS renewal evidence.

`lifecycle-status.sh` reports per-service state, health, OOM, exit/restart counts, authority filesystem capacity/inodes and host memory without echoing environment or container logs. It is an on-demand snapshot, not historical monitoring or alerting.

## Historical verified recovery boundary

The earlier isolated acceptance used the actual operator initialization, schema 7 and a real organization-invited Executor over CA-verified HTTPS. It stopped application writers, advanced the existing three-authority checkpoint, backed up control/Runtime PG plus the entire stopped SILO data tree and protected state key, and restored to independent directories. Replacement PG/S3 workload credentials rejected the old credentials; wrong-key startup was refused. Real SDK model memory resumed without the original application-node scratch, the artifact hash survived, and the original external device reconnected and executed another real tool call.

That historical drill is a **cold, operator-controlled recovery subset**, not evidence for the later automated backup/restore command, a production HA claim, a supported upgrade/rollback decision or a guarantee about arbitrary in-flight effects. The external Executor workspace/device identity and provider credentials have separate recovery contracts. SILO needs adequate real free space: a genuine 507 low-watermark failure was preserved in the evidence; do not delete partial installation markers or lower storage safety thresholds to make initialization appear successful. The tiny persistent loop-backed filesystems used in that drill are test infrastructure, not deployment sizing guidance. See the evidence ledger for exact image/revision, credential boundaries and remaining gates.

## Historical initialization acceptance (2026-10-29)

The [bounded evidence record](../../docs/evidence/evaluation/dedicated-aspire-initialization-20261029.json) binds application images built from `c948fe30` to the corrected outside-operated AppHost/initialization scripts at `d2afae3c`. This was the bundled-Caddy graph, not the new `external` ingress profile. Application code is unchanged by the later operator-only corrections. Official .NET SDK 10.0.403/Aspire CLI 13.6.3 built and published the actual model. The six Docker-registered OCI digests are recorded; they are unsigned local test artifacts, not registry-provenance or release certification.

The real isolated run rejects unsafe input ownership before creating any container; initializes fresh PG/SILO/claims/schema/Owner with only authorities left running; refuses wrong-password continuation; starts all six healthy services with the original identity; and passes CA-verified HTTPS Owner login. A wrong 32-byte state key causes Runtime checkpoint rejection and a nonzero startup result with no readiness success. Restoring the original key permits explicit continuation without reinitialization, and the same opaque Owner login session remains usable after application restart. The fixture used only synthetic credentials/state and no Agent business Session. All its containers, networks and project-specific Caddy volumes were removed.

The same drill preserved a real provisioning-client OOM and showed that a raw-loopback/fetch Gateway probe is rejected by the existing Host policy; native HTTP with the configured public Host succeeds. The limits/probe are fixed without disabling capability, TLS, Host or release-asset checks. Local CA read permissions were corrected in the client fixture, not bypassed. Gateway Owner tests passed 8 cases (including real PG/committed-child SIGKILL), topology 2, existing release/privacy regressions 22; actual AppHost build passed with the known ASPIRE010 warning retained. This new initialization slice does not inherit the older real SDK/Executor acceptance as evidence for these images. The newer operator/credential/observability work below has separate evidence; this initialization record does not certify its recovery, upgrade, full latest-image Agent, public TLS, hardening or release gates.

## Current operator and observability candidate (2026-10-29)

[Frozen external-ingress acceptance](external-ingress-acceptance.md) binds source `069e6172` to new Runtime/Gateway images, a real five-service external graph and production artifact-v3 three-root recovery. Independent verified TLS, Owner cookie, authenticated WebSocket and exact SQL/S3 markers survived application-only restore; external certificate custody stayed separate. The earlier `b2a8ee03` correction is now baked and was exercised in the frozen Runtime against real Collector/Dashboard with synthetic indeterminate timing input, not a real model turn.

[Earlier bundled acceptance](current-image-acceptance.md) remains bound to `1e6fd5bd`: nine-resource operation, packaged Owner change/reset and bundled artifact-v2 trust-preserving recovery. Neither record silently inherits the other's profile or historical distinct-image upgrade evidence. External eight-resource runtime recovery, bundled-v3 PKI runtime recovery, continuous infrastructure/history/alerts, latest-image real SDK/Executor/child work, generic startup-secret/state-key rotation, public TLS/soak/hardening and signed supported release remain open.

## Infrastructure observation follow-up

[Real infrastructure acceptance](telemetry/infrastructure-acceptance.md) closes the earlier Runtime/Gateway-only resource gap with real `postgres`, `silo` and product `dashboard` observations. It verifies all three fixed databases, actual S3/capacity metrics, monitoring-only privilege isolation, fresh offline secret preparation and official four-profile publication. Runtime/Gateway images remain the frozen `069e6172` pair; this follow-up changes deployment/operator/Collector configuration, not application images. A standalone telemetry resource list still is not a full AppHost/Docker lifecycle topology. Native database/S3 client tracing, Caddy/host metrics and durable history/alerts remain separate gaps.


The [online-client and ingress follow-up](telemetry/native-client-ingress-acceptance.md) supersedes only the earlier record's missing PG/S3 client and Caddy coverage. It builds new Runtime/Gateway images, validates real packaged clients against restricted running PG/S3, then performs a policy-reviewed cold-backup upgrade. Bundled telemetry now mounts an additional read-only Caddy scrape configuration; external telemetry intentionally does not. Full lifecycle/log inventory, remote/native Agent tracing and durable history/alerts remain separate work.

## Dedicated API handoff follow-up

[Current-image API acceptance](dedicated-api-acceptance.md) closes the earlier authenticated Session-list401 and memo/tab404. New Gateway-managed Platform composition requires the verified ingress actor in either tenancy mode; legacy direct Dedicated Token authentication remains and still rejects forged ingress headers. User state now uses the complete permission-checked Unit/service/Organization/role/principal handoff with same-origin cookie writes. The final image pair is frozen from source346b92fc; three actual Owner read routes returned200 and each had four production Runtime PG CLIENT children under Gateway→Runtime HTTP spans. This is not a real model/Executor run or successful live memo-write test.

### Idle PostgreSQL load repair

The later [idle-load acceptance](./dedicated-idle-pg-acceptance.md) supersedes the earlier Runtime image: source `00685518` removes read-triggered lease writes and per-second calendar polling; actual scheduled-state scans fall 97.8% and scheduler-lease writes 93.7%. Necessary fenced heartbeat remains; default discovery delay is now up to 30 seconds plus processing time. Old Aspire history was cleared, not business data.

### Quiet-idle trace correction

The later [quiet-idle acceptance](./dedicated-client-trace-acceptance.md) supersedes the earlier idle-load repair for tracing: final source `2d04bcea` preserves real request CLIENT children, aggregates unparented clients and reports readiness via metrics/error logs. The final real 65-second idle window had **zero total trace spans**, with all three leases renewing and all six resources receiving metrics.
