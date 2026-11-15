import { z } from 'zod'

const identifier = z.string().min(1).max(512).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value))
const revision = z.string().regex(/^(?:0|[1-9]\d*)$/u).refine(value =>
  value.length < 19 || value.length === 19 && value <= '9223372036854775807')
const unsignedDecimal = z.string().regex(/^(?:0|[1-9]\d*)$/u)
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const label = z.string().trim().min(1).max(200)
const iso = z.string().datetime({ offset: true })
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const runtimeOrigin = z.string().url().refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === value }
  catch { return false }
})
const absolutePath = z.string().min(1).refine(value => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value) && !value.includes('\0'))
const protectedReference = z.string().min(1).max(4096).refine(value => {
  if (value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return false
  if (value.startsWith('bao:')) {
    const match = /^bao:([^#]+)#([^#]+)$/u.exec(value)
    const path = match?.[1]?.split('/')
    const segment = (part: string): boolean => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(part) && part.length <= 128
    return !!path && path.length <= 16 && path.every(segment) && !!match?.[2] && segment(match[2])
  }
  try {
    const url = new URL(value)
    return url.protocol === 'file:' && !url.hostname && url.pathname.startsWith('/') && url.pathname.length > 1
      && !url.search && !url.hash && !url.pathname.includes('%00')
  } catch { return false }
})

export const SettingsOperatorResourceKindSchema = z.enum([
  'model-management', 'workspace', 'pool', 'entitlement', 'webhook-secret-binding',
])

export const SettingsOperatorProfileSchema = z.object({
  schemaVersion: z.literal(1),
  installationIdFile: absolutePath,
  controlPlaneDatabaseUrlRef: protectedReference,
  runtimeControlOrigin: z.string().url().refine(value => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) && url.origin === value
        && !url.username && !url.password && !url.search && !url.hash
    } catch { return false }
  }),
  additionalRuntimeControlOrigins: z.array(runtimeOrigin).max(1_000).refine(values => new Set(values).size === values.length).optional(),
  internalCredentialRef: protectedReference,
  planSigningKeyRef: protectedReference,
  allowedOrganizations: z.array(identifier).min(1).max(10_000).refine(values => new Set(values).size === values.length),
  allowedResourceKinds: z.array(SettingsOperatorResourceKindSchema).min(1).max(5).refine(values => new Set(values).size === values.length),
}).strict()

const workspace = z.object({ name: label.optional(), status: z.enum(['active', 'archived']).optional() })
  .strict().refine(value => Object.keys(value).length > 0)
const pool = z.object({
  name: label.optional(), mode: z.enum(['organization', 'workspace']).optional(), workspaceId: identifier.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0
  && (value.mode === undefined ? !Object.hasOwn(value, 'workspaceId')
    : value.mode === 'organization' ? value.workspaceId === null : typeof value.workspaceId === 'string'))
const entitlement = z.object({
  contractReference: label.optional(), supportTier: z.enum(['standard', 'business', 'enterprise']).optional(),
  startsAt: iso.optional(), endsAt: iso.optional(), graceEndsAt: iso.nullable().optional(),
  seatLimit: positiveInteger.optional(), concurrentSessionLimit: positiveInteger.optional(), workspaceLimit: positiveInteger.optional(),
  monthlyTokenLimit: unsignedDecimal.nullable().optional(), storageBytesLimit: unsignedDecimal.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0)

export function validOrganizationWebhookSecretReference(reference: string, organizationId: string): boolean {
  if (/[\u0000-\u0020\u007f]/u.test(reference)) return false
  const match = /^bao:([^#]+)#([^#]+)$/u.exec(reference)
  if (!match || !/^[a-zA-Z0-9_-]{1,128}$/u.test(organizationId)) return false
  const path = match[1]!.split('/')
  const segment = (value: string): boolean => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(value) && value.length <= 128
  return path.length >= 4 && path.length <= 16 && path.every(segment) && segment(match[2]!)
    && path[0] === 'organizations' && path[1] === organizationId && path[2] === 'webhooks'
}

const binding = z.object({ label: label.optional(), secretRef: z.string().min(1).max(4096).optional() })
  .strict().refine(value => Object.keys(value).length > 0 && (value.secretRef === undefined || value.label !== undefined))
const common = {
  schemaVersion: z.literal(1), operationId: z.string().uuid(), organizationId: identifier, expectedRevision: revision,
}
const resource = <Kind extends z.infer<typeof SettingsOperatorResourceKindSchema>>(kind: Kind) =>
  z.object({ kind: z.literal(kind), id: identifier }).strict()

export const SettingsOperatorChangeSchema = z.union([
  z.object({ ...common, resource: resource('model-management'), patch: z.object({ management: z.enum(['operator', 'dashboard']) }).strict() }).strict(),
  z.object({ ...common, resource: resource('workspace'), patch: workspace }).strict(),
  z.object({ ...common, resource: resource('pool'), patch: pool }).strict(),
  z.object({ ...common, resource: resource('entitlement'), patch: entitlement }).strict(),
  z.object({ ...common, resource: resource('webhook-secret-binding'), patch: binding }).strict(),
]).superRefine((value, context) => {
  if (['model-management', 'entitlement'].includes(value.resource.kind) && value.resource.id !== value.organizationId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resource', 'id'], message: 'resource must identify its organization' })
  }
  if (value.resource.kind === 'webhook-secret-binding' && 'secretRef' in value.patch
    && value.patch.secretRef !== undefined && !validOrganizationWebhookSecretReference(value.patch.secretRef, value.organizationId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['patch', 'secretRef'], message: 'invalid organization webhook reference' })
  }
  if (value.resource.kind === 'webhook-secret-binding') {
    const creating = value.expectedRevision === '0'
    if (creating ? !('secretRef' in value.patch && 'label' in value.patch) : 'secretRef' in value.patch) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['patch'], message: 'binding reference is required on creation and immutable thereafter' })
    }
  }
})

export const SettingsOperatorEffectSchema = z.enum([
  'model-management.maintenance', 'workspace.rename', 'workspace.archive', 'workspace.reactivate',
  'pool.rename', 'pool.rebind', 'entitlement.contract-admission', 'entitlement.reported-metadata',
  'webhook-secret-binding.create', 'webhook-secret-binding.rename',
])

export const SettingsOperatorPlanSchema = z.object({
  ...common, installationFingerprint: digest, profileDigest: digest,
  resource: z.object({ kind: SettingsOperatorResourceKindSchema, id: identifier }).strict(),
  patch: z.record(z.string(), z.unknown()),
  dependencies: z.array(z.object({
    kind: z.enum(['resource', 'model-catalog', 'serving-membership', 'workspace-admission',
      'workspace-references', 'pool-references', 'entitlement-usage', 'secret-resolver']),
    id: identifier, revision: z.string().min(1).max(512),
    state: z.enum(['ready', 'active', 'archived', 'unconfigured', 'quiesced', 'pending', 'absent', 'enrolled', 'denied']),
  }).strict()).max(10_000),
  effects: z.array(SettingsOperatorEffectSchema).min(1).max(20),
  reversible: z.boolean(), createdAt: iso, expiresAt: iso,
  changeDigest: digest, signature: digest,
}).strict().superRefine((plan, context) => {
  if (new Set(plan.effects).size !== plan.effects.length || plan.effects.some(effect => !effect.startsWith(`${plan.resource.kind}.`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['effects'], message: 'effects must be unique and resource-specific' })
  }
  if (new Set(plan.dependencies.map(dependency => JSON.stringify([dependency.kind, dependency.id]))).size !== plan.dependencies.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dependencies'], message: 'dependency identities must be unique' })
  }
  const lifetime = Date.parse(plan.expiresAt) - Date.parse(plan.createdAt)
  if (!(lifetime > 0 && lifetime <= 15 * 60_000)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'plan lifetime must be at most 15 minutes' })
  }
  const change = SettingsOperatorChangeSchema.safeParse({
    schemaVersion: plan.schemaVersion, operationId: plan.operationId, organizationId: plan.organizationId,
    resource: plan.resource, expectedRevision: plan.expectedRevision, patch: plan.patch,
  })
  if (!change.success) context.addIssue({ code: z.ZodIssueCode.custom, path: ['patch'], message: 'invalid typed change' })
})

export type SettingsOperatorProfile = z.infer<typeof SettingsOperatorProfileSchema>
export type SettingsOperatorChange = z.infer<typeof SettingsOperatorChangeSchema>
export type SettingsOperatorPlan = z.infer<typeof SettingsOperatorPlanSchema>
