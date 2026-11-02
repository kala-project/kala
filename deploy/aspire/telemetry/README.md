# Dedicated observability channel

This optional profile provides an **OTLP viewer**, not an Aspire orchestration or deployment-control UI. Lifecycle actions remain operator-owned.

## Enable and publish

The legacy six-service topology remains the default. Set these only for a new publish:

```bash
export KALA_ASPIRE_OBSERVABILITY=1
export KALA_ASPIRE_OBSERVABILITY_PORT=18888
export KALA_ASPIRE_DASHBOARD_IMAGE='mcr.microsoft.com/dotnet/aspire-dashboard@sha256:<reviewed-digest>'
export KALA_OTEL_COLLECTOR_IMAGE='otel/opentelemetry-collector-contrib@sha256:<reviewed-digest>'
export KALA_OBSERVABILITY_PROBE_IMAGE='curlimages/curl@sha256:<reviewed-digest>'
```

All three images must be operator-supplied immutable digest references. Publishing then requires three Aspire secret parameters (the generated Compose variables are `OBSERVABILITY_BROWSER_TOKEN`, `OBSERVABILITY_OTLP_API_KEY`, and `OBSERVABILITY_INGEST_TOKEN`). Generate independent random values with at least 128 bits of entropy; do not commit them, put them on command lines, or reuse application credentials. Rotate the browser token for each newly published launch as recommended by the Dashboard documentation.

- `observability-browser-token`: browser login token. Open `http://127.0.0.1:18888/login?t=<token>` locally or over a trusted SSH tunnel.
- `observability-otlp-api-key`: protects Dashboard OTLP with `x-otlp-api-key` and its telemetry API with `x-api-key`.
- `observability-ingest-token`: bearer token accepted by the internal Collector and used only by Gateway/Runtime.

Run `verify-published-compose.py` on the unresolved publication before deployment. It accepts exactly the legacy six services or nine resources: eight long-running services and one finite `observability-readiness` job. In the observability form, only Dashboard port 18888 may be additionally published, and only with `host_ip: 127.0.0.1`; Collector and Dashboard OTLP ports remain Compose-network-only.

The official Dashboard and Collector images are minimal and do not contain a shell/HTTP probe tool. The finite unprivileged curl job checks native Dashboard `/health` and Collector `health_check`; Runtime/Gateway depend on its successful completion. This is a startup check, not ongoing container-health monitoring. The Dashboard is not given a fictitious shell healthcheck. The readiness job has a separate 0.1 CPU/32 MiB cap and 1 MiB × 1 log file.

## Bounds and failure behavior

Gateway and Runtime export best-effort OTLP/HTTP JSON with a 512-item in-memory queue, batches of 64, a 2-second request timeout, one retry, and no telemetry files. Queue overflow drops the oldest observation. Export failure never fails a business request.

Collector uses bearer authentication, a 192 MiB memory limiter, batches capped at 512, an in-memory exporter queue capped at 256 requests, and retries capped at 30 seconds. Docker log rotation is 10 MiB × 3 files. Compose limits Collector to 0.5 CPU/256 MiB and Dashboard to 0.5 CPU/384 MiB. Dashboard retention and attribute limits are in `dashboard.settings.json`; its storage is ephemeral and no application-data volume is mounted.

The emitted allowlist contains service name, coarse reviewed route class, HTTP method/status class, outcome, component/operation/provider, safe fixed log messages, durations, request counts, existing LLM counters, and aggregate Runtime queue depth. It does **not** emit request/response bodies, prompts, thinking, source, file paths, query strings, credentials, raw SQL, raw error messages/stacks, session IDs, user IDs, organization IDs, or task IDs. Socket.IO/WebSocket transports are deliberately excluded from short-request spans. Trace context is passed explicitly through `traceparent`; no `async_hooks` ambient context is used.

## Agent business timing

Runtime's authoritative `LoopBroadcast.onEvent` forwards its existing persisted `EventTimingMetadata` to a stateless export bridge. It does not scan historical Sessions, replay effects, duplicate conversations, or create another business authority. Completed LLM, tool, approval, compaction, retry and recovery observations become children of an `agent.turn` span; the root is exported only when the turn has a terminal summary. Children may therefore be visible before their root finishes, as with ordinary long-running traces.

Trace/span IDs are domain-separated HMACs of the authoritative Unit scope plus internal identifiers using the high-entropy ingestion token; raw Unit/Session/turn/call IDs never leave Runtime. Reusing the same Session/turn IDs in different Units cannot merge their traces. Ingestion-token rotation intentionally changes this anonymous correlation namespace. Duplicate/out-of-order observations retain the same IDs without an unbounded per-Session map. The metrics are best-effort observations, not an exactly-once billing ledger; retries/re-observation can duplicate metric samples.

Histograms use `ms` for phase/queue/first-token/executor-reported durations and `{call}` for counts/concurrency. Labels are fixed operation/component/outcome and a small provider allowlist, not model/tool names or identities. `interrupted` exports an unset OTLP status and `execution.state=unknown`, never fabricated success or proof of failure. Tool spans are `server_observed`; existing executor-reported duration is a separate measurement, not a native remote Executor span. Recovered estimated timing remains marked as estimated.

The published model sets `KALA_OTEL_SERVICE_VERSION` to each Runtime/Gateway image's 64-character SHA-256, which the client exports as `service.version`; this identifies the actual immutable image, not release certification. HTTP Gateway→Runtime traces and Socket.IO Agent business traces remain separate trees: this bridge does not invent a Gateway command parent, native SDK spans or cross-machine propagation.

`prove-standalone.sh` requires built Shared and Host outputs. It sends synthetic timing metadata through the actual bridge, Collector and protected Dashboard; it checks returned parent/child IDs, unknown tool state, metrics presence, authentication and sensitive-field exclusion. This is a real component/transport proof, **not** a real provider, SDK or Executor business run. Those require a separate current-image acceptance.

## What is not collected

PostgreSQL, SILO, Caddy, and the product Dashboard are not auto-instrumented by this profile. Their existing health checks are real readiness signals but are not infrastructure telemetry exporters. Add infrastructure receivers/exporters only after a separate cardinality, authentication, TLS, resource, and image review; do not expose scrape or OTLP ports publicly.

No external backend is mandatory. To add one, modify the Collector config only after configuring authenticated TLS, a fixed allowlist, bounded queue/retry settings, and an immutable reviewed Collector image. Never send the Dashboard browser token or application secrets to an external backend.

## Official configuration basis

The standalone Dashboard settings follow Microsoft Aspire documentation:

- `Dashboard:Frontend:AuthMode=BrowserToken` and `Dashboard:Frontend:BrowserToken`
- `Dashboard:Otlp:AuthMode=ApiKey`, `Dashboard:Otlp:PrimaryApiKey`, and request header `x-otlp-api-key`
- `Dashboard:Api:AuthMode=ApiKey`
- `ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL`

The actual pinned-image [standalone acceptance](standalone-acceptance.md) verifies protected UI/API/OTLP, real trace/log/metric arrival, bounded disconnected export and exclusion of sensitive fixture data.

See <https://aspire.dev/dashboard/standalone/>, <https://aspire.dev/dashboard/security-considerations/>, and <https://aspire.dev/dashboard/configuration/>.
