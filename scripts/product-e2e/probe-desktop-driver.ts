import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createDesktopDriver, type DesktopInputAction } from '../../packages/executor/src/computer-use/desktop-driver.js'
import { ComputerInputActionSchema } from '../../packages/shared/src/computer-use.js'

async function main(): Promise<void> {
  const output = resolve(process.env.KALA_TEST_EVIDENCE_DIR ?? 'desktop-evidence')
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const actions: DesktopInputAction[] = process.argv[2]
    ? JSON.parse(readFileSync(process.argv[2], 'utf8')).map((action: unknown) => ComputerInputActionSchema.parse(action))
    : []
  const driver = createDesktopDriver()
  const evidence: Record<string, unknown> = { platform: process.platform, node: process.version, startedAt: new Date().toISOString() }
  try {
    const status = await driver.status()
    assert.equal(status.available, true, status.reason)
    evidence.status = status
    for (const phase of ['before', 'after']) {
      if (phase === 'after') {
        const began = performance.now()
        for (const action of actions) await driver.input(action)
        evidence.inputDurationMs = Math.round(performance.now() - began)
        await driver.releaseInputs()
      }
      const began = performance.now()
      const image = await driver.screenshot()
      const bytes = Buffer.from(image.base64, 'base64')
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(bytes.readUInt32BE(16), image.width)
      assert.equal(bytes.readUInt32BE(20), image.height)
      writeFileSync(join(output, `${phase}.png`), bytes, { mode: 0o600 })
      evidence[phase] = { width: image.width, height: image.height, originX: image.originX, originY: image.originY, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), captureDurationMs: Math.round(performance.now() - began) }
    }
    evidence.ok = true
    console.log(JSON.stringify(evidence))
  } finally { await driver.close() }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
