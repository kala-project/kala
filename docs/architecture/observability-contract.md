# Runtime Observability Contract

**Status:** accepted implementation contract
**Scope:** Dedicated and Private Cloud RuntimeIngressGateway/RuntimeHost/TenantRuntimeUnit

## Principles

- Observability is outside Kernel semantics and must never block an Agent turn.
- Metrics use bounded dimensions. Tenant, user, Session, Workspace, URL, prompt, model response, tool input, file path, and exception text are forbidden metric labels.
- Logs may carry opaque correlation IDs but never credentials, cookies, authorization headers, prompts, tool payloads, or raw Provider bodies.
- UI errors describe the failing layer, whether work was persisted, and the next safe recovery action.
- Health is separated into liveness, readiness, and dependency state.

## Required signals

| Layer | Counters / latency | Health and user state |
|---|---|---|
| Ingress | requests, status class, auth failures, proxy latency, WebSocket accepts/rejects | identity unavailable, RuntimeHost unavailable, Session expired |
| RuntimeHost | loaded Units, load/unload failures, request latency, event append failures | draining, storage unavailable, Unit unavailable |
| Queue/Agent | queued/dequeued/dropped, turn duration, cancel/recovery, compact attempts/results | queued, running, recovering, waiting for user, failed with retry |
| LLM | calls, Provider status class, TTFT, duration, input/output tokens, context-overflow recovery | Provider unavailable, rate limited, context recovered/truncated |
| Executor/Tool | attached count, reconnects, dispatch/result/timeout, duration | offline, reconnecting, incompatible, invite expired |
| WebSocket | active connections, reconnects, protocol rejects | connected, degraded, disconnected |
| Push/PWA | subscription create/remove/expiry, send outcome, click/navigation, SW update | permission denied, subscription stale, update ready |
| Storage | append latency/error, bytes, backup/restore outcome | read-only, capacity warning, restore required |

## Bounded attributes

Allowed examples:

- `product`: `dedicated` or `private-cloud`;
- `deployment.tenancy`: `single-tenant` or `multi-tenant`;
- `component`: fixed component enum;
- `operation`: fixed operation enum;
- `outcome`: `ok`, `error`, `timeout`, `cancelled`, `recovered`;
- `status_class`: `2xx`, `4xx`, `5xx`;
- `provider`: configured adapter ID from a bounded registry;
- `tool`: bounded built-in tool name, with unknown/custom collapsed to `other`;
- `error_code`: normalized internal code.

Opaque derived Unit and Session IDs may appear in protected traces/log correlation only. All such IDs, including hashes, MUST be omitted from exported metric labels and resource attributes; hashing does not bound cardinality. Tenant-level audit/usage belongs in PostgreSQL, not metric series.

## Service objectives

Initial objectives, measured over rolling 28 days:

- authenticated product navigation availability: $99.9\%$;
- accepted user-message durability: $99.99\%$;
- successful turn start after accepted message: $99.5\%$ within $5\text{s}$, excluding Provider outage;
- Runtime routing isolation violations: exactly $0$;
- persisted event loss after acknowledged write: exactly $0$;
- executor reconnect recovery: $99\%$ within $30\text{s}$ when network returns;
- notification suppression correctness while another device is active: $99.9\%$.

## Error model

Every structured operational error has:

```typescript
{
  code: string
  component: string
  operation: string
  outcome: 'error' | 'timeout' | 'recovered'
  retryable: boolean
  correlationId?: string
  safeMessage: string
}
```

Raw exceptions remain local and redacted. Dashboard responses receive only `code`, `retryable`, and `safeMessage`.

## Health endpoints

- `/healthz`: process liveness only; no network dependency checks.
- readiness endpoint: local storage writable, configuration valid, required internal listener available.
- dependency report: identity, RuntimeHost, Provider, Push, and optional collector status; degradation does not necessarily fail liveness.

## Alerting

Alert on sustained error-budget consumption rather than one user failure:

- ingress/Host 5xx ratio;
- event persistence failure;
- Unit routing rejection anomaly;
- queue age or concurrent-turn saturation;
- Provider failure/rate-limit spike;
- executor disconnect surge;
- storage capacity/read-only state;
- backup or restore verification failure.

No alert may include prompt, file content, Provider body, token, cookie, email, or raw tenant identifier.

## Acceptance

- exporter failure cannot change Agent outcome or add protocol events;
- metrics cardinality remains bounded with 1,000 temporary Units/Sessions;
- deliberate Provider, Executor, storage, and identity failures produce normalized logs and actionable UI state;
- redaction tests prove secrets and message content are absent;
- Private Cloud two-user tests prove no telemetry payload exposes one Unit to another;
- disposable dashboards/collector validate queryable counters and traces before release.
