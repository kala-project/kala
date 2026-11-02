import { describe, expect, it } from 'vitest'
import { decodePostgresJson, stringifyPostgresJson } from './postgres-json.js'

describe('lossless PostgreSQL JSON text', () => {
  it('preserves binary tool text and lone UTF-16 code units without changing ordinary Unicode or literal escapes', () => {
    const original = { state: { messages: [{ content: 'a\0b\ud800c\udfff' }, { content: '🙂中文\\u0000' }] },
      nested: { nested: { values: ['\0', '\ud800', '\udc00'] } } }
    const encoded = JSON.parse(stringifyPostgresJson(original)!)
    expect(encoded.state.messages[0].content).not.toContain('\0')
    expect(decodePostgresJson(encoded)).toEqual(original)
    expect(encoded.state.messages[0].content).not.toBe(original.state.messages[0].content)
    expect(decodePostgresJson({ valid: '🙂中文' })).toEqual({ valid: '🙂中文' })
    expect(stringifyPostgresJson({ valid: '🙂中文' })).toBe(JSON.stringify({ valid: '🙂中文' }))
  })

  it('rejects malformed or conflicting metadata instead of silently corrupting text', () => {
    expect(() => stringifyPostgresJson({ __kalaPostgresUtf16PathsV1: [] })).toThrow('Reserved')
    expect(() => decodePostgresJson({ __kalaPostgresUtf16PathsV1: [['missing']] })).toThrow('UTF-16')
    expect(() => decodePostgresJson({ text: 'AA==', __kalaPostgresUtf16PathsV1: [['text']] })).toThrow('byte length')
  })
})
