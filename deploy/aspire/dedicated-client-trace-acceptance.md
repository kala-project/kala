# Dedicated quiet-idle tracing acceptance

Final Runtime and Gateway source: `2d04bcea`. This supersedes the trace behavior of the earlier idle-query repair, which reduced actual queries but incorrectly left each background SQL statement as a standalone root trace.

## Observed failure and two corrections

Before this repair, Aspire held 905 spans since its last reset; 93 of the most recent 100 were standalone PostgreSQL roots. Background BEGIN/query/COMMIT and lease renewal were being mislabeled as independent business traces.

The first correction (`f9511800`) removed those unparented client traces: a real 65-second window had zero client spans but still 14 readiness HTTP traces. The final correction (`2d04bcea`) makes the fixed Gateway/Runtime health routes metrics-only too; health failures retain status counters and safe error logs without linking a nonexistent trace.

Low-level PG/S3 calls with a live HTTP parent still produce real CLIENT children. Without that parent, they accumulate counts, errors and latency histograms over 30 seconds; at most 16 fixed operation/outcome/source series are retained, and two aggregate metric messages are emitted per window. This is not a Collector drop filter or an OTLP shutdown. Explicit Agent spans are unchanged; absent Agent/WS client context is not replaced with a fabricated command parent.

## Final real deployment proof

After formal exact-image no-migration cold-backup upgrade and successful real authenticated API probes, the volatile viewer history was cleared and observed for more than 65 seconds with no synthetic business requests:

- **All trace spans: 0. Unparented PG/S3 traces: 0.** The unfiltered API response was fully parsed and not truncated.
- Placement, scheduler-writer and replica-membership lease counters each continued increasing during the observation. Quiet output was not caused by stopping Runtime, PostgreSQL or renewal.
- All six expected telemetry resources continued receiving metrics.
- Actual Session-list/memo/tab reads each returned200 with Gateway→Runtime→PG parents and four Runtime PG children; anonymous, Origin and outer/inner identity negatives still rejected.
- 56 focused tests and Shared/Host/Gateway typechecks passed. The immutable production Runtime image additionally verified1001 local callbacks (not real database queries): zero trace posts, one aggregate metric post containing two metric messages, preserving1000 successes and one failure. That isolated check had networking disabled and generated no live exporter traffic.
- Final v3 backup validates2011 entries across five roots, and the original TLS CA remains unchanged. No business volume/data was deleted; cold restore, real-browser and model/Executor work remain unverified.

Exact image references, actual timestamp/window/counter deltas and redacted proofs are in [dedicated-client-trace-acceptance.json](./dedicated-client-trace-acceptance.json). Earlier receipts remain historical rather than being rewritten to claim they already solved this problem.
