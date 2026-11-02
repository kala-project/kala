import type { CSSProperties } from 'react'
import { CHAT_FONT_SIZE_PX, readableFontSize } from '../../lib/display-sizes.js'
export { CHAT_FONT_SIZE_PX } from '../../lib/display-sizes.js'

export type ChatDisplayPrefs = {
  fontSize: number
  codeBlockFontSize?: number
  contentWidth: number
  sideSpace: number
  lineHeight: number
  mathScale?: number
}

export const CHAT_LINE_HEIGHT = [1.45, 1.7, 1.95] as const
export const CHAT_CONTENT_WIDTH_REM = [64, 84, 104] as const
export const CHAT_MATH_SCALE_EM = [1.25, 1.5, 2, 2.5, 3] as const
export const CHAT_SIDE_SPACE = [
  { base: '0.75rem', sm: '1.5rem', lg: '2rem' },
  { base: '1rem', sm: '2rem', lg: '3rem' },
  { base: '1.25rem', sm: '3rem', lg: '5rem' },
] as const

export function chatDisplayStyle(displayPrefs: ChatDisplayPrefs | undefined): CSSProperties {
  const fontSize = clampIndex(displayPrefs?.fontSize, CHAT_FONT_SIZE_PX, 3)
  const lineHeight = clampIndex(displayPrefs?.lineHeight, CHAT_LINE_HEIGHT, 1)
  const contentWidth = clampIndex(displayPrefs?.contentWidth, CHAT_CONTENT_WIDTH_REM, 1)
  const mathScale = clampIndex(displayPrefs?.mathScale, CHAT_MATH_SCALE_EM, 2)
  const sideSpace = CHAT_SIDE_SPACE[clampIndex(displayPrefs?.sideSpace, CHAT_SIDE_SPACE, 1)] ?? CHAT_SIDE_SPACE[1]
  return {
    '--ak-chat-font-size': `${readableFontSize(CHAT_FONT_SIZE_PX[fontSize] ?? 15) / 16}rem`,
    '--ak-code-font-size': `${readableFontSize(displayPrefs?.codeBlockFontSize ?? 15) / 16}rem`,
    '--ak-chat-line-height': String(CHAT_LINE_HEIGHT[lineHeight]),
    '--ak-chat-content-width': `${CHAT_CONTENT_WIDTH_REM[contentWidth]}rem`,
    '--ak-chat-math-scale': `${CHAT_MATH_SCALE_EM[mathScale]}em`,
    '--ak-chat-side-space': sideSpace.base,
    '--ak-chat-side-space-sm': sideSpace.sm,
    '--ak-chat-side-space-lg': sideSpace.lg,
  } as CSSProperties
}

function clampIndex<T extends readonly unknown[]>(value: number | undefined, values: T, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(values.length - 1, Math.max(0, Math.round(value ?? fallback)))
}
