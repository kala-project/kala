import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export const RC_EVIDENCE_SCHEMA_VERSION = 1

export const requiredReleaseEvidence = Object.freeze({
  portable: Object.freeze({
    targets: Object.freeze(['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64']),
    checks: Object.freeze([
      'assetIntegrity', 'cleanInstall', 'boot', 'capabilities', 'dashboard', 'nativeExecutor',
      'operatorCommandAccepted', 'fileRead', 'fileWrite', 'localShell', 'nativeTerminal',
      'statePersistence', 'restartRecovery', 'cleanStop', 'reinstall',
    ]),
    targetChecks: Object.freeze({
      'win32-x64': Object.freeze(['assetIntegrity', 'cleanInstall', 'boot', 'capabilities', 'dashboard', 'cleanStop', 'hostNode22', 'nativeExecutor', 'temporaryConptyLifecycle', 'serviceConptyLifecycle']),
    }),
  }),
  dedicated: Object.freeze({
    targets: Object.freeze(['linux-x64-systemd']),
    checks: Object.freeze(['assetIntegrity', 'stagedDisabled', 'cleanInstall', 'browser', 'executor', 'gracefulCutover', 'selfDeployment', 'reboot', 'backupRestore', 'rollback']),
  }),
  'private-cloud': Object.freeze({
    targets: Object.freeze(['linux-x64-compose', 'linux-x64-compose-fresh']),
    checks: Object.freeze(['assetIntegrity', 'cleanInstall', 'organizationProvisioning', 'tenantIsolation', 'browser', 'executor', 'fullUpgrade', 'mtlsClientRejection', 'unitResourceIsolation', 'runtimeRestartRecovery', 'dashboardUpgradeIsolation', 'rollback', 'backupRestore']),
    targetChecks: Object.freeze({
      'linux-x64-compose-fresh': Object.freeze(['assetIntegrity', 'imageDigestPinning', 'freshCandidateInstall', 'ephemeralBundledAcceptance', 'realBundledIdentities', 'authenticatedModelFixture', 'organizationProvisioning', 'tenantIsolation', 'browser', 'executor', 'mtlsClientRejection', 'unitResourceIsolation', 'runtimeRestartRecovery', 'backupRestore']),
    }),
  }),
})

const topLevelFields = new Set(['schemaVersion', 'category', 'tag', 'version', 'revision', 'target', 'artifact', 'artifacts', 'ok', 'checks', 'generatedAt'])
const windowsPortableArtifacts = Object.freeze([
  'kala-dashboard-with-runtime.cjs',
  'kala-executor-win32-x64.exe',
  'node-pty-win32-x64.tar.gz',
  'kala-executor-service-host-win32-x64.exe',
  'install-executor.ps1',
  'kala-copilot-runtime-win32-x64',
  'kala-copilot-runtime-node-win32-x64.node',
])
const sensitiveKey = /(?:token|secret|password|credential|api.?key|private.?key|session.?log|receipt|screenshot|domain|endpoint|origin|address|ip|path|directory|root)$/iu
const absolutePath = /(?:^|[\s=:])(?:[A-Za-z]:[\\/]|\/(?:home|Users|var|etc|opt|srv|tmp|run)\/)/u
const urlOrIp = /(?:https?:\/\/|(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:[^0-9]|$))/iu
const credentialMaterial = /(?:bearer\s+[A-Za-z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu

export function createRcEvidence(input) {
  const evidence = {
    schemaVersion: RC_EVIDENCE_SCHEMA_VERSION,
    category: input.category,
    tag: input.tag,
    version: input.version,
    revision: input.revision,
    target: input.target,
    artifact: input.artifact,
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ok: input.ok,
    checks: input.checks,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  }
  validateRcEvidence(evidence)
  return evidence
}

export function validateRcEvidence(value, expected = {}) {
  if (!plainObject(value)) throw new Error('release evidence must be a JSON object')
  rejectUnknown(value, topLevelFields, 'release evidence')
  if (value.schemaVersion !== RC_EVIDENCE_SCHEMA_VERSION) throw new Error('unsupported release evidence schemaVersion')
  const policy = requiredReleaseEvidence[value.category]
  if (!policy) throw new Error(`unsupported release evidence category: ` + String(value.category))
  if (!policy.targets.includes(value.target)) throw new Error(`unsupported ` + value.category + ` evidence target: ` + String(value.target))
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.tag)) throw new Error('release evidence tag is invalid')
  if (value.version !== value.tag.slice(1)) throw new Error('release evidence version does not match tag')
  if (!/^[0-9a-f]{40}$/u.test(value.revision)) throw new Error('release evidence revision must be an exact Git revision')
  validateArtifact(value.artifact, 'release evidence artifact')
  const targetChecks = policy.targetChecks?.[value.target]
  const requiredChecks = targetChecks ?? policy.checks
  if (value.category === 'portable' && value.target === 'win32-x64') {
    if (!Array.isArray(value.artifacts)) throw new Error('Windows Portable evidence must bind the complete release asset set')
    value.artifacts.forEach((artifact, index) => validateArtifact(artifact, `Windows Portable evidence artifact ${index}`))
    const names = value.artifacts.map((artifact) => artifact.name)
    if (new Set(names).size !== names.length || JSON.stringify([...names].sort()) !== JSON.stringify([...windowsPortableArtifacts].sort())) {
      throw new Error('Windows Portable evidence asset inventory is not exact')
    }
    const host = value.artifacts.find((artifact) => artifact.name === value.artifact.name)
    if (!host || host.sha256 !== value.artifact.sha256 || value.artifact.name !== 'kala-dashboard-with-runtime.cjs') throw new Error('Windows Portable primary artifact is not bound to its asset inventory')
  } else if (value.artifacts !== undefined) {
    throw new Error('release evidence artifacts are only supported for Windows Portable acceptance')
  }
  if (value.ok !== true) throw new Error('release evidence is not successful')
  if (!plainObject(value.checks)) throw new Error('release evidence checks must be an object')
  rejectUnknown(value.checks, new Set(requiredChecks), value.category + ' checks')
  for (const check of requiredChecks) if (value.checks[check] !== true) throw new Error(value.category + '/' + value.target + ' did not prove ' + check)
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('release evidence generatedAt is invalid')
  if (expected.tag && value.tag !== expected.tag) throw new Error('release evidence tag mismatch: ' + value.tag)
  if (expected.revision && value.revision !== expected.revision) throw new Error('release evidence revision mismatch: ' + value.revision)
  scanPrivacy(value)
  return value
}

export function collectRcEvidence(root) {
  const files = walk(root).filter((path) => path.endsWith('.rc-evidence.json')).sort()
  if (files.length === 0) throw new Error('no *.rc-evidence.json files were found')
  return files.map((path) => {
    let value
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('invalid JSON evidence file: ' + basename(path)) }
    return { path, value }
  })
}

export function verifyRcEvidenceSet(records, expected) {
  // Bootstrap RC: only Portable can be proven on hosted runners without an
  // attested predecessor or private clean-environment runner. Dedicated and
  // Private Cloud evidence remains strictly validated if provided, but neither
  // category can be claimed as accepted solely from packaged assets.
  const expectedKeys = new Set(requiredReleaseEvidence.portable.targets.map((target) => 'portable/' + target))
  const actual = new Map()
  for (const record of records) {
    const value = validateRcEvidence(record.value ?? record, expected)
    const key = value.category + '/' + value.target
    if (actual.has(key)) throw new Error('duplicate release evidence target: ' + key)
    actual.set(key, value)
  }
  const missing = [...expectedKeys].filter((key) => !actual.has(key))
  if (missing.length > 0) throw new Error('release evidence matrix is incomplete: ' + missing.join(', '))
  const unexpected = [...actual.keys()].filter((key) => !expectedKeys.has(key))
  if (unexpected.length > 0) throw new Error('release evidence matrix contains unexpected targets: ' + unexpected.join(', '))
  return [...actual.values()].sort((a, b) => (a.category + '/' + a.target).localeCompare(b.category + '/' + b.target))
}

function scanPrivacy(value, key = '') {
  if (sensitiveKey.test(key)) throw new Error('release evidence contains forbidden sensitive field: ' + key)
  if (typeof value === 'string' && (absolutePath.test(value) || urlOrIp.test(value) || credentialMaterial.test(value))) throw new Error('release evidence contains private diagnostic material in ' + (key || 'value'))
  if (Array.isArray(value)) for (const item of value) scanPrivacy(item, key)
  else if (plainObject(value)) for (const [childKey, item] of Object.entries(value)) scanPrivacy(item, childKey)
}

function validateArtifact(value, label) {
  if (!plainObject(value)) throw new Error(label + ' must be an object')
  rejectUnknown(value, new Set(['name', 'sha256']), label)
  if (typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value.name)) throw new Error(label + ' name is invalid')
  if (!/^[0-9a-f]{64}$/u.test(value.sha256)) throw new Error(label + ' SHA-256 is invalid')
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(label + ' contains unknown fields: ' + unknown.join(', '))
}
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function walk(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.isFile() && statSync(path).isFile()) files.push(path)
  }
  return files
}
