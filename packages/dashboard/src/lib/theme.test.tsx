import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DASHBOARD_PREFERENCES, usePreferencePersistenceFailure } from './prefs.js'
import { initializeTheme, useTheme } from './theme.js'
import {
  VSCODE_THEME_STORAGE_KEY,
  applyCurrentVSCodeTheme,
  currentVSCodeTheme,
  themeCssVarName,
  type StoredVSCodeTheme,
} from '../theme/vscode-theme.js'

type MediaController = {
  setDark(dark: boolean): void
}

function installColorSchemeMedia(initialDark: boolean): MediaController {
  let dark = initialDark
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    get matches() { return dark },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockReturnValue(media)
  return {
    setDark(next) {
      dark = next
      const event = { matches: next, media: media.media } as MediaQueryListEvent
      for (const listener of listeners) listener(event)
    },
  }
}

const darkCustomTheme: StoredVSCodeTheme = {
  source: 'custom',
  id: 'custom-dark',
  label: 'Custom Dark',
  theme: {
    type: 'dark',
    colors: {
      'editor.background': '#010203',
      'editor.foreground': '#fefefe',
    },
  },
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.vscodeThemeKind
})
afterEach(() => vi.restoreAllMocks())

describe('theme scheme authority', () => {
  it('uses system consistently as the registry and hook default', async () => {
    const media = installColorSchemeMedia(true)
    expect(DASHBOARD_PREFERENCES.theme.defaultValue).toBe('system')

    const { result } = renderHook(() => useTheme())
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true))
    expect(result.current[0]).toBe('system')
    expect(result.current[3]).toBe('dark')
    expect(localStorage.getItem('ak-theme')).toBe('system')

    act(() => media.setDark(false))
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(false))
    expect(result.current[3]).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('initializes from the selected scheme and ignores an incompatible saved custom theme', () => {
    installColorSchemeMedia(true)
    localStorage.setItem('ak-theme', 'light')
    localStorage.setItem(VSCODE_THEME_STORAGE_KEY, JSON.stringify(darkCustomTheme))

    initializeTheme()

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.documentElement.dataset.vscodeThemeKind).toBe('light')
    expect(currentVSCodeTheme('light').id).toBe('agent-kernel-light')
    expect(localStorage.getItem(VSCODE_THEME_STORAGE_KEY)).toBe(JSON.stringify(darkCustomTheme))
  })

  it('persists explicit selection and follows cross-tab scheme updates', async () => {
    installColorSchemeMedia(false)
    const { result } = renderHook(() => useTheme())

    act(() => result.current[2]('light'))
    await waitFor(() => expect(result.current[0]).toBe('light'))
    expect(localStorage.getItem('ak-theme')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    act(() => {
      localStorage.setItem('ak-theme', 'dark')
      window.dispatchEvent(new StorageEvent('storage', { key: 'ak-theme', newValue: 'dark' }))
    })
    await waitFor(() => expect(result.current[0]).toBe('dark'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('reapplies a compatible custom theme received from another tab', async () => {
    installColorSchemeMedia(false)
    localStorage.setItem('ak-theme', 'dark')
    renderHook(() => useTheme())
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true))

    act(() => {
      localStorage.setItem(VSCODE_THEME_STORAGE_KEY, JSON.stringify(darkCustomTheme))
      window.dispatchEvent(new StorageEvent('storage', {
        key: VSCODE_THEME_STORAGE_KEY,
        newValue: JSON.stringify(darkCustomTheme),
      }))
    })

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue(themeCssVarName('editor.background'))).toBe('#010203')
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('keeps custom themes stored and activates them only for a compatible scheme', () => {
    localStorage.setItem(VSCODE_THEME_STORAGE_KEY, JSON.stringify(darkCustomTheme))

    expect(applyCurrentVSCodeTheme('light').id).toBe('agent-kernel-light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue(themeCssVarName('editor.background'))).toBe('#f8f7f3')

    expect(applyCurrentVSCodeTheme('dark').id).toBe('custom-dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue(themeCssVarName('editor.background'))).toBe('#010203')
  })

  it('does not present a failed explicit scheme write as an applied preference', () => {
    installColorSchemeMedia(false)
    localStorage.setItem('ak-theme', 'light')
    const { result } = renderHook(() => ({ theme: useTheme(), failed: usePreferencePersistenceFailure() }))
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage unavailable', 'SecurityError') })
    act(() => result.current.theme[2]('dark'))
    expect(result.current.theme[0]).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(result.current.failed).toBe(true)
    storage.mockRestore()
    act(() => result.current.theme[2]('dark'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(result.current.failed).toBe(false)
  })
})
