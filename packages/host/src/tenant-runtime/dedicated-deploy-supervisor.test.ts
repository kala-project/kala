import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostRestartAttempt, HostRestartStatus } from '@agent-kernel/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DedicatedDeploySupervisor } from './dedicated-deploy-supervisor.js'
import { verifyImmutableRelease, type DedicatedDeployRequest } from './dedicated-deploy-protocol.js'
import type { DedicatedRouteState, DedicatedSlot } from './dedicated-slot-state.js'

const roots: string[] = []
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const modernAssets = [
  ...['kala-host', 'kala-executor', 'kala-dedicated-ingress', 'kala-dedicated-deploy-supervisor']
    .flatMap((name) => ['linux-x64', 'darwin-x64', 'darwin-arm64'].map((target) => `${name}-${target}`)),
  'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs', 'kala-dedicated-ingress.cjs',
  'kala-dedicated-deploy-supervisor.cjs', 'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz',
  'kala-release-metadata.tar.gz', 'run.sh', 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
]
const localDevelopmentAssets = [
  'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs',
  'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
  'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz',
  'kala-release-metadata.tar.gz', 'run.sh', 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
]
const legacyPredecessorAssets = [
  'bundle-dashboard-with-runtime.cjs', 'agent-runlab-runtime.cjs', 'kala-executor.cjs',
  'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
  'agent-kernel-dashboard-dist.tar.gz', 'dashboard-release.json', 'agent-runlab-docs.tar.gz',
  'agent-runlab-model-catalog-seed.json', 'run.sh', 'install-executor.sh',
  'kala-dedicated-ingress.service', 'kala-dedicated-unit@.service',
  'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-control-updater.service',
  'kala-dedicated-migration-finalizer.service', 'deployment.json', 'install-dedicated-systemd.mjs',
  'kala-dedicated.mjs', 'deploy-dedicated.mjs', 'deploy-dashboard.mjs', 'cutover-dedicated-systemd.mjs',
  'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs', 'update-dedicated-control-plane.mjs',
  'rollback-dedicated-systemd.mjs', 'sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt',
]
const supportAssets = [
  'cutover-dedicated-systemd.mjs', 'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs',
  'deploy-dashboard.mjs', 'deploy-dedicated.mjs', 'deployment.json', 'install-dedicated-systemd.mjs',
  'kala-dedicated-control-updater.service', 'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-ingress.service',
  'kala-dedicated-migration-finalizer.service', 'kala-dedicated-unit@.service', 'rollback-dedicated-systemd.mjs',
  'update-dedicated-control-plane.mjs',
]
const safe = { safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }

async function makeTreeRemovable(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    await makeTreeRemovable(join(dir, entry.name))
  }))
}

async function release(root: string, name: string, content: string): Promise<{ dir: string; bundle: string; release: string }> {
  const dir = join(root, 'releases', name)
  const result = await writeRelease(dir, content, true)
  await chmod(dir, 0o500)
  await Promise.all(result.files.map(async (file) => await chmod(join(dir, file), 0o400)))
  return result
}

async function submission(root: string, operationId: string, content: string): Promise<{ dir: string; bundle: string; release: string }> {
  return await writeRelease(join(root, 'submissions', operationId), content)
}

async function localDevelopmentRelease(dir: string, content: string, immutable = false): Promise<{ dir: string; bundle: string; release: string; files: string[] }> {
  await mkdir(dir, { recursive: true })
  const checksummed = new Map(localDevelopmentAssets.map((name) => [name, name === 'kala-runtime.cjs' ? content : `${name}:${content}`]))
  checksummed.set('manifest.json', JSON.stringify({ localDevelopment: true, source: { dirty: true }, assets: localDevelopmentAssets }))
  for (const [file, value] of checksummed) await writeFile(join(dir, file), value)
  const sums = [...checksummed].map(([file, value]) => digest(value) + '  ' + file).join('\n') + '\n'
  await writeFile(join(dir, 'SHA256SUMS'), sums)
  const files = [...checksummed.keys(), 'SHA256SUMS']
  if (immutable) {
    await Promise.all(files.map(async (file) => await chmod(join(dir, file), 0o400)))
    await chmod(dir, 0o500)
  }
  return { dir, bundle: digest(content), release: digest(sums), files }
}

async function legacyPredecessorRelease(dir: string, content: string, immutable = false): Promise<{ dir: string; bundle: string; release: string; files: string[] }> {
  await mkdir(dir, { recursive: true })
  const manifest = JSON.stringify({
    name: 'kala', version: '0.2.0-rc.12', assets: legacyPredecessorAssets,
    fallbackAssets: {
      'kala-host': 'bundle-dashboard-with-runtime.cjs',
      'agent-runlab-runtime': 'agent-runlab-runtime.cjs',
      'kala-executor': 'kala-executor.cjs',
      'kala-dedicated-ingress': 'kala-dedicated-ingress.cjs',
      'kala-dedicated-deploy-supervisor': 'kala-dedicated-deploy-supervisor.cjs',
    },
  })
  const checksummed = new Map(legacyPredecessorAssets.map((name) => [name, name === 'agent-runlab-runtime.cjs' ? content : `${name}:${content}`]))
  checksummed.set('manifest.json', manifest)
  checksummed.set('RELEASE_NOTES.md', '# Agent RunLab predecessor release')
  for (const [file, value] of checksummed) await writeFile(join(dir, file), value)
  const sums = [...checksummed].map(([file, value]) => digest(value) + '  ' + file).join('\n') + '\n'
  await writeFile(join(dir, 'SHA256SUMS'), sums)
  const files = [...checksummed.keys(), 'SHA256SUMS']
  if (immutable) {
    await Promise.all(files.map(async (file) => await chmod(join(dir, file), 0o400)))
    await chmod(dir, 0o500)
  }
  return { dir, bundle: digest(content), release: digest(sums), files }
}

async function rehashRelease(dir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { assets: string[] }
  const names = [...manifest.assets, 'manifest.json']
  const sums = (await Promise.all(names.map(async (name) => `${digest(await readFile(join(dir, name)))}  ${name}`))).join('\n') + '\n'
  await writeFile(join(dir, 'SHA256SUMS'), sums)
  return digest(sums)
}

async function writeRelease(dir: string, content: string, legacy = false): Promise<{ dir: string; bundle: string; release: string; files: string[] }> {
  await mkdir(dir, { recursive: true })
  const assets = legacy ? ['kala-runtime.cjs'] : modernAssets
  const checksummed = new Map(assets.map((name) => [name, name === 'kala-runtime.cjs' ? content : `${name}:${content}`]))
  checksummed.set('manifest.json', JSON.stringify({ assets }))
  if (legacy) checksummed.set('RELEASE_NOTES.md', '# predecessor release')
  for (const [file, value] of checksummed) await writeFile(join(dir, file), value)
  const sums = [...checksummed].map(([file, value]) => digest(value) + '  ' + file).join('\n') + '\n'
  await writeFile(join(dir, 'SHA256SUMS'), sums)
  if (!legacy) await writeFile(join(dir, 'SHA256SUMS.sigstore.json'), JSON.stringify({ fixture: true }))
  return {
    dir, bundle: digest(content), release: digest(sums),
    files: [...checksummed.keys(), 'SHA256SUMS', ...(!legacy ? ['SHA256SUMS.sigstore.json'] : [])],
  }
}

function initialRoute(): DedicatedRouteState {
  return { schemaVersion: 1, generation: 1, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'old' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'old' } }, updatedAt: new Date().toISOString() }
}

function restart(phase: HostRestartAttempt['phase'], ownership?: HostRestartAttempt['deployment']): HostRestartAttempt {
  return { attemptId: 'restart-attempt-0001', phase, mode: 'checkpoint', reason: 'deploy', requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10, sessions: [], ...(ownership ? { deployment: ownership } : {}) }
}

function harness(route = initialRoute()) {
  let current = route
  let originPersisted = false
  let restartState: HostRestartStatus = { pid: 10, startedAt: new Date().toISOString(), current: null, last: null }
  let requestedRestartPhase: HostRestartAttempt['phase'] = 'checkpoint_reached'
  let includeContinuation = false
  let controlStatus: {
    phase: 'pending' | 'completed' | 'rolled_back' | 'rollback_failed'
    previousSupervisorPid?: number; previousIngressPid?: number; ingressPid?: number; supervisorPid?: number
    activatedAt?: string; readyAt?: string; error?: string
  } | undefined
  const calls: string[] = []
  const adapter = {
    routeState: async () => current,
    inspectQuiescence: vi.fn(async (_slot: DedicatedSlot) => safe),
    originToolResultPersisted: vi.fn(async () => originPersisted),
    requestPlannedRestart: vi.fn(async (_slot: DedicatedSlot, ownership: NonNullable<HostRestartAttempt['deployment']>) => {
      const attempt = restart(requestedRestartPhase, ownership)
      restartState = { ...restartState, current: attempt }
      calls.push('restart:request')
      return attempt
    }),
    restartStatus: vi.fn(async (_slot: DedicatedSlot) => restartState),
    commitPlannedRestart: vi.fn(async (_slot: DedicatedSlot, attemptId: string) => {
      const attempt = { ...restartState.current!, attemptId, phase: 'restarting' as const }
      restartState = { ...restartState, current: attempt }
      calls.push('restart:commit')
      return attempt
    }),
    abortPlannedRestart: vi.fn(async (_slot: DedicatedSlot, _attemptId?: string) => {
      if (restartState.current) restartState = { ...restartState, current: null, last: { ...restartState.current, phase: 'aborted' } }
      calls.push('restart:abort')
    }),
    selfTestRelease: vi.fn(async (_dir: string) => {}),
    startControlPlaneUpdate: vi.fn(async () => { calls.push('control:start') }),
    controlPlaneUpdateStatus: vi.fn(async () => controlStatus ?? ({
      phase: 'completed' as const, previousSupervisorPid: 8, previousIngressPid: 9, ingressPid: 19, supervisorPid: 18,
      activatedAt: new Date().toISOString(), readyAt: new Date().toISOString(),
    })),
    recoverControlPlane: vi.fn(async () => ({ phase: 'recovered' as const })),
    writeRuntimeFence: vi.fn(async (ownership?: NonNullable<HostRestartAttempt['deployment']>) => { calls.push(ownership ? 'fence:set' : 'fence:clear') }),
    writeCandidateState: vi.fn(async (state?: { deploymentId: string; phase: 'paused' | 'candidate' | 'admission' }) => { calls.push(state ? `candidate:${state.phase}` : 'candidate:clear') }),
    admissionSnapshot: vi.fn(async () => ({ pending: 0, leased: 0, oldestAgeMs: 0 })),
    persistRuntimeReady: vi.fn(async (_receipt, evidence) => { calls.push(evidence.publicRoute ? 'runtime:public' : 'runtime:private') }),
    clearRuntimeReady: vi.fn(async () => { calls.push('runtime:clear') }),
    activateSlot: vi.fn(async (slot: DedicatedSlot, dir: string) => { calls.push('activate:' + slot + ':' + dir.split('/').at(-1)) }),
    startSlot: vi.fn(async (slot: DedicatedSlot) => { calls.push('start:' + slot) }),
    stopSlot: vi.fn(async (slot: DedicatedSlot) => { calls.push('stop:' + slot) }),
    verifySlot: vi.fn(async (slot: DedicatedSlot, _expected: { bundleSha256: string; deployment?: NonNullable<HostRestartAttempt['deployment']>; requireContinuation?: boolean }) => { calls.push('verify:' + slot); return { pid: slot === 'green' ? 42 : 7, processReadyAt: new Date().toISOString(), runtimeReadyAt: new Date().toISOString(), ...(includeContinuation ? { continuation: { attemptId: 'restart-attempt-0001', participants: 0, completed: 0, failed: 0 } } : {}) } }),
    switchRoute: vi.fn(async (next: DedicatedRouteState) => { calls.push('route:' + next.activeSlot); current = next }),
  }
  return {
    adapter, calls, route: () => current,
    setRestart: (attempt: HostRestartAttempt) => { restartState = { ...restartState, current: attempt } },
    setRequestedRestartPhase: (phase: HostRestartAttempt['phase']) => { requestedRestartPhase = phase },
    persistOriginResult: () => { originPersisted = true },
    includeContinuation: () => { includeContinuation = true },
    setControlStatus: (status: NonNullable<typeof controlStatus>) => { controlStatus = status },
    failNextVerification: () => adapter.verifySlot.mockImplementationOnce(async () => { throw new Error('unhealthy') }),
  }
}

function request(next: Awaited<ReturnType<typeof release>>, patch: Partial<DedicatedDeployRequest> = {}): DedicatedDeployRequest {
  return {
    schemaVersion: 1, action: 'deploy', operationId: 'operation-deploy-0001', deploymentId: 'deployment-0001',
    topology: 'dedicated-slots', unitId: 'local', requestedAt: new Date().toISOString(), expectedRouteGeneration: 1,
    fencingToken: 'fencing-token-0001', sourceReleaseDigest: patch.sourceReleaseDigest ?? '', targetReleaseDigest: next.release,
    predecessorReleaseId: 'old', candidateSlot: 'green', releaseId: 'next', stagedReleaseDir: next.dir, bundleSha256: next.bundle,
    ...patch,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTreeRemovable(root)
    await rm(root, { recursive: true, force: true })
  }))
})

describe('Dedicated Deploy Supervisor protocol', () => {
  it('rejects stale generation before persisting or stopping a slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-stale-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    await expect(supervisor.accept(request(next, { sourceReleaseDigest: old.release, expectedRouteGeneration: 2 }))).rejects.toThrow('stale route')
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
  })

  it('returns the same receipt for an idempotent operation and rejects a conflicting duplicate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-idempotent-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter); const input = request(next, { sourceReleaseDigest: old.release })
    const first = await supervisor.accept(input); const second = await supervisor.accept(input)
    expect(second.deploymentId).toBe(first.deploymentId)
    await expect(supervisor.accept({ ...input, bundleSha256: digest('different') })).rejects.toThrow('conflicts')
  })

  it('publishes the exact modern 27-file release with archived metadata and no standalone notes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-publish-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    expect(staged.releaseDir).toBe(join(root, 'releases', 'next'))
    expect(await readdir(staged.releaseDir)).toHaveLength(27)
    expect(await readFile(join(staged.releaseDir, 'kala-release-metadata.tar.gz'), 'utf8')).toBe('kala-release-metadata.tar.gz:next')
    await expect(readFile(join(staged.releaseDir, 'RELEASE_NOTES.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts an explicitly marked dirty local CJS candidate only with machine opt-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-local-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const next = await localDevelopmentRelease(join(root, 'submissions', 'operation-deploy-0001'), 'local-next')
    const input = request(next, { sourceReleaseDigest: old.release })
    await expect(new DedicatedDeploySupervisor(root, harness().adapter).accept(input)).rejects.toThrow('not enabled on this machine')

    const staged = await new DedicatedDeploySupervisor(root, harness().adapter, { allowLocalDevelopment: true }).accept(input)
    expect((await readdir(staged.releaseDir)).sort()).toEqual([...localDevelopmentAssets, 'manifest.json', 'SHA256SUMS'].sort())
    expect(localDevelopmentAssets).toContain('kala-release-metadata.tar.gz')
    expect(JSON.parse(await readFile(join(staged.releaseDir, 'manifest.json'), 'utf8'))).toMatchObject({
      localDevelopment: true, source: { dirty: true },
    })
    await expect(readFile(join(staged.releaseDir, 'SHA256SUMS.sigstore.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects local candidates without the marker, exact asset set, no-signature layout, or valid hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-local-invalid-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const options = { allowLocalDevelopment: true }

    const unmarked = await localDevelopmentRelease(join(root, 'submissions', 'operation-local-unmarked'), 'unmarked')
    const unmarkedManifest = JSON.parse(await readFile(join(unmarked.dir, 'manifest.json'), 'utf8'))
    delete unmarkedManifest.localDevelopment
    await writeFile(join(unmarked.dir, 'manifest.json'), JSON.stringify(unmarkedManifest)); unmarked.release = await rehashRelease(unmarked.dir)
    await expect(new DedicatedDeploySupervisor(root, harness().adapter, options).accept(request(unmarked, {
      operationId: 'operation-local-unmarked', deploymentId: 'deployment-local-unmarked', sourceReleaseDigest: old.release,
    }))).rejects.toThrow('exactly 27 files')

    const extra = await localDevelopmentRelease(join(root, 'submissions', 'operation-local-extra'), 'extra')
    const extraManifest = JSON.parse(await readFile(join(extra.dir, 'manifest.json'), 'utf8'))
    extraManifest.assets.push('unexpected.cjs'); await writeFile(join(extra.dir, 'unexpected.cjs'), 'unexpected')
    await writeFile(join(extra.dir, 'manifest.json'), JSON.stringify(extraManifest)); extra.release = await rehashRelease(extra.dir)
    await expect(new DedicatedDeploySupervisor(root, harness().adapter, options).accept(request(extra, {
      operationId: 'operation-local-extra', deploymentId: 'deployment-local-extra', sourceReleaseDigest: old.release,
    }))).rejects.toThrow('exact current or legacy CJS asset set')

    const signed = await localDevelopmentRelease(join(root, 'submissions', 'operation-local-signed'), 'signed')
    await writeFile(join(signed.dir, 'SHA256SUMS.sigstore.json'), '{}')
    await expect(new DedicatedDeploySupervisor(root, harness().adapter, options).accept(request(signed, {
      operationId: 'operation-local-signed', deploymentId: 'deployment-local-signed', sourceReleaseDigest: old.release,
    }))).rejects.toThrow('file set')

    const changed = await localDevelopmentRelease(join(root, 'submissions', 'operation-local-changed'), 'changed')
    await writeFile(join(changed.dir, 'kala-docs.tar.gz'), 'tampered')
    await expect(new DedicatedDeploySupervisor(root, harness().adapter, options).accept(request(changed, {
      operationId: 'operation-local-changed', deploymentId: 'deployment-local-changed', sourceReleaseDigest: old.release,
    }))).rejects.toThrow('invalid release asset')
  })

  it('accepts only archive-verified support expansion in an immutable modern predecessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-expanded-support-')); roots.push(root)
    const modern = await writeRelease(join(root, 'releases', 'modern'), 'modern')
    const supportEntries = []
    for (const name of supportAssets) {
      const bytes = Buffer.from(`support:${name}\n`); await writeFile(join(modern.dir, name), bytes)
      supportEntries.push({ name, bytes: bytes.length, sha256: digest(bytes) })
    }
    await writeFile(join(modern.dir, 'dedicated-support-manifest.json'), JSON.stringify({ schemaVersion: 1, product: 'kala-dedicated-support', assets: supportEntries }))
    const archived = spawnSync('tar', ['--format=ustar', '-czf', join(modern.dir, 'kala-dedicated-support.tar.gz'), '-C', modern.dir, ...supportAssets, 'dedicated-support-manifest.json'])
    expect(archived.status).toBe(0)
    await rm(join(modern.dir, 'dedicated-support-manifest.json'))
    const manifest = JSON.parse(await readFile(join(modern.dir, 'manifest.json'), 'utf8')) as { assets: string[] }
    const checksummed = [...manifest.assets, 'manifest.json'].sort()
    const sums = (await Promise.all(checksummed.map(async (name) => `${digest(await readFile(join(modern.dir, name)))}  ${name}`))).join('\n') + '\n'
    await writeFile(join(modern.dir, 'SHA256SUMS'), sums)
    for (const name of await readdir(modern.dir)) await chmod(join(modern.dir, name), 0o400)
    await chmod(modern.dir, 0o500)
    const input = { deployRoot: root, releaseDir: modern.dir, releaseId: 'modern', releaseDigest: digest(sums), bundleSha256: modern.bundle }
    await expect(verifyImmutableRelease(input)).resolves.toBeUndefined()
    await chmod(modern.dir, 0o700); await chmod(join(modern.dir, supportAssets[0]!), 0o600)
    await writeFile(join(modern.dir, supportAssets[0]!), 'tampered'); await chmod(join(modern.dir, supportAssets[0]!), 0o400); await chmod(modern.dir, 0o500)
    await expect(verifyImmutableRelease(input)).rejects.toThrow('expanded Dedicated support asset mismatch')
  })

  it('rejects extra submission files before immutable publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-extra-file-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    await writeFile(join(next.dir, 'unexpected'), 'not in manifest')
    const supervisor = new DedicatedDeploySupervisor(root, harness().adapter)
    await expect(supervisor.accept(request(next, { sourceReleaseDigest: old.release }))).rejects.toThrow('file set')
  })

  it('rejects standalone notes and predecessor-format submissions while retaining immutable predecessor rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-layouts-')); roots.push(root)
    const old = await legacyPredecessorRelease(join(root, 'releases', 'old'), 'old', true)
    const withNotes = await submission(root, 'operation-deploy-0001', 'next')
    await writeFile(join(withNotes.dir, 'RELEASE_NOTES.md'), '# no longer external')
    await expect(new DedicatedDeploySupervisor(root, harness().adapter).accept(request(withNotes, { sourceReleaseDigest: old.release }))).rejects.toThrow('file set')

    const legacy = await legacyPredecessorRelease(join(root, 'submissions', 'operation-deploy-0002'), 'legacy-next')
    await expect(new DedicatedDeploySupervisor(root, harness().adapter).accept(request(legacy, {
      operationId: 'operation-deploy-0002', deploymentId: 'deployment-0002', sourceReleaseDigest: old.release,
    }))).rejects.toThrow('missing kala-release-metadata.tar.gz')

    const rollbackRequest: DedicatedDeployRequest = {
      schemaVersion: 1, action: 'restart', operationId: 'operation-restart-0001', deploymentId: 'deployment-restart-0001',
      topology: 'dedicated-slots', unitId: 'local', requestedAt: new Date().toISOString(), expectedRouteGeneration: 1,
      fencingToken: 'fencing-token-restart-0001', sourceReleaseDigest: old.release, targetReleaseDigest: old.release,
      predecessorReleaseId: 'old', candidateSlot: 'green',
    }
    await expect(new DedicatedDeploySupervisor(root, harness().adapter).accept(rollbackRequest)).resolves.toMatchObject({ releaseId: 'old' })
  })

  it('rejects a metadata archive checksum mismatch and a mismatched SHA256SUMS digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-digests-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const changed = await submission(root, 'operation-deploy-0001', 'next')
    await writeFile(join(changed.dir, 'kala-release-metadata.tar.gz'), 'changed')
    await expect(new DedicatedDeploySupervisor(root, harness().adapter).accept(request(changed, { sourceReleaseDigest: old.release }))).rejects.toThrow('invalid release asset')

    const intact = await submission(root, 'operation-deploy-0002', 'next')
    await expect(new DedicatedDeploySupervisor(root, harness().adapter).accept(request(intact, {
      operationId: 'operation-deploy-0002', deploymentId: 'deployment-0002', sourceReleaseDigest: old.release, targetReleaseDigest: digest('wrong'),
    }))).rejects.toThrow('release digest mismatch')
  })

  it('rebuilds a missing operation index from the authoritative receipt after a crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-index-recovery-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const input = request(next, { sourceReleaseDigest: old.release })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const first = await supervisor.accept(input)
    await rm(join(root, 'operation-index.json'))
    const recovered = await new DedicatedDeploySupervisor(root, h.adapter).accept(input)
    expect(recovered).toMatchObject({ deploymentId: first.deploymentId, receiptRevision: first.receiptRevision })
    expect(JSON.parse(await readFile(join(root, 'operation-index.json'), 'utf8'))).toMatchObject({ [input.operationId]: input.deploymentId })
  })

  it('recovers schema-v1 receipts containing the original completed continuation outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-completed-recovery-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const input = request(next, { sourceReleaseDigest: old.release })
    const first = await new DedicatedDeploySupervisor(root, h.adapter).accept(input)
    const receiptPath = join(root, 'receipts', `${first.deploymentId}.json`)
    const durable = JSON.parse(await readFile(receiptPath, 'utf8'))
    durable.continuation = {
      attemptId: 'restart-attempt-0001',
      participants: 1,
      completed: 1,
      failed: 0,
      sessions: [{ sessionId: 'session-0001', cursor: 7, checkpointKind: 'before_llm', resumeAction: 'continue_turn', outcome: 'completed' }],
    }
    await writeFile(receiptPath, JSON.stringify(durable))

    await expect(new DedicatedDeploySupervisor(root, h.adapter).accept(input)).resolves.toMatchObject({
      deploymentId: first.deploymentId,
      continuation: { participants: 1, completed: 1, failed: 0 },
    })
  })

  it('aborts safely before reservation and persists a monotonic terminal receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-abort-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const abort: DedicatedDeployRequest = { ...request(next, { sourceReleaseDigest: old.release }), action: 'abort', operationId: 'operation-abort-0001', deploymentId: staged.deploymentId, targetDeploymentId: staged.deploymentId, releaseId: undefined, stagedReleaseDir: undefined, bundleSha256: undefined }
    const receipt = await supervisor.accept(abort)
    expect(receipt).toMatchObject({ phase: 'aborted', action: 'abort' })
    expect(receipt.receiptRevision).toBeGreaterThan(staged.receiptRevision)
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
  })

  it('safely aborts a waiting boundary by cancelling its planned restart and restoring control', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-boundary-abort-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    h.setRequestedRestartPhase('draining')
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting.phase).toBe('waiting_for_boundary')

    const abort: DedicatedDeployRequest = {
      ...request(next, { sourceReleaseDigest: old.release }), action: 'abort', operationId: 'operation-abort-boundary-0001',
      deploymentId: staged.deploymentId, targetDeploymentId: staged.deploymentId, releaseId: undefined, stagedReleaseDir: undefined, bundleSha256: undefined,
    }
    const receipt = await supervisor.accept(abort)
    expect(receipt).toMatchObject({ phase: 'rolled_back', action: 'abort', rollback: { mode: 'cancel', outcome: 'completed' } })
    expect(h.calls).toContain('restart:abort')
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
    expect(h.route()).toMatchObject({ generation: 1, activeSlot: 'blue' })
  })

  it('hands planned continuation ownership to the candidate before route commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-ok-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', previousSlot: 'blue', candidateSlot: 'green', activatedPid: 42, routeGeneration: 2 })
    expect(h.calls).toEqual(['control:start', 'restart:request', 'candidate:paused', 'runtime:clear', 'fence:set', 'restart:commit', 'stop:blue', 'activate:green:next', 'start:green', 'candidate:candidate', 'verify:green', 'candidate:admission', 'runtime:private', 'route:green', 'runtime:public', 'candidate:clear'])
    expect(h.adapter.persistRuntimeReady).toHaveBeenLastCalledWith(expect.objectContaining({ deploymentId: staged.deploymentId }), expect.objectContaining({ publicRoute: true, routeGeneration: 2 }))
    expect(h.adapter.verifySlot).toHaveBeenCalledWith('green', {
      bundleSha256: next.bundle,
      deployment: expect.objectContaining({
        deploymentId: staged.deploymentId,
        targetReleaseDigest: next.release,
        expectedRouteGeneration: 1,
        fencingToken: 'fencing-token-0001',
      }),
    })
    expect(h.route()).toMatchObject({ generation: 2, activeSlot: 'green' })
  })

  it('gracefully restarts onto the other slot without staging or updating the control plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-restart-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const input: DedicatedDeployRequest = {
      schemaVersion: 1, action: 'restart', operationId: 'operation-restart-0001', deploymentId: 'deployment-restart-0001',
      topology: 'dedicated-slots', unitId: 'local', requestedAt: new Date().toISOString(), expectedRouteGeneration: 1,
      fencingToken: 'fencing-token-restart-0001', sourceReleaseDigest: old.release, targetReleaseDigest: old.release,
      predecessorReleaseId: 'old', candidateSlot: 'green',
    }
    const accepted = await supervisor.accept(input)
    expect(accepted).toMatchObject({ action: 'restart', phase: 'control_ready', releaseId: 'old', releaseDigest: old.release })
    const completed = await supervisor.reconcile(accepted.deploymentId)
    expect(completed).toMatchObject({ action: 'restart', phase: 'completed', routeGeneration: 2, previousSlot: 'blue', candidateSlot: 'green' })
    expect(h.adapter.startControlPlaneUpdate).not.toHaveBeenCalled()
    expect(h.calls).not.toContain('control:start')
    expect(h.calls).toContain('activate:green:old')
  })

  it('clears the admission blocker and records reconciled handoff operations before completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-admission-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness()
    h.adapter.admissionSnapshot
      .mockResolvedValueOnce({ pending: 1, leased: 0, oldestAgeMs: 25 })
      .mockResolvedValueOnce({ pending: 0, leased: 0, oldestAgeMs: 0 })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting).toMatchObject({ phase: 'verifying', admission: { pending: 1, reconciled: 0 }, blockers: ['admission_queue'] })
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', admission: { pending: 0, reconciled: 1, oldestAgeMs: 0 }, blockers: [] })
  })

  it('keeps the deployment non-terminal until the control updater proves both new processes ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-control-wait-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.setControlStatus({ phase: 'pending' })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting).toMatchObject({ phase: 'control_updating' })
    expect(waiting.routeGeneration).toBeUndefined()
    expect(h.route()).toMatchObject({ generation: 1, activeSlot: 'blue' })
    expect(h.adapter.requestPlannedRestart).not.toHaveBeenCalled()
    expect(h.adapter.startSlot).not.toHaveBeenCalled()

    const activatedAt = new Date().toISOString(); const readyAt = new Date().toISOString()
    h.setControlStatus({ phase: 'completed', previousSupervisorPid: 8, previousIngressPid: 9, ingressPid: 19, supervisorPid: 18, activatedAt, readyAt })
    const completed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(completed).toMatchObject({
      phase: 'completed',
      controlPlane: { previousSupervisorPid: 8, previousIngressPid: 9, ingressPid: 19, supervisorPid: 18, activatedAt, readyAt },
    })
    expect(h.adapter.startControlPlaneUpdate).toHaveBeenCalledTimes(2)
  })

  it('revalidates local opt-in after a control-plane Supervisor restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-local-control-restart-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const next = await localDevelopmentRelease(join(root, 'submissions', 'operation-deploy-0001'), 'local-next')
    const h = harness(); h.setControlStatus({ phase: 'pending' })
    const staged = await new DedicatedDeploySupervisor(root, h.adapter, { allowLocalDevelopment: true }).accept(request(next, { sourceReleaseDigest: old.release }))
    expect(await new DedicatedDeploySupervisor(root, h.adapter, { allowLocalDevelopment: true }).reconcile(staged.deploymentId)).toMatchObject({ phase: 'control_updating' })

    const rejected = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(rejected).toMatchObject({ phase: 'rolled_back', error: { message: expect.stringContaining('not enabled on this machine') } })
    expect(h.adapter.requestPlannedRestart).not.toHaveBeenCalled()
  })

  it('continues a local deployment after restart when the machine opt-in remains configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-local-control-opted-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const next = await localDevelopmentRelease(join(root, 'submissions', 'operation-deploy-0001'), 'local-next')
    const h = harness(); h.setControlStatus({ phase: 'pending' })
    const options = { allowLocalDevelopment: true }
    const staged = await new DedicatedDeploySupervisor(root, h.adapter, options).accept(request(next, { sourceReleaseDigest: old.release }))
    expect(await new DedicatedDeploySupervisor(root, h.adapter, options).reconcile(staged.deploymentId)).toMatchObject({ phase: 'control_updating' })
    h.setControlStatus({
      phase: 'completed', previousSupervisorPid: 8, previousIngressPid: 9, ingressPid: 19, supervisorPid: 18,
      activatedAt: new Date().toISOString(), readyAt: new Date().toISOString(),
    })
    await expect(new DedicatedDeploySupervisor(root, h.adapter, options).reconcile(staged.deploymentId)).resolves.toMatchObject({ phase: 'completed' })
  })

  it('restores the control plane before rolling Runtime back after target control failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-control-rollback-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.includeContinuation(); h.setControlStatus({ phase: 'rolled_back', error: 'target control unhealthy' })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const rolledBack = await supervisor.reconcile(staged.deploymentId)
    expect(rolledBack.phase).toBe('rolled_back')
    expect(h.adapter.recoverControlPlane).toHaveBeenCalled()
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
    expect(h.adapter.verifySlot).toHaveBeenCalledWith('blue', expect.anything())
    expect(h.route()).toMatchObject({ activeSlot: 'blue' })
  })

  it('does not drain or stop the origin Session Host until its deploy Tool result is durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-origin-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, {
      sourceReleaseDigest: old.release,
      origin: { sessionId: 'session-origin-0001', callId: 'call-deploy-0001' },
    }))
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting).toMatchObject({ phase: 'waiting_for_origin_result', blockers: ['origin_tool_result'] })
    expect(h.adapter.requestPlannedRestart).not.toHaveBeenCalled()
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()

    h.persistOriginResult()
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', origin: staged.origin })
    expect(completed.originResultPersistedAt).toEqual(expect.any(String))
    expect(h.adapter.originToolResultPersisted).toHaveBeenCalledWith('blue', staged.origin)
  })

  it('restores the predecessor and resumes persisted rollback after Supervisor restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-rollback-')); roots.push(root)
    const old = await legacyPredecessorRelease(join(root, 'releases', 'old'), 'old', true); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.failNextVerification(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const receipt = await supervisor.reconcile(staged.deploymentId)
    expect(receipt.phase).toBe('rolled_back')
    expect(h.adapter.verifySlot).toHaveBeenCalledWith('blue', expect.objectContaining({ bundleSha256: old.bundle }))
    const persisted = JSON.parse(await readFile(join(root, 'receipts', staged.deploymentId + '.json'), 'utf8'))
    await writeFile(join(root, 'receipts', staged.deploymentId + '.json'), JSON.stringify({ ...persisted, phase: 'rolling_back', receiptRevision: persisted.receiptRevision + 1, rollback: { predecessorReleaseId: 'old', outcome: 'pending' } }))
    const resumed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(resumed.phase).toBe('rolled_back')
  })

  it('revalidates local predecessor opt-in when rollback resumes after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-local-rollback-restart-')); roots.push(root)
    const old = await localDevelopmentRelease(join(root, 'releases', 'old'), 'local-old', true)
    const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.failNextVerification()
    const options = { allowLocalDevelopment: true }
    const staged = await new DedicatedDeploySupervisor(root, h.adapter, options).accept(request(next, { sourceReleaseDigest: old.release }))
    const rolledBack = await new DedicatedDeploySupervisor(root, h.adapter, options).reconcile(staged.deploymentId)
    expect(rolledBack.phase).toBe('rolled_back')

    const receiptPath = join(root, 'receipts', staged.deploymentId + '.json')
    const persisted = JSON.parse(await readFile(receiptPath, 'utf8'))
    await writeFile(receiptPath, JSON.stringify({
      ...persisted, phase: 'rolling_back', receiptRevision: persisted.receiptRevision + 1,
      rollback: { predecessorReleaseId: 'old', outcome: 'pending', stage: 'verifying_live' },
    }))
    const rejected = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(rejected).toMatchObject({
      phase: 'rollback_failed', error: { message: expect.stringContaining('local development release is not enabled on this machine') },
    })
  })

  it('runs an operator rollback through a new planned handoff deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-operator-rollback-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed.phase).toBe('completed')

    const rollbackRequest: DedicatedDeployRequest = {
      schemaVersion: 1, action: 'rollback', operationId: 'operation-rollback-0001', deploymentId: 'deployment-rollback-0001',
      topology: 'dedicated-slots', unitId: 'local', requestedAt: new Date().toISOString(), expectedRouteGeneration: 2,
      fencingToken: 'fencing-token-rollback-0001', sourceReleaseDigest: next.release, targetReleaseDigest: old.release,
      predecessorReleaseId: 'old', candidateSlot: 'blue', targetDeploymentId: completed.deploymentId,
    }
    const rollback = await supervisor.accept(rollbackRequest)
    expect(rollback).toMatchObject({
      deploymentId: rollbackRequest.deploymentId, targetDeploymentId: completed.deploymentId, action: 'rollback',
      phase: 'staged', previousSlot: 'green', candidateSlot: 'blue', releaseId: 'old', predecessorReleaseId: 'next',
    })
    h.calls.splice(0)
    const rolledBack = await supervisor.reconcile(rollback.deploymentId)
    expect(rolledBack).toMatchObject({ phase: 'completed', action: 'rollback', routeGeneration: 3, rollback: { outcome: 'completed', pid: 7 } })
    expect(h.calls).toEqual([
      'control:start', 'restart:request', 'candidate:paused', 'runtime:clear', 'fence:set', 'restart:commit', 'stop:green',
      'activate:blue:old', 'start:blue', 'candidate:candidate', 'verify:blue', 'candidate:admission',
      'runtime:private', 'route:blue', 'runtime:public', 'candidate:clear',
    ])
  })

  it('resumes automatic rollback at a persisted stage without repeating predecessor activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-staged-rollback-resume-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.failNextVerification(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const rolledBack = await supervisor.reconcile(staged.deploymentId)
    expect(rolledBack.phase).toBe('rolled_back')
    const persisted = JSON.parse(await readFile(join(root, 'receipts', staged.deploymentId + '.json'), 'utf8'))
    await writeFile(join(root, 'receipts', staged.deploymentId + '.json'), JSON.stringify({
      ...persisted, phase: 'rolling_back', receiptRevision: persisted.receiptRevision + 1,
      rollback: { ...persisted.rollback, outcome: 'pending', stage: 'verifying' },
    }))
    h.calls.splice(0)
    const resumed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(resumed.phase).toBe('rolled_back')
    expect(h.calls).not.toContain('activate:blue:old')
    expect(h.calls).not.toContain('start:blue')
    expect(h.calls).toContain('verify:blue')
  })

  it('replays a persisted predecessor-activation boundary idempotently after Supervisor crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-rollback-activation-boundary-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.failNextVerification(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const rolledBack = await supervisor.reconcile(staged.deploymentId)
    expect(rolledBack.phase).toBe('rolled_back')
    const persisted = JSON.parse(await readFile(join(root, 'receipts', staged.deploymentId + '.json'), 'utf8'))
    await writeFile(join(root, 'receipts', staged.deploymentId + '.json'), JSON.stringify({
      ...persisted, phase: 'rolling_back', receiptRevision: persisted.receiptRevision + 1,
      rollback: { ...persisted.rollback, outcome: 'pending', stage: 'activating_predecessor' },
    }))
    h.calls.splice(0)
    const resumed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(resumed.phase).toBe('rolled_back')
    expect(h.calls).toEqual(expect.arrayContaining(['candidate:paused', 'activate:blue:old', 'start:blue', 'candidate:candidate', 'verify:blue']))
  })
})
