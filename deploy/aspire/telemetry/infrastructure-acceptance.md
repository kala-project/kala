# Real Dedicated infrastructure observation — 2026-10-29

**Passed: real PostgreSQL and SILO/S3 measurements plus product UI availability in the running Dedicated, with protected Aspire ingestion.** This closes the earlier Runtime/Gateway-only telemetry resource gap, not all observability gaps. The [deployment contract](../../../docs/architecture/deployment-mode-contract.md) is authoritative; [machine evidence](./infrastructure-acceptance.json) binds configuration hashes and proof boundaries.

## What was observed

After restarting only the standalone Dashboard and Collector, the now-empty Dashboard received five real service resources with `hasMetrics=true`: `postgres`, `silo`, `dashboard`, `kala-runtime`, and `kala-gateway`. Runtime/Gateway telemetry was triggered by actual product requests; PG/SILO/UI observations came from active receivers. No empty resource was fabricated and the six core application/data/ingress containers were not restarted to install monitoring. Product Owner login, verified HTTPS, Runtime capabilities and protected management API continued to pass.

A separate bounded temporary Collector used the **same pinned receiver version and actual monitored servers**, with a local debug exporter rather than the production exporter, to inspect concrete numeric observations. It verified:

- `postgresql.backends`, `postgresql.commits`, `postgresql.connection.max`, `postgresql.database.count`;
- fixed `postgres`, `runlab_control`, and `kala_runtime` database aggregates;
- `minio_cluster_capacity_raw_total_bytes` and `minio_s3_requests_total`;
- `httpcheck.status` for the real product Dashboard.

This second proof establishes receiver measurements, while the cleared Dashboard proof establishes actual production-pipeline arrival. Dashboard's current telemetry API exposes resource metric availability, not a metric-value query endpoint; the record does not invent one. An initial detailed-debug probe hit its own debug queue limit; disabling that temporary queue and allowing a longer scrape interval passed. Production's bounded authenticated OTLP queues were not relaxed.

## Identity, bounds and operator behavior

- PG uses independent `kala_observer`: `pg_monitor`, login and CONNECT for the three fixed databases; no superuser/create-role/create-db/replication/bypass-RLS privileges. Application-table SELECT/INSERT/UPDATE/DELETE privileges were checked absent in both running application databases. Business-role credential fingerprints were unchanged by the monitoring-only upgrade.
- SILO uses an official metrics-only JWT. Official mc generation succeeded against an unreachable loopback endpoint, then inside a no-network/read-only/capability-dropped container using synthetic root inputs. Two consecutive preparation runs preserved every credential byte. No root key is injected into Collector.
- A separate low-memory synthetic PG authority proved fresh provisioning, refusal of monitoring-only mode without an existing installation, safe monitoring-only retry, monitor membership and application-table permission denial. It was destroyed with its owned network and private synthetic files afterwards.
- Production intervals are 30 seconds; S3 scrape timeout is 5 seconds and samples/labels are bounded. The metrics-only probe used a shorter interval only to establish measurements. SQL samples/plans and per-table/index/replication signals are disabled; S3 labels exclude bucket/object/user/client/server details. Credential values were absent from the sampled export.
- Collector retains 0.5 CPU/256 MiB limits, memory limiter and bounded queues/retries. No Docker socket or arbitrary application log directory is mounted. Credentials/configuration are covered by explicit initialization and lifecycle provenance checks.

## Verification and version boundaries

Official Aspire CLI republished all four reviewed 6/9/5/8 resource shapes with the new monitoring parameters; final topology gates passed. Actual AppHost build passed with ASPIRE010 still visible. All 37 existing Python cases passed as root; shell and Node syntax checks passed. Existing real Collector/Dashboard OTLP authentication, anonymous timing, unknown status, privacy and bounded stopped-backend component regression passed.

Runtime/Gateway images remain frozen application source `069e6172`; this is an operator/Collector configuration change, not a rebuilt application release. New-monitoring cold restore, external eight-resource runtime operation and old telemetry artifact migration are not established by this slice. No model or remote Executor business acceptance is implied.

Still open: Caddy/host/container lifecycle metrics and logs, native database/S3 client spans and full logical/native end-to-end tracing, durable history/alerting and a complete resource topology/status feed. Standalone Dashboard remains a telemetry viewer, not a Compose supervisor. A telemetry resource's existence is not proof that its container is currently alive.
