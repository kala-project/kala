import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { ComputerUseManager } from '../../../../packages/executor/src/computer-use/manager.js'
import { createConfiguredDesktopDriver, serveDesktopCompanion } from '../../../../packages/executor/src/computer-use/companion.js'
import { createDesktopDriver } from '../../../../packages/executor/src/computer-use/desktop-driver.js'
import { type ComputerObservation, type ComputerRequest } from '@agent-kernel/shared'

async function main() {
  const root = resolve(process.argv[2] ?? '')
  if (process.env.KALA_HYBRID_ISOLATED !== '1' || !basename(root).startsWith('kala-clean-hybrid-')) throw new Error('Explicit disposable fixture directory and acknowledgement are required')
  assert.equal((await readFile(join(root, 'ready'), 'utf8')).trim(), 'ready')
  const configPath = join(root, `c${randomUUID().slice(0, 8)}`, 'connection.json')
  const driver = createDesktopDriver()
  const timings: Record<string, number[]> = {}
  const measure = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now()
    const result = await run()
    ;(timings[name] ??= []).push(Math.round(performance.now() - start))
    return result
  }
  const first = await measure('status', () => driver.status())
  assert.equal(first.available, true, first.reason)
  for (let i = 0; i < 3; i++) assert.equal((await measure('status', () => driver.status())).available, true)
  const companion = await serveDesktopCompanion(configPath, { driver })
  const proxy = createConfiguredDesktopDriver({ env: { ...process.env, KALA_COMPUTER_USE_COMPANION_CONFIG: configPath } })
  const manager = new ComputerUseManager(proxy, true)
  const signal = new AbortController().signal
  const request = (operation: Record<string, unknown>) => manager.request({
    requestId: randomUUID(), workspaceId: 'isolated', sessionId: 'isolated', ...operation,
  } as ComputerRequest, 'fixture-controller', signal)
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    await assert.rejects(manager.agent({ operation: 'observe', backend: 'desktop' }, 'isolated', signal), /authorization/i)
    const started = await request({ operation: 'start', consent: true, allowAgent: true })
    assert.ok(started.leaseId, JSON.stringify(started.error))
    const leaseId = started.leaseId
    heartbeat = setInterval(() => { void request({ operation: 'renew', leaseId }) }, 5000)
    const observe = async (): Promise<ComputerObservation> => JSON.parse(await measure('observe', () => manager.agent({ operation: 'observe', backend: 'desktop' }, 'isolated', signal))) as ComputerObservation
    const snapshot = await observe()
    assert.equal(snapshot.title, 'Kala hybrid acceptance')
    const field = snapshot.elements.find((element) => element.name === 'Kala text' && element.actions.includes('setValue'))
    const save = snapshot.elements.find((element) => element.name === 'Save semantic')
    assert.ok(field, JSON.stringify(snapshot))
    assert.ok(save, JSON.stringify(snapshot))
    const text = 'Semantic \u4e2d\u6587 \ud83d\ude00'
    const result = JSON.parse(await measure('act', () => manager.agent({
      operation: 'act', backend: 'desktop', snapshotId: snapshot.snapshotId,
      actions: [{ ref: field.ref, action: 'setValue', value: text }, { ref: save.ref, action: 'invoke' }],
    }, 'isolated', signal))) as ComputerObservation
    const deadline = Date.now() + 5000
    while (true) {
      try { if (await readFile(join(root, 'saved.txt'), 'utf8') === text) break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (Date.now() > deadline) throw new Error('The actual GUI application did not save the exact Unicode text')
      await delay(50)
    }
    assert.notEqual(result.snapshotId, snapshot.snapshotId)
    await assert.rejects(manager.agent({ operation: 'act', backend: 'desktop', snapshotId: snapshot.snapshotId, actions: [{ ref: save.ref, action: 'invoke' }] }, 'isolated', signal), /Stale/i)
    const disabled = result.elements.find((element) => element.name === 'Disabled semantic')
    const latestSave = result.elements.find((element) => element.name === 'Save semantic')!
    assert.ok(disabled)
    await assert.rejects(manager.agent({
      operation: 'act', backend: 'desktop', snapshotId: result.snapshotId,
      actions: [{ ref: disabled.ref, action: 'invoke' }, { ref: latestSave.ref, action: 'invoke' }],
    }, 'isolated', signal), /1 later actions skipped/)
    assert.equal((await readFile(join(root, 'count.txt'), 'utf8')).trim(), '1')
    const image = JSON.parse(await measure('screenshot', () => manager.agent({ operation: 'screenshot' }, 'isolated', signal))) as { screenshot: { base64: string } }
    await writeFile(join(root, 'desktop.png'), Buffer.from(image.screenshot.base64, 'base64'))
    const takeover = await request({ operation: 'input', leaseId, action: { type: 'key', key: 'Escape' } })
    assert.equal(takeover.status?.allowAgent, false, JSON.stringify(takeover.error))
    await assert.rejects(manager.agent({ operation: 'observe', backend: 'desktop' }, 'isolated', signal), /paused/i)
    const stopped = await request({ operation: 'stop', leaseId })
    assert.equal(stopped.status?.active, false, JSON.stringify(stopped.error))
    const report = { ok: true, platform: process.platform, realNativeSemantics: true, realCompanionIPC: true, exactUnicodeFile: true, staleRefsRejected: true, failedBatchSkipped: true, manualTakeoverDeniedAgent: true, stopped: true, timings }
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    await manager.close()
    await companion.close()
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
