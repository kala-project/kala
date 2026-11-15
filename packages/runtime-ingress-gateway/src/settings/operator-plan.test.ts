import { describe, expect, it } from 'vitest'
import { authenticateOperatorPlan, createOperatorPlan, operatorChangeDigest, operatorInstallationFingerprint } from './operator-plan.js'

const profile = {
  schemaVersion: 1, installationIdFile: '/protected/installation-id', controlPlaneDatabaseUrlRef: 'file:/protected/control',
  runtimeControlOrigin: 'https://runtime.private.test', internalCredentialRef: 'file:/protected/internal',
  planSigningKeyRef: 'file:/protected/plan-key', allowedOrganizations: ['org-a'], allowedResourceKinds: ['workspace'],
}
const change = { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000001', organizationId: 'org-a',
  resource: { kind: 'workspace', id: 'workspace-a' }, expectedRevision: '17', patch: { name: 'Renamed' } }
const key = new Uint8Array(32).fill(19)
const now = Date.parse('2026-01-01T00:00:00.000Z')
const identity = { installationId: 'installation-a', databaseAuthority: { host: 'database', port: 5432, database: 'control', role: 'settings_operator' },
  runtimeControlOrigin: profile.runtimeControlOrigin }
const fingerprint = operatorInstallationFingerprint(identity)
const planned = () => createOperatorPlan({ profile, change, installationFingerprint: fingerprint, key,
  dependencies: [{ kind: 'resource', id: 'workspace-a', revision: '17', state: 'active' }],
  effects: ['workspace.rename'], reversible: true, now })
const authenticate = (plan: unknown, overrides = {}) => authenticateOperatorPlan({
  profile, plan, installationFingerprint: fingerprint, key, now: now + 1000, ...overrides,
})

describe('authenticated complete Operator plans', () => {
  it('authenticates the complete plan with a canonical validated change', () => {
    const plan = planned()
    expect(authenticate(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
    expect(operatorChangeDigest({ patch: { name: '  Renamed  ' }, expectedRevision: '17',
      resource: change.resource, organizationId: 'org-a', operationId: change.operationId, schemaVersion: 1 })).toBe(plan.changeDigest)
    expect(() => createOperatorPlan({ profile, change, key, installationFingerprint: fingerprint,
      dependencies: [], effects: ['workspace.rename'], reversible: true, now, lifetimeMs: 900_001 })).toThrow('invalid_plan')
  })

  it('rejects altered dependencies, reversibility, effects, patches, operation identity and expiry even with unchanged changeDigest', () => {
    const original = planned()
    for (const alteration of [
      { dependencies: [{ ...original.dependencies[0], revision: '18' }] }, { reversible: false },
      { effects: ['workspace.archive'] }, { patch: { name: 'Injected' } },
      { operationId: '00000000-0000-4000-8000-000000000002' }, { expiresAt: '2026-01-01T00:14:00.000Z' },
      { changeDigest: 'f'.repeat(64) },
    ]) expect(() => authenticate({ ...original, ...alteration })).toThrow('altered_plan')
    expect(() => authenticate(original, { key: new Uint8Array(32).fill(20) })).toThrow('altered_plan')
    expect(() => authenticate({ ...original, signature: '' })).toThrow('invalid_plan')
    expect(() => authenticate(original, { now: now + 15 * 60_000 })).toThrow('expired_plan')
    expect(() => authenticate(original, { now: now - 1 })).toThrow('expired_plan')
  })

  it('binds exact installation, effective database authority and reviewed Runtime origin', () => {
    for (const changed of [
      { ...identity, installationId: 'installation-b' },
      { ...identity, databaseAuthority: { ...identity.databaseAuthority, database: 'other' } },
      { ...identity, databaseAuthority: { ...identity.databaseAuthority, port: 5433 } },
      { ...identity, runtimeControlOrigin: 'https://other.private.test' },
    ]) {
      expect(() => authenticate(planned(), { installationFingerprint: operatorInstallationFingerprint(changed) })).toThrow('wrong_installation')
    }
  })

  it('checks current protected profile authorization again rather than trusting a signed file path', () => {
    const plan = planned()
    expect(() => authenticate(plan, { profile: { ...profile, allowedOrganizations: ['org-b'] } })).toThrow('profile_scope_denied')
    expect(() => authenticate(plan, { profile: { ...profile, allowedResourceKinds: ['entitlement'] } })).toThrow('profile_scope_denied')
    expect(() => createOperatorPlan({ profile: { ...profile, allowedOrganizations: ['org-b'] }, change, key,
      installationFingerprint: fingerprint, dependencies: [], effects: ['workspace.rename'], reversible: true, now })).toThrow('profile_scope_denied')
    expect(() => authenticate(plan, { key: key.subarray(0, 20) })).toThrow('invalid_signing_key')
    for (const changed of [
      { additionalRuntimeControlOrigins: ['https://unreviewed.private.test'] },
      { internalCredentialRef: 'file:/protected/different-internal' },
      { controlPlaneDatabaseUrlRef: 'file:/protected/different-control' },
    ]) expect(() => authenticate(plan, { profile: { ...profile, ...changed } })).toThrow('invalid_profile')
  })
})
