import assert from 'node:assert/strict'
import { createRcEvidence, requiredReleaseEvidence, validateRcEvidence, verifyRcEvidenceSet } from './rc-evidence.mjs'
import test from 'node:test'

const revision = 'a'.repeat(40)
const tag = 'v0.2.0-rc.1'

test('requires exactly four Linux, macOS, and Windows Portable targets', () => {
  const portable = requiredReleaseEvidence.portable.targets.map((target) => create('portable', target))
  assert.equal(verifyRcEvidenceSet(portable, { tag, revision }).length, 4)
  assert.throws(() => create('portable', 'linux-arm64'), /unsupported portable evidence target/u)
  assert.throws(() => verifyRcEvidenceSet([...portable, create('dedicated', 'linux-x64-systemd')], { tag, revision }), /unexpected targets/u)
  assert.throws(() => verifyRcEvidenceSet(portable.slice(1), { tag, revision }), /matrix is incomplete/u)
})

test('requires mTLS, cross-Unit limits and restart recovery in Private Cloud acceptance', () => {
  const record = create('private-cloud', 'linux-x64-compose')
  assert.equal(record.checks.mtlsClientRejection, true)
  for (const check of ['mtlsClientRejection', 'unitResourceIsolation', 'runtimeRestartRecovery']) {
    assert.throws(() => validateRcEvidence({ ...record, checks: { ...record.checks, [check]: false } }), new RegExp(`did not prove ${check}`, 'u'))
  }
})

test('predecessor evidence is formally validated as non-certifying and cannot enter the promotion matrix', () => {
  const predecessor = create('private-cloud-predecessor', 'linux-x64-compose')
  assert.equal(validateRcEvidence(predecessor), predecessor)
  assert.equal(predecessor.certifying, false)
  assert.equal(predecessor.predecessorPolicy, 'unsupported-explicit-override')
  assert.throws(() => validateRcEvidence({ ...predecessor, certifying: true }), /explicitly non-certifying/u)
  assert.throws(() => validateRcEvidence({ ...predecessor, predecessorPolicy: 'certified' }), /supported predecessor policy/u)
  const portable = requiredReleaseEvidence.portable.targets.map((target) => create('portable', target))
  assert.throws(() => verifyRcEvidenceSet([...portable, predecessor], { tag, revision }), /unexpected targets/u)
  assert.throws(() => validateRcEvidence({ ...create('private-cloud', 'linux-x64-compose-fresh'), certifying: false, predecessorPolicy: 'unsupported-explicit-override' }), /must not declare predecessor/u)
})

test('fresh Private Cloud evidence requires candidate-first and digest-pinning checks without lifecycle claims', () => {
  const record = create('private-cloud', 'linux-x64-compose-fresh')
  assert.equal(validateRcEvidence(record), record)
  assert.equal(record.checks.freshCandidateInstall, true)
  assert.equal(record.checks.imageDigestPinning, true)
  assert.equal(record.checks.realBundledIdentities, true)
  assert.equal(record.checks.authenticatedModelFixture, true)
  assert.equal(record.checks.fullUpgrade, undefined)
  assert.equal(record.checks.rollback, undefined)
  for (const check of ['freshCandidateInstall', 'imageDigestPinning', 'ephemeralBundledAcceptance', 'realBundledIdentities', 'authenticatedModelFixture', 'browser', 'executor', 'tenantIsolation', 'backupRestore']) {
    assert.throws(() => validateRcEvidence({ ...record, checks: { ...record.checks, [check]: false } }), new RegExp(`did not prove ${check}`, 'u'))
  }
})

test('requires native message, filesystem, terminal, restart, and reinstall contracts', () => {
  const portable = create('portable', 'linux-x64')
  for (const check of ['nativeExecutor', 'operatorCommandAccepted', 'fileRead', 'fileWrite', 'localShell', 'nativeTerminal', 'restartRecovery', 'reinstall']) {
    assert.throws(() => validateRcEvidence({ ...portable, checks: { ...portable.checks, [check]: false } }), new RegExp(`did not prove ${check}`, 'u'))
  }
})

test('rejects duplicate targets and mismatched revisions', () => {
  const portable = create('portable', 'linux-x64')
  assert.throws(() => verifyRcEvidenceSet([portable, portable], { tag, revision }), /duplicate/u)
  assert.throws(() => validateRcEvidence(portable, { tag, revision: 'b'.repeat(40) }), /revision mismatch/u)
})

test('rejects diagnostics, private locations, URLs, and sensitive fields', () => {
  const portable = create('portable', 'linux-x64')
  assert.throws(() => validateRcEvidence({ ...portable, receipt: 'completed' }), /unknown fields/u)
  assert.throws(() => validateRcEvidence({ ...portable, artifact: { ...portable.artifact, name: '/home/example/release' } }), /artifact name/u)
  assert.throws(() => validateRcEvidence({ ...portable, checks: { ...portable.checks, endpoint: 'https://example.test' } }), /unknown fields/u)
})

function create(category, target) {
  const windowsNames = [
    'kala-dashboard-with-runtime.cjs', 'kala-executor-win32-x64.exe', 'node-pty-win32-x64.tar.gz',
    'kala-executor-service-host-win32-x64.exe', 'install-executor.ps1', 'kala-copilot-runtime-win32-x64', 'kala-copilot-runtime-node-win32-x64.node',
  ]
  const windows = category === 'portable' && target === 'win32-x64'
  const artifact = windows ? { name: windowsNames[0], sha256: 'b'.repeat(64) } : { name: category + '-' + target + '.tar.gz', sha256: 'b'.repeat(64) }
  const checks = requiredReleaseEvidence[category].targetChecks?.[target] ?? requiredReleaseEvidence[category].checks
  return createRcEvidence({
    category, target, tag, version: tag.slice(1), revision, ok: true,
    artifact,
    ...(windows ? { artifacts: windowsNames.map((name) => ({ name, sha256: 'b'.repeat(64) })) } : {}),
    ...(requiredReleaseEvidence[category].certifying === false ? { certifying: false, predecessorPolicy: requiredReleaseEvidence[category].predecessorPolicy } : {}),
    checks: Object.fromEntries(checks.map((name) => [name, true])),
    generatedAt: '2026-08-21T00:00:00.000Z',
  })
}
