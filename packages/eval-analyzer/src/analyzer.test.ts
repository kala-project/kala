import { execFileSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { zstdDecompressSync } from 'node:zlib'

import { describe, expect, it, vi } from 'vitest'

import { AnalyzerInputSchema, DefectFindingSchema, StaticSigningKeyRegistry, parseTrialTraceJsonl, serializeTrialTraceJsonl, counterfactualFailureFingerprint, type AnalyzerInput, type DefectFinding, type NormalizedAgentEvent } from '@agent-kernel/eval-protocol'
import { alignTraces, analyzeRequiredDetectors, buildVerifiedReproductionBundle, calibratedDetectorConfidence, clusterUnknownFailures, CommandCounterfactualContinuationHarness, continueCounterfactual, humanPromoteCluster, minimizeFailure, recordHumanClusterPromotion, requiredDetectorValidationCorpus, requiredDetectorValidationManifest, validateDetector, verifyReproductionBundleSignature, type DetectorValidationCase, type RequiredDetectorId } from './index.js'

const HASH = 'a'.repeat(64)
const AT = '2026-08-03T00:00:00.000Z'

describe('required defect detectors', () => {
  it('detects each seeded failure and stays silent on its paired control', () => {
    const cases = validationCases()
    for (const detectorId of requiredDetectorIds()) {
      const positive = cases.find((entry) => entry.detectorId === detectorId && entry.expectedFinding)!
      const negative = cases.find((entry) => entry.detectorId === detectorId && !entry.expectedFinding)!
      expect(analyzeRequiredDetectors(positive.input, [detectorId])).toHaveLength(1)
      expect(analyzeRequiredDetectors(negative.input, [detectorId])).toHaveLength(0)
    }
  })

  it('generates versioned precision/recall/F1 reports from the seeded corpus', () => {
    const cases = validationCases()
    for (const detectorId of requiredDetectorIds()) {
      expect(validateDetector(detectorId, cases, AT)).toMatchObject({ cases: 2, truePositive: 1, falsePositive: 0, trueNegative: 1, falseNegative: 0, precision: 1, recall: 1, f1: 1 })
    }
  })

  it('computes non-perfect measured validation rather than hard-coding a perfect score', () => {
    const cases = validationCases().filter((entry) => entry.detectorId === 'instruction-drift')
    const mislabeled = cases.map((entry, index) => index === 0 ? { ...entry, expectedFinding: false } : entry)
    expect(validateDetector('instruction-drift', mislabeled, AT)).toMatchObject({ precision: 0, recall: 0, falsePositive: 1, trueNegative: 1 })
  })

  it('uses a strict grouped train/holdout synthetic-derived corpus with difficult and incomplete cases', async () => {
    const cases = await requiredDetectorValidationCorpus()
    const manifest = await requiredDetectorValidationManifest(cases)
    expect(cases).toHaveLength(60)
    expect(new Set(cases.map((entry) => entry.caseId)).size).toBe(60)
    expect(new Set(cases.map((entry) => entry.metadata?.agentId))).toEqual(new Set(['agent-runlab', 'claude-code', 'codex']))
    expect(cases.some((entry) => entry.metadata?.difficulty === 'difficult-negative')).toBe(true)
    expect(cases.some((entry) => entry.metadata?.difficulty === 'missing-evidence')).toBe(true)
    expect(manifest.provenanceStatement).toContain('synthetic-derived')
    for (const groupId of new Set(cases.map((entry) => entry.metadata!.groupId))) expect(new Set(cases.filter((entry) => entry.metadata!.groupId === groupId).map((entry) => entry.metadata!.split)).size).toBe(1)
    for (const detectorId of requiredDetectorIds()) {
      expect(validateDetector(detectorId, cases, AT, manifest.corpusId, manifest.corpusVersion)).toMatchObject({ cases: 8, truePositive: 4, falsePositive: 0, trueNegative: 4, falseNegative: 0, precision: 1, recall: 1, f1: 1, confidenceIntervals: { method: 'group-bootstrap', samples: 1000 }, calibration: { bins: 10 }, annotation: { annotatedCases: 8, doubleAnnotatedCases: 8, adjudicatedCases: 2 } })
    }
  })

  it('calibrates confidence from evidence completeness rather than returning one', async () => {
    const cases = await requiredDetectorValidationCorpus()
    const complete = cases.find((entry) => entry.detectorId === 'instruction-drift' && entry.expectedFinding && entry.metadata?.difficulty === 'standard')!
    const incomplete = cases.find((entry) => entry.detectorId === 'instruction-drift' && entry.expectedFinding && entry.metadata?.difficulty === 'missing-evidence')!
    const completeConfidence = analyzeRequiredDetectors(complete.input, ['instruction-drift'])[0]!.confidence
    const incompleteConfidence = calibratedDetectorConfidence('instruction-drift', incomplete.input, [])
    expect(completeConfidence).toBeLessThan(1)
    expect(incompleteConfidence).toBeLessThan(completeConfidence)
  })
})

describe('trace mining and minimization', () => {
  it('reports the exact first meaningful divergence', () => {
    const left = [event(0, 'status', { state: 'start' }), event(1, 'tool_call', { tool: 'read' }), event(2, 'error', { code: 'ENOENT' })]
    const right = [event(0, 'status', { state: 'start' }), event(1, 'tool_call', { tool: 'read' }), event(2, 'tool_call', { tool: 'search' })]
    expect(alignTraces('left', left, 'right', right)).toMatchObject({ commonPrefixLength: 2, firstDivergence: { leftSequence: 2, rightSequence: 2, leftKind: 'error', rightKind: 'tool_call' } })
  })

  it('aligns cross-Agent semantics, identifies the missing successful action, and measures failed recovery cost', () => {
    const success = [
      { ...event(0, 'status', { state: 'start', requestId: 'agent-a' }), at: '2026-08-03T00:00:00.000Z' },
      { ...event(1, 'tool_call', { tool: 'read', path: 'src/a.ts', latencyMs: 5 }), at: '2026-08-03T00:00:01.000Z' },
      { ...event(2, 'command', { argv: ['pnpm', 'test'] }), at: '2026-08-03T00:00:02.000Z' },
      { ...event(3, 'usage', { costUsd: 0.1 }), at: '2026-08-03T00:00:03.000Z' },
      { ...event(4, 'status', { state: 'done' }), at: '2026-08-03T00:00:04.000Z' },
    ]
    const failure = [
      { ...event(0, 'status', { state: 'start', requestId: 'agent-b' }), at: '2026-08-03T00:01:00.000Z' },
      { ...event(1, 'tool_call', { tool: 'read', path: 'src/a.ts', latencyMs: 90 }), at: '2026-08-03T00:01:02.000Z' },
      { ...event(2, 'tool_call', { tool: 'deploy' }), at: '2026-08-03T00:01:04.000Z' },
      { ...event(3, 'error', { code: 'ECONNRESET' }), at: '2026-08-03T00:01:06.000Z' },
      { ...event(4, 'tool_call', { tool: 'deploy' }), at: '2026-08-03T00:01:08.000Z' },
      { ...event(5, 'error', { code: 'ECONNRESET' }), at: '2026-08-03T00:01:10.000Z' },
      { ...event(6, 'usage', { costUsd: 0.7 }), at: '2026-08-03T00:01:11.000Z' },
      { ...event(7, 'status', { state: 'failed' }), at: '2026-08-03T00:01:12.000Z' },
    ]
    expect(alignTraces('agent-a-success', success, 'agent-b-failure', failure)).toMatchObject({
      leftOutcome: 'success', rightOutcome: 'failure', commonPrefixLength: 2, additionalLoopCost: 3,
      firstDivergence: { leftSequence: 2, rightSequence: 2, leftKind: 'command', rightKind: 'tool_call' },
      missingSuccessfulAction: { successfulTrialId: 'agent-a-success', failedTrialId: 'agent-b-failure', sequence: 2, kind: 'command' },
      costAfterDivergence: { leftEvents: 2, rightEvents: 5, leftWallMs: 2_000, rightWallMs: 8_000, leftCostUsd: 0.1, rightCostUsd: 0.7 },
    })
  })

  it('clusters unknown failures deterministically and requires human naming for promotion', () => {
    const finding = (id: string): DefectFinding => DefectFindingSchema.parse({ schemaVersion: 1, findingId: id, detectorId: 'unknown-cluster', detectorVersion: '1', runId: 'run', trialId: 'trial-' + id, category: 'unknown', severity: 'high', confidence: 0.5, evidenceRefs: ['evidence:' + id], status: 'detected' })
    const clusters = clusterUnknownFailures([{ finding: finding('one'), actionErrorSequence: ['read:ENOENT', 'read:ENOENT'] }, { finding: finding('two'), actionErrorSequence: ['read:ENOENT', 'read:ENOENT'] }])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.memberFindingIds).toEqual(['one', 'two'])
    expect(humanPromoteCluster(clusters[0]!, 'Repeated stale path', 'tool_recovery')).toMatchObject({ status: 'human_named', humanName: 'Repeated stale path', promotedCategory: 'tool_recovery' })
    expect(recordHumanClusterPromotion({
      promotionId: 'promotion-one', sourceJobId: 'cluster-job', runId: 'run', cluster: clusters[0]!,
      humanName: 'Repeated stale path', promotedCategory: 'tool_recovery', promotedBy: { actorId: 'reviewer-one', authority: 'reviewer' }, promotedAt: AT,
    })).toMatchObject({ sourceJobId: 'cluster-job', promotedBy: { actorId: 'reviewer-one' }, cluster: { status: 'human_named', promotedCategory: 'tool_recovery' } })
  })

  it('continues all five interventions from one hash-bound checkpoint', async () => {
    const source = AnalyzerInputSchema.parse({ ...baseInput('counterfactual'), events: [
      event(0, 'status', { state: 'start' }), event(1, 'tool_call', { tool: 'read' }), event(2, 'error', { code: 'ENOENT' }),
    ], verifierIntegrity: { ...baseInput('counterfactual').verifierIntegrity, passed: false } })
    const sourceFailureFingerprint = await counterfactualFailureFingerprint(source.events, 1)
    const request = {
      schemaVersion: 1 as const, requestId: 'cf', sourceTrialId: source.trialId, checkpointSequence: 1, sourceFailureFingerprint,
      interventions: [
        { kind: 'corrected_action' as const, actionKind: 'tool_call' as const, replacement: { tool: 'search' } },
        { kind: 'different_backend' as const, backendId: 'codex', agentVersion: '1' },
        { kind: 'different_model' as const, modelId: 'model-b', configHash: 'c'.repeat(64) },
        { kind: 'corrected_tool_result' as const, toolCallSequence: 1, resultArtifactRef: 'fixtures/read.json', resultSha256: 'd'.repeat(64) },
        { kind: 'fault_removed' as const, faultScenarioId: 'missing-file' },
      ],
    }
    const checkpoints: string[] = []
    const results = await continueCounterfactual(request, source, { continue: async ({ checkpointHash, intervention }) => {
      checkpoints.push(checkpointHash)
      const failed = intervention.kind === 'different_model'
      return {
        outcome: failed ? 'same_failure' : 'resolved',
        ...(failed ? { observedFailureFingerprint: request.sourceFailureFingerprint } : {}),
        evidenceRefs: ['untrusted:' + intervention.kind], continuationEvents: [failed ? event(2, 'error', { code: 'ENOENT' }) : event(2, 'status', { state: 'done' })],
      }
    } }, { verify: async ({ continuationEvents }) => ({ passed: continuationEvents[0]?.kind !== 'error', evidenceRefs: ['verifier:evidence'] }) })
    expect(results.map((result) => result.intervention)).toEqual(['corrected_action', 'different_backend', 'different_model', 'corrected_tool_result', 'fault_removed'])
    expect(new Set(checkpoints).size).toBe(1)
    expect(new Set(results.map((result) => result.checkpointHash))).toEqual(new Set(checkpoints))
    expect(results.find((result) => result.intervention === 'different_model')).toMatchObject({ outcome: 'same_failure', observedFailureFingerprint: request.sourceFailureFingerprint })
    expect(new Set(results.map((result) => result.continuationHash)).size).toBe(5)
  })

  it('runs a configurable continuation command through a bounded JSON contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'counterfactual-harness-'))
    const harnessPath = join(directory, 'harness.mjs')
    await writeFile(harnessPath, "let input = ''; for await (const chunk of process.stdin) input += chunk; const request = JSON.parse(input); process.stdout.write(JSON.stringify({ outcome: 'resolved', evidenceRefs: ['command:' + request.intervention.kind], continuationEvents: [{ schemaVersion: 1, sequence: request.checkpoint.at(-1).sequence + 1, at: '2026-08-03T00:00:01.000Z', kind: 'status', data: { state: 'done' } }] }))\n")
    const source = AnalyzerInputSchema.parse({ ...baseInput('command-counterfactual'), events: [event(0, 'status', { state: 'start' }), event(1, 'error', { code: 'fixture' })], verifierIntegrity: { ...baseInput('command-counterfactual').verifierIntegrity, passed: false } })
    const results = await continueCounterfactual({
      schemaVersion: 1, requestId: 'command-cf', sourceTrialId: source.trialId, checkpointSequence: 0, sourceFailureFingerprint: await counterfactualFailureFingerprint(source.events, 0),
      interventions: [{ kind: 'fault_removed', faultScenarioId: 'fault' }],
    }, source, new CommandCounterfactualContinuationHarness([process.execPath, harnessPath], 5_000), passingCounterfactualVerifier)
    expect(results).toMatchObject([{ intervention: 'fault_removed', outcome: 'resolved', evidenceRefs: ['verifier:evidence'] }])
  })

  it('isolates the continuation environment and bounds untrusted output without leaking stderr', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'counterfactual-harness-'))
    const harnessPath = join(directory, 'harness.mjs')
    const seededSecret = 'seeded-counterfactual-secret'
    process.env.COUNTERFACTUAL_SEEDED_SECRET = seededSecret
    const source = AnalyzerInputSchema.parse({ ...baseInput('secure-command-counterfactual'), events: [event(0, 'status', { state: 'start' }), event(1, 'error', { code: 'fixture' })], verifierIntegrity: { ...baseInput('secure-command-counterfactual').verifierIntegrity, passed: false } })
    const request = { schemaVersion: 1 as const, requestId: 'secure-command-cf', sourceTrialId: source.trialId, checkpointSequence: 0, sourceFailureFingerprint: await counterfactualFailureFingerprint(source.events, 0), interventions: [{ kind: 'fault_removed' as const, faultScenarioId: 'fault' }] }
    try {
      await writeFile(harnessPath, "process.stdout.write(JSON.stringify({ outcome: 'resolved', evidenceRefs: [String(process.env.COUNTERFACTUAL_SEEDED_SECRET)], continuationEvents: [{ schemaVersion: 1, sequence: 1, at: '2026-08-03T00:00:01.000Z', kind: 'status', data: { state: 'done' } }] }))\n")
      const results = await continueCounterfactual(request, source, new CommandCounterfactualContinuationHarness([process.execPath, harnessPath], 5_000), passingCounterfactualVerifier)
      expect(results[0]?.evidenceRefs).toEqual(['verifier:evidence'])

      await writeFile(harnessPath, `process.stderr.write('${seededSecret}\\n'); process.exit(9)\n`)
      const failure = await continueCounterfactual(request, source, new CommandCounterfactualContinuationHarness([process.execPath, harnessPath], 5_000), passingCounterfactualVerifier).catch((error: unknown) => error as Error)
      expect(failure.message).toContain('code 9')
      expect(failure.message).not.toContain(seededSecret)

      await writeFile(harnessPath, "process.stdout.write('x'.repeat(1024 * 1024 + 1))\n")
      await expect(continueCounterfactual(request, source, new CommandCounterfactualContinuationHarness([process.execPath, harnessPath], 5_000), passingCounterfactualVerifier)).rejects.toThrow('stdout exceeded limit')

      if (process.platform !== 'win32') {
        const pidPath = join(directory, 'descendant.pid')
        await writeFile(harnessPath, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); setInterval(() => {}, 1000)\n`)
        const controller = new AbortController()
        const running = continueCounterfactual(request, source, new CommandCounterfactualContinuationHarness([process.execPath, harnessPath], 5_000), passingCounterfactualVerifier, controller.signal)
        const descendantPid = await vi.waitFor(async () => {
          const pid = Number(await readFile(pidPath, 'utf8'))
          expect(pid).toBeGreaterThan(0)
          return pid
        }, { timeout: 3_000, interval: 10 })
        controller.abort(new Error('fixture cancellation'))
        await expect(running).rejects.toThrow('fixture cancellation')
        await delay(1_100)
        expect(() => process.kill(descendantPid, 0)).toThrow()
      }
    } finally {
      delete process.env.COUNTERFACTUAL_SEEDED_SECRET
    }
  })

  it('delta-minimizes only while the same failure is preserved', async () => {
    const minimized = await minimizeFailure(['noise-a', 'trigger', 'noise-b', 'noise-c'], async (candidate) => candidate.includes('trigger'))
    expect(minimized.minimized).toEqual(['trigger'])
    expect(minimized.attempts).toBeGreaterThan(1)
    await expect(minimizeFailure(['noise'], async () => false)).rejects.toThrow('original reproduction')

    let calls = 0
    const flaky = await minimizeFailure(['noise', 'trigger'], async (candidate) => { calls += 1; return candidate.includes('trigger') && calls % 3 !== 1 }, { repetitions: 3, requiredPreservations: 2 })
    expect(flaky).toMatchObject({ minimized: ['trigger'], repetitions: 3, requiredPreservations: 2, oneMinimalVerified: true })
  })
})

describe('verified reproduction bundles', () => {
  it('minimizes, reruns in distinct fresh environments, checks the control, hashes every file, and signs the manifest', async () => {
    const finding = DefectFindingSchema.parse({ schemaVersion: 1, findingId: 'finding', detectorId: 'tool-recovery', detectorVersion: '1', runId: 'run', trialId: 'trial', category: 'tool_recovery', severity: 'high', confidence: 1, evidenceRefs: ['trace.jsonl'], status: 'human_validated' })
    const environmentLock = { schemaVersion: 1 as const, provider: 'docker' as const, imageDigest: 'sha256:fixture', repositoryRevision: 'revision', dependencyLockHashes: {}, redactedEnvironment: {}, resourcePolicyHash: HASH, networkPolicyHash: HASH, toolchainVersions: {}, fixtureVersions: {}, faultInjectorVersions: {} }
    const failureFingerprint = 'b'.repeat(64)
    const { privateKey } = generateKeyPairSync('ed25519')
    const built = await buildVerifiedReproductionBundle({
      bundleId: 'bundle', finding, failureFingerprint, environmentLock, task: reproductionTask(), agentConfig: { model: 'fixture' }, toolRegistry: { tools: ['read'] },
      traceJsonl: analyzedTraceJsonl(), finalDiff: '', verifierResult: { passed: false }, analysis: { category: 'tool_recovery' },
      units: [{ id: 'noise', path: 'noise.txt', content: 'noise' }, { id: 'trigger', path: 'trigger.txt', content: 'trigger' }], attempts: 3,
      harness: {
        preservesFailure: async (units) => units.some((unit) => unit.id === 'trigger'),
        reproduce: async (_units, index) => ({ ...freshEvidence('fresh-' + String(index), 'nonce-' + String(index)), environmentLock, failureFingerprint, evidenceRefs: ['attempt-' + String(index)] }),
        expectedSuccessControl: async () => ({ ...freshEvidence('fresh-control', 'nonce-control'), environmentLock, passed: true, evidenceRefs: ['control'] }),
      },
      signingKey: { keyReference: 'fixture-signing-key', privateKey },
    })
    expect(built.bundle.reproduction).toMatchObject({ reproduced: 3, minimization: { originalUnits: 2, minimizedUnits: 1 }, expectedSuccessControl: { passed: true } })
    expect(new Set(built.bundle.reproduction.attempts.map((attempt) => attempt.freshEnvironmentId)).size).toBe(3)
    const registry = new StaticSigningKeyRegistry({ schemaVersion: 1, keys: [{ keyReference: 'fixture-signing-key', algorithm: 'ed25519', publicKeySpkiBase64: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'), scopes: ['reproduction_bundle'], status: 'active', validFrom: '2026-01-01T00:00:00.000Z' }] })
    await expect(verifyReproductionBundleSignature(built.bundle, registry, AT)).resolves.toBe(true)
    await expect(verifyReproductionBundleSignature(built.bundle, new StaticSigningKeyRegistry({ schemaVersion: 1, keys: [] }), AT)).resolves.toBe(false)
    const trace = parseTrialTraceJsonl(new TextDecoder().decode(built.files.get('bundles/bundle/trace.jsonl')!))
    expect(trace.spans.map((span) => span.name)).toEqual(expect.arrayContaining(['analyzer.detect', 'reproduction.verify']))
    expect(trace.spans.filter((span) => span.name === 'reproduction.verify')).toHaveLength(4)
    expect([...built.files.keys()].map((path) => path.split('/').at(-1))).toEqual(expect.arrayContaining(['minimal-workspace.tar.zst', 'reproduce.sh', 'SHA256SUMS']))
    const archive = built.files.get('bundles/bundle/minimal-workspace.tar.zst')!
    const tar = zstdDecompressSync(archive)
    expect(execFileSync('tar', ['-tf', '-'], { input: tar, encoding: 'utf8' }).trim().split('\n')).toEqual(['trigger.txt'])
    expect(execFileSync('tar', ['-xOf', '-', 'trigger.txt'], { input: tar, encoding: 'utf8' })).toBe('trigger')
    const tampered = structuredClone(built.bundle); tampered.failureFingerprint = 'c'.repeat(64)
    await expect(verifyReproductionBundleSignature(tampered, registry, AT)).resolves.toBe(false)
  })

  it('rejects leaked paths and a failed success control', async () => {
    const finding = DefectFindingSchema.parse({ schemaVersion: 1, findingId: 'finding', detectorId: 'tool-recovery', detectorVersion: '1', runId: 'run', trialId: 'trial', category: 'tool_recovery', severity: 'high', confidence: 1, evidenceRefs: ['trace.jsonl'], status: 'human_validated' })
    const environmentLock = { schemaVersion: 1 as const, provider: 'docker' as const, imageDigest: 'sha256:fixture', repositoryRevision: 'revision', dependencyLockHashes: {}, redactedEnvironment: {}, resourcePolicyHash: HASH, networkPolicyHash: HASH, toolchainVersions: {}, fixtureVersions: {}, faultInjectorVersions: {} }
    const { privateKey } = generateKeyPairSync('ed25519')
    const base = { bundleId: 'bundle', finding, failureFingerprint: 'b'.repeat(64), environmentLock, task: reproductionTask('/home/example/work'), agentConfig: {}, toolRegistry: {}, traceJsonl: analyzedTraceJsonl(), finalDiff: '', verifierResult: {}, analysis: {}, units: [{ id: 'trigger', path: 'trigger', content: 'trigger' }], attempts: 2, harness: { preservesFailure: async () => true, reproduce: async (_units: readonly unknown[], index: number) => ({ freshEnvironmentId: 'fresh-' + index, environmentLock, failureFingerprint: 'b'.repeat(64), evidenceRefs: ['attempt'] }), expectedSuccessControl: async () => ({ freshEnvironmentId: 'control', environmentLock, passed: true, evidenceRefs: ['control'] }) }, signingKey: { keyReference: 'key', privateKey } }
    await expect(buildVerifiedReproductionBundle(base)).rejects.toThrow('private absolute path')
    await expect(buildVerifiedReproductionBundle({ ...base, task: reproductionTask(), harness: { ...base.harness, expectedSuccessControl: async () => ({ freshEnvironmentId: 'control', environmentLock, passed: false, evidenceRefs: ['control'] }) } })).rejects.toThrow('control did not pass')
  })
})

function freshEvidence(freshEnvironmentId: string, nonce: string) { return { freshEnvironmentId, providerAttestation: 'provider-signed:' + nonce, imageDigest: 'sha256:fixture', nonce, initialStateHash: HASH, networkPolicyHash: HASH, cleanupReceipt: 'destroyed:' + freshEnvironmentId } }

function reproductionTask(stderrIncludes = 'fixture failure') {
  return { schemaVersion: 1 as const, taskId: 'task', reproduction: { argv: ['sh', '-ceu', 'echo fixture failure >&2; exit 23'], expectedExitCode: 23, stderrIncludes, failureFingerprintSource: 'fixture failure' } }
}

function analyzedTraceJsonl(): string {
  const refs = { runId: 'run', trialId: 'trial', backendId: 'custom-command', taskId: 'task' }
  const span = (spanId: string, parentSpanId: string | undefined, name: 'evaluation.run' | 'evaluation.trial' | 'environment.prepare' | 'agent.execute' | 'workspace.snapshot' | 'verifier.execute' | 'analyzer.detect') => ({ schemaVersion: 1 as const, traceId: 'trace-run-trial', spanId, ...(parentSpanId ? { parentSpanId } : {}), name, startedAt: AT, completedAt: AT, status: 'ok' as const, refs, artifactRefs: [] })
  return serializeTrialTraceJsonl({ schemaVersion: 1, traceId: 'trace-run-trial', runId: 'run', trialId: 'trial', spans: [
    span('run', undefined, 'evaluation.run'), span('trial', 'run', 'evaluation.trial'), span('environment', 'trial', 'environment.prepare'),
    span('agent', 'trial', 'agent.execute'), span('workspace', 'trial', 'workspace.snapshot'), span('verifier', 'trial', 'verifier.execute'),
    { ...span('analyzer', 'trial', 'analyzer.detect'), outcomeCategory: 'finding_detected' },
  ] })
}

function validationCases(): DetectorValidationCase[] {
  return requiredDetectorIds().flatMap((detectorId) => [
    { caseId: detectorId + '-positive', detectorId, expectedFinding: true, input: seeded(detectorId, true) },
    { caseId: detectorId + '-negative', detectorId, expectedFinding: false, input: seeded(detectorId, false) },
  ])
}

function seeded(detectorId: RequiredDetectorId, positive: boolean): AnalyzerInput {
  const base = baseInput(detectorId + '-' + (positive ? 'positive' : 'negative'))
  switch (detectorId) {
    case 'instruction-drift': return AnalyzerInputSchema.parse({ ...base, constraints: [{ id: 'must-test', kind: 'must', sourceRef: 'task#must-test', verifierId: 'constraint', verifierVersion: '1' }], constraintLifecycle: [{ constraintId: 'must-test', state: positive ? 'violated' : 'satisfied', eventSequence: 1, evidenceRefs: ['trace#1'] }] })
    case 'context-forgetting': return AnalyzerInputSchema.parse({ ...base, memoryProbes: [{ probeId: 'probe', introducedSequence: 0, observedSequence: 1, kind: 'compaction', outcome: positive ? 'post_compaction_violation' : 'retained', evidenceRefs: ['trace#1'] }] })
    case 'test-gaming': return AnalyzerInputSchema.parse({ ...base, workspaceIntegrity: { ...base.workspaceIntegrity, changedPaths: positive ? ['tests/hidden.py'] : ['src/fix.py'], hiddenVerifierPaths: ['tests/hidden.py'] } })
    case 'tool-recovery': return AnalyzerInputSchema.parse({ ...base, toolAttempts: positive ? [
      { sequence: 0, tool: 'deploy', schemaValid: true, executable: true, outcome: 'indeterminate', observedStateSufficientForRecovery: true, evidenceRefs: ['trace#0'] },
      { sequence: 1, tool: 'deploy', schemaValid: true, executable: true, outcome: 'success', observedStateSufficientForRecovery: true, replayOfSequence: 0, evidenceRefs: ['trace#1'] },
    ] : [{ sequence: 0, tool: 'deploy', schemaValid: true, executable: true, outcome: 'success', observedStateSufficientForRecovery: true, evidenceRefs: ['trace#0'] }] })
    case 'planning-execution': return AnalyzerInputSchema.parse({ ...base, planSteps: [{ stepId: 'implement', prerequisiteStepIds: [], critical: true, startedSequence: 0, completedSequence: 1, ...(positive ? {} : { verifiedSequence: 2 }), abandoned: false, evidenceRefs: ['plan#implement'] }] })
  }
}

const passingCounterfactualVerifier = { verify: async () => ({ passed: true, evidenceRefs: ['verifier:evidence'] }) }

function baseInput(id: string): AnalyzerInput {
  return AnalyzerInputSchema.parse({
    schemaVersion: 1, runId: 'validation-run', trialId: 'trial-' + id, taskId: 'task', traceHash: HASH, projectionHash: HASH, normalizationVersion: 'fixture-v1', events: [event(0, 'status', { state: 'start' }), event(1, 'status', { state: 'done' })],
    constraints: [], constraintLifecycle: [], memoryProbes: [], toolAttempts: [], planSteps: [],
    workspaceIntegrity: { changedPaths: [], deletedPaths: [], protectedPaths: [], hiddenVerifierPaths: [], verifierLeakagePaths: [], suspiciousLiteralEvidenceRefs: [] },
    verifierIntegrity: { passed: true, protectedIntegrityPassed: true, hiddenVerifierPassed: true, selectedTestFraction: 1, evidenceRefs: ['verifier-result.json'] }, inputManifestHash: HASH,
  })
}

function event(sequence: number, kind: NormalizedAgentEvent['kind'], data: Record<string, unknown>): NormalizedAgentEvent { return { schemaVersion: 1, sequence, at: AT, kind, nativeEventRef: 'native-events.jsonl#' + String(sequence), data } }
function requiredDetectorIds(): RequiredDetectorId[] { return ['instruction-drift', 'context-forgetting', 'test-gaming', 'tool-recovery', 'planning-execution'] }
