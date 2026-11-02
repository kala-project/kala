import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSandbox } from '../sandbox.js'
import { multiGrepTool } from './multi-grep.js'
import { grepTool } from './grep.js'
import { allTools } from './index.js'

let root: string
let ctx: Parameters<typeof multiGrepTool.run>[1]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'multi-grep-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.ts'), 'alpha\nbeta\n你好 alpha\n')
  writeFileSync(join(root, 'src/b.ts'), 'beta\ngamma\n')
  ctx = { sessionId: 's', callId: 'c', sandbox: createSandbox({ roots: [root] }), signal: new AbortController().signal, cwd: root }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('multi_grep', () => {
  it('runs ordered searches with mixed output modes', async () => {
    const out = await multiGrepTool.run({ searches: [
      { pattern: 'alpha', path: 'src', output_mode: 'content' },
      { pattern: 'beta', path: 'src', output_mode: 'count' },
    ] }, ctx)
    expect(out.indexOf('search[0]')).toBeLessThan(out.indexOf('search[1]'))
    expect(out).toContain(':1:alpha')
    expect(out).toMatch(/a\.ts:1/)
  })

  it('keeps an empty section for no matches', async () => {
    const out = await multiGrepTool.run({ searches: [{ pattern: 'missing', path: 'src' }] }, ctx)
    expect(out).toBe('===== search[0] =====\n')
  })

  it.each([
    [{}, /searches/],
    [{ searches: [] }, /must not be empty/],
    [{ searches: Array.from({ length: 21 }, () => ({ pattern: 'x' })) }, /at most 20/],
    [{ searches: [{ pattern: '[' }] }, /invalid regex/],
  ])('rejects invalid input %#', async (input, message) => {
    await expect(multiGrepTool.run(input as never, ctx)).rejects.toThrow(message)
  })

  it('preserves every child result exactly even when an earlier search is large', async () => {
    writeFileSync(join(root, 'src/large.ts'), Array.from({ length: 900 }, (_, index) => `common-${index}`).join('\n'))
    const searches = [
      { pattern: 'common', path: 'src', output_mode: 'content' },
      { pattern: 'gamma', path: 'src/b.ts', output_mode: 'content' },
    ] as const
    const expected = await Promise.all(searches.map((search) => grepTool.run(search, ctx)))
    const out = await multiGrepTool.run({ searches }, ctx)
    expect(out).toBe(expected.map((result, index) => `===== search[${index}] =====\n${result}`).join('\n\n'))
    expect(out).toContain(':2:gamma')
    expect(out).not.toContain('multi_grep output truncated')
  })

  it('is the only publicly registered regex search tool', () => {
    expect(allTools.some((tool) => tool.name === 'grep')).toBe(false)
    expect(allTools.some((tool) => tool.name === 'multi_grep')).toBe(true)
    expect(allTools.some((tool) => tool.name === 'todowrite')).toBe(false)
  })

  it('honors cancellation before execution', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(multiGrepTool.run({ searches: [{ pattern: 'alpha' }] }, { ...ctx, signal: controller.signal })).rejects.toThrow(/ECANCELED/)
  })

  it('passes independent page bounds through each batch search', async () => {
    const out = await multiGrepTool.run({ searches: [
      { pattern: 'alpha', path: 'src/a.ts', output_mode: 'content', limit: 1, offset: 1 },
      { pattern: 'beta', path: 'src', output_mode: 'count', limit: 1 },
    ] }, ctx)
    expect(out).toContain(':3:你好 alpha')
    expect(out).not.toContain(':1:alpha')
    expect(out).toContain('next_offset=1')
  })

  it('preserves earlier and later successful searches when an independent path fails', async () => {
    try {
      await multiGrepTool.run({ searches: [
        { pattern: 'alpha', path: 'src/a.ts', output_mode: 'content' },
        { pattern: 'beta', path: 'src/missing.ts' },
        { pattern: 'gamma', path: 'src/b.ts', output_mode: 'content' },
      ] }, ctx)
      expect.fail('partial failure must not be reported as success')
    } catch (error) {
      expect(String(error)).toContain('EPARTIAL')
      expect(String(error)).toContain('search[1] (failed)')
      expect(String(error)).toContain(':1:alpha')
      expect(String(error)).toContain(':2:gamma')
    }
  })

})
