import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyFilePatchTool } from './apply-file-patch.js'
import { makeCtx } from './_test-helpers.js'

describe('apply_file_patch', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ak-patch-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('adds and updates files from patch format', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'one\ntwo\nthree\n')
    const out = await applyFilePatchTool.run({ patch: `*** Begin Patch
*** Add File: ${join(root, 'b.txt')}
+hello
*** Update File: ${p}
@@
 one
-two
+TWO
 three

*** End Patch` }, makeCtx(root))
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(p, 'utf8')).toBe('one\nTWO\nthree\n')
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: [{ operation: 'created' }, { operation: 'modified' }] })
  })

  it('applies separate hunks in a file and rejects a later invalid hunk without writing', async () => {
    const p = join(root, 'hunks.txt')
    const before = 'one\ntwo\nkeep\nthree\nfour\n'
    writeFileSync(p, before)
    const patch = `*** Begin Patch
*** Update File: ${p}
@@
 one
-two
+TWO
@@
 three
-four
+FOUR
*** End Patch`
    await expect(applyFilePatchTool.run({ patch: patch.replace('-four', '-missing') }, makeCtx(root))).rejects.toThrow(/ENOTFOUND/)
    expect(readFileSync(p, 'utf8')).toBe(before)
    await applyFilePatchTool.run({ patch }, makeCtx(root))
    expect(readFileSync(p, 'utf8')).toBe('one\nTWO\nkeep\nthree\nFOUR\n')
  })

  it.each(['missing', 'filesystem'])('reports already-applied files when a later operation fails: %s', async (failure) => {
    const p = join(root, 'created.txt')
    const failingOperation = failure === 'missing'
      ? `*** Delete File: ${join(root, 'missing.txt')}`
      : `*** Add File: ${join(p, 'child.txt')}\n+invalid parent`
    const error = await applyFilePatchTool.run({ patch: `*** Begin Patch
*** Add File: ${p}
+retained
${failingOperation}
*** End Patch` }, makeCtx(root)).catch((error: Error) => error)
    expect(readFileSync(p, 'utf8')).toBe('retained\n')
    expect(error).toMatchObject({ code: 'EPARTIAL' })
    expect(String(error)).toContain('1/2 file operations applied')
    expect(String(error)).toContain(p)
    if (failure === 'missing') expect(String(error)).toContain('ENOENT')
  })

  it('deletes files', async () => {
    const p = join(root, 'gone.txt')
    writeFileSync(p, 'bye')
    await applyFilePatchTool.run({ patch: `*** Begin Patch
*** Delete File: ${p}
*** End Patch` }, makeCtx(root))
    expect(existsSync(p)).toBe(false)
  })
})
