# Dedicated observability channel

This optional profile provides an **OTLP viewer**, not an Aspire orchestration or deployment-control UI. Lifecycle actions and ingress remain operator-owned. It applies to both ingress profiles defined by the [Product Deployment Contract](../../../docs/architecture/deployment-mode-contract.md): bundled Caddy remains the backward-compatible default, while external ingress uses an existing operator-owned TLS proxy/load balancer.

## Enable and publish

Without this profile, the selected core topology is six services for `KALA_INGRESS_MODE=bundled-caddy` (the default) or five for `external`. Set these only for a new publish:

```bash
export KALA_ASPIRE_OBSERVABILITY=1
export KALA_ASPIRE_OBSERVABILITY_PORT=18888
export KALA_ASPIRE_DASHBOARD_IMAGE='mcr.microsoft.com/dotnet/aspire-dashboard@sha256:<reviewed-digest>'
export KALA_OTEL_COLLECTOR_IMAGE='otel/opentelemetry-collector-contrib@sha256:<reviewed-digest>'
export KALA_OBSERVABILITY_PROBE_IMAGE='curlimages/curl@sha256:<reviewed-digest>'
```

All three images must be operator-supplied immutable digest references. Publishing requires five independent Aspire secret parameters: the three transport/UI tokens below plus `observability-postgres-password` and `observability-silo-metrics-token`. Generate independent random values with at least 128 bits of entropy; do not commit them, put them on command lines, or reuse application credentials. Rotate the browser token for each newly published launch as recommended by the Dashboard documentation.

- `observability-browser-token`: browser login token. Open `http://127.0.0.1:18888/login?t=<token>` locally or over a trusted SSH tunnel.
- `observability-otlp-api-key`: protects Dashboard OTLP with `x-otlp-api-key` and its telemetry API with `x-api-key`.
- `observability-ingest-token`: bearer token accepted by the internal Collector and used only by Gateway/Runtime.
- `observability-postgres-password`: independent `kala_observer` login, at least 32 bytes and different from all six database credentials. It has `pg_monitor` and `CONNECT` to only the fixed `postgres`, `runlab_control`, and `kala_runtime` databases; no application-table SELECT/DML, schema creation or administration grants.
- `observability-silo-metrics-token`: official `mc admin prometheus generate --api-version v2` signed metrics-only JWT. Collector never receives SILO root access/secret keys.

Before publication, after preparing the normal root-private initialization inputs, run:

```sh
sudo python3 deploy/aspire/prepare-observability-secrets.py /secure/kala-init-secrets \
  --mc-image 'pgsty/silo@sha256:<reviewed-digest>'
```

This creates protected `observability_postgres_password` and `observability_silo_metrics_token` files. Official mc generates the JWT **offline**, inside a no-network/read-only/capability-dropped container; SILO need not be started first. Existing values are preserved on retry, not rotated. Bind their values to the two corresponding generated Aspire parameters using protected operator tooling, never command-line arguments. `initialize.sh` infers the telemetry profile from the reviewed graph, requires both private files, compares the resolved Collector credentials exactly, and provisions the monitor role before application startup. Disabling an environment flag cannot bypass this check.

For current bounded-v2 output, first use the [PID-only publication finalizer](../README.md#publishing-shape), retain raw template/ready Compose/receipt together, and run `verify-published-compose.py` on the **ready** file plus protected `.env` before deployment. Do not deploy the raw Aspire template; telemetry services and the finite readiness job also require their reviewed container PID budgets. It accepts exactly four shapes: bundled core `6`, bundled telemetry `9` (eight long-running services plus `observability-readiness`), external core `5`, or external telemetry `8` (seven long-running services plus that job). Official Aspire publication and static topology checks have passed for all four. Publication alone does not prove runtime behavior. The separate [five-service external acceptance](../external-ingress-acceptance.md) proves local verified TLS/WebSocket, fencing and application-only restore, not external eight-resource runtime recovery or a real model/Executor run. In either telemetry shape, only Dashboard port 18888 may be additionally published, and only with `host_ip: 127.0.0.1`; Collector and Dashboard OTLP ports remain Compose-network-only. External mode additionally exposes only Gateway's configured IPv4-loopback handoff and has no Caddy resource or named volumes.

The official Dashboard and Collector images are minimal and do not contain a shell/HTTP probe tool. The finite unprivileged curl job checks native Dashboard `/health` and Collector `health_check`; Runtime/Gateway depend on its successful completion. This is a startup check, not ongoing container-health monitoring. The Dashboard is not given a fictitious shell healthcheck. The readiness job has a separate 0.1 CPU/32 MiB cap and 1 MiB × 1 log file.

## Bounds and failure behavior

Gateway and Runtime export best-effort OTLP/HTTP JSON with a 512-item in-memory queue, batches of 64, a 2-second request timeout, one retry, and no telemetry files. Queue overflow drops the oldest observation. Export failure never fails a business request.

Collector uses bearer authentication, a 192 MiB memory limiter, batches capped at 512, an in-memory exporter queue capped at 256 requests, and retries capped at 30 seconds. Docker log rotation is 10 MiB × 3 files. Compose limits Collector to 0.5 CPU/256 MiB and Dashboard to 0.5 CPU/384 MiB. Dashboard retention and attribute limits are in `dashboard.settings.json`; its storage is ephemeral and no application-data volume is mounted.

The emitted allowlist contains service name, coarse reviewed route class, HTTP method/status class, outcome, component/operation/provider, safe fixed log messages, durations, request counts, existing LLM counters, and aggregate Runtime queue depth. It does **not** emit request/response bodies, prompts, thinking, source, file paths, query strings, credentials, raw SQL, raw error messages/stacks, session IDs, user IDs, organization IDs, or task IDs. Socket.IO/WebSocket transports are deliberately excluded from short-request spans. Trace context crosses HTTP services explicitly through `traceparent`. Online client spans use request-owned `AsyncLocalStorage` only within short HTTP dispatch: the store is invalidated on response finish/close, and Socket.IO/upgrade paths never activate it. Background or post-response client work emits root client spans rather than borrowing a completed HTTP parent.

## Agent business timing

Runtime's authoritative `LoopBroadcast.onEvent` forwards its existing persisted `EventTimingMetadata` to a stateless export bridge. It does not scan historical Sessions, replay effects, duplicate conversations, or create another business authority. Completed LLM, tool, approval, compaction, retry and recovery observations become children of an `agent.turn` span; the root is exported only when the turn has a terminal summary. Children may therefore be visible before their root finishes, as with ordinary long-running traces.

Trace/span IDs are domain-separated HMACs of the authoritative Unit scope plus internal identifiers using the high-entropy ingestion token; raw Unit/Session/turn/call IDs never leave Runtime. Reusing the same Session/turn IDs in different Units cannot merge their traces. Ingestion-token rotation intentionally changes this anonymous correlation namespace. Duplicate/out-of-order observations retain the same IDs without an unbounded per-Session map. The metrics are best-effort observations, not an exactly-once billing ledger; retries/re-observation can duplicate metric samples.

Histograms use `ms` for phase/queue/first-token/executor-reported durations and `{call}` for counts/concurrency. Labels are fixed operation/component/outcome and a small provider allowlist, not model/tool names or identities. `interrupted` exports an unset OTLP status and `execution.state=unknown`, never fabricated success or proof of failure. Tool spans are `server_observed`; existing executor-reported duration is a separate measurement, not a native remote Executor span. Recovered estimated timing remains marked as estimated.

The published model sets `KALA_OTEL_SERVICE_VERSION` to each Runtime/Gateway image's 64-character SHA-256, which the client exports as `service.version`; this identifies the actual immutable image, not release certification. HTTP Gateway→Runtime traces and Socket.IO Agent business traces remain separate trees: this bridge does not invent a Gateway command parent, native SDK spans or cross-machine propagation.

`prove-standalone.sh` requires built Shared and Host outputs and disables the separate infrastructure pipelines because its fixture owns no PG/SILO authorities. It sends synthetic timing metadata through the actual bridge, Collector and protected Dashboard; it checks returned parent/child IDs, unknown tool state, metrics presence, authentication and sensitive-field exclusion. This is a real component/transport proof, **not** a real provider, SDK or Executor business run. Those require a separate current-image acceptance.

## Actual infrastructure collection and limits

The same bounded Collector has three base metric pipelines, plus a bundled-only ingress pipeline, at 30-second intervals:

| Resource identity | Real source | Scope |
| --- | --- | --- |
| `postgres` | official PostgreSQL receiver via `kala_observer` | connections, commits/rollbacks/deadlocks, database sizes/counts and background-writer statistics for the three fixed databases |
| `silo` | authenticated `/minio/v2/metrics/cluster` | allowlisted capacity, health, node process and S3 requests/errors/TTFB/traffic; 5-second timeout, 512-sample/12-label limits |
| `dashboard` | HTTP receiver against product `/healthz` | observed availability/duration, not a fabricated lifecycle state |
| `ingress` (bundled only) | private Caddy `/metrics` on unpublished `8082` | request counts/inflight and request duration/size/response size; 256-sample/12-label limits, no host/path/query/user/client labels |

SILO relabeling keeps only fixed API/histogram labels, never bucket/object/user/client/server labels. SQL samples/plans and per-table/index/replication metrics are explicitly disabled; PostgreSQL uses private Compose-network transport matching the application, not publicly exposed DB ports. Existing Gateway/Runtime OTLP remains intact. These observations create real telemetry resources, not fake empty entities. A stopped service may remain in Dashboard's ephemeral history; this is **not** a complete Docker/AppHost lifecycle inventory or controller.

For an already-initialized installation, stage/review both credentials and the updated published Collector configuration first. Run the existing PostgreSQL provisioner explicitly with `--monitoring-only`, `KALA_ASPIRE_OBSERVABILITY=1`, and the protected init/operator mounts, using a disposable Runtime container. It requires the matching existing installation marker and creates/updates only the monitor identity, never initializes databases, rotates business-role passwords or reboots Owner. Then recreate only Collector with the reviewed configuration. Do **not** run fresh initialization against running writers. This explicit monitoring upgrade does not establish a general credential-rotation ceremony.

Lifecycle provenance now includes both monitoring credentials; every mounted config remains inside the protected recovery root. Old telemetry graphs missing these authorities fail closed and need explicit republishing/monitoring migration; do not relabel an older artifact's fingerprints or claim an untested old-telemetry restore. Historical no-telemetry provenance stays unchanged.

Bundled telemetry loads `otel-collector.yaml` and the read-only `otel-collector-caddy.yaml` using two explicit `--config` arguments. External telemetry loads only the base file: it neither owns nor probes Caddy. Stage the reviewed operator Caddyfile with global server metrics enabled and its private metrics listener before enabling this pipeline; keep admin disabled and do not publish 8082. Existing custom Caddyfiles must be explicitly updated without losing TLS identity. This listener exposes only aggregates within the private network, even in a core-only bundled publication.

Still missing: host/container lifecycle metrics/logs, durable telemetry history/alerts, and a complete resource topology feed. Native PG/S3 spans now cover the online factories below, not arbitrary bootstrap or remote Executor calls. No Docker socket is mounted and no arbitrary container log directory is scraped. Do not expose scrape or OTLP ports publicly.

No external backend is mandatory. To add one, modify the Collector config only after configuring authenticated TLS, a fixed allowlist, bounded queue/retry settings, and an immutable reviewed Collector image. Never send the Dashboard browser token or application secrets to an external backend.

## Official configuration basis

The standalone Dashboard settings follow Microsoft Aspire documentation:

- `Dashboard:Frontend:AuthMode=BrowserToken` and `Dashboard:Frontend:BrowserToken`
- `Dashboard:Otlp:AuthMode=ApiKey`, `Dashboard:Otlp:PrimaryApiKey`, and request header `x-otlp-api-key`
- `Dashboard:Api:AuthMode=ApiKey`
- `ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL`

The actual pinned-image [standalone acceptance](standalone-acceptance.md) verifies protected UI/API/OTLP, real trace/log/metric arrival, bounded disconnected export, and exclusion of sensitive fixture data. It is component/transport evidence, not external-ingress runtime acceptance or a real provider/Executor business run. The earlier bundled full-profile record remains bound to `1e6fd5bd`. The [new external candidate](../external-ingress-acceptance.md), source `069e6172`, bakes the `b2a8ee03` correction; its packaged tracker/bridge/client passed a real Collector/Dashboard run with synthetic indeterminate receipt/timing input. Neither component proof is a real model/SDK/Executor turn.

See <https://aspire.dev/dashboard/standalone/>, <https://aspire.dev/dashboard/security-considerations/>, and <https://aspire.dev/dashboard/configuration/>.

## Online PG/S3 client tracing

Runtime hot-state queries (including acquired transaction clients), materialization/placement/resource ownership and Gateway control-plane/origin/resource-owner queries now emit actual CLIENT spans. Runtime artifact S3 `send` calls emit `s3.put`, `s3.get`, `s3.delete`; signing a URL is not a network request and does not fabricate a span. PG span name is always `postgresql.query`, with no SQL parser or query-specific names. Attributes are fixed provider/operation/component/outcome; backend errors become `client_error`, never error text. Both successful and rejected calls are timed, and the original result/error behavior is preserved. S3 spans measure SDK send, not subsequent body-consumer latency.

The production roots supply a single shared telemetry instance to their HTTP server and online clients. Short HTTP parent context is isolated between requests and disabled after response completion. Socket.IO and upgrades never activate it. Low-level clients without an active request parent no longer create standalone root CLIENT traces: background/WS calls contribute only bounded operation/error counts and latency histograms, aggregated over 30 seconds (at most 16 fixed series). Real request clients retain their correlated child spans; explicit Agent spans remain a separate boundary. Fixed Gateway/Runtime readiness health routes contribute metrics, not business traces; failures retain error metrics and safe error logs. Startup claims, owner migrations, recovery/installation bootstrap and independent maintenance binaries remain outside this coverage. Existing Agent timing and native Executor tracing are different boundaries.

[prove-native-clients.mjs](./prove-native-clients.mjs) runs **inside each frozen image** using its actual packaged factories, an actual loopback HTTP server, real PostgreSQL transactions/rollback, and (Runtime) a uniquely owned S3 object plus missing-object error. It creates no tables/Session/model requests and deletes its object in `finally`. Supply only the existing restricted online PG/S3 credentials and protected Collector token via a temporary root-private environment file; mount the script read-only and use a bounded, disposable container on the private network. Do not copy real credentials to a build host or use provider roots. It captures the actual outgoing payload in memory for privacy/parent assertions and forwards it to the real Collector; returned trace IDs can be checked via the protected Aspire spans API. Probe HTTP spans are explicitly named `proof.*`, not mislabeled as production browser traffic. Actual public Owner requests require their separate production wiring verification.

The subsequent [Dedicated API repair](../dedicated-api-acceptance.md) closes the previous record's Owner Session-list401 and user-tabs404. Actual Session list/memo/tab reads now establish production Gateway→Runtime→PG parents with four Runtime PG CLIENT children each. Correlate these requests through W3C trace context; the versioned API's independent `x-request-id` must not be assumed to equal an OTLP trace ID. This adds real production Runtime request evidence, not native model/SDK/remote Executor end-to-end acceptance.
