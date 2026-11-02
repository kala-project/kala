import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { lazyFeatureBuild } from './lazy-feature-build.mjs'
import { buildSteps, inheritedEnvironment, normalizePublishedPermissions, systemdBudget } from './build.mjs'

const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { parseAst } = viteRequire('rollup/parseAst')

test('build entry keeps sequential bounded steps and an invocation-only hard budget', () => {
  const steps = buildSteps(['--mode', 'production'])
  assert.equal(steps.length, 2)
  assert.ok(steps[0].includes('--noEmit'))
  assert.equal(steps[0][0], '--max-old-space-size=768')
  assert.equal(steps[1][0], '--max-old-space-size=1536')
  assert.deepEqual(steps[1].slice(-2), ['--mode', 'production'])
  assert.ok(buildSteps(['--prototype'])[0].includes('tsconfig.prototype.json'))
  assert.ok(buildSteps(['--prototype'])[1].includes('vite.prototype.config.ts'))
  assert.ok(systemdBudget.includes('MemoryMax=2304M'))
  assert.ok(systemdBudget.includes('MemorySwapMax=0'))
  assert.ok(systemdBudget.includes('KillMode=control-group'))
  assert.ok(systemdBudget.includes('LimitCORE=0'))
  assert.deepEqual(inheritedEnvironment({ PRIVATE_TOKEN: 'never-on-command-line', 'invalid-name': 'ignored' }), ['--setenv=PRIVATE_TOKEN'])
})

test('published assets remain readable by a non-owner runtime after a private build umask', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kala-static-permissions-'))
  try {
    const icons = join(root, 'icons')
    const logo = join(icons, 'octopus-web.svg')
    await mkdir(icons, { mode: 0o700 })
    await writeFile(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>', { mode: 0o600 })
    normalizePublishedPermissions(root)
    assert.ok((await stat(root)).mode & 0o001)
    assert.ok((await stat(icons)).mode & 0o001)
    assert.ok((await stat(logo)).mode & 0o004)
    assert.equal((await stat(logo)).mode & 0o022, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('published permissions reject symlinks instead of changing files outside the output', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kala-static-symlink-'))
  try {
    const output = join(root, 'dist')
    const privateFile = join(root, 'private')
    await mkdir(output)
    await writeFile(privateFile, 'private', { mode: 0o600 })
    await symlink(privateFile, join(output, 'asset'))
    assert.throws(() => normalizePublishedPermissions(output), /Unsupported published asset/u)
    assert.equal((await stat(privateFile)).mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('real lazy ESM assets preserve Shiki languages/themes and Mermaid diagram imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kala-lazy-feature-test-'))
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousParser = globalThis.DOMParser
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.DOMParser = dom.window.DOMParser
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    const plugin = lazyFeatureBuild()
    plugin.configResolved({ root, build: { assetsDir: 'assets', target: 'es2020', minify: true, sourcemap: false } })
    const assets = []
    await plugin.buildStart.call({ emitFile(asset) { assets.push(asset); return `artifact${assets.length}` } })
    for (const asset of assets) {
      const path = join(root, asset.fileName)
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, asset.source)
    }
    const entry = (feature) => assets.find((asset) => asset.fileName.startsWith(`assets/lazy-${feature}/entry-`))
    const shiki = await import(pathToFileURL(join(root, entry('shiki').fileName)).href)
    assert.ok(Object.keys(shiki.bundledLanguages).length > 100)
    assert.ok(Object.keys(shiki.bundledThemes).length > 20)
    const highlighter = await shiki.createHighlighter({ themes: ['github-light', 'github-dark'], langs: [] })
    try {
      for (const lang of ['typescript', 'python', 'rust', 'sql', 'bash', 'yaml', 'json']) {
        await highlighter.loadLanguage(lang)
        const html = highlighter.codeToHtml('const example = 42', { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
        assert.match(html, /--shiki-dark/u)
      }
    } finally { highlighter.dispose() }
    const { default: mermaid } = await import(pathToFileURL(join(root, entry('mermaid').fileName)).href)
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    assert.match((await mermaid.parse('graph TD; A-->B')).diagramType, /flowchart/u)
    assert.equal((await mermaid.parse('sequenceDiagram\nAlice->>Bob: Hello')).diagramType, 'sequence')
    const input = `// import('shiki') stays a comment\nconst text = "import('mermaid')"; const a = import('shiki'); const b = import('mermaid');`
    const transformed = plugin.transform.call({ parse: parseAst }, input, 'fixture.js')
    assert.match(transformed.code, /const a = import\(\/\* @vite-ignore \*\/ import\.meta\.ROLLUP_FILE_URL_/u)
    assert.ok(transformed.code.includes('// import(\'shiki\') stays a comment'))
    assert.ok(transformed.code.includes('"import(\'mermaid\')"'))
    assert.ok(transformed.map.mappings.length)
  } finally {
    globalThis.window = previousWindow; globalThis.document = previousDocument; globalThis.DOMParser = previousParser
    dom.window.close()
    await rm(root, { recursive: true, force: true })
  }
})
