import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const children: ChildProcess[] = []
const tsxLoader = createRequire(import.meta.url).resolve('tsx')

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('planned restart process handoff', () => {
  it('replaces a restarting marker in another process and never repeats completed continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restart-process-handoff-')); roots.push(root)
    const statePath = join(root, 'restart.json')
    const marker = {
      attemptId: 'process-handoff-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: process.pid,
      sessions: [],
      deployment: { deploymentId: 'deployment-process-0001', targetReleaseDigest: 'a'.repeat(64), expectedRouteGeneration: 7, fencingToken: 'fencing-token-process-0001' },
    }
    await writeFile(statePath, JSON.stringify(marker))
    const runner = join(root, 'runner.mts')
    await writeFile(runner, `
      import { RestartCoordinator } from ${JSON.stringify(new URL('../restart-coordinator.ts', import.meta.url).href)}
      void (async () => {
        const expected = ${JSON.stringify(marker.deployment)}
        const coordinator = new RestartCoordinator({
          statePath: process.argv[2], expectedDeployment: expected,
          store: { recordsSnapshot: () => [], get: () => undefined },
          loop: { resumeSession: async () => true }, emit() {}, closeServer: async () => {}, exitProcess() {},
        } as never)
        await coordinator.resumeMarkedSessions()
        process.stdout.write(JSON.stringify(coordinator.status()))
      })()
    `)
    const first = await runTsx(runner, statePath)
    expect(JSON.parse(first)).toMatchObject({ last: { attemptId: marker.attemptId, phase: 'completed' } })
    const firstState = JSON.parse(await readFile(statePath, 'utf8'))
    expect(firstState).toMatchObject({ phase: 'completed', deployment: marker.deployment })
    const second = await runTsx(runner, statePath)
    expect(JSON.parse(second)).toMatchObject({ last: { phase: 'completed', newPid: firstState.newPid } })
  })
})

async function runTsx(script: string, statePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, script, statePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = ''; let stderr = ''
    child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${String(code)}`)))
  })
}
