import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { schema } from '@agent-kernel/shared'

type Plan = schema.SettingsOperatorPlan
type Profile = schema.SettingsOperatorProfile
type Change = schema.SettingsOperatorChange

export class OperatorPlanError extends Error {
  readonly exitCode = 2
  constructor(readonly code: 'invalid_plan' | 'invalid_change' | 'invalid_profile' | 'profile_scope_denied'
    | 'invalid_signing_key' | 'wrong_installation' | 'expired_plan' | 'altered_plan') {
    super(code)
    this.name = 'OperatorPlanError'
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new OperatorPlanError('invalid_plan')
}

function sha(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function sign(unsigned: Omit<Plan, 'signature'>, key: Uint8Array): string {
  if (key.byteLength < 32 || key.byteLength > 4096) throw new OperatorPlanError('invalid_signing_key')
  return createHmac('sha256', key).update('kala:settings-operator:plan:v1\0').update(canonical(unsigned)).digest('hex')
}

function scope(profile: Profile, change: Pick<Change, 'organizationId' | 'resource'>): void {
  if (!profile.allowedOrganizations.includes(change.organizationId)
    || !profile.allowedResourceKinds.includes(change.resource.kind)) throw new OperatorPlanError('profile_scope_denied')
}

function profileFor(value: unknown): Profile {
  const parsed = schema.SettingsOperatorProfileSchema.safeParse(value)
  if (!parsed.success) throw new OperatorPlanError('invalid_profile')
  return parsed.data
}

export function operatorChangeDigest(value: unknown): string {
  const parsed = schema.SettingsOperatorChangeSchema.safeParse(value)
  if (!parsed.success) throw new OperatorPlanError('invalid_change')
  return sha(parsed.data)
}

/** Callers supply the effective PG connection identity, never a credential-bearing URL. */
export function operatorInstallationFingerprint(identity: {
  installationId: string
  databaseAuthority: { host: string; port: number; database: string; role: string }
  runtimeControlOrigin: string
}): string {
  const { installationId, databaseAuthority, runtimeControlOrigin } = identity
  const authority = databaseAuthority
  if (!installationId.trim() || !authority.host.trim() || !authority.database.trim() || !authority.role.trim()
    || !Number.isInteger(authority.port) || authority.port < 1 || authority.port > 65535) throw new OperatorPlanError('invalid_profile')
  try {
    const url = new URL(runtimeControlOrigin)
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== runtimeControlOrigin) throw new Error()
  } catch { throw new OperatorPlanError('invalid_profile') }
  return sha({ domain: 'kala:settings-operator:installation:v1', installationId,
    databaseAuthority: { host: authority.host, port: authority.port, database: authority.database, role: authority.role }, runtimeControlOrigin })
}

export function createOperatorPlan(input: {
  profile: unknown; change: unknown; installationFingerprint: string; key: Uint8Array
  dependencies: Plan['dependencies']; effects: Plan['effects']; reversible: boolean
  now?: number; lifetimeMs?: number
}): Plan {
  const profile = profileFor(input.profile)
  const parsed = schema.SettingsOperatorChangeSchema.safeParse(input.change)
  if (!parsed.success) throw new OperatorPlanError('invalid_change')
  const change = parsed.data
  scope(profile, change)
  const now = input.now ?? Date.now()
  const lifetime = input.lifetimeMs ?? 15 * 60_000
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 15 * 60_000
    || Math.abs(now) > 8_640_000_000_000_000 - lifetime) throw new OperatorPlanError('invalid_plan')
  const candidate = {
    ...change, installationFingerprint: input.installationFingerprint,
    profileDigest: sha(profile),
    dependencies: input.dependencies, effects: input.effects, reversible: input.reversible,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + lifetime).toISOString(),
    changeDigest: sha(change), signature: '0'.repeat(64),
  }
  const validated = schema.SettingsOperatorPlanSchema.safeParse(candidate)
  if (!validated.success) throw new OperatorPlanError('invalid_plan')
  const { signature: _, ...unsigned } = validated.data
  return { ...unsigned, signature: sign(unsigned, input.key) }
}

export function authenticateOperatorPlan(input: {
  profile: unknown; plan: unknown; installationFingerprint: string; key: Uint8Array; now?: number
}): Plan {
  const profile = profileFor(input.profile)
  const validated = schema.SettingsOperatorPlanSchema.safeParse(input.plan)
  if (!validated.success) throw new OperatorPlanError('invalid_plan')
  const plan = validated.data
  scope(profile, plan)
  if (plan.installationFingerprint !== input.installationFingerprint) throw new OperatorPlanError('wrong_installation')
  if (plan.profileDigest !== sha(profile)) throw new OperatorPlanError('invalid_profile')
  const now = input.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < Date.parse(plan.createdAt) || now >= Date.parse(plan.expiresAt)) {
    throw new OperatorPlanError('expired_plan')
  }
  const { signature, ...unsigned } = plan
  const expected = sign(unsigned, input.key)
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw new OperatorPlanError('altered_plan')
  const change = {
    schemaVersion: plan.schemaVersion, operationId: plan.operationId, organizationId: plan.organizationId,
    resource: plan.resource, expectedRevision: plan.expectedRevision, patch: plan.patch,
  }
  if (operatorChangeDigest(change) !== plan.changeDigest) throw new OperatorPlanError('altered_plan')
  return plan
}
