import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { WINDOWS_TERMINAL_NODE, WINDOWS_TERMINAL_WORKER, windowsTerminalFixtures } from './terminal-product-fixtures.mjs'

test('Windows fixtures use the pinned Node runtime and PowerShell 5.1-compatible invocations', () => {
  const fixture = windowsTerminalFixtures({ artifact: 'terminal-acceptance-test' })
  assert.equal(fixture.prepareArgv[0], WINDOWS_TERMINAL_NODE)
  assert.match(fixture.tty, /\$PSVersionTable\.PSVersion\.ToString\(\)/u)
  assert.match(fixture.tty, /& 'C:\\KalaTest\\node\\node-v22\.22\.1-win-x64\\node\.exe'/u)
  assert.match(fixture.multilineFirst, /@\('line-one',$/u)
  assert.equal(fixture.multilineLast, "'line-two')")
  assert.match(fixture.raw, /probe\.cjs' raw$/u)
  assert.doesNotThrow(() => new Script(WINDOWS_TERMINAL_WORKER))
  assert.doesNotThrow(() => new Script(fixture.prepareArgv[2]))
})

test('fixture paths are constrained and PowerShell literal quoting is preserved', () => {
  assert.throws(() => windowsTerminalFixtures({ artifact: '../elsewhere' }))
  assert.throws(() => windowsTerminalFixtures({ artifact: 'terminal-acceptance-test', nodeExecutable: 'node.exe' }))
  const fixture = windowsTerminalFixtures({ artifact: 'terminal-acceptance-test', nodeExecutable: "C:\\Trusted O'Brien\\node.exe" })
  assert.match(fixture.raw, /Trusted O''Brien/u)
})

test('the actual proof worker writes exact multiline and composed UTF-8 bytes without extra dependencies', () => {
  const root = resolve(`.artifacts/windows-terminal-fixtures-${process.pid}`)
  mkdirSync(root, { recursive: true })
  const script = resolve(root, 'probe.cjs')
  writeFileSync(script, WINDOWS_TERMINAL_WORKER)
  try {
    assert.equal(execFileSync(process.execPath, [script, 'text', 'multiline.txt', 'MULTI', 'line-one', 'line-two'], { encoding: 'utf8' }), 'MULTI_DONE\n')
    assert.equal(readFileSync(resolve(root, 'multiline.txt'), 'utf8'), 'line-one\nline-two\n')
    assert.equal(execFileSync(process.execPath, [script, 'text', 'ime.txt', 'IME', '终端✓'], { encoding: 'utf8' }), 'IME_DONE\n')
    assert.equal(readFileSync(resolve(root, 'ime.txt'), 'utf8'), '终端✓\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
