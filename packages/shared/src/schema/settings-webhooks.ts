import { z } from 'zod'

export const SettingsWebhookTopicSchema = z.enum([
  'organization.provisioned', 'organization.contract_renewed', 'usage.monthly_token_threshold',
])
const id = z.string().min(1).max(512).refine(value =>
  value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value))
const topics = z.array(SettingsWebhookTopicSchema).min(1).max(3)
  .refine(values => new Set(values).size === values.length)
const fields = {
  url: z.string().min(1).max(4096),
  topics,
  enabled: z.boolean(),
  secretBindingId: id,
}

export const SettingsWebhookCreateSchema = z.object(fields).strict()
export const SettingsWebhookPatchSchema = z.object({
  url: fields.url.optional(), topics: topics.optional(), enabled: fields.enabled.optional(),
  secretBindingId: id.optional(),
}).strict().refine(value => Object.keys(value).length > 0)

export type SettingsWebhookCreate = z.infer<typeof SettingsWebhookCreateSchema>
export type SettingsWebhookPatch = z.infer<typeof SettingsWebhookPatchSchema>
