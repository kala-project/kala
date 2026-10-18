import { describe, expect, it } from 'vitest'

import { normalizeThinkingDisplayText } from './normalize-thinking-text.js'

describe('normalizeThinkingDisplayText', () => {
  it('repairs only separated typographic apostrophes in English contractions', () => {
    expect(normalizeThinkingDisplayText('I’ m checking; we’ re looking; they＇ ve started.')).toBe("I'm checking; we're looking; they've started.")
    expect(normalizeThinkingDisplayText('I’\u00a0m working.')).toBe("I'm working.")
  })

  it('preserves ordinary punctuation, already correct contractions, and line breaks', () => {
    const text = 'John’s report says “ready”. I’m here.\nI’\nm is split across lines.'
    expect(normalizeThinkingDisplayText(text)).toBe(text)
  })
})
