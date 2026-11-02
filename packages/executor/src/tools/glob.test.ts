import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globTool } from './glob.js'
import { makeCtx, makeTempWorkspace } from './_test-helpers.js'

describe('glob', () => {
  let root: string
  beforeEach(() => {
    root = makeTempWorkspace('ak-glob-')
    writeFileSync(join(root, 'a.ts'), '')
    writeFileSync(join(root, 'b.ts'), '')
    writeFileSync(join(root, 'c.js'), '')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'nested.ts'), '')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('matches by extension', async () => {
    const out = await globTool.run(
      { pattern: '**/*.ts', cwd: root },
      makeCtx(root),
    )
    const paths = out.split('\n').sort()
    expect(paths).toEqual([
      join(root, 'a.ts'),
      join(root, 'b.ts'),
      join(root, 'sub', 'nested.ts'),
    ].sort())
  })

  it('returns empty for zero matches', async () => {
    const out = await globTool.run(
      { pattern: '**/*.py', cwd: root },
      makeCtx(root),
    )
    expect(out).toBe('')
  })

  it('defaults cwd to the first workspace root', async () => {
    const out = await globTool.run({ pattern: '*.ts' }, makeCtx(root))
    expect(out.split('\n').sort()).toEqual(
      [join(root, 'a.ts'), join(root, 'b.ts')].sort(),
    )
  })

  it('honors advertised path scope and rejects conflicting legacy cwd', async () => {
    expect(await globTool.run({ pattern: '**/*.ts', path: join(root, 'sub') }, makeCtx(root))).toBe(join(root, 'sub/nested.ts'))
    await expect(globTool.run({ pattern: '**/*', path: join(root, 'sub'), cwd: root }, makeCtx(root))).rejects.toThrow(/disagree/)
  })

  it('paginates tied mtimes by path without duplicates', async () => {
    const paths = ['a.ts', 'b.ts', 'c.js', 'sub/nested.ts'].map((p) => join(root, p))
    for (const path of paths) utimesSync(path, 1, 1)
    const first = await globTool.run({ pattern: '**/*', limit: 2 }, makeCtx(root))
    const next = await globTool.run({ pattern: '**/*', limit: 2, offset: 2 }, makeCtx(root))
    expect(first.split('\n').filter((s) => s.startsWith(root))).toEqual(paths.slice(0, 2))
    expect(next.split('\n').filter((s) => s.startsWith(root))).toEqual(paths.slice(2))
    expect(first).toContain('next_offset=2')
    expect(next).toContain('next_offset=none observed')
  })

})
