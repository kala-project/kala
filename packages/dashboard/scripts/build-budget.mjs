import { basename } from 'node:path'

/**
 * Vite bundles ?worker imports inside its own Node process. Do not retain five
 * Monaco worker graphs concurrently with the main application graph.
 * Nested workers bypass the sibling gate: their parent is waiting for them.
 */
export function serialWorkerPlugins({ report = false } = {}) {
  let tail = Promise.resolve()
  return () => {
    let nested = false
    let entry = 'worker'
    let release
    let finished = false
    let admitted = false
    const finish = () => {
      finished = true
      if (release && admitted) {
        const unlock = release
        release = undefined
        // Let bundle.close() drop its graph before admitting the next sibling.
        setImmediate(unlock)
      }
    }
    return [{
      name: 'kala-worker-build-budget',
      configResolved(config) {
        const chain = config.bundleChain ?? []
        nested = chain.length > 1
        entry = basename(chain.at(-1) ?? 'worker')
      },
      async buildStart() {
        if (nested) return
        const previous = tail
        tail = new Promise((resolve) => { release = resolve })
        await previous
        admitted = true
        if (finished) { finish(); throw new Error('Worker build cancelled before admission') }
        if (report) {
          const { heapUsed, rss } = process.memoryUsage()
          console.info(`[build-budget] ${entry}: heap=${Math.ceil(heapUsed / 1048576)} MiB rss=${Math.ceil(rss / 1048576)} MiB`)
        }
      },
      buildEnd(error) { if (error) finish() },
      closeBundle: finish,
    }]
  }
}
