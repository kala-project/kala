import { describe, expect, it } from 'vitest'

import {
  DASHBOARD_PREFERENCES,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_FILE_VIEW_FONT_SIZE,
  DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_CHAT_FONT_SIZE,
  PREF_FILE_VIEW_FONT_SIZE,
  PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_AUTO_HIDE_OFFLINE_WORKSPACES,
  PREF_HIDE_SUB_AGENT_SESSIONS,
  PREF_SHOW_PINNED_MESSAGE,
  dashboardPreferenceDefinitions,
  numberPreferenceOptions,
} from './prefs.js'

describe('dashboard preference registry', () => {
  it('keeps storage keys unique', () => {
    const keys = dashboardPreferenceDefinitions().map((definition) => definition.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps number defaults inside their configured bounds', () => {
    for (const definition of dashboardPreferenceDefinitions()) {
      if (definition.type !== 'number') continue
      if (definition.min !== undefined) expect(definition.defaultValue).toBeGreaterThanOrEqual(definition.min)
      if (definition.max !== undefined) expect(definition.defaultValue).toBeLessThanOrEqual(definition.max)
    }
  })

  it('exports legacy constants from the registry source of truth', () => {
    expect(PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT).toBe(DASHBOARD_PREFERENCES.liveToolActivityTailCount.key)
    expect(DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT).toBe(DASHBOARD_PREFERENCES.liveToolActivityTailCount.defaultValue)
    expect(PREF_CHAT_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.chatFontSize.key)
    expect(DEFAULT_CHAT_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.chatFontSize.defaultValue)
    expect(DASHBOARD_PREFERENCES.codeBlockFontSize).toEqual({ key: 'ak-code-block-font-size', type: 'number', defaultValue: 15, min: 12, max: 48 })
    expect(PREF_FILE_VIEW_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.fileViewFontSize.key)
    expect(DEFAULT_FILE_VIEW_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.fileViewFontSize.defaultValue)
    expect(PREF_AUTO_HIDE_OFFLINE_WORKSPACES).toBe(DASHBOARD_PREFERENCES.autoHideOfflineWorkspaces.key)
    expect(PREF_HIDE_SUB_AGENT_SESSIONS).toBe(DASHBOARD_PREFERENCES.hideSubAgentSessions.key)
    expect(PREF_SHOW_PINNED_MESSAGE).toBe(DASHBOARD_PREFERENCES.showPinnedMessage.key)
    expect(DASHBOARD_PREFERENCES.autoHideOfflineWorkspaces.defaultValue).toBe(true)
    expect(DASHBOARD_PREFERENCES.hideSubAgentSessions.defaultValue).toBe(true)
    expect(DASHBOARD_PREFERENCES.showPinnedMessage.defaultValue).toBe(true)
  })

  it('derives number hook bounds from number definitions', () => {
    expect(numberPreferenceOptions(DASHBOARD_PREFERENCES.sessionViewCacheMaxMb)).toEqual({ min: 0, max: 4096 })
  })
})
