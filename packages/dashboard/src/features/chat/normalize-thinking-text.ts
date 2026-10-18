// Reasoning from upstream runtimes can contain a separated typographic
// apostrophe in English contractions (e.g. "I’ m"). Fix only this malformed
// display text: never rewrite the stored Session event or ordinary punctuation.
export function normalizeThinkingDisplayText(text: string): string {
  return text.replace(/\b([a-z]+)[\u2018\u2019\uff07][ \t\u00a0\u2000-\u200a\u202f\u3000]+(m|re|ve|ll|d|s|t)\b/giu, "$1'$2")
}
