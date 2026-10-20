import { useEffect, useState } from 'react'
import { CHAT_FONT_SIZE_PX, SESSION_EXPLORER_FONT_SIZE_PX, FILE_EXPLORER_FONT_SIZE_PX, FILE_VIEW_FONT_SIZE_PX, DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_MIN, INTERFACE_SCALE_MAX } from './display-sizes.js'

const CHANGE_EVENT = 'ak-pref-change'

type PrefChangeDetail = { key: string; value: string | null }

type BooleanPreferenceDefinition = {
  readonly key: string
  readonly type: 'boolean'
  readonly defaultValue: boolean
}

type NumberPreferenceDefinition = {
  readonly key: string
  readonly type: 'number'
  readonly defaultValue: number
  readonly min?: number
  readonly max?: number
}

type StringPreferenceDefinition = {
  readonly key: string
  readonly type: 'string'
  readonly defaultValue: string
}

type JsonPreferenceDefinition = {
  readonly key: string
  readonly type: 'json'
}

type PreferenceDefinition =
  | BooleanPreferenceDefinition
  | NumberPreferenceDefinition
  | StringPreferenceDefinition
  | JsonPreferenceDefinition

type PreferenceRegistry = Record<string, PreferenceDefinition>

function definePreferenceRegistry<const T extends PreferenceRegistry>(registry: T): T {
  return registry
}

export const DASHBOARD_PREFERENCES = definePreferenceRegistry({
  interfaceScale: { key: 'ak-interface-scale', type: 'number', defaultValue: DEFAULT_INTERFACE_SCALE, min: INTERFACE_SCALE_MIN, max: INTERFACE_SCALE_MAX },
  showToolCallTab: { key: 'ak-show-tool-call-tab', type: 'boolean', defaultValue: true },
  showPinnedMessage: { key: 'ak-show-pinned-message', type: 'boolean', defaultValue: true },
  liveToolActivityTailCount: { key: 'ak-live-tool-activity-tail-count', type: 'number', defaultValue: 3, min: 0, max: 50 },
  toolActivityIconScale: { key: 'ak-tool-activity-icon-scale', type: 'number', defaultValue: 150, min: 100, max: 300 },
  explorerOpen: { key: 'ak-explorer-open', type: 'boolean', defaultValue: true },
  sessionExplorerSectionOpen: { key: 'ak-session-explorer-section-open', type: 'boolean', defaultValue: true },
  inspectorOpen: { key: 'ak-inspector-open', type: 'boolean', defaultValue: true },
  topbarOpen: { key: 'ak-topbar-open', type: 'boolean', defaultValue: true },
  autoHideOfflineWorkspaces: { key: 'ak-auto-hide-offline-workspaces', type: 'boolean', defaultValue: true },
  hideSubAgentSessions: { key: 'ak-hide-sub-agent-sessions', type: 'boolean', defaultValue: true },
  chatFontSize: { key: 'ak-chat-font-size', type: 'number', defaultValue: 3, min: 0, max: CHAT_FONT_SIZE_PX.length - 1 },
  codeBlockFontSize: { key: 'ak-code-block-font-size', type: 'number', defaultValue: 15, min: 10, max: 48 },
  sessionExplorerFontSize: { key: 'ak-session-explorer-font-size', type: 'number', defaultValue: 2, min: 0, max: SESSION_EXPLORER_FONT_SIZE_PX.length - 1 },
  fileExplorerFontSize: { key: 'ak-file-explorer-font-size', type: 'number', defaultValue: 1, min: 0, max: FILE_EXPLORER_FONT_SIZE_PX.length - 1 },
  fileViewFontSize: { key: 'ak-file-view-font-size', type: 'number', defaultValue: 2, min: 0, max: FILE_VIEW_FONT_SIZE_PX.length - 1 },
  chatContentWidth: { key: 'ak-chat-content-width', type: 'number', defaultValue: 1, min: 0, max: 2 },
  chatSideSpace: { key: 'ak-chat-side-space', type: 'number', defaultValue: 1, min: 0, max: 2 },
  chatLineHeight: { key: 'ak-chat-line-height', type: 'number', defaultValue: 1, min: 0, max: 2 },
  chatMathScale: { key: 'ak-chat-math-scale', type: 'number', defaultValue: 2, min: 0, max: 4 },
  sessionViewCacheMaxMb: { key: 'ak-session-view-cache-max-mb', type: 'number', defaultValue: 500, min: 0, max: 4096 },
  sessionSubscriptionWarmthMinutes: { key: 'ak-session-subscription-warmth-minutes', type: 'number', defaultValue: 60, min: 0, max: 1440 },
  durableSessionCacheEnabled: { key: 'ak-durable-session-cache-enabled', type: 'boolean', defaultValue: true },
  appBadgeEnabled: { key: 'ak-app-badge-enabled', type: 'boolean', defaultValue: true },
  keepScreenAwake: { key: 'ak-keep-screen-awake', type: 'boolean', defaultValue: false },
  smoothStreamingText: { key: 'ak-smooth-streaming-text', type: 'boolean', defaultValue: true },
  expandThinkingByDefault: { key: 'ak-expand-thinking-by-default', type: 'boolean', defaultValue: false },
  messageTimestamps: { key: 'ak-message-timestamps', type: 'string', defaultValue: 'auto' },
  chapterReadingMode: { key: 'ak-chapter-reading-mode', type: 'string', defaultValue: 'chapters' },
  desktopNotificationsEnabled: { key: 'ak-desktop-notifications-enabled', type: 'boolean', defaultValue: false },
  desktopNotificationApproval: { key: 'ak-desktop-notification-approval-required', type: 'boolean', defaultValue: true },
  desktopNotificationWaiting: { key: 'ak-desktop-notification-waiting-for-user', type: 'boolean', defaultValue: true },
  desktopNotificationError: { key: 'ak-desktop-notification-session-error', type: 'boolean', defaultValue: true },
  desktopNotificationConnection: { key: 'ak-desktop-notification-connection-lost', type: 'boolean', defaultValue: true },
  desktopNotificationWorkspace: { key: 'ak-desktop-notification-workspace-offline', type: 'boolean', defaultValue: true },
  desktopNotificationSound: { key: 'ak-desktop-notification-sound', type: 'boolean', defaultValue: true },
  desktopNotificationDetails: { key: 'ak-desktop-notification-details', type: 'boolean', defaultValue: false },
  theme: { key: 'ak-theme', type: 'string', defaultValue: 'system' },
  vscodeTheme: { key: 'ak-vscode-theme', type: 'json' },
  dashboardLanguage: { key: 'ak-dashboard-language', type: 'string', defaultValue: 'en' },
  hostEndpoint: { key: 'agent-kernel:host-endpoint', type: 'string', defaultValue: '' },
  model: { key: 'ak-model', type: 'string', defaultValue: '' },
  agentRuntime: { key: 'ak-agent-runtime', type: 'string', defaultValue: 'kernel' },
  composerMode: { key: 'ak-composer-mode', type: 'string', defaultValue: 'full' },
  composerSendModePrefix: { key: 'agent-kernel:composer:send-mode:', type: 'string', defaultValue: '' },
  composerDraftPrefix: { key: 'agent-kernel:composer:draft:', type: 'string', defaultValue: '' },
  terminalKeepRunningPrefix: { key: 'ak-terminal:keep-running:', type: 'string', defaultValue: '' },
  terminalFontSizePrefix: { key: 'ak-terminal:font-size:', type: 'string', defaultValue: '' },
  hiddenWorkspaces: { key: 'ak-hidden-workspaces', type: 'json' },
  hiddenSessions: { key: 'ak-hidden-sessions', type: 'json' },
  workspaceOrder: { key: 'agent-kernel:explorer:workspace-order:v1', type: 'json' },
  sessionOrder: { key: 'agent-kernel:explorer:session-order:v1', type: 'json' },
  workspaceOpen: { key: 'agent-kernel:explorer:workspace-open:v1', type: 'json' },
  sessionChildrenOpen: { key: 'agent-kernel:explorer:session-children-open:v1', type: 'json' },
} as const)

export function dashboardPreferenceDefinitions(): readonly PreferenceDefinition[] {
  return Object.values(DASHBOARD_PREFERENCES)
}

export function numberPreferenceOptions(definition: NumberPreferenceDefinition): { min?: number; max?: number } {
  return { min: definition.min, max: definition.max }
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {}
  window.dispatchEvent(
    new CustomEvent<PrefChangeDetail>(CHANGE_EVENT, { detail: { key, value } }),
  )
}

/**
 * Read/write a boolean preference in localStorage. All hook instances mounted
 * against the same key stay in sync via a same-tab custom event and the
 * cross-tab `storage` event.
 */
/**
 * Read a boolean preference imperatively (no React). Used by non-component code
 * such as the streaming loop in session.ts that needs the current value without
 * subscribing. Falls back to `defaultValue` when unset/unparseable.
 */
export function readBooleanPref(key: string, defaultValue: boolean): boolean {
  const raw = readRaw(key)
  if (raw === null) return defaultValue
  return raw === '1' || raw === 'true'
}

export function readNumberPref(key: string, defaultValue: number, options: { min?: number; max?: number } = {}): number {
  const raw = readRaw(key)
  const parsed = raw === null ? defaultValue : Number(raw)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(options.max ?? Number.POSITIVE_INFINITY, Math.max(options.min ?? Number.NEGATIVE_INFINITY, Math.round(parsed)))
}

export function readStringPref(key: string, defaultValue: string): string {
  return readRaw(key) ?? defaultValue
}

export function writeStringPref(key: string, value: string): void {
  writeRaw(key, value)
}

export function useBooleanPref(
  key: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const raw = readRaw(key)
    if (raw === null) return defaultValue
    return raw === '1' || raw === 'true'
  })

  useEffect(() => {
    const onCustom = (e: Event): void => {
      const detail = (e as CustomEvent<PrefChangeDetail>).detail
      if (detail.key !== key) return
      if (detail.value === null) {
        setValue(defaultValue)
        return
      }
      setValue(detail.value === '1' || detail.value === 'true')
    }
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      if (e.newValue === null) {
        setValue(defaultValue)
        return
      }
      setValue(e.newValue === '1' || e.newValue === 'true')
    }
    window.addEventListener(CHANGE_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [key, defaultValue])

  const set = (next: boolean): void => {
    writeRaw(key, next ? '1' : '0')
    setValue(next)
  }

  return [value, set]
}

export function useNumberPref(
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): [number, (next: number) => void] {
  const normalize = (next: number): number => {
    if (!Number.isFinite(next)) return defaultValue
    const rounded = Math.round(next)
    const min = options.min ?? Number.NEGATIVE_INFINITY
    const max = options.max ?? Number.POSITIVE_INFINITY
    return Math.min(max, Math.max(min, rounded))
  }

  const parse = (raw: string | null): number => {
    if (raw === null) return defaultValue
    return normalize(Number(raw))
  }
  const [value, setValue] = useState<number>(() => parse(readRaw(key)))

  useEffect(() => {
    const onCustom = (e: Event): void => {
      const detail = (e as CustomEvent<PrefChangeDetail>).detail
      if (detail.key !== key) return
      setValue(parse(detail.value))
    }
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      setValue(parse(e.newValue))
    }
    window.addEventListener(CHANGE_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [key, defaultValue, options.min, options.max])

  const set = (next: number): void => {
    const normalized = normalize(next)
    writeRaw(key, String(normalized))
    setValue(normalized)
  }

  return [value, set]
}

export function useStringPref(
  key: string,
  defaultValue: string,
): [string, (next: string) => void] {
  const [value, setValue] = useState(() => readStringPref(key, defaultValue))
  useEffect(() => {
    const onCustom = (event: Event): void => {
      const detail = (event as CustomEvent<PrefChangeDetail>).detail
      if (detail.key === key) setValue(detail.value ?? defaultValue)
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === key) setValue(event.newValue ?? defaultValue)
    }
    window.addEventListener(CHANGE_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [defaultValue, key])
  const set = (next: string): void => {
    writeRaw(key, next)
    setValue(next)
  }
  return [value, set]
}

export const PREF_SHOW_TOOL_CALL_TAB = DASHBOARD_PREFERENCES.showToolCallTab.key
export const PREF_SHOW_PINNED_MESSAGE = DASHBOARD_PREFERENCES.showPinnedMessage.key
export const PREF_INTERFACE_SCALE = DASHBOARD_PREFERENCES.interfaceScale.key
export const PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT = DASHBOARD_PREFERENCES.liveToolActivityTailCount.key
export const PREF_TOOL_ACTIVITY_ICON_SCALE = DASHBOARD_PREFERENCES.toolActivityIconScale.key
export const PREF_EXPLORER_OPEN = DASHBOARD_PREFERENCES.explorerOpen.key
export const PREF_SESSION_EXPLORER_SECTION_OPEN = DASHBOARD_PREFERENCES.sessionExplorerSectionOpen.key
export const PREF_INSPECTOR_OPEN = DASHBOARD_PREFERENCES.inspectorOpen.key
export const PREF_TOPBAR_OPEN = DASHBOARD_PREFERENCES.topbarOpen.key
export const PREF_AUTO_HIDE_OFFLINE_WORKSPACES = DASHBOARD_PREFERENCES.autoHideOfflineWorkspaces.key
export const PREF_HIDE_SUB_AGENT_SESSIONS = DASHBOARD_PREFERENCES.hideSubAgentSessions.key
export const PREF_CHAT_FONT_SIZE = DASHBOARD_PREFERENCES.chatFontSize.key
export const PREF_CODE_BLOCK_FONT_SIZE = DASHBOARD_PREFERENCES.codeBlockFontSize.key
export const PREF_SESSION_EXPLORER_FONT_SIZE = DASHBOARD_PREFERENCES.sessionExplorerFontSize.key
export const PREF_FILE_EXPLORER_FONT_SIZE = DASHBOARD_PREFERENCES.fileExplorerFontSize.key
export const PREF_FILE_VIEW_FONT_SIZE = DASHBOARD_PREFERENCES.fileViewFontSize.key
export const PREF_CHAT_CONTENT_WIDTH = DASHBOARD_PREFERENCES.chatContentWidth.key
export const PREF_CHAT_SIDE_SPACE = DASHBOARD_PREFERENCES.chatSideSpace.key
export const PREF_CHAT_LINE_HEIGHT = DASHBOARD_PREFERENCES.chatLineHeight.key
export const PREF_CHAT_MATH_SCALE = DASHBOARD_PREFERENCES.chatMathScale.key
export const PREF_DURABLE_SESSION_CACHE_ENABLED = DASHBOARD_PREFERENCES.durableSessionCacheEnabled.key
export const PREF_SESSION_SUBSCRIPTION_WARMTH_MINUTES = DASHBOARD_PREFERENCES.sessionSubscriptionWarmthMinutes.key
export const PREF_APP_BADGE_ENABLED = DASHBOARD_PREFERENCES.appBadgeEnabled.key
export const PREF_KEEP_SCREEN_AWAKE = DASHBOARD_PREFERENCES.keepScreenAwake.key
export const PREF_SMOOTH_STREAMING_TEXT = DASHBOARD_PREFERENCES.smoothStreamingText.key
export const PREF_EXPAND_THINKING_BY_DEFAULT = DASHBOARD_PREFERENCES.expandThinkingByDefault.key
export const PREF_MESSAGE_TIMESTAMPS = DASHBOARD_PREFERENCES.messageTimestamps.key
export const PREF_CHAPTER_READING_MODE = DASHBOARD_PREFERENCES.chapterReadingMode.key
export const PREF_MODEL = DASHBOARD_PREFERENCES.model.key
export const PREF_AGENT_RUNTIME = DASHBOARD_PREFERENCES.agentRuntime.key
export const PREF_HOST_ENDPOINT = DASHBOARD_PREFERENCES.hostEndpoint.key
export const PREF_THEME = DASHBOARD_PREFERENCES.theme.key
export const PREF_VSCODE_THEME = DASHBOARD_PREFERENCES.vscodeTheme.key
export const PREF_DASHBOARD_LANGUAGE = DASHBOARD_PREFERENCES.dashboardLanguage.key
export const PREF_COMPOSER_MODE = DASHBOARD_PREFERENCES.composerMode.key
export const PREF_COMPOSER_SEND_MODE_PREFIX = DASHBOARD_PREFERENCES.composerSendModePrefix.key
export const PREF_COMPOSER_DRAFT_PREFIX = DASHBOARD_PREFERENCES.composerDraftPrefix.key
export const PREF_HIDDEN_WORKSPACES = DASHBOARD_PREFERENCES.hiddenWorkspaces.key
export const PREF_HIDDEN_SESSIONS = DASHBOARD_PREFERENCES.hiddenSessions.key
export const PREF_WORKSPACE_ORDER = DASHBOARD_PREFERENCES.workspaceOrder.key
export const PREF_SESSION_ORDER = DASHBOARD_PREFERENCES.sessionOrder.key
export const PREF_WORKSPACE_OPEN = DASHBOARD_PREFERENCES.workspaceOpen.key
export const PREF_SESSION_CHILDREN_OPEN = DASHBOARD_PREFERENCES.sessionChildrenOpen.key
export const DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT = DASHBOARD_PREFERENCES.liveToolActivityTailCount.defaultValue
export const DEFAULT_SESSION_SUBSCRIPTION_WARMTH_MINUTES = DASHBOARD_PREFERENCES.sessionSubscriptionWarmthMinutes.defaultValue
export const DEFAULT_TOOL_ACTIVITY_ICON_SCALE = DASHBOARD_PREFERENCES.toolActivityIconScale.defaultValue
export const DEFAULT_CHAT_FONT_SIZE = DASHBOARD_PREFERENCES.chatFontSize.defaultValue
export const DEFAULT_CODE_BLOCK_FONT_SIZE = DASHBOARD_PREFERENCES.codeBlockFontSize.defaultValue
export const DEFAULT_SESSION_EXPLORER_FONT_SIZE = DASHBOARD_PREFERENCES.sessionExplorerFontSize.defaultValue
export const DEFAULT_FILE_EXPLORER_FONT_SIZE = DASHBOARD_PREFERENCES.fileExplorerFontSize.defaultValue
export const DEFAULT_FILE_VIEW_FONT_SIZE = DASHBOARD_PREFERENCES.fileViewFontSize.defaultValue
export const DEFAULT_CHAT_CONTENT_WIDTH = DASHBOARD_PREFERENCES.chatContentWidth.defaultValue
export const DEFAULT_CHAT_SIDE_SPACE = DASHBOARD_PREFERENCES.chatSideSpace.defaultValue
export const DEFAULT_CHAT_LINE_HEIGHT = DASHBOARD_PREFERENCES.chatLineHeight.defaultValue
export const DEFAULT_CHAT_MATH_SCALE = DASHBOARD_PREFERENCES.chatMathScale.defaultValue
