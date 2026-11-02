import { createRequire } from 'node:module'
import { basename, relative } from 'node:path'

const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { build } = viteRequire('esbuild')
const MagicString = viteRequire('magic-string')
const features = ['shiki', 'mermaid']
const lazyImport = /\bimport\(\s*(['"])(shiki|mermaid)\1\s*\)/gu

/** Keep large, independently lazy ESM graphs out of the main Rollup heap. */
export function lazyFeatureBuild({ report = false } = {}) {
  let config
  const references = new Map()
  return {
    name: 'kala-memory-bounded-lazy-features',
    apply: 'build',
    // Run after TS stripping so typeof import('...') is never rewritten.
    enforce: 'post',
    configResolved(resolved) { config = resolved },
    async buildStart() {
      references.clear()
      for (const feature of features) {
        const outdir = `${config.root}/.kala-native-${feature}`
        const result = await build({
          entryPoints: [require.resolve(feature)], bundle: true, splitting: true,
          format: 'esm', platform: 'browser', write: false, metafile: true, outdir,
          entryNames: 'entry-[hash]', chunkNames: 'chunk-[name]-[hash]',
          target: config.build.target || 'esnext', minify: config.build.minify !== false,
          sourcemap: config.build.sourcemap ? (config.build.sourcemap === 'hidden' ? 'external' : 'linked') : false,
          legalComments: 'inline', logLevel: 'silent',
        })
        if (result.warnings.length) throw new Error(`${feature} lazy build produced warnings: ${result.warnings.map((warning) => warning.text).join('; ')}`)
        const entry = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint === require.resolve(feature))
          ?? Object.entries(result.metafile.outputs).find(([file]) => /\/entry-[A-Z0-9]+\.js$/u.test(file.replaceAll('\\', '/')))
        if (!entry) throw new Error(`${feature} lazy build produced no entry script`)
        for (const file of result.outputFiles) {
          const name = relative(outdir, file.path).replaceAll('\\', '/')
          if (name.startsWith('../') || !/\.js(?:\.map)?$/u.test(name)) throw new Error(`Unsupported ${feature} lazy artifact: ${name}; preserve its runtime loading before enabling this build path`)
          const fileName = `${config.build.assetsDir}/lazy-${feature}/${name}`
          let source = file.text
          if (name.endsWith('.map')) {
            const map = JSON.parse(source); map.file = basename(name.slice(0, -4)); source = JSON.stringify(map)
          }
          const reference = this.emitFile({ type: 'asset', fileName, source })
          if (name === basename(entry[0])) references.set(feature, reference)
        }
        if (!references.has(feature)) throw new Error(`${feature} entry artifact was not emitted`)
        if (report) console.info(`[build-budget] ${feature} lazy graph packaged natively: ${result.outputFiles.length} artifacts; heap=${Math.ceil(process.memoryUsage().heapUsed / 1048576)} MiB`)
      }
    },
    transform(code, id) {
      if (!code.includes('import(')) return
      let rewritten
      lazyImport.lastIndex = 0
      if (!lazyImport.test(code)) return
      const visit = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.type === 'ImportExpression' && features.includes(node.source?.value)) {
          const feature = node.source.value
          const reference = references.get(feature)
          if (!reference) throw new Error(`Missing ${feature} lazy build artifact`)
          rewritten ??= new MagicString(code)
          rewritten.overwrite(node.start, node.end, `import(/* @vite-ignore */ import.meta.ROLLUP_FILE_URL_${reference})`)
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(visit)
          else if (value && typeof value === 'object') visit(value)
        }
      }
      visit(this.parse(code))
      if (rewritten) return { code: rewritten.toString(), map: rewritten.generateMap({ hires: true, source: id, includeContent: true }) }
    },
  }
}
