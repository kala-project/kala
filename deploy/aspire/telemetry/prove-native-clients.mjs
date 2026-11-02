// Run with Node inside the frozen Runtime/Gateway image on its private network.
// Inputs are the existing least-privileged service credentials; never print them.
// Uses an actual loopback HTTP server, actual packaged PG factories and real S3
// SDK calls. Creates no DB schema/table/Session and removes its owned S3 object.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const runtime = process.argv[2] === 'runtime'
assert(runtime || process.argv[2] === 'gateway', 'expected runtime or gateway')
const base = `/app/packages/${runtime ? 'host' : 'runtime-ingress-gateway'}`
const { OnlineTelemetry } = await import(`${base}/node_modules/@agent-kernel/shared/dist/node-telemetry.js`)
const sent = []
const telemetry = new OnlineTelemetry({
  serviceName: runtime ? 'kala-runtime' : 'kala-gateway',
  endpoint: process.env.KALA_OTEL_EXPORTER_ENDPOINT,
  authToken: process.env.KALA_OTEL_EXPORTER_TOKEN,
  serviceVersion: process.env.KALA_OTEL_SERVICE_VERSION,
  flushIntervalMs: 60_000,
  fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return fetch(url, init) },
})
const suffix = randomBytes(8).toString('hex')
const canary = `private-client-proof-${suffix}`
const sql = '/* private_client_sql_canary */ SELECT $1::text AS receipt'
let db, store, server
const org = `org_proof${suffix}`, key = `native-client-proof/${suffix}`
try {
  if (runtime) {
    const { createPostgresHotStateStore } = await import(`${base}/dist/src/tenant-runtime/postgres-hot-state.js`)
    db = createPostgresHotStateStore({ connectionString: process.env.KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING, telemetry, maxConnections: 2 }).database
    const { S3ArtifactObjectStore } = await import(`${base}/dist/src/artifacts/object-store.js`)
    store = new S3ArtifactObjectStore({
      endpoint: process.env.KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT,
      region: process.env.KALA_RUNTIME_EXPERIMENTAL_S3_REGION,
      bucket: process.env.KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET,
      accessKeyId: process.env.KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY,
      maxObjectBytes: 1024, telemetry,
    })
  } else {
    const { createPostgresControlPlaneDatabase } = await import(`${base}/dist/src/persistence/postgres.js`)
    db = createPostgresControlPlaneDatabase({ connectionString: process.env.KALA_INGRESS_DATABASE_URL, telemetry, maxConnections: 2 })
  }
  let requestError
  server = createServer(async (req, res) => {
    const span = telemetry.startHttpSpan(req.method, req.url === '/ok' ? 'proof.success' : 'proof.error')
    span.activate()
    res.once('finish', () => span.end(res.statusCode))
    res.once('close', () => span.end(499))
    res.setHeader('x-proof-traceparent', span.traceparent)
    try {
      if (req.url === '/ok') {
        await db.transaction(async tx => {
          const result = await tx.query(sql, [canary])
          assert.equal(result.rows[0].receipt, canary)
        })
        if (store) {
          await store.put({ organizationId: org, key, contentType: 'application/octet-stream', body: Buffer.from(canary) })
          assert.equal(Buffer.from(await store.get(org, key)).toString(), canary)
          await store.delete(org, key)
        }
      } else {
        await assert.rejects(db.transaction(tx => tx.query(`SELECT * FROM missing_proof_${suffix}`)))
        if (store) await assert.rejects(store.get(org, `missing-${suffix}`))
      }
      res.end('ok')
    } catch (error) { requestError = error; res.statusCode = 500; res.end('failed') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const responses = await Promise.all(['/ok', '/error'].map(async path => {
    const response = await fetch(origin + path); await response.text()
    assert.equal(response.status, 200, 'real client proof request failed')
    return response.headers.get('x-proof-traceparent').split('-')
  }))
  assert.equal(requestError, undefined)
  // A completed HTTP parent must not attach to subsequent work.
  await db.query(sql, [canary])
  await telemetry.close()
  const spans = sent.flatMap(p => (p.resourceSpans ?? []).flatMap(r => r.scopeSpans.flatMap(s => s.spans)))
  const clients = spans.filter(s => s.kind === 3)
  for (const [, traceId, parentId] of responses) {
    const parent = spans.find(s => s.spanId === parentId && s.kind === 2)
    assert(parent && parent.traceId === traceId)
    const children = clients.filter(s => s.traceId === traceId)
    assert(children.length > 0)
    assert(children.every(s => s.parentSpanId === parentId))
  }
  assert.notEqual(responses[0][1], responses[1][1])
  assert(clients.some(s => s.status.code === 1))
  assert(clients.some(s => s.name === 'Database query' && s.status.code === 2))
  assert(clients.some(s => !s.parentSpanId), 'expired HTTP parent leaked')
  if (runtime) for (const name of ['Save stored file', 'Read stored file', 'Delete stored file']) assert(clients.some(s => s.name === name))
  if (runtime) assert(clients.some(s => s.name === 'Read stored file' && s.status.code === 2))
  const text = JSON.stringify(sent)
  const privateValues = [canary, org, key, 'private_client_sql_canary', `missing_proof_${suffix}`,
    ...Object.entries(process.env).filter(([k]) => /DATABASE_URL|CONNECTION_STRING|ACCESS_KEY|SECRET|TOKEN/u.test(k)).map(([,v]) => v)]
  for (const value of privateValues.filter(Boolean)) assert(!text.includes(value), 'sensitive value exported')
  console.log(JSON.stringify({ passed: true, mode: runtime ? 'runtime' : 'gateway',
    actualPackagedClients: true, realHttpParentIsolation: true, realPostgresTransactionsAndRollback: true,
    realS3PutGetDeleteAndMissingObject: runtime, clientSpans: clients.length, traceIds: responses.map(r => r[1]),
    noPrivateInputsInOtlpPayload: true, noSessionOrModelCreated: true }))
} finally {
  // A failure midway through put/get must not leave the owned test object.
  await store?.delete(org, key).catch(() => undefined)
  await db?.close?.()
  await new Promise(resolve => server ? server.close(resolve) : resolve())
  await telemetry.close()
}
