import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditSource, minimumTextViolations } from './style-rules.mjs'

const audit = (classes) => auditSource(`<div className="${classes}" />`, 'fixture.tsx')

test('soft card rims, semantic alerts and focus-within are documented exceptions', () => {
  for (const classes of [
    'border border-border/50', 'border border-border/60',
    'border-t border-border/50', 'border-l border-l-transparent',
    'border border-amber-500 dark:border-amber-900/60',
    'border border-border/50 focus-within:border-border',
    'md:border-r border-border/50',
    'border-l border-x-border/50',
    'border border-sidebar-border/50',
  ]) {
    const hits = audit(classes)
    assert.deepEqual(hits['bare-border'], [], classes)
    assert.deepEqual(hits['directional-bare-border'], [], classes)
    assert.deepEqual(hits['border-border-full-opacity'], [], classes)
  }
})

test('uncolored borders and unfocused full-opacity outlines still fail', () => {
  assert.deepEqual(audit('border bg-card')['bare-border'], [1])
  assert.deepEqual(audit('border-t bg-background')['directional-bare-border'], [1])
  assert.deepEqual(audit('border border-border')['border-border-full-opacity'], [1])
  assert.deepEqual(audit('border border-border/50 hover:border-border')['border-border-full-opacity'], [1])
  assert.deepEqual(audit('border-t border-l-transparent')['directional-bare-border'], [1])
  assert.deepEqual(audit('border hover:border-border/50')['bare-border'], [1])
  assert.deepEqual(audit('border border-l-transparent')['bare-border'], [1])
  assert.deepEqual(audit('border border-[1px]')['bare-border'], [1])
})

test('comments are not UI, but variants and prototype classes are audited', () => {
  const source = '// overflow-auto border border-border\n<div className="sm:overflow-auto border" />'
  const hits = auditSource(source, 'src/prototype/preview.tsx')
  assert.deepEqual(hits['naked-overflow-scroll'], [2])
  assert.deepEqual(hits['bare-border'], [2])
})

test('minimum typography includes CSS, arbitrary lengths, and inline numeric sizes', () => {
  const source = 'text-[11.5px] text-[0.7rem] text-[length:9px] font-size: 0.6875rem; fontSize: 10; text-[0.9em] font-size: 0.85em'
  assert.equal(minimumTextViolations(source).length, 7)
  assert.deepEqual(minimumTextViolations('text-caption text-[12px] font-size: 0.75rem; fontSize: 12'), [])
})
