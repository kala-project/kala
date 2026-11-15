import { afterEach, describe, expect, it } from 'vitest'
import { openSettings, parseSettingsRoute, returnFromSettings, settingsHash, settingsReturnHash, settingsTargetMatchesOrigin } from './routes.js'

afterEach(() => window.history.replaceState(null, '', '/'))

describe('Settings hash contract', () => {
  it('refuses cross-target, credential-bearing and non-root settings targets', () => {
    expect(settingsTargetMatchesOrigin('', 'https://target.example')).toBe(true)
    expect(settingsTargetMatchesOrigin('https://target.example/', 'https://target.example')).toBe(true)
    for (const target of ['https://other.example', 'https://target.example:444', 'http://target.example', Object.assign(new URL('https://target.example'), { username: 'invalid-fixture-user' }).href, 'https://target.example/path', 'https://target.example/?target=other', 'javascript:alert(1)']) {
      expect(settingsTargetMatchesOrigin(target, 'https://target.example')).toBe(false)
    }
  })
  it('canonicalizes only documented defaults and keeps unknown hashes inside Settings', () => {
    expect(parseSettingsRoute('#/settings')).toEqual({ kind: 'page', path: 'personal/interface' })
    expect(parseSettingsRoute('#/settings/organization/models')).toEqual({ kind: 'page', path: 'organization/models/providers' })
    expect(parseSettingsRoute('#/settings/deployment')).toEqual({ kind: 'page', path: 'deployment/services' })
    expect(parseSettingsRoute('#/settings/organization/no-such-page')).toEqual({ kind: 'not-found', path: 'organization/no-such-page' })
    expect(parseSettingsRoute('#/settings/organization/models/providers/extra')).toMatchObject({ kind: 'not-found' })
    expect(parseSettingsRoute('#/settings-other')).toBeNull()
    expect(() => settingsHash('missing')).toThrow()
  })

  it('decodes workspace IDs exactly once and rejects route separators, controls and malformed escapes', () => {
    expect(parseSettingsRoute('#/settings/organization/workspaces/space%20%25%3F%23/mcp')).toEqual({
      kind: 'page', path: 'organization/workspaces/space%20%25%3F%23/mcp', workspaceId: 'space %?#',
    })
    expect(parseSettingsRoute('#/settings/organization/workspaces/id%252Fpart')).toEqual({
      kind: 'page', path: 'organization/workspaces/id%252Fpart/overview', workspaceId: 'id%2Fpart',
    })
    for (const id of ['%', '%2F', '%5C', '%00', '%0A', '%7F', '%E0%A4%A']) {
      expect(parseSettingsRoute(`#/settings/organization/workspaces/${id}/mcp`)).toMatchObject({ kind: 'not-found' })
    }
  })

  it('preserves application pathname/query and validated return state across Settings navigation', () => {
    window.history.replaceState({ existing: 'kept' }, '', '/desktop/index.html?mode=native#/agent')
    openSettings('organization/models')
    expect(window.location.pathname).toBe('/desktop/index.html')
    expect(window.location.search).toBe('?mode=native')
    expect(window.location.hash).toBe('#/settings/organization/models/providers')
    expect(window.history.state.existing).toBe('kept')
    expect(settingsReturnHash()).toBe('#/agent')
    openSettings('organization/access/audit')
    expect(settingsReturnHash()).toBe('#/agent')
    returnFromSettings()
    expect(window.location.hash).toBe('#/agent')
    window.history.replaceState({ kalaSettingsReturnHash: 'https://other.invalid/' }, '', '/#/settings')
    expect(settingsReturnHash()).toBe('#/agent')
  })
})
