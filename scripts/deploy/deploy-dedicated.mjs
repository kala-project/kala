#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const sourceRepositoryRoot = resolve(scriptDir, '../..')
const packagedReleaseRoot = scriptDir
const repositoryRoot = existsSync(join(sourceRepositoryRoot, 'scripts', 'release', 'verify-release-assets.mjs'))
  ? sourceRepositoryRoot
  : undefined
const defaultReleaseDir = repositoryRoot ? join(repositoryRoot, 'release') : packagedReleaseRoot
const supportArchive = 'kala-dedicated-support.tar.gz'
const localDevelopmentAssets = ['kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs', 'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs', 'kala-dashboard.tar.gz', 'kala-docs.tar.gz', supportArchive, 'kala-model-catalog-seed.json', 'run.sh', 'kala-dedicated.mjs', 'kala-release-metadata.tar.gz']
const legacyLocalDevelopmentAssets = [...localDevelopmentAssets, 'kala-copilot-runtime-linux-x64', 'kala-copilot-runtime-node-linux-x64.node']
const supportManifest = 'dedicated-support-manifest.json'
const supportAssets = ['cutover-dedicated-systemd.mjs', 'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs', 'deploy-dashboard.mjs', 'deploy-dedicated.mjs', 'deployment.json', 'install-dedicated-systemd.mjs', 'kala-dedicated-control-updater.service', 'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-ingress.service', 'kala-dedicated-migration-finalizer.service', 'kala-dedicated-unit@.service', 'rollback-dedicated-systemd.mjs', 'update-dedicated-control-plane.mjs']
const args = process.argv.slice(2)
// pnpm versions differ on whether the conventional script argument separator
// is consumed or forwarded. Keep the documented command surface identical in
// both cases without treating later `--` values as subcommands.
if (args[0] === '--') args.shift()

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  process.stdout.write(`Kala Dedicated slot deployment

Usage:
  pnpm run deploy:dedicated -- stage [--local | --lxd <container> | --ssh <target>] [options]
  pnpm run deploy:dedicated -- status <deployment-or-operation-id> [transport]
  pnpm run deploy:dedicated -- wait <deployment-or-operation-id> [transport] [--timeout-ms <ms>]
  pnpm run deploy:dedicated -- inspect [transport]
  pnpm run deploy:dedicated -- abort <deployment-id> [transport] [--operation-id <id>]
  pnpm run deploy:dedicated -- rollback <deployment-id> [transport] [--operation-id <id>]

Transport options:
  --local                    Operate on this system (default)
  --lxd <container>          Operate through the local LXD control plane
  --ssh <target>             Operate through SSH and scp
  --deploy-root <path>       Default: /var/lib/kala/deploy

Stage options:
  --release-dir <path>       Verified local release directory; default: release
  --release-id <id>          Immutable target release id; defaults to its digest
  --operation-id <id>        Stable idempotency id; generated when omitted
  --deployment-id <id>       Stable deployment id; generated when omitted
  --origin-session <id> --origin-call <id>
                              Defaults to KALA_SESSION_ID/CALL_ID inside a Tool
  --skip-build               Reuse release assets after verification
  --local-development        Stage a repository-built localDevelopment release (local/LXD only)
  --legacy-local-development Stage the old asset set once to upgrade a pre-Copilot-runtime Supervisor

This command never invokes the legacy single-service restart/finalizer path.
`)
  process.exit(0)
}

const command = args[0]
if (args.includes('--local-development') && command !== 'stage') throw new Error('--local-development is a stage-only option')
const positional = args.slice(1).filter((value, index, all) => !value.startsWith('--') && (index === 0 || !optionTakesValue(all[index - 1])))
const transport = createTransport(args)
const deployRoot = resolveTargetPath(optionValue(args, '--deploy-root') ?? '/var/lib/kala/deploy')

if (command === 'stage') stage()
else if (command === 'status') status(requiredIdentity(positional[0]))
else if (command === 'wait') await wait(requiredIdentity(positional[0]))
else if (command === 'inspect') inspect()
else if (command === 'abort') mutate('abort', requiredIdentity(positional[0]))
else if (command === 'rollback') mutate('rollback', requiredIdentity(positional[0]))
else throw new Error('unknown deploy:dedicated command: ' + command)

function stage() {
  const localDevelopment = args.includes('--local-development')
  const legacyLocalDevelopment = args.includes('--legacy-local-development')
  if (legacyLocalDevelopment && !localDevelopment) throw new Error('--legacy-local-development requires --local-development')
  if (localDevelopment && !repositoryRoot) throw new Error('--local-development is available only from a source repository checkout')
  if (localDevelopment && transport.kind === 'ssh') throw new Error('--local-development does not support SSH transport')
  if (localDevelopment && optionValue(args, '--release-dir')) throw new Error('--local-development always derives from the repository release/ directory')
  const operationId = optionValue(args, '--operation-id') ?? 'operation-' + randomUUID()
  assertIdentifier(operationId, 'operation id')
  const replay = findRequest(operationId) ?? findReceipt(operationId)
  if (replay && !localDevelopment) {
    assertStageReplay(replay)
    writeStageAccepted(replay, true)
    return
  }
  let releaseDir = optionValue(args, '--release-dir')
    ? resolve(optionValue(args, '--release-dir'))
    : defaultReleaseDir
  if (!args.includes('--skip-build')) {
    if (!repositoryRoot) throw new Error('packaged deploy:dedicated requires --skip-build; build the immutable release from a source checkout')
    runSourceCommand(process.execPath, ['scripts/release/build-release-assets.mjs', '--no-native', '--repo', process.env.GITHUB_REPOSITORY ?? 'local/agent-runlab'])
  }
  // The repository verifier is intentionally fixed to repositoryRoot/release.
  // A caller-supplied --release-dir must instead be verified in place below;
  // otherwise a valid default release could mask a tampered staged directory.
  if (repositoryRoot && releaseDir === join(repositoryRoot, 'release')) runSourceCommand(process.execPath, ['scripts/release/verify-release-assets.mjs'])
  let temporaryReleaseDir
  try {
    if (localDevelopment) {
      temporaryReleaseDir = createLocalDevelopmentRelease(releaseDir, legacyLocalDevelopment ? legacyLocalDevelopmentAssets : localDevelopmentAssets)
      releaseDir = temporaryReleaseDir
    }
    if (replay) {
      assertStageReplay(replay, releaseDir)
      writeStageAccepted(replay, true)
      return
    }
    const release = inspectLocalRelease(releaseDir)
    const releaseId = optionValue(args, '--release-id') ?? 'release-' + release.releaseDigest.slice(0, 20)
    assertReleaseId(releaseId)
    assertNoActiveDeployment()
    const route = readRemoteJson(join(deployRoot, 'route-state.json'))
    validateRoute(route)
    const predecessorReleaseId = route.slots[route.activeSlot].releaseId
    const predecessorSums = transport.read(join(deployRoot, 'releases', predecessorReleaseId, 'SHA256SUMS'))
    const sourceReleaseDigest = sha256(predecessorSums)
    const stagedReleaseDir = join(deployRoot, 'submissions', operationId)
    transport.stageRelease(releaseDir, stagedReleaseDir, release.files, release.sums)
    const deploymentId = optionValue(args, '--deployment-id') ?? 'deployment-' + randomUUID()
    assertIdentifier(deploymentId, 'deployment id')
    const originSession = optionValue(args, '--origin-session') ?? process.env.KALA_SESSION_ID
    const originCall = optionValue(args, '--origin-call') ?? process.env.KALA_CALL_ID
    if (Boolean(originSession) !== Boolean(originCall)) throw new Error('origin Session and call identity must be supplied together')
    const request = {
      schemaVersion: 1, action: 'deploy', operationId, deploymentId, topology: 'dedicated-slots', unitId: 'local',
      requestedAt: new Date().toISOString(), expectedRouteGeneration: route.generation,
      fencingToken: randomBytes(24).toString('base64url'), sourceReleaseDigest, targetReleaseDigest: release.releaseDigest,
      predecessorReleaseId, candidateSlot: route.activeSlot === 'blue' ? 'green' : 'blue',
      releaseId, stagedReleaseDir, bundleSha256: release.bundleSha256,
      ...(originSession && originCall ? { origin: { sessionId: originSession, callId: originCall } } : {}),
    }
    const accepted = submitRequest(request)
    writeStageAccepted(accepted, accepted !== request)
  } finally {
    if (temporaryReleaseDir) rmSync(temporaryReleaseDir, { recursive: true, force: true })
  }
}

function status(identity) {
  const receipt = findReceipt(identity)
  if (!receipt) throw new Error('deployment receipt not found: ' + identity)
  process.stdout.write(JSON.stringify(redactReceipt(receipt), null, 2) + '\n')
}

async function wait(identity) {
  const timeoutMs = positive(optionValue(args, '--timeout-ms'), 3_720_000)
  const pollMs = positive(optionValue(args, '--poll-ms'), 1000)
  const deadline = Date.now() + timeoutMs
  let lastRevision = -1
  while (Date.now() < deadline) {
    const rejection = findRejection(identity)
    if (rejection) throw new Error(`deployment request rejected: ${String(rejection.message ?? rejection.code ?? 'unknown reason')}`)
    try {
      const receipt = findReceipt(identity)
      if (receipt) {
        if (receipt.receiptRevision !== lastRevision) {
          process.stdout.write(JSON.stringify({ deploymentId: receipt.deploymentId, operationId: receipt.operationId, phase: receipt.phase, receiptRevision: receipt.receiptRevision, updatedAt: receipt.updatedAt }) + '\n')
          lastRevision = receipt.receiptRevision
        }
        if (terminal(receipt.phase)) {
          process.stdout.write(JSON.stringify(redactReceipt(receipt), null, 2) + '\n')
          if (!['completed', 'aborted', 'rolled_back'].includes(receipt.phase)) process.exitCode = 1
          return
        }
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs))
  }
  throw new Error('deployment wait deadline exceeded for ' + identity)
}

function inspect() {
  const route = readRemoteJson(join(deployRoot, 'route-state.json'))
  validateRoute(route)
  const receipts = transport.list(join(deployRoot, 'receipts')).filter((name) => name.endsWith('.json')).map((name) => readRemoteJson(join(deployRoot, 'receipts', name))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const services = ['kala-dedicated-ingress.service', 'kala-dedicated-unit@blue.service', 'kala-dedicated-unit@green.service', 'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-control-updater.service']
  const processes = Object.fromEntries(services.map((service) => [service, transport.systemctl(service)]))
  const statusPath = join(deployRoot, 'operator-status.json')
  const operator = transport.exists(statusPath) ? readRemoteJson(statusPath) : undefined
  process.stdout.write(JSON.stringify({ topology: 'dedicated-slots', route, services: processes, ...(operator ? { operator } : {}), deployment: receipts[0] ? redactReceipt(receipts[0]) : null }, null, 2) + '\n')
}

function mutate(action, targetDeploymentId) {
  assertIdentifier(targetDeploymentId, 'target deployment id')
  const operationId = optionValue(args, '--operation-id') ?? 'operation-' + action + '-' + randomUUID()
  assertIdentifier(operationId, 'operation id')
  const replay = findRequest(operationId)
  if (replay) {
    if (replay.action !== action || replay.targetDeploymentId !== targetDeploymentId) throw new Error('operationId conflicts with an existing deployment request')
    writeMutationAccepted(replay, true)
    return
  }
  const target = findReceipt(targetDeploymentId)
  if (!target) throw new Error('deployment receipt not found: ' + targetDeploymentId)
  const route = readRemoteJson(join(deployRoot, 'route-state.json'))
  validateRoute(route)
  const deploymentId = action === 'abort'
    ? target.deploymentId
    : optionValue(args, '--deployment-id') ?? 'deployment-rollback-' + randomUUID()
  assertIdentifier(deploymentId, 'deployment id')
  const request = {
    schemaVersion: 1, action, operationId, deploymentId, topology: 'dedicated-slots', unitId: 'local',
    requestedAt: new Date().toISOString(), expectedRouteGeneration: route.generation, fencingToken: randomBytes(24).toString('base64url'),
    sourceReleaseDigest: action === 'rollback' ? target.releaseDigest : target.sourceReleaseDigest,
    targetReleaseDigest: action === 'rollback' ? target.sourceReleaseDigest : target.releaseDigest,
    predecessorReleaseId: target.predecessorReleaseId, candidateSlot: action === 'rollback' ? target.previousSlot : target.candidateSlot, targetDeploymentId,
  }
  const accepted = submitRequest(request)
  writeMutationAccepted(accepted, accepted !== request)
}

function assertNoActiveDeployment() {
  const active = transport.list(join(deployRoot, 'receipts'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRemoteJson(join(deployRoot, 'receipts', name)))
    .find((receipt) => !terminal(receipt.phase))
  if (active) throw new Error('deployment ' + active.deploymentId + ' is already active in phase ' + active.phase)
}

function submitRequest(request) {
  const finalPath = join(deployRoot, 'requests', request.operationId + '.json')
  const existing = findRequest(request.operationId)
  if (existing) return sameRequestIntent(existing, request)
  const created = transport.atomicWrite(finalPath, Buffer.from(JSON.stringify(request, null, 2) + '\n'))
  if (created) return request
  const winner = findRequest(request.operationId)
  if (!winner) throw new Error('operation request submission lost an atomic-create race without a visible winner')
  return sameRequestIntent(winner, request)
}

function findRequest(operationId) {
  assertIdentifier(operationId, 'operation id')
  const base = operationId + '.json'
  const rejected = base + '.rejected'
  if (transport.exists(join(deployRoot, 'requests', rejected))) {
    const errorPath = join(deployRoot, 'requests', rejected + '.error')
    const detail = transport.exists(errorPath) ? readRemoteJson(errorPath) : undefined
    throw new Error('operation request was rejected' + (detail?.message ? ': ' + detail.message : ''))
  }
  const names = transport.list(join(deployRoot, 'requests')).filter((name) => name === base || name === base + '.accepted' || name.startsWith(base + '.accepted.') && /^(?:completed|aborted|rolled_back|rollback_failed|failed)$/u.test(name.slice((base + '.accepted.').length)))
  if (names.length > 1) throw new Error('multiple authoritative request files exist for operationId')
  return names[0] ? readRemoteJson(join(deployRoot, 'requests', names[0])) : undefined
}

function sameRequestIntent(existing, requested) {
  const stable = (value) => ({
    schemaVersion: value.schemaVersion, action: value.action, operationId: value.operationId, deploymentId: value.deploymentId,
    topology: value.topology, unitId: value.unitId, expectedRouteGeneration: value.expectedRouteGeneration,
    sourceReleaseDigest: value.sourceReleaseDigest, targetReleaseDigest: value.targetReleaseDigest,
    predecessorReleaseId: value.predecessorReleaseId, candidateSlot: value.candidateSlot, releaseId: value.releaseId,
    stagedReleaseDir: value.stagedReleaseDir, bundleSha256: value.bundleSha256, targetDeploymentId: value.targetDeploymentId, origin: value.origin,
  })
  if (JSON.stringify(stable(existing)) !== JSON.stringify(stable(requested))) throw new Error('operationId conflicts with an existing deployment request')
  return existing
}

function assertStageReplay(request, releaseDir = optionValue(args, '--release-dir') ? resolve(optionValue(args, '--release-dir')) : defaultReleaseDir) {
  if (request.action !== 'deploy' || !request.operationIds?.includes?.(optionValue(args, '--operation-id')) && request.operationId !== optionValue(args, '--operation-id')) throw new Error('operationId conflicts with an existing deployment request')
  const explicitDeployment = optionValue(args, '--deployment-id')
  const explicitRelease = optionValue(args, '--release-id')
  const explicitOrigin = optionValue(args, '--origin-session') ?? process.env.KALA_SESSION_ID
  const explicitCall = optionValue(args, '--origin-call') ?? process.env.KALA_CALL_ID
  if (explicitDeployment && request.deploymentId !== explicitDeployment) throw new Error('operationId conflicts with a different deployment id')
  if (explicitRelease && request.releaseId !== explicitRelease) throw new Error('operationId conflicts with a different release id')
  if (Boolean(explicitOrigin) !== Boolean(explicitCall)) throw new Error('origin Session and call identity must be supplied together')
  if (explicitOrigin && (request.origin?.sessionId !== explicitOrigin || request.origin?.callId !== explicitCall)) throw new Error('operationId conflicts with a different origin')
  const operationRequest = findRequest(optionValue(args, '--operation-id'))
  if (!operationRequest && !terminal(request.phase)) throw new Error('active operation receipt exists without its authoritative request')
  const release = inspectLocalRelease(releaseDir)
  const expectedReleaseDigest = operationRequest?.targetReleaseDigest ?? request.releaseDigest
  if (release.releaseDigest !== expectedReleaseDigest || release.bundleSha256 !== request.bundleSha256) throw new Error('operationId conflicts with a different release')
}

function writeStageAccepted(request, replayed) {
  process.stdout.write(JSON.stringify({ accepted: true, replayed, operationId: optionValue(args, '--operation-id') ?? request.operationId, deploymentId: request.deploymentId, releaseId: request.releaseId, releaseDigest: request.targetReleaseDigest ?? request.releaseDigest, bundleSha256: request.bundleSha256, expectedRouteGeneration: request.expectedRouteGeneration, ...(request.phase ? { phase: request.phase } : {}) }, null, 2) + '\n')
}

function writeMutationAccepted(request, replayed) {
  process.stdout.write(JSON.stringify({ accepted: true, replayed, action: request.action, operationId: request.operationId, deploymentId: request.deploymentId, targetDeploymentId: request.targetDeploymentId, expectedRouteGeneration: request.expectedRouteGeneration }, null, 2) + '\n')
}

function findRejection(identity) {
  const path = join(deployRoot, 'requests', `${identity}.json.rejected.error`)
  return transport.exists(path) ? readRemoteJson(path) : undefined
}

function findReceipt(identity) {
  const direct = join(deployRoot, 'receipts', identity + '.json')
  if (transport.exists(direct)) return readRemoteJson(direct)
  const indexPath = join(deployRoot, 'operation-index.json')
  if (!transport.exists(indexPath)) return undefined
  const index = readRemoteJson(indexPath)
  const deploymentId = index[identity]
  return typeof deploymentId === 'string' ? readRemoteJson(join(deployRoot, 'receipts', deploymentId + '.json')) : undefined
}

function createLocalDevelopmentRelease(sourceReleaseDir, assets) {
  const manifest = JSON.parse(readFileSync(join(sourceReleaseDir, 'manifest.json'), 'utf8'))
  if (!assets.every((asset) => manifest.assets.includes(asset))) throw new Error('repository release does not contain the required local-development asset set')
  const temporaryReleaseDir = mkdtempSync(join(tmpdir(), 'kala-local-development-release-'))
  try {
    for (const asset of assets) copyFileSync(join(sourceReleaseDir, asset), join(temporaryReleaseDir, asset))
    const localManifest = { ...manifest, localDevelopment: true, assets: [...assets] }
    writeFileSync(join(temporaryReleaseDir, 'manifest.json'), JSON.stringify(localManifest, null, 2) + '\n')
    const checksummed = [...assets, 'manifest.json'].sort()
    const sums = checksummed.map((name) => `${sha256(readFileSync(join(temporaryReleaseDir, name)))}  ${name}`).join('\n') + '\n'
    writeFileSync(join(temporaryReleaseDir, 'SHA256SUMS'), sums)
    if (readdirSync(temporaryReleaseDir).length !== assets.length + 2) throw new Error('local-development release has an incomplete file set')
    return temporaryReleaseDir
  } catch (error) {
    rmSync(temporaryReleaseDir, { recursive: true, force: true })
    throw error
  }
}

function inspectLocalRelease(releaseDir) {
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'))
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error('release manifest assets are required')
  const assets = manifest.assets.map((name) => safeAssetName(name))
  if (new Set(assets).size !== assets.length) throw new Error('release manifest contains duplicate assets')
  if (assets.some((name) => ['manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS'].includes(name))) throw new Error('release manifest assets contain a reserved metadata name')
  if (!assets.includes(supportArchive) || assets.some((name) => supportAssets.includes(name))) throw new Error('release does not use the Dedicated support bundle contract')
  const signature = existsSync(join(releaseDir, 'SHA256SUMS.sigstore.json')) ? ['SHA256SUMS.sigstore.json'] : []
  const sourceFiles = [...assets, 'manifest.json', 'SHA256SUMS', ...signature].sort()
  const actual = readdirSync(releaseDir, { withFileTypes: true })
  const actualNames = actual.map((entry) => entry.name).sort()
  const expandedFiles = [...sourceFiles, ...supportAssets].sort()
  const isExpanded = JSON.stringify(actualNames) === JSON.stringify(expandedFiles)
  if (actual.some((entry) => !entry.isFile()) || (!isExpanded && JSON.stringify(actualNames) !== JSON.stringify(sourceFiles))) throw new Error('release file set does not exactly match the raw or expanded bundle contract')
  for (const name of sourceFiles) if (!statSync(join(releaseDir, name)).isFile()) throw new Error('missing release asset: ' + name)
  const sums = readFileSync(join(releaseDir, 'SHA256SUMS'))
  const parsedSums = parseSums(String(sums))
  const checksummed = [...assets, 'manifest.json'].sort()
  if (JSON.stringify([...parsedSums.keys()].sort()) !== JSON.stringify(checksummed)) throw new Error('release checksum file set does not exactly match its manifest')
  for (const name of checksummed) if (sha256(readFileSync(join(releaseDir, name))) !== parsedSums.get(name)) throw new Error('release checksum mismatch: ' + name)
  const bundleSha256 = parsedSums.get('kala-runtime.cjs')
  if (!bundleSha256) throw new Error('bundle checksum missing from SHA256SUMS')
  inspectSupportArchive(join(releaseDir, supportArchive))
  if (isExpanded) verifyExpandedSupport(releaseDir)
  // Expanded support assets may exist beside an installed control client, but
  // modern submissions must preserve the checksummed outer release contract.
  return { files: sourceFiles, sums, releaseDigest: sha256(sums), bundleSha256 }
}

function createTransport(values) {
  const local = values.includes('--local')
  const hasLxd = values.includes('--lxd') || values.some((value) => value.startsWith('--lxd='))
  const hasSsh = values.includes('--ssh') || values.some((value) => value.startsWith('--ssh='))
  const lxd = optionValue(values, '--lxd')
  const ssh = optionValue(values, '--ssh')
  if (Number(local) + Number(hasLxd) + Number(hasSsh) > 1) throw new Error('choose exactly one transport')
  if (hasLxd && !lxd) throw new Error('--lxd requires a container')
  if (hasSsh && !ssh) throw new Error('--ssh requires a target')
  if (lxd) return commandTransport('lxd', lxd)
  if (ssh) return commandTransport('ssh', ssh)
  return localTransport()
}

function localTransport() {
  return {
    kind: 'local',
    read: (path) => readFileSync(path),
    exists: (path) => existsSync(path),
    list: (path) => existsSync(path) ? readdirSync(path) : [],
    atomicWrite: (path, bytes) => atomicWriteLocal(path, bytes),
    stageRelease: (source, target, files, sums) => stageReleaseLocal(source, target, files, sums),
    systemctl: (service) => systemctlLocal(service),
  }
}

function commandTransport(kind, target) {
  const targetPattern = kind === 'lxd' ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u : /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/u
  if (!targetPattern.test(target)) throw new Error('invalid ' + kind + ' target')
  const shell = (script, input) => {
    // OpenSSH joins its trailing argv into one remote-shell command. Preserve
    // the script as the single `bash -lc` argument; without this quoting,
    // `bash -lc cat -- /path` runs only `cat` and silently drops `/path`.
    const commandArgs = kind === 'lxd'
      ? ['exec', target, '--', 'bash', '-lc', script]
      : [target, 'bash', '-lc', quote(script)]
    const command = kind === 'lxd' ? 'lxc' : 'ssh'
    const result = spawnSync(command, commandArgs, { input, encoding: input ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(kind + ' command failed: ' + String(result.stderr))
    return result.stdout
  }
  return {
    kind,
    read: (path) => Buffer.from(shell('cat -- ' + quote(path))),
    exists: (path) => { try { shell('test -e ' + quote(path)); return true } catch { return false } },
    list: (path) => { try { return String(shell('find ' + quote(path) + ' -mindepth 1 -maxdepth 1 -printf %f\\n')).trim().split('\n').filter(Boolean) } catch { return [] } },
    atomicWrite: (path, bytes) => String(shell(atomicWriteScript(path), bytes)).trim() === 'created',
    stageRelease: (source, destination, files, sums) => {
      if (remoteReleaseMatches(shell, destination, files, sums)) return
      if (transportPathExists(shell, destination)) throw new Error('immutable release destination already exists with different content')
      const incoming = destination + '.incoming-' + randomBytes(12).toString('hex')
      shell('mkdir -m 0700 -- ' + quote(incoming))
      try {
        for (const file of files) {
          const local = join(source, file); const remote = incoming + '/' + file
          if (kind === 'lxd') runCommand('lxc', ['file', 'push', local, target + remote])
          else runCommand('scp', [local, target + ':' + remote])
        }
        shell('set -e; cd ' + quote(incoming) + ' && sha256sum -c SHA256SUMS >/dev/null; chmod -R a-w -- ' + quote(incoming) + '; chmod 511 -- ' + quote(incoming) + '; sync -f ' + quote(incoming) + '; mv -Tn -- ' + quote(incoming) + ' ' + quote(destination) + '; sync -f ' + quote(dirname(destination)))
        if (transportPathExists(shell, incoming)) shell('rm -rf -- ' + quote(incoming))
        if (!remoteReleaseMatches(shell, destination, files, sums)) throw new Error('immutable release destination won a race with different content')
      } catch (error) {
        try { shell('rm -rf -- ' + quote(incoming)) } catch {}
        throw error
      }
    },
    systemctl: (service) => {
      try { return parseSystemctlShow(String(shell(`systemctl show ${quote(service)} -p ActiveState -p UnitFileState -p MainPID`))) }
      catch { return { activeState: 'unknown', unitFileState: 'unknown', mainPid: 0 } }
    },
  }
}

function stageReleaseLocal(source, target, files, sums) {
  if (localReleaseMatches(target, files, sums)) return
  if (existsSync(target)) throw new Error('immutable release destination already exists with different content')
  if (!existsSync(dirname(target)) || !statSync(dirname(target)).isDirectory()) throw new Error('Dedicated submission dropbox is not installed: ' + dirname(target))
  const incoming = target + '.incoming-' + randomBytes(12).toString('hex')
  mkdirSync(incoming, { recursive: false, mode: 0o700 })
  try {
    for (const file of files) copyFileSync(join(source, file), join(incoming, file))
    const verified = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: incoming, encoding: 'utf8' })
    if (verified.status !== 0) throw new Error('transferred release checksum verification failed')
    const immutable = spawnSync('chmod', ['-R', 'a-w', incoming], { encoding: 'utf8' })
    if (immutable.status !== 0) throw new Error('failed to make transferred release immutable')
    const traversable = spawnSync('chmod', ['511', incoming], { encoding: 'utf8' })
    if (traversable.status !== 0) throw new Error('failed to make transferred release traversable')
    syncRelease(incoming, files)
    const publish = spawnSync('mv', ['-Tn', '--', incoming, target], { encoding: 'utf8' })
    if (publish.status !== 0) throw new Error('failed to atomically publish immutable release')
    if (existsSync(incoming)) rmSync(incoming, { recursive: true, force: true })
    if (!localReleaseMatches(target, files, sums)) throw new Error('immutable release destination won a race with different content')
    const directory = openSync(dirname(target), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true })
    throw error
  }
}

function atomicWriteLocal(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = path + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex')
  writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
  try {
    const file = openSync(temp, 'r'); try { fsyncSync(file) } finally { closeSync(file) }
    try { linkSync(temp, path) } catch (error) { if (error?.code === 'EEXIST') return false; throw error }
    const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
    return true
  } finally {
    try { unlinkSync(temp) } catch {}
  }
}

function atomicWriteScript(path) {
  const parent = dirname(path)
  return `set -euo pipefail; mkdir -p ${quote(parent)}; umask 077; tmp=$(mktemp -- ${quote(parent + '/.request.tmp.XXXXXXXX')}); trap 'rm -f -- "$tmp"' EXIT; cat > "$tmp"; sync -f "$tmp"; if ln -- "$tmp" ${quote(path)}; then sync -f ${quote(parent)}; printf created; elif test -e ${quote(path)}; then printf existing; else exit 1; fi`
}

function systemctlLocal(service) {
  const result = spawnSync('systemctl', ['show', service, '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'MainPID'], { encoding: 'utf8' })
  if (result.status !== 0) return { activeState: 'unknown', unitFileState: 'unknown', mainPid: 0 }
  return parseSystemctlShow(result.stdout)
}
function parseSystemctlShow(value) { const fields = Object.fromEntries(value.trim().split('\n').map((line) => { const at = line.indexOf('='); return at < 1 ? ['', ''] : [line.slice(0, at), line.slice(at + 1)] }).filter(([key]) => key)); return { activeState: fields.ActiveState ?? 'unknown', unitFileState: fields.UnitFileState ?? 'unknown', mainPid: Number(fields.MainPID) || 0 } }

function readRemoteJson(path) { return JSON.parse(String(transport.read(path))) }
function resolveTargetPath(path) { if (!/^\/[A-Za-z0-9._/-]+$/u.test(path)) throw new Error('--deploy-root must be an absolute path containing only portable path characters'); const normalized = resolve(path); if (normalized === '/') throw new Error('--deploy-root must not be the filesystem root'); return normalized }
function validateRoute(route) { if (route?.schemaVersion !== 1 || !Number.isSafeInteger(route.generation) || !['blue', 'green'].includes(route.activeSlot) || !route.slots?.blue || !route.slots?.green) throw new Error('invalid route state') }
function redactReceipt(receipt) { const { releaseDir: _releaseDir, error, ...safe } = receipt; return { ...safe, ...(error ? { error: { code: error.code, message: String(error.message).replaceAll(/(?:[A-Za-z]:)?[\/][^\s;]+/gu, '<path>'), at: error.at } } : {}) } }
function terminal(phase) { return ['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed'].includes(phase) }
function requiredIdentity(value) { if (!value) throw new Error('deployment or operation id is required'); assertIdentifier(value, 'deployment or operation id'); return value }
function assertReleaseId(value) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error('invalid release id') }
function assertIdentifier(value, name) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) throw new Error('invalid ' + name) }
function safeAssetName(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(value)) throw new Error('invalid release asset name'); return value }
function inspectSupportArchive(archive) {
  const entries = readExactTarGz(readFileSync(archive), 'Dedicated support')
  const expected = [...supportAssets, supportManifest].sort()
  if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Dedicated support archive entries are unsafe or incomplete')
  let manifest
  try { manifest = JSON.parse(String(entries.get(supportManifest))) } catch { throw new Error('invalid Dedicated support manifest') }
  if (manifest?.schemaVersion !== 1 || manifest.product !== 'kala-dedicated-support' || JSON.stringify(manifest.assets?.map((entry) => entry.name)) !== JSON.stringify(supportAssets)) throw new Error('invalid Dedicated support manifest')
  for (const entry of manifest.assets) { const bytes = entries.get(entry.name); if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256) || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Dedicated support asset mismatch: ${entry.name}`) }
  return new Map(supportAssets.map((name) => [name, entries.get(name)]))
}
function verifyExpandedSupport(root) { const entries = inspectSupportArchive(join(root, supportArchive)); for (const name of supportAssets) { const path = join(root, name); const value = lstatSync(path); const bytes = readFileSync(path); if (!value.isFile() || value.isSymbolicLink() || !bytes.equals(entries.get(name))) throw new Error(`Dedicated support extracted asset mismatch: ${name}`) } }
function readExactTarGz(compressed, label) {
  let tar
  try { tar = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }) } catch { throw new Error(`${label} archive is unreadable`) }
  const entries = new Map(); let offset = 0; let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every((byte) => byte === 0)) { ended = true; break }
    const expectedChecksum = tarNumber(header.subarray(148, 156), label); let actualChecksum = 0
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : header[index]
    if (actualChecksum !== expectedChecksum) throw new Error(`${label} archive has an invalid header checksum`)
    const name = tarText(header.subarray(0, 100)), prefix = tarText(header.subarray(345, 500)); const path = prefix ? `${prefix}/${name}` : name
    if (!path || path.includes('\\') || path.startsWith('/') || path.endsWith('/') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${label} archive contains an unsafe path`)
    if (![0, 48].includes(header[156])) throw new Error(`${label} archive contains a non-regular entry`)
    const size = tarNumber(header.subarray(124, 136), label)
    if (size > 512 * 1024 * 1024 || offset + size > tar.length || entries.has(path)) throw new Error(`${label} archive contains a duplicate, truncated, or oversized entry`)
    entries.set(path, Buffer.from(tar.subarray(offset, offset + size))); offset += Math.ceil(size / 512) * 512
  }
  if (!ended || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error(`${label} archive has an invalid terminator`)
  return entries
}
function tarText(bytes) { const end = bytes.indexOf(0); return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end < 0 ? bytes.length : end)) }
function tarNumber(bytes, label) { if (bytes[0] & 0x80) throw new Error(`${label} archive uses an unsupported tar number`); const value = tarText(bytes).trim(); if (!/^[0-7]*$/u.test(value)) throw new Error(`${label} archive has an invalid tar number`); const number = Number.parseInt(value || '0', 8); if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} archive has an invalid tar number`); return number }
function parseSums(value) { const result = new Map(); for (const line of value.trim().split('\n')) { const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u); if (!match || result.has(match[2])) throw new Error('invalid or duplicate SHA256SUMS entry'); result.set(match[2], match[1]) } return result }
function localReleaseMatches(path, files, sums) { try { if (!existsSync(path) || !statSync(path).isDirectory() || (statSync(path).mode & 0o222) !== 0) return false; const entries = readdirSync(path, { withFileTypes: true }); if (entries.some((entry) => !entry.isFile() || (statSync(join(path, entry.name)).mode & 0o222) !== 0) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify([...files].sort())) return false; if (sha256(readFileSync(join(path, 'SHA256SUMS'))) !== sha256(sums)) return false; const verification = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: path, encoding: 'utf8' }); return verification.status === 0 } catch { return false } }
function syncRelease(path, files) { for (const name of files) { const file = openSync(join(path, name), 'r'); try { fsyncSync(file) } finally { closeSync(file) } } const directory = openSync(path, 'r'); try { fsyncSync(directory) } finally { closeSync(directory) } }
function transportPathExists(shell, path) { try { shell('test -e ' + quote(path)); return true } catch { return false } }
function remoteReleaseMatches(shell, path, files, sums) { try { const entries = String(shell('test -d ' + quote(path) + ' && ! find ' + quote(path) + ' -perm /222 -print -quit | grep -q . && find ' + quote(path) + ' -mindepth 1 -maxdepth 1 -printf ' + quote('%f\t%y\n'))).trim().split('\n').filter(Boolean).map((line) => { const [name, type] = line.split('\t'); if (type !== 'f') throw new Error('non-file release entry'); return name }).sort(); if (JSON.stringify(entries) !== JSON.stringify([...files].sort())) return false; if (sha256(Buffer.from(shell('cat -- ' + quote(path + '/SHA256SUMS')))) !== sha256(sums)) return false; shell('cd ' + quote(path) + ' && sha256sum -c SHA256SUMS >/dev/null'); return true } catch { return false } }
function positive(value, fallback) { const number = Number(value ?? fallback); if (!Number.isSafeInteger(number) || number <= 0) throw new Error('expected a positive integer'); return number }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function optionValue(values, name) { for (let index = 0; index < values.length; index += 1) { if (values[index] === name) return values[index + 1]; if (values[index]?.startsWith(name + '=')) return values[index].slice(name.length + 1) } return undefined }
function optionTakesValue(value) { return ['--lxd', '--ssh', '--deploy-root', '--release-dir', '--release-id', '--operation-id', '--deployment-id', '--origin-session', '--origin-call', '--timeout-ms', '--poll-ms'].includes(value) }
function quote(value) { return String.fromCharCode(39) + String(value).replaceAll(String.fromCharCode(39), String.fromCharCode(39) + '\\' + String.fromCharCode(39) + String.fromCharCode(39)) + String.fromCharCode(39) }
function runSourceCommand(command, commandArgs) {
  if (!repositoryRoot) throw new Error('source repository is unavailable for local build or verification')
  const result = spawnSync(command, commandArgs, { cwd: repositoryRoot, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(command + ' failed with exit code ' + result.status)
}
function runCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(command + ' failed with exit code ' + result.status)
}
function captureCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: null, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(command + ' failed: ' + String(result.stderr || result.status))
  return result.stdout
}
