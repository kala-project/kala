import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { grepTool } from './grep.js'
import { makeCtx, makeTempWorkspace } from './_test-helpers.js'

describe('grep', () => {
  let root: string
  beforeEach(() => {
    root = makeTempWorkspace('ak-grep-')
    writeFileSync(join(root, 'a.ts'), 'hello world\nsecond hello')
    writeFileSync(join(root, 'b.ts'), 'nothing here')
    writeFileSync(join(root, 'c.js'), 'hello js')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('default output_mode is files_with_matches', async () => {
    const out = await grepTool.run(
      { pattern: 'hello' },
      makeCtx(root),
    )
    const paths = out.split('\n').sort()
    expect(paths).toEqual([join(root, 'a.ts'), join(root, 'c.js')].sort())
  })

  it('count mode reports per-file counts', async () => {
    const out = await grepTool.run(
      { pattern: 'hello', output_mode: 'count' },
      makeCtx(root),
    )
    const lines = out.split('\n').sort()
    expect(lines).toContain(`${join(root, 'a.ts')}:2`)
    expect(lines).toContain(`${join(root, 'c.js')}:1`)
  })

  it('content mode returns path:line:text', async () => {
    const out = await grepTool.run(
      { pattern: 'hello', output_mode: 'content', glob: '*.ts' },
      makeCtx(root),
    )
    expect(out).toContain(`${join(root, 'a.ts')}:1:hello world`)
    expect(out).toContain(`${join(root, 'a.ts')}:2:second hello`)
    expect(out).not.toContain('c.js')
  })

  it('throws EINVAL on bad regex', async () => {
    await expect(
      grepTool.run({ pattern: '(' }, makeCtx(root)),
    ).rejects.toThrow(/EINVAL/)
  })

  it('continues past the old 1000-row ceiling without skipping the boundary match', async () => {
    const file = join(root, 'many.txt')
    writeFileSync(file, Array.from({ length: 1002 }, (_, i) => `match-${i}`).join('\n'))
    const first = await grepTool.run({ pattern: 'match-', path: file, output_mode: 'content' }, makeCtx(root))
    const next = await grepTool.run({ pattern: 'match-', path: file, output_mode: 'content', offset: 1000, limit: 1000 }, makeCtx(root))
    expect(first).toContain('next_offset=1000')
    expect(first).toContain(':1000:match-999')
    expect(first).not.toContain(':1001:match-1000')
    expect(next).toContain(':1001:match-1000')
    expect(next).toContain(':1002:match-1001')
    expect(next).toContain('returned=2; next_offset=none observed')
  })

  it('pages file/count modes in deterministic order and rejects invalid bounds', async () => {
    for (const mode of ['files_with_matches', 'count']) {
      const out = await grepTool.run({ pattern: 'hello', output_mode: mode, limit: 1, offset: 1 }, makeCtx(root))
      expect(out).toContain(join(root, 'c.js'))
      expect(out).not.toContain(join(root, 'a.ts'))
      expect(out).toContain('returned=1; next_offset=none observed')
    }
    for (const bounds of [{ limit: 0 }, { limit: 1001 }, { limit: null }, { offset: -1 }, { offset: 0.5 }]) {
      await expect(grepTool.run({ pattern: 'hello', ...bounds }, makeCtx(root))).rejects.toThrow(/EINVAL/)
    }
  })

})
