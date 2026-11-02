# Dedicated API and trusted user-state handoff — 2026-10-29

**Passed for this slice:** the running Dedicated now returns 200 for authenticated Owner Session listing, memo and user tabs, with real Gateway → Runtime → PG parents/children in Aspire. The former 401/404 failures are closed by code and current-image acceptance, not by weakening login or faking spans. [Machine evidence](./dedicated-api-acceptance.json) binds the exact images and source `346b92fc`; the [deployment contract](../../docs/architecture/deployment-mode-contract.md) remains authoritative.

## Root causes and fixes

1. Versioned Runtime API authorization treated an ingress actor as valid only for `multi-tenant`. Dedicated is **Platform single-tenant**, not Portable. New Gateway-managed Platform composition now explicitly requires ingress identity and accepts the Organization/role binding in both tenancy modes. Anonymous/local fallback is refused at that composition root. Portable continues to reject ingress headers.
2. Memo/user-tab requests had an early Gateway proxy branch which set principal/Organization but omitted Unit and ingress service credentials. The outer Runtime correctly returned `TENANT_RUNTIME_UNIT_NOT_FOUND`. Removing that branch lets both routes reuse the complete permission-checked, authority-rewriting handoff. Cookies and caller Authorization are stripped; incoming Unit/secret/Organization/role/principal values are replaced, not trusted. Cookie-authenticated state writes additionally require the public Origin.
3. Historical direct Dedicated listeners are **not** silently converted to Gateway-managed authentication. Without the explicit composition-root requirement, their old local Token authentication remains and forged ingress headers are still rejected. A further negative legacy-header regression prompted the final Runtime rebuild after the initial `0ee99b0e` repair. Only the final safe source `346b92fc` is certified here.

## Actual running-version checks

Using the existing Owner over CA-verified public HTTPS, with deliberately forged browser routing/identity headers:

| Request | Result | Runtime PG CLIENT children |
| --- | --- | --- |
| `GET /api/v1/sessions?limit=1` | 200, versioned list envelope | 4 |
| `GET /memo` | 200, memo document envelope | 4 |
| `GET /user/session-tabs` | 200, tab document envelope | 4 |

Both user-state HEAD requests also passed. All three real requests carried ordinary W3C `traceparent`; protected Aspire spans API confirmed Gateway HTTP → Runtime HTTP → every Runtime PG CLIENT parent relationship. No spans were manually registered. The initial trace lookup failed because the versioned API's independent `x-request-id` was mistaken for an OTLP trace ID; the final proof explicitly uses incoming W3C correlation and waits for both services' bounded OTLP batches. It does not redefine the API request-ID contract or claim every API request ID is a trace ID.

Negative current-image checks:

- Anonymous requests with forged owner/Unit/service headers: 401 on all three routes.
- Authenticated memo/tab PUT without Origin or with a different Origin: 403, before content mutation. Invalid bodies were used to prevent accidental writes even if the guard had regressed.
- Direct outer Runtime requests with missing/wrong service credential: 404 even with forged identity/Unit headers.
- Correct outer service credential but no ingress identity: 401 inside the new Platform composition; no anonymous fallback.
- Viewer writes, header replacement, cookie/Authorization stripping, cross-Organization Session isolation in both tenancy modes, legacy direct Token acceptance, legacy forged-ingress rejection and Portable ingress rejection passed in focused real-server fixtures. No additional human identity/role was provisioned in the retained single-Owner deployment just to manufacture a live viewer case.

The proof did not create a business Session, write memo/tab content or request a model/Executor. Its own final probe login was explicitly logged out without revoking other user devices. This is HTTP-client acceptance, not a real-browser navigation test or successful live memo-write acceptance.

## Build and deployment

Frozen Git-only snapshots built the existing Runtime Linux-x64 test image (including the standard unsigned release-asset verifier) and Gateway image serially. Their daemon-registered OCI repository digests were preserved and checked during LXD import. No image or Git push occurred.

Both the initial repair and final legacy-safe correction used the formal no-schema-change compatibility policy, admission/writer fence and cold backup before startup. The canonical autostart Compose now uses the final images, not a temporary candidate file. The final five-root artifact-v3 payload and all **2,011 entries** validated. This is **not** a cold-restore/startup proof. Existing maintenance-stop limitations from the earlier record, including non-graceful product-Dashboard stop, are not certified away.

TLS authority fingerprint remained the original retained Dedicated CA. Owner login, Runtime capabilities, protected Aspire API, six core healthchecks and eight long-running services passed. Fresh post-upgrade metrics arrived for all six telemetry resources: dashboard, ingress, Runtime, Gateway, postgres and silo. Host/Gateway type checks and **47 focused regression cases** passed on the final source.

## Still open

This closes only the API routing/authorization failures recorded in the [preceding observation acceptance](./telemetry/native-client-ingress-acceptance.md). Full resource lifecycle/log inventory, host metrics, durable history/alerting, monitor-aware cold restore, real configured model/SDK/remote Executor business and signed release/soak remain open. `modelConfigured` is still false. The deployed images are unsigned local Linux test builds, not a supported signed release.
