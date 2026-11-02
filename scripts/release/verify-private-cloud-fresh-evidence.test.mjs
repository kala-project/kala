import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createRcEvidence, requiredReleaseEvidence } from './rc-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const script = 'scripts/release/verify-private-cloud-fresh-evidence.mjs'
const tag = 'v0.3.0-beta.18'
const revision = 'a'.repeat(40)

test('fresh Cloud acceptance keeps the Executor workspace available after browser closure', () => {
  const source = readFileSync(join(root, 'scripts/release/verify-private-cloud-clean-compose.mjs'), 'utf8')
  const definition = source.indexOf("const workspaceRoot = join(scratch, 'workspace')")
  const browser = source.indexOf('const browser = await puppeteer.launch')
  const reuse = source.indexOf('PRIVATE_CLOUD_TEST_WORKSPACE_ROOT: workspaceRoot')
  assert.ok(definition >= 0 && definition < browser && browser < reuse, 'workspace must be in scope for full workspace acceptance after the browser closes')
  assert.equal(source.match(/const workspaceRoot =/gu)?.length, 1)
})

test('Cloud restart acceptance holds a real authenticated model turn while retaining per-Unit limits', () => {
  const source = readFileSync(join(root, 'scripts/release/verify-private-cloud-clean-compose.mjs'), 'utf8')
  assert.ok(source.includes("'KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES=2'"))
  assert.ok(source.includes("'KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES=1048576'"))
  assert.ok(source.includes("text: hold, mode: 'steer'"))
  assert.ok(source.includes("text: marker, mode: 'queue'"))
  assert.ok(source.indexOf("'candidate DAG lease'") < source.indexOf('text: hold, mode:'), 'DAG lease must precede the held model turn')
  assert.ok(source.indexOf('text: marker, mode:') < source.indexOf('if (markerProjectedBeforeRestart)'), 'the marker must be queued before restart')
})

test('restart recovery reauthenticates both chat and DAG sockets after HTTP health', () => {
  const source = readFileSync(join(root, 'scripts/release/verify-private-cloud-clean-compose.mjs'), 'utf8')
  assert.ok(source.includes('async function connectReadyDashboard(origin, cookie, sessionId, timeout)'))
  assert.ok(source.includes("const ready = await once(socket, 'session:ready', 5_000)"))
  assert.ok(source.includes("socket.on('server:message_queue', (event) => queues.push(event))"))
  assert.ok(source.includes("socket.on('state:changed', (event) => states.push(event))"))
  assert.ok(source.includes("}, timeout, 'authenticated Private Cloud socket recovery')"))
  assert.ok(source.includes('const recovered = await connectReadyDashboard(origin, alice.cookie, chatSession, 90_000)'))
  assert.ok(source.includes('const recoveredDag = await connectReadyDashboard(origin, alice.cookie, dagSession, 90_000)'))
  assert.ok(source.includes('const cursorRecovered = recovered.ready.cursor'))
  assert.ok(source.includes('const firstQueue = await waitFor(() => recovered.queues[0]'))
  assert.ok(source.includes('const cursorAfterMarker = completed.cursor'))
  assert.ok(source.includes('if (hasProjectedUserText(recovered.ready.state, marker)) throw new Error'))
  assert.ok(source.includes("event.cursor > cursorRecovered && event.state?.status === 'done' && hasAssistantText(event.state, marker)"))
  assert.ok(!source.includes('maxHistoryCursor('), 'external Runtime must not use Kernel-only history as a cursor')
})

test('Cloud recovery verifies a durable user projection before queuing and a completed marker after restart', () => {
  const source = readFileSync(join(root, 'scripts/release/verify-private-cloud-clean-compose.mjs'), 'utf8')
  assert.ok(source.indexOf('const baselineProjected =') < source.indexOf('const initialized = await socketAck(dagSocket'), 'persist baseline before DAG and held model turn')
  assert.ok(source.includes("intent: 'text', sessionId: chatSession, text: baseline, mode: 'steer'"))
  assert.ok(source.includes('hasProjectedUserText(event.state, baseline)'))
  assert.ok(source.includes('hasProjectedUserText(recovered.ready.state, baseline)'))
  assert.ok(source.includes('if (markerProjectedBeforeRestart) throw new Error'))
  assert.ok(source.includes('hasProjectedUserText(event.state, marker)'))
  assert.ok(source.includes('hasAssistantText(event.state, marker)'))
  assert.ok(source.includes('recovery.cursorRecovered < recovery.cursorBefore'))
  assert.ok(source.includes('recovery.cursorAfterMarker <= recovery.cursorRecovered'))
})

test('Cloud runtime gate waits for Socket.IO events without exposing cookie or session data in errors', () => {
  const source = readFileSync(join(root, 'scripts/release/verify-private-cloud-clean-compose.mjs'), 'utf8')
  assert.match(source, /function once\(socket, event, timeout\) \{/u)
  assert.match(source, /socket\.once\(event, onEvent\)/u)
  assert.match(source, /socket\.once\('connect_error', onError\)/u)
  assert.match(source, /socket\.once\('disconnect', onError\)/u)
  assert.match(source, /clearTimeout\(timer\)/u)
})

test('binds fresh candidate evidence to the exact accepted archive bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'private-cloud-fresh-evidence-'))
  const archive = join(scratch, 'kala-private-cloud-0.3.0-beta.18-linux-x64.tar.gz')
  const evidence = join(scratch, 'fresh.rc-evidence.json')
  writeFileSync(archive, 'signed draft bundle bytes')
  writeFileSync(evidence, JSON.stringify(freshEvidence(archive)))

  const accepted = verify(evidence, archive)
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).target, 'linux-x64-compose-fresh')

  writeFileSync(archive, 'different bundle bytes')
  const rejected = verify(evidence, archive)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /archive digest mismatch/u)
})

test('rejects predecessor lifecycle evidence as a fresh candidate result', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'private-cloud-fresh-evidence-'))
  const archive = join(scratch, 'kala-private-cloud-0.3.0-beta.18-linux-x64.tar.gz')
  const evidence = join(scratch, 'lifecycle.rc-evidence.json')
  writeFileSync(archive, 'signed draft bundle bytes')
  writeFileSync(evidence, JSON.stringify(createRcEvidence({
    category: 'private-cloud', target: 'linux-x64-compose', tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: archive.split('/').at(-1), sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') },
    checks: Object.fromEntries(requiredReleaseEvidence['private-cloud'].checks.map((name) => [name, true])),
  })))

  const rejected = verify(evidence, archive)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /fresh Private Cloud evidence target is required/u)
})

function freshEvidence(archive) {
  const checks = requiredReleaseEvidence['private-cloud'].targetChecks['linux-x64-compose-fresh']
  return createRcEvidence({
    category: 'private-cloud', target: 'linux-x64-compose-fresh', tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: archive.split('/').at(-1), sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') },
    checks: Object.fromEntries(checks.map((name) => [name, true])),
  })
}

test('fresh evidence cannot use bundled identity or an external-backup acknowledgement as restore proof', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'private-cloud-fresh-evidence-'))
  const archive = join(scratch, 'kala-private-cloud-0.3.0-beta.18-linux-x64.tar.gz')
  const evidence = join(scratch, 'fresh.rc-evidence.json')
  writeFileSync(archive, 'signed draft bundle bytes')
  const valid = freshEvidence(archive)
  for (const check of ['isolatedExternalOidc', 'externalPostgresS3', 'verifiedExternalRestore']) {
    const forged = { ...valid, checks: { ...valid.checks } }
    delete forged.checks[check]
    forged.checks.ephemeralBundledAcceptance = true
    forged.checks.realBundledIdentities = true
    writeFileSync(evidence, JSON.stringify(forged))
    const rejected = verify(evidence, archive)
    assert.notEqual(rejected.status, 0, `${check} must be mandatory`)
  }
})

function verify(evidence, archive) {
  return spawnSync(process.execPath, [script, '--evidence', evidence, '--archive', archive, '--tag', tag, '--revision', revision], { cwd: root, encoding: 'utf8' })
}
