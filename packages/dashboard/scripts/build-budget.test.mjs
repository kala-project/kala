import assert from 'node:assert/strict'
import test from 'node:test'
import { serialWorkerPlugins } from './build-budget.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const plugin = (factory, chain = ['worker.js']) => {
  const [worker] = factory()
  worker.configResolved({ bundleChain: chain })
  return worker
}

test('sibling worker graphs are admitted serially through generation/close', async () => {
  const factory = serialWorkerPlugins()
  const first = plugin(factory); const second = plugin(factory)
  await first.buildStart()
  let admitted = false
  const pending = second.buildStart().then(() => { admitted = true })
  await tick(); assert.equal(admitted, false)
  first.buildEnd() // Successful transform is not full bundle generation.
  await tick(); assert.equal(admitted, false)
  first.closeBundle(); await pending; assert.equal(admitted, true)
  second.closeBundle()
})

test('nested workers bypass a parent that is waiting for their result', async () => {
  const factory = serialWorkerPlugins()
  const parent = plugin(factory); const child = plugin(factory, ['worker.js', 'nested.js'])
  await parent.buildStart(); await child.buildStart()
  child.closeBundle(); parent.closeBundle()
})

test('error and queued cancellation release once without overtaking the owner', async () => {
  const factory = serialWorkerPlugins()
  const owner = plugin(factory); const cancelled = plugin(factory); const next = plugin(factory)
  await owner.buildStart()
  const rejected = assert.rejects(cancelled.buildStart(), /cancelled before admission/u)
  cancelled.buildEnd(new Error('cancelled'))
  let admitted = false
  const pending = next.buildStart().then(() => { admitted = true })
  await tick(); assert.equal(admitted, false)
  owner.buildEnd(new Error('failed')); owner.closeBundle()
  await rejected; await pending; assert.equal(admitted, true)
  next.closeBundle()
})
