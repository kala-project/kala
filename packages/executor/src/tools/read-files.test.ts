import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeCtx } from './_test-helpers.js'
import { readFilesTool } from './read-files.js'

describe('read_files', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-read-files-'))
    writeFileSync(join(root, 'a.txt'), 'alpha\nbeta')
    writeFileSync(join(root, 'b.txt'), 'one\ntwo\nthree')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns batcat-style sections', async () => {
    const out = await readFilesTool.run({ files: [
      { path: join(root, 'a.txt') },
      { path: join(root, 'b.txt'), offset: 1, limit: 1 },
    ] }, makeCtx(root))
    expect(out).toContain(`===== ${join(root, 'a.txt')} =====`)
    expect(out).toContain('1\talpha')
    expect(out).toContain(`===== ${join(root, 'b.txt')} =====`)
    expect(out).toContain('2\ttwo')
  })

  it('preserves earlier and later successes around a failed file', async () => {
    const error = await readFilesTool.run({ files: [
      { path: join(root, 'a.txt') },
      { path: join(root, 'missing.txt') },
      { path: join(root, 'b.txt') },
    ] }, makeCtx(root)).catch((error: Error) => error)
    expect(error).toMatchObject({ code: 'EPARTIAL' })
    expect(String(error)).toContain('1\talpha')
    expect(String(error)).toContain('ENOENT')
    expect(String(error)).toContain('3\tthree')
    expect(String(error)).toContain('1/3 attempted files failed')
  })

  it('validates the whole batch and honors cancellation rather than reporting partial success', async () => {
    await expect(readFilesTool.run({ files: [{ path: join(root, 'missing.txt') }, { path: join(root, 'a.txt'), limit: 0 }] }, makeCtx(root))).rejects.toThrow(/EINVAL/)
    const controller = new AbortController(); controller.abort()
    await expect(readFilesTool.run({ files: [{ path: join(root, 'a.txt') }] }, makeCtx(root, controller.signal))).rejects.toThrow(/ECANCELED/)
  })

  it('keeps even tiny UTF-8 output budgets and identifies unattempted files', async () => {
    for (const max_bytes of [1, 16, 180]) {
      const out = await readFilesTool.run({ files: [{ path: join(root, 'a.txt') }, { path: join(root, 'b.txt') }], max_bytes }, makeCtx(root))
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(max_bytes)
      expect(out).not.toContain('�')
    }
    writeFileSync(join(root, 'large.txt'), '界'.repeat(500))
    const out = await readFilesTool.run({ files: [{ path: join(root, 'large.txt') }, { path: join(root, 'b.txt') }], max_bytes: 230 }, makeCtx(root))
    expect(out).toContain('1 not attempted')
    expect(out).not.toContain('3\tthree')
  })

  it('keeps truncated multi-file output within the byte budget', async () => {
    writeFileSync(join(root, 'large.txt'), '界'.repeat(500))
    const maxBytes = 180
    const out = await readFilesTool.run({
      files: [
        { path: join(root, 'a.txt') },
        { path: join(root, 'large.txt') },
      ],
      max_bytes: maxBytes,
    }, makeCtx(root))

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect(out).toContain(`... read_files output truncated at ${maxBytes} bytes ...`)
    expect(out).not.toContain('�')
  })
})
