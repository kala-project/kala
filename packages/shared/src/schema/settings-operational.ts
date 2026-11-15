import { z } from 'zod'
import { SettingsModelPolicyRequestSchema } from './settings-model-management.js'

const resource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('pool'), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('entitlement'), id: z.string().min(1).max(200) }).strict(),
])
export const SettingsOperationalRequestSchema = SettingsModelPolicyRequestSchema.extend({ resource }).strict()
export const SettingsOperationalObservationSchema = SettingsOperationalRequestSchema.extend({
  revision: z.string().regex(/^[1-9]\d*$/u),
  observedAt: z.string().datetime(),
  value: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace'), status: z.enum(['active', 'archived']) }).strict(),
    z.object({ kind: z.literal('pool'), mode: z.enum(['organization', 'workspace']), workspaceId: z.string().nullable(),
      workspaceStatus: z.enum(['active', 'archived']).nullable() }).strict(),
    z.object({ kind: z.literal('entitlement'), admitted: z.boolean(), startsAt: z.string(), endsAt: z.string() }).strict(),
  ]),
}).strict().refine(value => value.resource.kind === value.value.kind)
export type SettingsOperationalRequest = z.infer<typeof SettingsOperationalRequestSchema>
export type SettingsOperationalObservation = z.infer<typeof SettingsOperationalObservationSchema>
export const SettingsOperationalReceiptSchema = SettingsOperationalObservationSchema.safeExtend({
  operationId: z.string().uuid(), consumed: z.literal(true),
})
export const SettingsExecutorAdmissionRequestSchema = SettingsModelPolicyRequestSchema.extend({
  executorId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200),
  enrollmentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  enrollmentInviteId: z.string().min(1).max(512).optional(),
}).strict()
export const SettingsExecutorAdmissionSchema = SettingsExecutorAdmissionRequestSchema.extend({
  admitted: z.boolean(), registry: z.enum(['registered', 'legacy-unregistered']),
  pool: z.object({ id: z.string(), revision: z.string().regex(/^[1-9]\d*$/u),
    mode: z.enum(['organization', 'workspace']), workspaceId: z.string().nullable() }).strict().nullable(),
  workspaceStatus: z.enum(['active', 'archived', 'unregistered']), observedAt: z.string().datetime(),
}).strict()
export type SettingsExecutorAdmissionRequest = z.infer<typeof SettingsExecutorAdmissionRequestSchema>
