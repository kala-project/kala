import { beforeEach, describe, expect, it } from 'vitest'

import { markToolUpgradeNoticeSeen, toolUpgradeNoticeSeen } from './app.js'

describe('tool upgrade notices', () => {
  beforeEach(() => localStorage.clear())

  it('notifies once per Session across remounts and later tool-set changes', () => {
    const mounted = new Set<string>()
    expect(toolUpgradeNoticeSeen('account-a', 'session-a', mounted)).toBe(false)
    markToolUpgradeNoticeSeen('account-a', 'session-a', mounted)
    expect(toolUpgradeNoticeSeen('account-a', 'session-a', mounted)).toBe(true)
    expect(toolUpgradeNoticeSeen('account-a', 'session-a', new Set())).toBe(true)
    expect(toolUpgradeNoticeSeen('account-a', 'session-b', new Set())).toBe(false)
    expect(toolUpgradeNoticeSeen('account-b', 'session-a', new Set())).toBe(false)
  })
})
