import { z } from 'zod'

const organizationId = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value))
const unitId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
const revision = z.string().regex(/^[1-9]\d*$/u).refine(value =>
  value.length < 19 || value.length === 19 && value <= '9223372036854775807')
export const SettingsModelManagementSchema = z.enum(['operator', 'dashboard'])
export const SettingsModelPolicyRequestSchema = z.object({
  installationId: z.string().uuid(), organizationId, unitId,
}).strict()
export const SettingsModelServingReplicaSchema = z.object({
  replicaId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u),
  generation: revision,
  origin: z.string().url().refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value }
    catch { return false }
  }),
  phase: z.enum(['drain', 'startup']),
}).strict()
export const SettingsModelPolicySchema = z.object({
  ...SettingsModelPolicyRequestSchema.shape,
  installed: z.boolean(),
  desiredManagement: SettingsModelManagementSchema, desiredRevision: revision,
  effectiveManagement: SettingsModelManagementSchema, effectiveRevision: revision,
  state: z.enum(['active', 'preparing', 'awaiting_runtime', 'failed']),
  operationId: z.string().uuid().nullable(),
  requiredServingScope: z.array(SettingsModelServingReplicaSchema).max(10_000),
}).strict().superRefine((value, context) => {
  const desired = BigInt(value.desiredRevision), effective = BigInt(value.effectiveRevision)
  if (desired < effective || value.state === 'active' && (desired !== effective || value.desiredManagement !== value.effectiveManagement)
    || value.state === 'preparing' && desired <= effective
    || value.state === 'awaiting_runtime' && (desired !== effective || value.desiredManagement !== value.effectiveManagement)
    || value.state !== 'active' && value.operationId === null
    || !value.installed && (value.state !== 'active' || effective !== 1n || value.effectiveManagement !== 'operator'
      || value.operationId !== null || value.requiredServingScope.length !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid model policy state' })
  }
  if (new Set(value.requiredServingScope.map(replica => `${replica.phase}:${replica.replicaId}:${replica.generation}`)).size
    !== value.requiredServingScope.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate serving identity' })
})
export const SettingsModelPolicyReconcileSchema = z.object({
  operationId: z.string().uuid(), organizationId, unitId,
  expectedEffectivePolicyRevision: revision, desiredPolicyRevision: revision,
  management: SettingsModelManagementSchema,
}).strict().refine(value => BigInt(value.desiredPolicyRevision) > BigInt(value.expectedEffectivePolicyRevision))

export type SettingsModelPolicy = z.infer<typeof SettingsModelPolicySchema>
export type SettingsModelPolicyRequest = z.infer<typeof SettingsModelPolicyRequestSchema>
export type SettingsModelPolicyReconcile = z.infer<typeof SettingsModelPolicyReconcileSchema>

const catalogRevision = z.string().regex(/^(?:0|[1-9]\d*)$/u).refine(value =>
  value.length < 19 || value.length === 19 && value <= '9223372036854775807')
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const SettingsModelPolicyInspectionSchema = z.object({
  installationId: z.string().uuid(), organizationId, unitId, protocol: z.literal('model-management-v1'),
  installed: z.boolean(), policyRevision: revision, management: SettingsModelManagementSchema,
  state: z.enum(['active', 'preparing', 'awaiting_runtime', 'failed']),
  catalogRevision, operatorCatalogRevision: digest, sessionReferencesRevision: digest,
  compatible: z.object({ operator: z.boolean(), dashboard: z.boolean() }).strict(),
  servingScope: z.array(SettingsModelServingReplicaSchema.refine(replica => replica.phase === 'drain')).max(10_000),
}).strict()
export const SettingsModelPolicyReconciliationSchema = z.object({
  operationId: z.string().uuid(), organizationId, unitId, policyRevision: revision,
  management: SettingsModelManagementSchema, catalogRevision,
}).strict()
export const SettingsModelPolicyReadySchema = SettingsModelPolicyReconciliationSchema.extend({
  replicaId: SettingsModelServingReplicaSchema.shape.replicaId,
  generation: revision, observedAt: z.string().datetime({ offset: true }),
}).strict()
export type SettingsModelPolicyInspection = z.infer<typeof SettingsModelPolicyInspectionSchema>
export type SettingsModelPolicyReady = z.infer<typeof SettingsModelPolicyReadySchema>
