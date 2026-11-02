import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { monacoWorkerBuild } from './monaco-worker-build.mjs'

const require = createRequire(import.meta.url)
const config = { build: { assetsDir: 'assets', target: 'es2020', minify: true, sourcemap: false } }
const source = {
  editor: 'monaco-editor/esm/vs/editor/editor.worker',
  css: 'monaco-editor/esm/vs/language/css/css.worker',
  html: 'monaco-editor/esm/vs/language/html/html.worker',
  json: 'monaco-editor/esm/vs/language/json/json.worker',
  ts: 'monaco-editor/esm/vs/language/typescript/ts.worker',
}

test('all five real Monaco workers remain self-hosted and boot; duplicate imports share one artifact', async () => {
  const plugin = monacoWorkerBuild()
  plugin.configResolved(config); plugin.buildStart()
  const assets = []
  const context = { emitFile(asset) { assets.push(asset); return `worker${assets.length}` } }
  for (const [kind, entry] of Object.entries(source)) {
    const id = plugin.resolveId(`${entry}?worker`)
    assert.ok(id)
    const [first, repeated] = await Promise.all([plugin.load.call(context, id), plugin.load.call(context, id)])
    assert.equal(first, repeated)
    assert.match(first, /import\.meta\.ROLLUP_FILE_URL_/u)
    const asset = assets.at(-1)
    assert.match(asset.fileName, new RegExp(`^assets/monaco-${kind}\\.worker-[a-f0-9]{12}\\.js$`, 'u'))
    const scope = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      performance, TextEncoder, TextDecoder, URL,
      navigator: { userAgent: 'Linux fixture', language: 'en-US' },
      origin: 'http://localhost:3000',
      importScripts() { throw new Error('Unexpected external worker import') },
      postMessage() {}, addEventListener() {},
    }
    scope.self = scope
    vm.runInNewContext(asset.source, scope, { timeout: 5000 })
    assert.equal(typeof scope.onmessage, 'function', `${kind} worker did not boot its message handler`)
  }
  assert.equal(assets.length, 5)
})

test('the installed language fallback factories resolve to the same worker artifacts', async () => {
  const plugin = monacoWorkerBuild()
  for (const [kind, language] of [['css', 'css'], ['html', 'html'], ['json', 'json'], ['ts', 'typescript']]) {
    const id = require.resolve(`monaco-editor/esm/vs/language/${language}/workerManager.js`)
    const code = await readFile(id, 'utf8')
    const result = plugin.transform(code, id)
    assert.ok(result, `${language} fallback was not recognized; review the new Monaco version before building`)
    assert.match(result.code, new RegExp(`kala:monaco-worker/${kind}`, 'u'))
    assert.doesNotMatch(result.code, /new Worker\(new URL/u)
  }
  assert.equal(plugin.resolveId('unrelated.worker?worker'), undefined)
  assert.equal(plugin.resolveId('kala:monaco-worker/unknown'), undefined)
})

test('profiling keeps worker maps hidden and paired to the hashed script', async () => {
  const plugin = monacoWorkerBuild()
  plugin.configResolved({ build: { ...config.build, sourcemap: 'hidden' } }); plugin.buildStart()
  const assets = []
  const id = plugin.resolveId(`${source.editor}?worker`)
  await plugin.load.call({ emitFile(asset) { assets.push(asset); return 'editor' } }, id)
  const script = assets.find((asset) => asset.fileName.endsWith('.js'))
  const map = assets.find((asset) => asset.fileName.endsWith('.js.map'))
  assert.equal(map.fileName, `${script.fileName}.map`)
  assert.doesNotMatch(script.source, /sourceMappingURL/u)
  assert.equal(JSON.parse(map.source).file, script.fileName.split('/').at(-1))
})
