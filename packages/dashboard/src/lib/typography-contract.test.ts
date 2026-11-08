import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { minimumTextViolations } from '../../scripts/style-rules.mjs'

const stylesheet = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
const entrypoint = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8')

describe('typography contract', () => {
  it('keeps production, prototypes, stylesheets and inline text at or above the caption floor', () => {
    const root = resolve(process.cwd(), 'src')
    const violations = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:tsx?|css)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name))
      .flatMap((entry) => {
        const path = resolve(entry.parentPath, entry.name)
        return minimumTextViolations(readFileSync(path, 'utf8')).map(({ value }: { value: string }) => `${path}: ${value}`)
      })
    expect(violations).toEqual([])
  })
  it('uses locally bundled variable font families', () => {
    expect(entrypoint).toContain("import '@fontsource-variable/inter/wght.css'")
    expect(entrypoint).toContain("import '@fontsource-variable/noto-sans-sc/wght.css'")
    expect(entrypoint).toContain("import '@fontsource-variable/jetbrains-mono/wght.css'")
    expect(stylesheet).toContain("'Inter Variable'")
    expect(stylesheet).toContain("'Noto Sans SC Variable'")
    expect(stylesheet).toContain("'JetBrains Mono Variable'")
  })

  it('scales the root metric with interface zoom and exposes semantic type roles', () => {
    expect(stylesheet).toMatch(/:root\s*\{[\s\S]*?font-size:\s*calc\(16px \* var\(--ak-interface-scale, 1\)\);/)
    for (const role of ['caption', 'meta', 'ui', 'body', 'title', 'heading', 'code']) {
      expect(stylesheet).toContain(`--ak-type-${role}-size:`)
      expect(stylesheet).toContain(`--ak-type-${role}-leading:`)
    }
  })

  it('scales fixed transcript and status text roles without changing the independent code size', () => {
    const rules: { selector: string; fontSize: string }[] = []
    postcss.parse(stylesheet).walkRules((rule) => {
      rule.walkDecls('font-size', (decl) => rules.push({ selector: rule.selector, fontSize: decl.value }))
    })
    for (const role of ['text-xs', 'text-sm', 'text-meta', 'text-caption', 'text-ui', 'text-base', 'text-2xl']) {
      expect(rules.some(({ selector, fontSize }) => selector.split(',').some((item) => item.trim() === `.ak-chat-display .${role}`) && fontSize.includes('--ak-chat-text-scale'))).toBe(true)
    }
    for (const size of ['0.75rem', '0.9375rem']) {
      expect(stylesheet).toContain(`[class~="text-[${size}]"]`)
    }
    expect(rules.some(({ selector, fontSize }) => selector === '.ak-chat-display .ak-tool-detail-code' && fontSize === 'var(--ak-code-font-size, 0.9375rem)')).toBe(true)
    expect(stylesheet).toMatch(/\.ak-code-lines\s*\{\s*font-size: var\(--ak-code-font-size/)
    expect(stylesheet).toMatch(/\.ak-chat-display :is\(\[role="menu"\], \[role="dialog"\], \[role="tooltip"\]\)\s*\{\s*--ak-chat-text-scale: 1;/)
  })

  it('uses language-aware fallback order without forcing grayscale smoothing', () => {
    expect(stylesheet).toContain(':root:lang(zh)')
    expect(stylesheet).toContain('font-synthesis: none')
    expect(stylesheet).toContain('-webkit-font-smoothing: auto')
    expect(stylesheet).not.toContain('-webkit-font-smoothing: antialiased')
  })
})
