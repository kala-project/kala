import { describe, expect, it } from 'vitest'
import { assertControlSettingsWrite, controlSettingsEtag, controlSettingsWriteProtocol } from './control-revisions.js'

describe('control configuration deployment protocol', () => {
  it('fails closed on an invalid rollout setting and requires the shared writer upgrade after transition', () => {
    expect(controlSettingsWriteProtocol('legacy-compatible')).toBe('legacy-compatible')
    expect(controlSettingsWriteProtocol('conditional-required')).toBe('conditional-required')
    for (const value of ['', 'required', 'CONDITIONAL-REQUIRED', 'legacy-compatible ']) expect(() => controlSettingsWriteProtocol(value)).toThrow('invalid settingsWriteProtocol')
    expect(() => assertControlSettingsWrite('org', 'retention', '1', { writeProtocol: 'conditional-required' }))
      .toThrow('client_upgrade_required')
    expect(() => assertControlSettingsWrite('org', 'attachment-policy', undefined, { expectedRevision: '1' }))
      .toThrow('configuration_revisions_unavailable')
  })

  it('binds preconditions to authority, organization and resource without weakening strong ETags', () => {
    const authority = 'https://installation-a.test'
    const expectedEtag = controlSettingsEtag('org', 'retention', '7', authority)
    expect(() => assertControlSettingsWrite('org', 'retention', '7', { expectedEtag, authority })).not.toThrow()
    for (const other of [
      { organization: 'foreign', resource: 'retention', authority },
      { organization: 'org', resource: 'attachment-policy', authority },
      { organization: 'org', resource: 'retention', authority: 'https://installation-b.test' },
    ] as const) expect(() => assertControlSettingsWrite(other.organization, other.resource, '7', { expectedEtag, authority: other.authority })).toThrow('configuration_conflict')
    for (const invalid of ['*', `W/${expectedEtag}`, `${expectedEtag},${expectedEtag}`]) {
      expect(() => assertControlSettingsWrite('org', 'retention', '7', { expectedEtag: invalid, authority })).toThrow('configuration_conflict')
    }
  })
})
