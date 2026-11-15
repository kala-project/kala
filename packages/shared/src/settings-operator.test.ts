import { describe, expect, it } from 'vitest'
import { SettingsOperatorChangeSchema, SettingsOperatorPlanSchema, SettingsOperatorProfileSchema, validOrganizationWebhookSecretReference } from './schema/settings-operator.js'

const change = { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000001',
  organizationId: 'org-a', resource: { kind: 'workspace', id: 'workspace-a' },
  expectedRevision: '1', patch: { name: 'Renamed' } }
describe('frozen Settings Operator contracts', () => {
  it('rejects generic SQL, field authority escalation and incomplete atomic pool bindings', () => {
    expect(SettingsOperatorChangeSchema.parse(change).patch).toEqual({ name: 'Renamed' })
    for (const patch of [{}, { name: null }, { organizationId: 'org-b' }, { query: 'UPDATE organizations' }, { status: 'deleted' }]) {
      expect(SettingsOperatorChangeSchema.safeParse({ ...change, patch }).success).toBe(false)
    }
    for (const patch of [{ mode: 'workspace' }, { workspaceId: 'workspace-a' }, { mode: 'organization', workspaceId: 'workspace-a' }]) {
      expect(SettingsOperatorChangeSchema.safeParse({ ...change, resource: { kind: 'pool', id: 'pool-a' }, patch }).success).toBe(false)
    }
    expect(SettingsOperatorChangeSchema.safeParse({ ...change, resource: { kind: 'pool', id: 'pool-a' },
      patch: { mode: 'workspace', workspaceId: 'workspace-a' } }).success).toBe(true)
    expect(SettingsOperatorChangeSchema.safeParse({ ...change, expectedRevision: '9223372036854775808' }).success).toBe(false)
  })

  it('binds policy and entitlement identity and preserves nullable unlimited decimal caps without accepting enforcement input', () => {
    const resource = { kind: 'entitlement', id: 'org-a' }
    const patch = { monthlyTokenLimit: '18446744073709551616000', storageBytesLimit: null, graceEndsAt: null }
    expect(SettingsOperatorChangeSchema.safeParse({ ...change, resource, patch }).success).toBe(true)
    expect(SettingsOperatorChangeSchema.safeParse({ ...change, resource: { ...resource, id: 'org-b' }, patch }).success).toBe(false)
    expect(SettingsOperatorChangeSchema.safeParse({ ...change, resource, patch: { ...patch, enforcement: 'enforced' } }).success).toBe(false)
    expect(SettingsOperatorChangeSchema.safeParse({ ...change, resource, patch: { seatLimit: 0 } }).success).toBe(false)
  })

  it('rejects worker-incompatible, foreign, traversal and empty signing-key references', () => {
    expect(validOrganizationWebhookSecretReference('bao:organizations/org-a/webhooks/signing-v2#key', 'org-a')).toBe(true)
    for (const ref of ['bao:organizations/org-b/webhooks/key#key', 'bao:organizations/org-a/webhooks/../identity#key',
      'bao:organizations/org-a/webhooks/#key', 'bao:organizations/org-a/webhooks/key', 'file:/credentials',
      'bao:organizations/org-a/webhooks/key#key\n', 'bao:organizations/org-a/webhooks/key\n#key']) {
      expect(validOrganizationWebhookSecretReference(ref, 'org-a')).toBe(false)
    }
    expect(SettingsOperatorChangeSchema.safeParse({ ...change, resource: { kind: 'webhook-secret-binding', id: 'binding-a' },
      patch: { label: 'Binding', secretRef: 'bao:organizations/org-b/webhooks/signing#key' } }).success).toBe(false)
    const createBinding = { ...change, expectedRevision: '0', resource: { kind: 'webhook-secret-binding', id: 'binding-a' },
      patch: { label: 'Binding', secretRef: 'bao:organizations/org-a/webhooks/signing#key' } }
    expect(SettingsOperatorChangeSchema.safeParse(createBinding).success).toBe(true)
    expect(SettingsOperatorChangeSchema.safeParse({ ...createBinding, expectedRevision: '1' }).success).toBe(false)
    expect(SettingsOperatorChangeSchema.safeParse({ ...createBinding, expectedRevision: '1', patch: { label: 'New label' } }).success).toBe(true)
  })

  it('requires an exact protected profile and refuses credential-bearing or pathful origins', () => {
    const profile = { schemaVersion: 1, installationIdFile: '/protected/installation-id',
      controlPlaneDatabaseUrlRef: 'file:/protected/control-url', runtimeControlOrigin: 'https://runtime.private.test',
      internalCredentialRef: 'file:/protected/internal', planSigningKeyRef: 'file:/protected/plan-key',
      allowedOrganizations: ['org-a'], allowedResourceKinds: ['workspace'] }
    expect(SettingsOperatorProfileSchema.safeParse(profile).success).toBe(true)
    for (const origin of [Object.assign(new URL('https://runtime.private.test'), { username: 'invalid-fixture-user' }).href, 'https://runtime.private.test/path', 'https://runtime.private.test/?token=bad']) {
      expect(SettingsOperatorProfileSchema.safeParse({ ...profile, runtimeControlOrigin: origin }).success).toBe(false)
    }
    expect(SettingsOperatorProfileSchema.safeParse({ ...profile, sql: 'arbitrary' }).success).toBe(false)
  })

  it('rejects plans with invalid typed patches, unknown effects and lifetimes beyond fifteen minutes', () => {
    const plan = { ...change, installationFingerprint: 'a'.repeat(64), profileDigest: 'd'.repeat(64), dependencies: [], effects: ['workspace.rename'],
      reversible: true, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:15:00.000Z',
      changeDigest: 'b'.repeat(64), signature: 'c'.repeat(64) }
    expect(SettingsOperatorPlanSchema.safeParse(plan).success).toBe(true)
    expect(SettingsOperatorPlanSchema.safeParse({ ...plan, profileDigest: undefined }).success).toBe(false)
    expect(SettingsOperatorPlanSchema.safeParse({ ...plan, expiresAt: '2026-01-01T00:15:00.001Z' }).success).toBe(false)
    expect(SettingsOperatorPlanSchema.safeParse({ ...plan, patch: { organizationId: 'org-b' } }).success).toBe(false)
    expect(SettingsOperatorPlanSchema.safeParse({ ...plan, effects: ['execute-sql'] }).success).toBe(false)
    expect(SettingsOperatorPlanSchema.safeParse({ ...plan, effects: ['pool.rename'] }).success).toBe(false)
  })
})
