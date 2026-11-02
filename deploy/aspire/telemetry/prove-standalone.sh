#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
umask 077
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
else
  DOCKER=(sudo -n docker)
fi
DASHBOARD_IMAGE='mcr.microsoft.com/dotnet/aspire-dashboard@sha256:e4220c55fa3c3e40ad2d733ef07973392299b420e9bde6924e8f6a1e71ff01a8'
COLLECTOR_IMAGE='otel/opentelemetry-collector-contrib@sha256:faf125d656fa47cea568b2f3b4494efd2525083bc75c1e96038bc23f05cd68fd'
PROBE_IMAGE='curlimages/curl@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6'
ID="kala-otel-proof-$$"
NETWORK="$ID"
DASHBOARD="$ID-dashboard"
COLLECTOR="$ID-collector"
TMP=$(mktemp -d)
cleanup() {
  "${DOCKER[@]}" rm -f "$COLLECTOR" "$DASHBOARD" >/dev/null 2>&1 || true
  "${DOCKER[@]}" network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

browser=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
api_key=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ingest=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
# No PG/SILO authorities in this transport-only fixture. Their real metric
# pipelines have separate live-server acceptance; do not claim it here.
sed '/^    metrics\/postgres:/,$d' "$ROOT/deploy/aspire/telemetry/otel-collector.yaml" > "$TMP/collector.transport.yaml"
chmod 644 "$TMP/collector.transport.yaml"
"${DOCKER[@]}" network create "$NETWORK" >/dev/null
"${DOCKER[@]}" run -d --name "$DASHBOARD" --network "$NETWORK" --network-alias observability-dashboard -p 127.0.0.1::18888 \
  -e ASPNETCORE_URLS=http://0.0.0.0:18888 \
  -e ASPIRE_DASHBOARD_OTLP_ENDPOINT_URL=http://0.0.0.0:18889 \
  -e ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL=http://0.0.0.0:18890 \
  -e ASPIRE_DASHBOARD_CONFIG_FILE_PATH=/etc/kala-observability/dashboard.settings.json \
  -e Dashboard__Frontend__BrowserToken="$browser" -e Dashboard__Otlp__PrimaryApiKey="$api_key" -e Dashboard__Api__PrimaryApiKey="$api_key" \
  -v "$ROOT/deploy/aspire/telemetry/dashboard.settings.json:/etc/kala-observability/dashboard.settings.json:ro" "$DASHBOARD_IMAGE" >/dev/null
"${DOCKER[@]}" run -d --name "$COLLECTOR" --network "$NETWORK" --network-alias otel-collector -p 127.0.0.1::4318 \
  -e KALA_OTEL_INGEST_TOKEN="$ingest" -e KALA_ASPIRE_DASHBOARD_OTLP_API_KEY="$api_key" \
  -e KALA_OBSERVABILITY_POSTGRES_PASSWORD=unused-transport-proof-no-database \
  -e KALA_OBSERVABILITY_SILO_METRICS_TOKEN=unused-transport-proof-no-silo \
  -v "$TMP/collector.transport.yaml:/etc/otelcol-contrib/config.yaml:ro" "$COLLECTOR_IMAGE" \
  --config=/etc/otelcol-contrib/config.yaml >/dev/null

# This is the exact finite native readiness command published by Program.cs.
"${DOCKER[@]}" run --rm --network "$NETWORK" --entrypoint /bin/sh "$PROBE_IMAGE" -c \
  'set -eu; for url in http://observability-dashboard:18888/health http://otel-collector:13133/; do attempts=0; until curl -fsS --max-time 3 "$url" >/dev/null; do attempts=$((attempts+1)); [ "$attempts" -lt 60 ] || exit 1; sleep 1; done; done'
dash_port=$("${DOCKER[@]}" port "$DASHBOARD" 18888/tcp | sed 's/.*://')
collector_port=$("${DOCKER[@]}" port "$COLLECTOR" 4318/tcp | sed 's/.*://')
base="http://127.0.0.1:$dash_port"
[ "$(curl -sS -o "$TMP/health" -w '%{http_code}' -H 'Host: localhost' "$base/health")" = 200 ]
[ "$(cat "$TMP/health")" = Healthy ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: localhost' "$base/structuredlogs")" = 302 ]
[ "$(curl -sS -L -c "$TMP/cookie" -o /dev/null -w '%{http_code}' -H 'Host: localhost' "$base/login?t=$browser")" = 200 ]
[ "$(curl -sS -b "$TMP/cookie" -o /dev/null -w '%{http_code}' -H 'Host: localhost' "$base/structuredlogs")" = 200 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: localhost' "$base/api/telemetry/resources")" = 401 ]
for signal in traces logs metrics; do
  [ "$("${DOCKER[@]}" run --rm --network "$NETWORK" "$PROBE_IMAGE" -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/x-protobuf' --data-binary '' "http://observability-dashboard:18890/v1/$signal")" = 401 ]
  [ "$("${DOCKER[@]}" run --rm --network "$NETWORK" "$PROBE_IMAGE" -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/x-protobuf' -H "x-otlp-api-key: $api_key" --data-binary '' "http://observability-dashboard:18890/v1/$signal")" = 200 ]
done
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"resourceSpans":[]}' "http://127.0.0.1:$collector_port/v1/traces")" = 401 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $ingest" -d '{"resourceSpans":[]}' "http://127.0.0.1:$collector_port/v1/traces")" = 200 ]

KALA_PROOF_ENDPOINT="http://127.0.0.1:$collector_port" KALA_PROOF_TOKEN="$ingest" KALA_PROOF_EXPECTED="$TMP/expected.json" node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs'
import { OnlineTelemetry } from './packages/shared/dist/node-telemetry.js'
import { AgentTelemetryBridge } from './packages/host/dist/src/agent-telemetry.js'
const secret = 'SENSITIVE_FIXTURE_9b1f_prompt_cookie_password_home'
const t = new OnlineTelemetry({ serviceName: 'kala-acceptance-fixture', endpoint: process.env.KALA_PROOF_ENDPOINT, authToken: process.env.KALA_PROOF_TOKEN, flushIntervalMs: 60000, timeoutMs: 1000 })
const s = t.startHttpSpan('POST', secret, `00-${'12'.repeat(16)}-${'34'.repeat(8)}-01`)
s.end(503)
t.gauge('kala_acceptance_queue_depth', 7, { component: 'runtime', prompt: secret, cookie: secret })
await t.close()
// Synthetic authoritative-timing inputs prove transport/semantics, not a real
// provider/SDK/Executor run. No business content is copied into this fixture.
const agent = new OnlineTelemetry({ serviceName: 'kala-agent-timing-fixture', serviceVersion: 'candidate-business-timing', endpoint: process.env.KALA_PROOF_ENDPOINT, authToken: process.env.KALA_PROOF_TOKEN, flushIntervalMs: 60000, timeoutMs: 1000 })
const bridge = new AgentTelemetryBridge(agent)
const sessionId = `session_${secret}`, turnId = `turn_${secret}`
const now = Date.now(), at = (delta) => new Date(now + delta).toISOString()
const children = [
  { spanId: `llm_${secret}`, turnId, kind: 'llm', component: 'host', startedAt: at(-850), completedAt: at(-550), durationMs: 300, status: 'succeeded', firstTokenMs: 33 },
  { spanId: `tool_a_${secret}`, turnId, kind: 'tool', component: 'host', startedAt: at(-500), completedAt: at(-100), durationMs: 400, status: 'succeeded', executorDurationMs: 350 },
  { spanId: `tool_b_${secret}`, turnId, kind: 'tool', component: 'host', startedAt: at(-400), completedAt: at(-50), durationMs: 350, status: 'interrupted' },
]
for (const span of children) bridge.observe(sessionId, { turnId, span, prompt: secret }, 'openai')
bridge.observe(sessionId, { turnId, summary: { turnId, status: 'interrupted', startedAt: at(-900), completedAt: at(0), wallDurationMs: 900, estimated: false, queueDurationMs: 50, activeDurationMs: 750, approvalWaitMs: 0, llm: { wallDurationMs: 300, requestCount: 1, firstTokenMs: 33 }, tools: { wallDurationMs: 450, aggregateDurationMs: 700, callCount: 2, peakConcurrency: 2, partial: true }, compactionDurationMs: 0, retryDurationMs: 0, recoveryDurationMs: 0 } })
writeFileSync(process.env.KALA_PROOF_EXPECTED, JSON.stringify({ traceId: agent.deriveTraceId('agent.turn.trace', ['local', sessionId, turnId]), root: agent.deriveSpanId('agent.turn.root', ['local', sessionId, turnId]), children: children.map((span) => agent.deriveSpanId('agent.turn.child', ['local', sessionId, turnId, span.spanId])) }), { mode: 0o600 })
await agent.close()
JS
sleep 3
for endpoint in resources traces spans logs; do curl -fsS -H 'Host: localhost' -H "x-api-key: $api_key" "$base/api/telemetry/$endpoint?limit=20" >"$TMP/$endpoint.json"; done
node --input-type=module - "$TMP" <<'JS'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const directory = process.argv[2]
const expected = JSON.parse(readFileSync(`${directory}/expected.json`, 'utf8'))
const spans = JSON.parse(readFileSync(`${directory}/spans.json`, 'utf8'))
const objects = []
function visit(value) {
  if (Array.isArray(value)) for (const item of value) visit(item)
  else if (value && typeof value === 'object') { objects.push(value); for (const item of Object.values(value)) visit(item) }
}
visit(spans)
const root = objects.find((span) => span.spanId === expected.root)
assert(root, 'Dashboard did not return the Agent root span')
assert.equal(root.traceId, expected.traceId)
for (const id of expected.children) {
  const child = objects.find((span) => span.spanId === id)
  assert(child, 'Dashboard did not return an Agent child span')
  assert.equal(child.traceId, expected.traceId)
  assert.equal(child.parentSpanId, expected.root)
}
const text = JSON.stringify(spans)
for (const name of ['agent.turn', 'agent.llm', 'agent.tool', 'execution.state', 'unknown']) assert(text.includes(name))
const resources = JSON.stringify(JSON.parse(readFileSync(`${directory}/resources.json`, 'utf8')))
// This summary API selects resource names/metric presence, not arbitrary
// resource attributes. service.version encoding is covered by the client test.
assert(resources.includes('kala-agent-timing-fixture'))
JS
cat "$TMP"/{resources,traces,spans,logs}.json >"$TMP/all"
grep -q 'kala-acceptance-fixture' "$TMP/all"
grep -q 'http other' "$TMP/all"
grep -q 'HTTP request failed' "$TMP/all"
grep -q '"hasMetrics":true' "$TMP/resources.json"
! grep -q 'SENSITIVE_FIXTURE_9b1f' "$TMP/all"
[ -z "$("${DOCKER[@]}" logs "$COLLECTOR" 2>&1)" ]
"${DOCKER[@]}" stop -t 2 "$COLLECTOR" "$DASHBOARD" >/dev/null
timeout 5s env KALA_PROOF_ENDPOINT="http://127.0.0.1:$collector_port" KALA_PROOF_TOKEN="$ingest" node --input-type=module <<'JS'
import { OnlineTelemetry } from './packages/shared/dist/node-telemetry.js'
const t = new OnlineTelemetry({ serviceName: 'kala-stopped-export-fixture', endpoint: process.env.KALA_PROOF_ENDPOINT, authToken: process.env.KALA_PROOF_TOKEN, flushIntervalMs: 60000, timeoutMs: 100 })
t.counter('kala_stopped_export_total')
await t.close()
JS
printf '%s\n' 'PASS: real Dashboard/Collector auth, readiness, HTTP plus anonymous Agent parent/child spans, unknown tool state, histograms, logs, metrics, stopped-backend finite close, and sensitive-field exclusion'
