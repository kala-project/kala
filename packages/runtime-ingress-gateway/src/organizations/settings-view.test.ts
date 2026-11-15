import { expect, it } from 'vitest'
import { parseSettingsPage, settingsPageCursor } from './settings-view.js'

it('bounds projected collection reads and binds keyset cursors to their organization and task', () => {
  const cursor = settingsPageCursor('org-one', 'audit', '2026-01-01T00:00:00.000Z', 'event-one')
  expect(parseSettingsPage('org-one', 'audit', new URLSearchParams({ cursor }))).toEqual({ limit: 50, after: ['2026-01-01T00:00:00.000Z', 'event-one'] })
  for (const [organization, section] of [['org-other', 'audit'], ['org-one', 'sessions']] as const) {
    expect(() => parseSettingsPage(organization, section, new URLSearchParams({ cursor }))).toThrow('invalid_page_cursor')
  }
  for (const limit of ['0', '101', '1.2', '', 'NaN']) {
    expect(() => parseSettingsPage('org-one', 'audit', new URLSearchParams({ limit }))).toThrow('invalid_page_limit')
  }
  const malformed = settingsPageCursor('org-one', 'audit', 'not-a-date', 'event-one')
  expect(() => parseSettingsPage('org-one', 'audit', new URLSearchParams({ cursor: malformed }))).toThrow('invalid_page_cursor')
  expect(() => parseSettingsPage('org-one', 'audit', new URLSearchParams({ cursor: '%bad' }))).toThrow('invalid_page_cursor')
})
