import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadRuntimeHooks } from './runtime-hooks.js'

describe('Runtime Unit hooks', () => {
  const roots: string[] = []
  const root = () => { const path = mkdtempSync(join(tmpdir(), 'kala-runtime-hooks-')); roots.push(path); return path }
  afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

  it('loads Unit-scoped enforcement without sharing it with another organization', async () => {
    const directory = root()
    const first = join(directory, 'first'), second = join(directory, 'second')
    mkdirSync(first); mkdirSync(second)
    writeFileSync(join(first, 'config.toml'), '[[hooks]]\nevent = "pre_tool_use"\ncommand = "exit 7"\nmatch = "bash"\n')
    const configured = loadRuntimeHooks({ unitRoot: first, product: 'private-cloud' })
    expect(configured.hooks).toHaveLength(1)
    const result = await configured.hookRunner!.run(configured.hooks[0]!, { event: 'pre_tool_use', sessionId: 'session', toolName: 'bash' })
    expect(result).toMatchObject({ ok: false, exitCode: 7 })
    expect(loadRuntimeHooks({ unitRoot: second, product: 'private-cloud' }).hooks).toEqual([])
  })

  it('supports an explicit Dedicated operator configuration and fails if it disappears', () => {
    const directory = root()
    const path = join(directory, 'operator.toml')
    writeFileSync(path, '[[hooks]]\nevent = "session_start"\ncommand = "true"\n')
    expect(loadRuntimeHooks({ unitRoot: directory, product: 'dedicated', configPath: path }).hooks).toHaveLength(1)
    rmSync(path)
    expect(() => loadRuntimeHooks({ unitRoot: directory, product: 'dedicated', configPath: path })).toThrow()
    expect(() => loadRuntimeHooks({ unitRoot: directory, product: 'private-cloud', configPath: path })).toThrow(/Dedicated/)
  })

  it('does not silently drop malformed enforcement', () => {
    const directory = root()
    writeFileSync(join(directory, 'config.toml'), '[[hooks]]\nevent = "pre_tool_us"\ncommand = "exit 7"\n')
    expect(() => loadRuntimeHooks({ unitRoot: directory, product: 'dedicated' })).toThrow(/Invalid Runtime hook/)
  })
})
