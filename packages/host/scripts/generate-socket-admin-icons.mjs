import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(new URL('../package.json', import.meta.url))
const ui = join(dirname(require.resolve('@socket.io/admin-ui/package.json')), 'ui/dist/js')
const font = dirname(require.resolve('@mdi/font/package.json'))
const fontVersion = require('@mdi/font/package.json').version
const upstreamCss = readFileSync(join(font, 'css/materialdesignicons.min.css'), 'utf8')
const icons = new Set()
for (const name of readdirSync(ui).filter(name => name.endsWith('.js'))) {
  for (const [icon] of readFileSync(join(ui, name), 'utf8').matchAll(/mdi-[\w-]+/g)) icons.add(icon)
}

const rules = []
const codepoints = []
for (const icon of [...icons].sort()) {
  const rule = upstreamCss.match(new RegExp(`\\.${icon}::before\\{content:"\\\\([A-F0-9]+)"\\}`))
  if (!rule) throw new Error(`Missing official @mdi/font glyph for ${icon}`)
  codepoints.push(rule[1])
  rules.push(`.${icon}::before{content:"\\${rule[1]}"}`)
}

const subset = resolve('packages/host/.socket-admin-icons-subset.woff2')
try {
  const result = spawnSync('python3', [
    '-m', 'fontTools.subset', join(font, 'fonts/materialdesignicons-webfont.woff2'),
    `--unicodes=${codepoints.map(codepoint => `U+${codepoint}`).join(',')}`,
    '--flavor=woff2', `--output-file=${subset}`,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`fontTools subset failed: ${result.stderr}`)
  const license = readFileSync(join(font, 'LICENSE'), 'utf8').replace(/\r/g, '')
  const css = `/* @mdi/font ${fontVersion}; ${license.replace(/\*\//g, '* /')} */\n`
    + '@font-face{font-family:"Material Design Icons";src:url("../fonts/materialdesignicons-webfont.woff2") format("woff2");font-weight:normal;font-style:normal}'
    + '.mdi::before,.mdi-set{display:inline-block;font:normal normal normal 24px/1 "Material Design Icons";font-size:inherit;text-rendering:auto;line-height:inherit;-webkit-font-smoothing:antialiased}'
    + rules.join('')
  const source = `// Generated from pinned @socket.io/admin-ui and @mdi/font ${fontVersion} by scripts/generate-socket-admin-icons.mjs.\n`
    + `export const SOCKET_ADMIN_ICON_CSS = ${JSON.stringify(css)}\n`
    + `export const SOCKET_ADMIN_ICON_WOFF2 = '${readFileSync(subset).toString('base64')}'\n`
  writeFileSync(new URL('../src/socket-admin-icons.ts', import.meta.url), source)
  console.log(`Generated ${icons.size} icons and ${readFileSync(subset).byteLength} font bytes`)
} finally {
  rmSync(subset, { force: true })
}
