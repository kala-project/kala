import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { maybeOverflow, overflowMarker, sliceHeadTailUtf8 } from './overflow.js'

describe('tool output overflow', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-overflow-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves small outputs inline', async () => {
    const res = await maybeOverflow('small output', {
      sessionId: 'sess-1',
      callId: 'call-1',
      config: { inlineBytes: 1024, previewLines: 4, overflowDir: dir },
    })

    expect(res).toMatchObject({ content: 'small output', overflowed: false })
    expect(res.filePath).toBeUndefined()
  })

  it('spills large outputs and keeps head plus tail in the inline preview with actionable read_file offset', async () => {
    const full = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join('\n')

    const res = await maybeOverflow(full, {
      sessionId: 'sess-1',
      callId: 'call-1',
      config: { inlineBytes: 82, previewLines: 6, overflowDir: dir },
    })

    expect(res.overflowed).toBe(true)
    expect(res.filePath).toBe(join(dir, 'sess-1', 'call-1.txt'))
    expect(readFileSync(res.filePath!, 'utf8')).toBe(full)
    expect(res.content).toContain('line-1')
    expect(res.content).toContain('line-12')
    expect(res.content).toContain('[... 6 lines omitted (lines 4-9) ...]')
    expect(res.content).toContain('overflow://call-1')
    expect(res.content).toContain(`read_file { path: '${res.filePath!}', offset: 3, limit: 6 }`)
    expect(res.content).toContain('multi_grep')
    expect(res.content).toContain(`multi_grep { searches: [{ pattern: '<pattern>', path: '${res.filePath!}' }] }`)
    // Dashboard sentinel must remain in the final 512 chars
    expect(res.content.slice(-512)).toContain('--- output truncated:')
  })

  it('preserves both head and tail for single-line / long-line blobs exceeding inlineBytes', async () => {
    const middle = 'x'.repeat(2000)
    const full = `HEAD_MARKER_START:${middle}:TAIL_MARKER_END`

    const res = await maybeOverflow(full, {
      sessionId: 'sess-1',
      callId: 'call-single-line',
      config: { inlineBytes: 300, previewLines: 400, overflowDir: dir },
    })

    expect(res.overflowed).toBe(true)
    expect(readFileSync(res.filePath!, 'utf8')).toBe(full)
    expect(res.content).toContain('HEAD_MARKER_START:')
    expect(res.content).toContain(':TAIL_MARKER_END')
    expect(res.content).toContain('bytes omitted')
    expect(res.content.slice(-512)).toContain('--- output truncated:')
  })

  it('slices multibyte UTF-8 strings (CJK and emoji) without producing U+FFFD replacement characters', () => {
    const full = '开头标记🚀🎉' + '中文字节测试🔥'.repeat(200) + '结尾标记✅🏁'
    for (const budget of [64, 95, 96, 97, 128, 255, 256, 257]) {
      const sliced = sliceHeadTailUtf8(full, budget)
      expect(sliced).not.toContain('\uFFFD')
      expect(Buffer.byteLength(sliced, 'utf8')).toBeLessThanOrEqual(budget)
      expect(sliced).toContain('开头')
      expect(sliced).toContain('🏁')
    }
  })

  it('keeps the dashboard sentinel in the final 512 characters with long spill paths', () => {
    const marker = overflowMarker(`/workspace/${'nested/'.repeat(60)}output.txt`, 'call-long', 4, 100, 100, 1000, 2, 96)
    expect(marker.slice(-512)).toContain('--- output truncated:')
    expect(marker).toContain("multi_grep { searches: [{ pattern: '<pattern>', path:")
  })

  it('starts line pagination at zero when byte clipping removes whole preview lines', async () => {
    const full = [`HEAD:${'A'.repeat(500)}`, ...Array.from({ length: 10 }, (_, i) => `middle-${i}`), `TAIL:${'Z'.repeat(500)}`].join('\n')
    const res = await maybeOverflow(full, {
      sessionId: 'sess-1',
      callId: 'call-long-lines',
      config: { inlineBytes: 100, previewLines: 6, overflowDir: dir },
    })
    expect(res.content).not.toContain('lines 4-9')
    expect(res.content).toContain("offset: 0, limit: 12")
    expect(res.content).toContain('HEAD:')
    expect(res.content).toContain('ZZZZ')
  })
})
