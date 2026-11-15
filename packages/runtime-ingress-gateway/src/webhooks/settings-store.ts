import { createHash, randomUUID } from 'node:crypto'
import { schema } from '@agent-kernel/shared'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import type { AuthenticatedIdentity } from '../assignments/store.js'
import { settingsPageCursor, type SettingsPageRequest } from '../organizations/settings-view.js'
import { safeDestination } from './outbox-worker.js'

export class WebhookSettingsError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 412 | 428 | 503, readonly code: string) { super(code) }
}

type Endpoint = {
  id: string; url: string; topics: string[]; enabled: boolean; revision: string;
  delivery_generation: string; secret_binding_id: string | null; configuration_error: string | null; created_at: string;
}
export type WebhookEndpointView = {
  organizationId: string; id: string; url: string; topics: string[]; enabled: boolean; revision: string; etag: string;
  deliveryGeneration: string; secretBindingId: string | null; configurationError: string | null; createdAt: string;
}

export class PostgresWebhookSettingsStore {
  private readonly origins: Set<string>
  constructor(private readonly database: ControlPlaneDatabase, private readonly options: {
    publicOrigin: string; allowedOrigins: readonly string[]; allowLoopbackHttp?: boolean
  }) {
    const origin = new URL(options.publicOrigin)
    if (origin.origin !== options.publicOrigin || !['https:', 'http:'].includes(origin.protocol)) throw new Error('invalid_webhook_authority')
    this.origins = new Set(options.allowedOrigins.map(value => {
      const url = new URL(value)
      if (url.origin !== value || !safeDestination(url, options.allowLoopbackHttp)) throw new Error('invalid_webhook_origin_policy')
      return url.origin
    }))
    if (!this.origins.size) throw new Error('webhook_origin_policy_required')
  }

  async list(organizationId: string, page: SettingsPageRequest) {
    return this.database.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await this.assertSchema(tx)
      const result = await tx.query<Endpoint>(`SELECT id,url,topics,enabled,revision::text,delivery_generation::text,
        secret_binding_id,configuration_error,created_at::text FROM webhook_endpoints
        WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3))
        ORDER BY created_at DESC,id DESC LIMIT $4`,
      [organizationId, page.after?.[0] ?? null, page.after?.[1] ?? null, page.limit + 1])
      const rows = result.rows.slice(0, page.limit)
      const counts = await tx.query<{ enabled: string }>(
        'SELECT count(*)::text AS enabled FROM webhook_endpoints WHERE organization_id=$1 AND enabled', [organizationId])
      const deliveries = rows.length ? await tx.query<{ endpoint_id: string; state: string; count: string }>(
        `SELECT endpoint_id,state,count(*)::text FROM webhook_deliveries
          WHERE organization_id=$1 AND endpoint_id=ANY($2::text[]) GROUP BY endpoint_id,state`, [organizationId, rows.map(row => row.id)]) : { rows: [] }
      const last = rows.at(-1)
      return {
        organizationId,
        endpoints: rows.map(row => ({ ...this.view(organizationId, row),
          deliveries: Object.fromEntries(deliveries.rows.filter(delivery => delivery.endpoint_id === row.id)
            .map(delivery => [delivery.state, delivery.count])) })),
        enabledCount: counts.rows[0]?.enabled ?? '0', limit: 100,
        blocked: BigInt(counts.rows[0]?.enabled ?? '0') > 100n,
        delivery: 'at-least-once' as const, consumerVerification: 'not-observed' as const,
        topics: schema.SettingsWebhookTopicSchema.options,
        capabilities: [{ id: 'webhooks.configure', scope: 'organization', resourceId: organizationId,
          supported: true, canRead: true, canWrite: true, management: 'dashboard' }],
        ...(result.rows.length > page.limit && last ? {
          nextCursor: settingsPageCursor(organizationId, 'webhooks', last.created_at, last.id),
        } : {}),
      }
    })
  }

  async bindings(organizationId: string, page: SettingsPageRequest = { limit: 50 }) {
    return this.database.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await this.assertSchema(tx)
      const bindings = await tx.query<{ id: string; label: string; revision: string }>(
        `SELECT id,label,revision::text FROM organization_webhook_secret_bindings
          WHERE organization_id=$1 AND ($2::text IS NULL OR (label,id)>($2,$3))
          ORDER BY label,id LIMIT $4`,
        [organizationId, page.after?.[0] ?? null, page.after?.[1] ?? null, page.limit + 1])
      const rows = bindings.rows.slice(0, page.limit)
      const last = rows.at(-1)
      return { organizationId, bindings: rows.map(binding => ({ ...binding, configured: true })),
        ...(bindings.rows.length > page.limit && last ? {
          nextCursor: settingsPageCursor(organizationId, 'webhook-bindings', last.label, last.id),
        } : {}) }
    })
  }

  async create(organizationId: string, actor: AuthenticatedIdentity, input: unknown): Promise<WebhookEndpointView> {
    const parsed = schema.SettingsWebhookCreateSchema.safeParse(input)
    if (!parsed.success) throw new WebhookSettingsError(400, 'invalid_webhook_configuration')
    this.assertDestination(parsed.data.url)
    return this.write(async tx => {
      const principal = await this.lockOrganization(tx, organizationId, actor)
      const reference = await this.reference(tx, organizationId, parsed.data.secretBindingId)
      const id = `wh_${randomUUID()}`
      const result = await tx.query<Endpoint>(`INSERT INTO webhook_endpoints
        (id,organization_id,url,topics,enabled,secret_binding_id,secret_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        RETURNING id,url,topics,enabled,revision::text,delivery_generation::text,secret_binding_id,configuration_error,created_at::text`,
      [id, organizationId, parsed.data.url, parsed.data.topics, parsed.data.enabled,
        parsed.data.secretBindingId, JSON.stringify({ ref: reference })])
      await this.audit(tx, organizationId, principal, id, 'webhook.created')
      return this.view(organizationId, result.rows[0]!)
    })
  }

  async patch(organizationId: string, actor: AuthenticatedIdentity, id: string, input: unknown, etag?: string): Promise<WebhookEndpointView> {
    const parsed = schema.SettingsWebhookPatchSchema.safeParse(input)
    if (!parsed.success) throw new WebhookSettingsError(400, 'invalid_webhook_configuration')
    if (etag === undefined) throw new WebhookSettingsError(428, 'client_upgrade_required')
    if (parsed.data.url !== undefined) this.assertDestination(parsed.data.url)
    return this.write(async tx => {
      const principal = await this.lockOrganization(tx, organizationId, actor)
      const existing = (await tx.query<Endpoint>(`SELECT id,url,topics,enabled,revision::text,delivery_generation::text,
        secret_binding_id,configuration_error,created_at::text FROM webhook_endpoints
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [organizationId, id])).rows[0]
      if (!existing) throw new WebhookSettingsError(404, 'webhook_not_found')
      if (etag !== this.etag(organizationId, id, existing.revision)) throw new WebhookSettingsError(412, 'configuration_conflict')
      const patch = parsed.data
      const bindingId = patch.secretBindingId ?? existing.secret_binding_id
      const reference = bindingId ? await this.reference(tx, organizationId, bindingId) : undefined
      const enabled = patch.enabled ?? existing.enabled
      if (enabled && !reference) throw new WebhookSettingsError(409, 'webhook_signing_binding_required')
      if (enabled && (patch.topics ?? existing.topics).some(topic =>
        !schema.SettingsWebhookTopicSchema.safeParse(topic).success)) {
        throw new WebhookSettingsError(400, 'invalid_webhook_configuration')
      }
      if (enabled) this.assertDestination(patch.url ?? existing.url)
      const updated = await tx.query<Endpoint>(`UPDATE webhook_endpoints SET url=$3,topics=$4,enabled=$5,
        secret_binding_id=$6,secret_ref=CASE WHEN $7::jsonb IS NULL THEN secret_ref ELSE $7::jsonb END,
        configuration_error=CASE WHEN $6::text IS NULL THEN configuration_error ELSE NULL END
        WHERE organization_id=$1 AND id=$2
        RETURNING id,url,topics,enabled,revision::text,delivery_generation::text,secret_binding_id,configuration_error,created_at::text`,
      [organizationId, id, patch.url ?? existing.url, patch.topics ?? existing.topics,
        enabled, bindingId, patch.secretBindingId !== undefined && reference ? JSON.stringify({ ref: reference }) : null])
      await this.audit(tx, organizationId, principal, id, 'webhook.updated')
      return this.view(organizationId, updated.rows[0]!)
    })
  }

  private async write<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try { return await this.database.transaction(operation) } catch (error) {
      if (error instanceof Error && error.message === 'webhook_endpoint_limit_exceeded') {
        throw new WebhookSettingsError(409, 'webhook_endpoint_limit_exceeded')
      }
      throw error
    }
  }

  private async assertSchema(tx: SqlExecutor) {
    await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kala:control-settings-schema:v1', 0))")
    const available = await tx.query<{ present: boolean }>(
      "SELECT to_regclass('public.organization_webhook_secret_bindings') IS NOT NULL AS present")
    if (!available.rows[0]?.present) throw new WebhookSettingsError(503, 'webhook_schema_unavailable')
  }

  private async lockOrganization(tx: SqlExecutor, organizationId: string, actor: AuthenticatedIdentity): Promise<string> {
    await this.assertSchema(tx)
    const organization = await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [organizationId])
    if (!organization.rowCount) throw new WebhookSettingsError(404, 'organization_not_found')
    const principal = await tx.query<{ id: string }>(`SELECT principal.id FROM principals principal
      JOIN organization_memberships membership ON membership.principal_id=principal.id
      WHERE membership.organization_id=$1 AND membership.status='active' AND membership.role IN ('owner','admin')
        AND principal.issuer=$2 AND principal.subject=$3`, [organizationId, actor.issuer, actor.subject])
    if (!principal.rows[0]) throw new WebhookSettingsError(403, 'organization_management_required')
    return principal.rows[0].id
  }

  private async reference(tx: SqlExecutor, organizationId: string, id: string): Promise<string> {
    const binding = await tx.query<{ secret_ref: string }>(
      'SELECT secret_ref FROM organization_webhook_secret_bindings WHERE organization_id=$1 AND id=$2', [organizationId, id])
    const reference = binding.rows[0]?.secret_ref
    if (!reference || !schema.validOrganizationWebhookSecretReference(reference, organizationId)) {
      throw new WebhookSettingsError(409, 'webhook_signing_binding_unavailable')
    }
    return reference
  }

  private assertDestination(value: string) {
    try {
      const url = new URL(value)
      if (/[\s\u0000-\u001f\u007f]/u.test(value) || !safeDestination(url, this.options.allowLoopbackHttp)
        || !this.origins.has(url.origin)) throw new Error()
    } catch { throw new WebhookSettingsError(400, 'webhook_destination_rejected') }
  }

  private etag(organizationId: string, id: string, revision: string) {
    return `"${createHash('sha256').update(JSON.stringify([
      'kala:organization-webhook:v1', this.options.publicOrigin, organizationId, id, revision,
    ])).digest('base64url')}"`
  }

  private view(organizationId: string, row: Endpoint): WebhookEndpointView {
    return { organizationId, id: row.id, url: row.url, topics: row.topics, enabled: row.enabled, revision: row.revision,
      etag: this.etag(organizationId, row.id, row.revision), deliveryGeneration: row.delivery_generation,
      secretBindingId: row.secret_binding_id, configurationError: row.configuration_error, createdAt: row.created_at }
  }

  private async audit(tx: SqlExecutor, organizationId: string, principal: string, id: string, action: string) {
    await tx.query(`INSERT INTO audit_events
      (id,organization_id,actor_principal_id,actor_kind,action,target_type,target_id,result)
      VALUES ($1,$2,$3,'human',$4,'webhook_endpoint',$5,'succeeded')`,
    [`aud_${randomUUID()}`, organizationId, principal, action, id])
  }
}
