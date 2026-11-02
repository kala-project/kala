# Standalone Aspire Dashboard acceptance — 2026-10-29

**Result: PASS** on amd64 with Docker 29.9.2. The machine-readable record is `standalone-acceptance.json`; `prove-standalone.sh` reruns the isolated proof with random synthetic credentials and targeted cleanup.

## Pinned test images

- Dashboard 13.6.2: `mcr.microsoft.com/dotnet/aspire-dashboard@sha256:e4220c55fa3c3e40ad2d733ef07973392299b420e9bde6924e8f6a1e71ff01a8`
- Collector 0.139.0: `otel/opentelemetry-collector-contrib@sha256:faf125d656fa47cea568b2f3b4494efd2525083bc75c1e96038bc23f05cd68fd`
- Finite readiness client: `curlimages/curl@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6`

The Dashboard digest was obtained by pulling Microsoft's official `mcr.microsoft.com/dotnet/aspire-dashboard:13.6.2` tag. The image reported version `13.6.2+af07e33f8d1ef733645138b3f8e36067d073148d` and runs as UID 1654.

## Proven behavior

- Native runtime readiness: Dashboard `GET /health` returned `200 Healthy`; Collector `health_check` returned `200` and `Server available`.
- UI: anonymous protected page redirected to login; BrowserToken login and cookie access returned 200.
- Telemetry API: missing/wrong `x-api-key` returned 401; the configured API key returned 200.
- Dashboard OTLP traces, logs, and metrics: a valid empty protobuf request returned 401 without `x-otlp-api-key` and 200 with it.
- Collector OTLP/HTTP: missing bearer credential returned 401 and the synthetic credential returned 200.
- Real `OnlineTelemetry` exported a correlated HTTP span, safe failure log, and metrics through Collector. The protected Dashboard API returned the trace and log; its resource response reported `hasMetrics: true`.
- `OnlineTelemetry.close()` completed against live services; after both containers were stopped, a new export and close against the disconnected endpoint also completed inside a 5-second outer bound.
- A synthetic prompt/cookie/password/path sentinel supplied through untrusted route and extra attribute inputs did not occur in protected API payloads.
- No Collector error output remained after the compatibility fixes. Test containers and network were removed; no global prune was used.

## Deployment defects fixed

1. The official Dashboard image is distroless: `/bin/bash` and `/bin/sh` are absent. The prior healthcheck could never execute.
2. `otelcol-contrib validate` only validates configuration; it says nothing about the running receiver/exporter. A finite unprivileged readiness service now checks both native HTTP health endpoints, and Runtime/Gateway depend on its successful completion.
3. `AllowedHosts` omitted the Compose service DNS name, so Collector exports received HTTP 400.
4. Collector 0.139 OTLP/HTTP enables gzip by default, while Dashboard 13.6.2 reads the request body as protobuf without decompression. This produced invalid-wire-type HTTP 500 responses. The exporter now explicitly uses `compression: none` and `encoding: proto`.

## Historical scope

This record describes the original HTTP-only component slice. The current proof script additionally checks Agent timing; the newer source-bound results and their real-model/Executor limitations are in [current candidate acceptance](../current-image-acceptance.md). Extending a driver does not retroactively certify its old result against new source.

## Scope limit

This proves OnlineTelemetry's HTTP boundary spans, safe operational failure logs, and operational aggregate metrics. It does **not** prove full Agent execution traces, prompts, model payloads, tool arguments, or session content—and those sensitive payloads are intentionally excluded.
