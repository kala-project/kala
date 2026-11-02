export const INTERFACE_SCALE_MIN = 75
export const INTERFACE_SCALE_MAX = 200
export const DEFAULT_INTERFACE_SCALE = 100
export const INTERFACE_DENSITY_OPTIONS = [
  { value: 90, density: 'compact', scale: 0.9 },
  { value: 100, density: 'default', scale: 1 },
  { value: 112, density: 'comfortable', scale: 1.125 },
] as const
export type InterfaceDensity = typeof INTERFACE_DENSITY_OPTIONS[number]['density']
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 48

export function readableFontSize(pixels: number, scale = 1): number {
  const size = Number.isFinite(pixels) ? pixels : 15
  const density = Number.isFinite(scale) && scale > 0 ? scale : 1
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size)) * density)
}

export function interfaceDensityForPercent(percent: number): InterfaceDensity {
  if (percent <= 95) return 'compact'
  if (percent <= 106) return 'default'
  return 'comfortable'
}

export function interfaceScaleForPercent(percent: number): number {
  const density = interfaceDensityForPercent(percent)
  return INTERFACE_DENSITY_OPTIONS.find((option) => option.density === density)?.scale ?? 1
}

export function interfacePreferenceForPercent(percent: number): number {
  const density = interfaceDensityForPercent(percent)
  return INTERFACE_DENSITY_OPTIONS.find((option) => option.density === density)?.value ?? DEFAULT_INTERFACE_SCALE
}

// Keep existing persisted indices stable; new controls display/edit pixels.
function extendFontSizes(previous: readonly number[]): readonly number[] {
  return [
    ...previous,
    ...Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => i + FONT_SIZE_MIN)
      .filter((size) => !previous.includes(size)),
  ]
}

export const CHAT_FONT_SIZE_PX = extendFontSizes([12, 13, 14, 15, 16, 18, 20])
export const SESSION_EXPLORER_FONT_SIZE_PX = extendFontSizes([11, 12, 13, 14, 15])
export const FILE_EXPLORER_FONT_SIZE_PX = extendFontSizes([10, 11, 12, 13, 14])
export const FILE_VIEW_FONT_SIZE_PX = extendFontSizes([10, 12, 14, 16, 18])
