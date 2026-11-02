#!/usr/bin/env node
// Ratchet-based STYLE.md audit. Rules and rationale live in
// packages/dashboard/STYLE.md §11. Explicit soft/semantic rims are allowed;
// remaining content overflow uses the global skin. Counts may only decrease.
//
// Update baseline: `node scripts/lint-style.mjs --write`

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULES, auditSource } from './style-rules.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const baselinePath = join(here, 'lint-style.baseline.json')

function auditTree(directory) {
  const results = Object.fromEntries(RULES.map(({ id }) => [id, { count: 0, sample: [] }]))
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      if (!/\.(?:tsx?|jsx?|css)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) continue
      const source = readFileSync(path, 'utf8')
      const lines = source.split('\n')
      for (const [id, hits] of Object.entries(auditSource(source, path))) {
        results[id].count += hits.length
        results[id].sample.push(...hits.map((line) => `${path}:${line}:${lines[line - 1]}`))
      }
    }
  }
  visit(directory)
  return results
}

const write = process.argv.includes('--write')

const results = auditTree(join(root, 'src'))

if (write) {
  const snap = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.count]))
  const previous = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (Object.entries(snap).some(([id, count]) => count > (previous[id] ?? 0))) {
    console.error('Refusing to increase a STYLE.md baseline. Fix the regressions first.')
    process.exit(1)
  }
  writeFileSync(baselinePath, `${JSON.stringify(snap, null, 2)}\n`)
  console.log(`Wrote baseline to ${baselinePath}:`)
  for (const [id, count] of Object.entries(snap)) console.log(`  ${id}: ${count}`)
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
} catch {
  console.error(`Baseline missing at ${baselinePath}. Run with --write to create.`)
  process.exit(2)
}

let regressed = false
for (const rule of RULES) {
  const current = results[rule.id].count
  const allowed = baseline[rule.id] ?? 0
  const marker = current > allowed ? 'FAIL' : current < allowed ? 'IMPROVED' : 'ok'
  console.log(`[${marker}] ${rule.id}: ${current} (baseline ${allowed})`)
  if (current > allowed) {
    regressed = true
    console.log(`  hint: ${rule.hint}`)
    for (const line of results[rule.id].sample.slice(0, 5)) console.log(`    ${line}`)
  }
}

if (regressed) {
  console.error('\nSTYLE.md regressions detected. Fix the UI; baselines may only decrease.')
  process.exit(1)
}

const improved = RULES.filter((r) => results[r.id].count < (baseline[r.id] ?? 0))
if (improved.length > 0) {
  console.log('\nCounts improved; ratchet the baseline DOWN with `pnpm --filter @agent-kernel/dashboard lint:style -- --write`.')
}
