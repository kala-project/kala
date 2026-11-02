import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
// Reuse Vite's locked compiler, not a second undeclared/global esbuild version.
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { build } = viteRequire('esbuild')
const monacoRoot = dirname(require.resolve('monaco-editor/package.json'))
const entries = {
  editor: 'esm/vs/editor/editor.worker.js',
  css: 'esm/vs/language/css/css.worker.js',
  html: 'esm/vs/language/html/html.worker.js',
  json: 'esm/vs/language/json/json.worker.js',
  ts: 'esm/vs/language/typescript/ts.worker.js',
}
const normalize = (path) => path.replaceAll('\\', '/')
const publicPrefix = 'kala:monaco-worker/'
const privatePrefix = '\0kala-monaco-worker/'
const fallbackWorker = /new Worker\(new URL\((['"])([^'"]+\.worker\.js)\1, import\.meta\.url\), \{ type: ['"]module['"] \}\)/gu

/** Same worker sources/features, bundled once by native esbuild, not large Rollup ASTs. */
export function monacoWorkerBuild({ report = false } = {}) {
  let config
  let tail = Promise.resolve()
  const bundles = new Map()
  const byPath = new Map(Object.entries(entries).map(([kind, file]) => [normalize(join(monacoRoot, file)), kind]))
  const byImport = new Map(Object.entries(entries).flatMap(([kind, file]) => [
    [`monaco-editor/${file}?worker`, kind], [`monaco-editor/${file.slice(0, -3)}?worker`, kind],
  ]))
  return {
    name: 'kala-memory-bounded-monaco-workers',
    enforce: 'pre',
    apply: 'build',
    configResolved(resolved) { config = resolved },
    buildStart() { bundles.clear(); tail = Promise.resolve() },
    resolveId(source) {
      const kind = source.startsWith(publicPrefix) ? source.slice(publicPrefix.length) : byImport.get(source)
      if (kind && Object.hasOwn(entries, kind)) return `${privatePrefix}${kind}`
    },
    // Monaco's fallback factories must share the same artifact as ?worker.
    // Otherwise Vite builds another full language graph even though our runtime
    // MonacoEnvironment.getWorker supplies the explicit constructor.
    transform(code, id) {
      const clean = normalize(id.split('?')[0])
      if (!clean.startsWith(`${normalize(monacoRoot)}/esm/`) || !code.includes('new Worker(new URL(')) return
      const imports = new Set()
      const rewritten = code.replace(fallbackWorker, (match, _quote, relative) => {
        const kind = byPath.get(normalize(resolve(dirname(clean), relative)))
        if (!kind) return match
        imports.add(kind)
        return `new __kala_monaco_${kind}()`
      })
      if (!imports.size) return
      return { code: [...imports].map((kind) => `import __kala_monaco_${kind} from ${JSON.stringify(publicPrefix + kind)};`).join('\n') + '\n' + rewritten, map: null }
    },
    async load(id) {
      if (!id.startsWith(privatePrefix)) return
      const kind = id.slice(privatePrefix.length)
      if (!Object.hasOwn(entries, kind)) throw new Error('Unknown Monaco worker build entry')
      if (!bundles.has(kind)) {
        const context = this
        const pending = tail.then(async () => {
          const result = await build({
            entryPoints: [join(monacoRoot, entries[kind])], bundle: true, write: false,
            outfile: 'worker.js', format: 'iife', platform: 'browser',
            target: config.build.target || 'esnext', minify: config.build.minify !== false,
            sourcemap: config.build.sourcemap ? 'external' : false,
            legalComments: 'inline', logLevel: 'silent',
          })
          if (result.warnings.length) throw new Error(`Monaco ${kind} worker build produced warnings: ${result.warnings.map((warning) => warning.text).join('; ')}`)
          const code = result.outputFiles.find((file) => normalize(file.path).endsWith('/worker.js'))?.text
          const sourceMap = result.outputFiles.find((file) => normalize(file.path).endsWith('/worker.js.map'))?.text
          if (!code) throw new Error(`Monaco ${kind} worker produced no script`)
          const hash = createHash('sha256').update(code).update(sourceMap ?? '').digest('hex').slice(0, 12)
          const fileName = `${config.build.assetsDir}/monaco-${kind}.worker-${hash}.js`
          if (sourceMap) {
            const map = JSON.parse(sourceMap); map.file = basename(fileName)
            context.emitFile({ type: 'asset', fileName: `${fileName}.map`, source: JSON.stringify(map) })
          }
          const source = sourceMap && config.build.sourcemap !== 'hidden' ? `${code}\n//# sourceMappingURL=${basename(fileName)}.map\n` : code
          const reference = context.emitFile({ type: 'asset', fileName, source })
          if (report) console.info(`[build-budget] monaco-${kind} bundled once: heap=${Math.ceil(process.memoryUsage().heapUsed / 1048576)} MiB`)
          return reference
        })
        bundles.set(kind, pending)
        tail = pending.catch(() => {})
      }
      const reference = await bundles.get(kind)
      return `export default function WorkerWrapper(options) { return new Worker(import.meta.ROLLUP_FILE_URL_${reference}, { type: 'classic', name: options?.name }); }`
    },
  }
}
