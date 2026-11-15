import { PREF_VSCODE_THEME, writeDashboardPreference } from '../lib/prefs.js'

export type VSCodeThemeKind = 'light' | 'dark' | 'hc' | 'hcLight'

export type VSCodeColorTheme = {
  name?: string
  type?: VSCodeThemeKind | string
  colors?: Record<string, string>
  tokenColors?: unknown
  semanticTokenColors?: unknown
}

export type StoredVSCodeTheme = {
  source: 'builtin' | 'marketplace' | 'custom'
  id: string
  label: string
  theme: VSCodeColorTheme
  extension?: string
}

export const VSCODE_THEME_CHANGE_EVENT = 'ak-vscode-theme-change'
export const VSCODE_THEME_STORAGE_KEY = PREF_VSCODE_THEME

const FALLBACK_DARK = '#111111'
const FALLBACK_LIGHT = '#f8f7f3'

export const BUILTIN_VSCODE_THEMES: readonly StoredVSCodeTheme[] = [
  {
    source: 'builtin',
    id: 'agent-kernel-dark',
    label: 'Default Dark',
    theme: {
      name: 'Default Dark',
      type: 'dark',
      colors: {
        foreground: '#e7e9ee',
        'editor.background': '#111111',
        'editor.foreground': '#e7e9ee',
        'sideBar.background': '#1c1c1c',
        'sideBar.foreground': '#e4e6eb',
        'sideBar.border': '#383838',
        'sideBarTitle.foreground': '#f4f4f5',
        'sideBarSectionHeader.background': '#232323',
        'sideBarSectionHeader.foreground': '#f4f4f5',
        'panel.background': '#1f1f1f',
        'panel.border': '#383838',
        'input.background': '#111111',
        'input.foreground': '#e7e9ee',
        'input.border': '#3a3a3a',
        'button.background': '#2563eb',
        'button.foreground': '#ffffff',
        'button.hoverBackground': '#3b82f6',
        'list.hoverBackground': '#2c2c2c',
        'list.activeSelectionBackground': '#3a3a3a',
        'list.activeSelectionForeground': '#fafafa',
        'badge.background': '#2563eb',
        'badge.foreground': '#ffffff',
        'errorForeground': '#f87171',
        'focusBorder': '#3b82f6',
      },
    },
  },
  {
    source: 'builtin',
    id: 'agent-kernel-light',
    label: 'Default Light',
    theme: {
      name: 'Default Light',
      type: 'light',
      colors: {
        foreground: '#111827',
        'editor.background': '#f8f7f3',
        'editor.foreground': '#111827',
        'sideBar.background': '#f1f0ea',
        'sideBar.foreground': '#111827',
        'sideBar.border': '#d5d0c6',
        'sideBarTitle.foreground': '#0f172a',
        'sideBarSectionHeader.background': '#ece9e2',
        'sideBarSectionHeader.foreground': '#0f172a',
        'panel.background': '#ffffff',
        'panel.border': '#d5d0c6',
        'input.background': '#ffffff',
        'input.foreground': '#111827',
        'input.border': '#d5d0c6',
        'button.background': '#2563eb',
        'button.foreground': '#ffffff',
        'button.hoverBackground': '#1d4ed8',
        'list.hoverBackground': '#ebe8e0',
        'list.activeSelectionBackground': '#e8e4da',
        'list.activeSelectionForeground': '#111827',
        'badge.background': '#2563eb',
        'badge.foreground': '#ffffff',
        'errorForeground': '#dc2626',
        'focusBorder': '#2563eb',
      },
    },
  },
]

export function themeCssVarName(token: string): string {
  return `--vscode-${token.replace(/[^a-zA-Z0-9]/gu, '-')}`
}

export function readStoredVSCodeTheme(): StoredVSCodeTheme | null {
  try {
    const raw = localStorage.getItem(VSCODE_THEME_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredVSCodeTheme
    if (!parsed || typeof parsed !== 'object' || !parsed.theme || !parsed.id) return null
    return parsed
  } catch {
    return null
  }
}

export function writeStoredVSCodeTheme(theme: StoredVSCodeTheme | null): boolean {
  if (!writeDashboardPreference(VSCODE_THEME_STORAGE_KEY, theme ? JSON.stringify(theme) : null)) return false
  window.dispatchEvent(new Event(VSCODE_THEME_CHANGE_EVENT))
  return true
}

export function builtinThemeForScheme(scheme: 'dark' | 'light'): StoredVSCodeTheme {
  return BUILTIN_VSCODE_THEMES.find((theme) => theme.id === `agent-kernel-${scheme}`) ?? BUILTIN_VSCODE_THEMES[0]!
}

export function currentVSCodeTheme(scheme: 'dark' | 'light'): StoredVSCodeTheme {
  const stored = readStoredVSCodeTheme()
  return stored && themeScheme(stored.theme, scheme) === scheme
    ? stored
    : builtinThemeForScheme(scheme)
}

export function applyCurrentVSCodeTheme(scheme: 'dark' | 'light'): StoredVSCodeTheme {
  const theme = currentVSCodeTheme(scheme)
  applyVSCodeTheme(theme.theme, scheme)
  return theme
}

/**
 * Apply VS Code color tokens without allowing the theme metadata to change the
 * app's selected color scheme. An opposite-scheme custom theme remains stored
 * and becomes active again when the user selects its compatible app scheme.
 */
export function applyVSCodeTheme(theme: VSCodeColorTheme, scheme: 'dark' | 'light' = 'dark'): void {
  const root = document.documentElement
  const compatibleTheme = themeScheme(theme, scheme) === scheme
    ? theme
    : builtinThemeForScheme(scheme).theme
  const kind = normalizeKind(compatibleTheme.type, scheme)
  root.classList.toggle('dark', scheme === 'dark')
  root.style.colorScheme = scheme
  root.dataset.vscodeThemeKind = kind
  const colors = compatibleTheme.colors ?? {}
  for (const [token, value] of Object.entries(colors)) {
    if (typeof value === 'string' && value.trim()) root.style.setProperty(themeCssVarName(token), value.trim())
  }
  applySemanticTokens(root, colors, kind)
}

export function themeScheme(theme: VSCodeColorTheme, fallbackScheme: 'dark' | 'light'): 'dark' | 'light' {
  const kind = normalizeKind(theme.type, fallbackScheme)
  return kind === 'dark' || kind === 'hc' ? 'dark' : 'light'
}

export function normalizeKind(value: unknown, fallbackScheme: 'dark' | 'light' = 'dark'): VSCodeThemeKind {
  if (value === 'light' || value === 'vs') return 'light'
  if (value === 'hc' || value === 'highContrast') return 'hc'
  if (value === 'hcLight' || value === 'highContrastLight') return 'hcLight'
  if (value === 'dark' || value === 'vs-dark') return 'dark'
  return fallbackScheme
}

export function validateVSCodeTheme(value: unknown): VSCodeColorTheme | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as VSCodeColorTheme
  if (candidate.colors !== undefined && (!candidate.colors || typeof candidate.colors !== 'object')) return null
  return candidate
}

function applySemanticTokens(root: HTMLElement, colors: Record<string, string>, kind: VSCodeThemeKind): void {
  const dark = kind === 'dark' || kind === 'hc'
  const editorBg = firstColor(colors, ['editor.background', 'panel.background'], dark ? FALLBACK_DARK : FALLBACK_LIGHT)
  const fg = firstColor(colors, ['foreground', 'editor.foreground'], dark ? '#e7e9ee' : '#111827')
  const sideBg = firstColor(colors, ['sideBar.background', 'panel.background', 'editor.background'], editorBg)
  const sideFg = firstColor(colors, ['sideBar.foreground', 'foreground'], fg)
  const panelBg = firstColor(colors, ['panel.background', 'editorWidget.background', 'editor.background'], editorBg)
  const border = firstColor(colors, ['sideBar.border', 'panel.border', 'input.border'], dark ? '#3a3a3a' : '#cbd5e1')
  const primary = firstColor(colors, ['button.background', 'focusBorder', 'badge.background'], '#2563eb')
  const primaryFg = firstColor(colors, ['button.foreground', 'badge.foreground'], '#ffffff')
  const hover = firstColor(colors, ['list.hoverBackground'], mix(editorBg, fg, dark ? 0.12 : 0.08))
  const active = mix(editorBg, fg, dark ? 0.18 : 0.1)
  const mutedFg = mix(fg, editorBg, dark ? 0.35 : 0.42)

  setHsl(root, '--background', editorBg)
  setHsl(root, '--foreground', fg)
  setHsl(root, '--card', panelBg)
  setHsl(root, '--card-foreground', fg)
  setHsl(root, '--popover', panelBg)
  setHsl(root, '--popover-foreground', fg)
  setHsl(root, '--primary', primary)
  setHsl(root, '--primary-foreground', primaryFg)
  setHsl(root, '--secondary', hover)
  setHsl(root, '--secondary-foreground', fg)
  setHsl(root, '--muted', hover)
  setHsl(root, '--muted-foreground', mutedFg)
  setHsl(root, '--accent', active)
  setHsl(root, '--accent-foreground', fg)
  setHsl(root, '--destructive', firstColor(colors, ['errorForeground'], '#ef4444'))
  setHsl(root, '--destructive-foreground', '#ffffff')
  setHsl(root, '--border', border)
  setHsl(root, '--input', firstColor(colors, ['input.border'], border))
  setHsl(root, '--ring', primary)
  setHsl(root, '--sidebar', sideBg)
  setHsl(root, '--sidebar-foreground', sideFg)
  setHsl(root, '--sidebar-primary', primary)
  setHsl(root, '--sidebar-primary-foreground', primaryFg)
  setHsl(root, '--sidebar-accent', hover)
  setHsl(root, '--sidebar-accent-foreground', sideFg)
  setHsl(root, '--sidebar-border', border)
  setHsl(root, '--sidebar-ring', primary)
}

function firstColor(colors: Record<string, string>, keys: readonly string[], fallback: string): string {
  for (const key of keys) {
    const parsed = parseCssColor(colors[key])
    if (parsed) return rgbToHex(parsed)
  }
  return fallback
}

function setHsl(root: HTMLElement, token: string, color: string): void {
  const rgb = parseCssColor(color)
  if (!rgb) return
  const { h, s, l } = rgbToHsl(rgb)
  root.style.setProperty(token, `${round(h)} ${round(s)}% ${round(l)}%`)
}

type Rgb = { r: number; g: number; b: number }

function parseCssColor(value: string | undefined): Rgb | null {
  if (!value) return null
  const input = value.trim()
  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu)
  if (hex) {
    let raw = hex[1]!
    if (raw.length === 3) raw = raw.split('').map((x) => x + x).join('')
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    }
  }
  const rgb = input.match(/^rgba?\(([^)]+)\)$/iu)
  if (rgb) {
    const parts = rgb[1]!.split(',').map((part) => Number.parseFloat(part.trim()))
    if (parts.length >= 3 && parts.every((part) => Number.isFinite(part))) {
      return { r: clamp(parts[0]!), g: clamp(parts[1]!), b: clamp(parts[2]!) }
    }
  }
  return null
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: (h / 6) * 360, s: s * 100, l: l * 100 }
}

function rgbToHex({ r, g, b }: Rgb): string {
  const parts = [r, g, b].map((part) => clamp(part).toString(16).padStart(2, '0'))
  return `#${parts[0]!}${parts[1]!}${parts[2]!}`
}

function mix(base: string, overlay: string, amount: number): string {
  const a = parseCssColor(base)
  const b = parseCssColor(overlay)
  if (!a || !b) return base
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  })
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
