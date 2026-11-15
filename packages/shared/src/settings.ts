import type { ProductVariant } from './deployment.js'
import type { ServerSettingsPayload } from './protocol.js'

export type SettingsCapability = {
  id: string
  scope: 'device' | 'account' | 'organization' | 'workspace' | 'session' | 'deployment'
  resourceId?: string
  supported: boolean
  canRead: boolean
  canWrite: boolean
  management: 'local-device' | 'dashboard' | 'operator' | 'identity-provider' | 'read-only'
  reasonCode?: string
  sourceRef?: string
}

export type SettingsCapabilities = {
  product: ProductVariant
  organizationId?: string
  capabilities: readonly SettingsCapability[]
}

export type IntegrationObservation = {
  id: 'secrets' | 'artifacts' | 'telemetry' | 'error-reporting' | 'ticketing' | 'webhooks'
  component: 'gateway' | 'runtime'
  configured: boolean | null
  health: 'healthy' | 'unavailable' | 'unknown' | 'not-applicable'
  sourceRef: string
  observedAt: string
  reasonCode?: string
}
export type RuntimeSettingsSection = 'models' | 'agent' | 'execution' | 'hooks' | 'skills' | 'engines' | 'storage' | 'diagnostics' | 'services' | 'integrations'
export type ConfigurationSourceObservation = {
  id: 'models' | 'agent' | 'credentials' | 'hooks'
  sourceRef: string
  management: 'dashboard' | 'protected-maintenance'
  revision: string | null
  effectiveRevision: string | null
  observedAt: string
  maintenance?: 'portable-model-import' | 'portable-agent-import' | 'runtime-operator'
}
export type SettingsSectionValue = Omit<Partial<ServerSettingsPayload>, 'defaultModel'> & {
  defaultModel?: string | null
  integrationStatus?: readonly IntegrationObservation[]
  configurationSources?: readonly ConfigurationSourceObservation[]
}
export type OrganizationSettingsSection = 'members' | 'workspaces' | 'executors' | 'policies' | 'usage' | 'sessions' | 'audit' | 'webhooks'
export type SettingsMember = { issuer: string; subject: string; displayName?: string; email?: string; role: 'owner' | 'admin' | 'member' | 'viewer'; createdAt: string }
export type SettingsInvite = { id: string; email: string; role: 'admin' | 'member' | 'viewer'; createdAt: string; expiresAt: string; acceptedAt?: string; revokedAt?: string }
export type SettingsWorkspace = { id: string; name: string; status: string; policy_version: number }
export type SettingsRetention = { session_days: number; artifact_days: number; audit_days: number; deleted_resource_grace_days: number; version: string | number }
export type SettingsSession = { id: string; device: unknown; created_at: string; last_seen_at: string; absolute_expires_at: string; revoked_at: string | null }
export type SettingsAudit = { id: string; actor_kind: string; action: string; target_type: string | null; target_id: string | null; result: string; occurred_at: string }
export type OrganizationSettingsValue = {
  members?: readonly SettingsMember[]
  invites?: readonly SettingsInvite[]
  workspaces?: readonly SettingsWorkspace[]
  executorPools?: readonly { id: string; name: string; mode: 'organization' | 'workspace'; workspaceId: string | null; revision: string }[]
  executorRegistrations?: readonly { id: string; name: string; poolId: string; status: string;
    nativeExecutorId: string | null; workspaceId: string | null; lastSeenAt: string | null }[]
  retention?: SettingsRetention
  attachmentMaxBytes?: number
  usage?: { tokens: string; sessions: number; entries: number }
  entitlement?: { contract_reference: string; support_tier: string; ends_at: string; seat_limit: number; concurrent_session_limit: number; workspace_limit: number; monthly_token_limit: string | null; storage_bytes_limit: string | null }
  sessions?: readonly SettingsSession[]
  audit?: readonly SettingsAudit[]
  nextCursor?: string
}

export type ConfigurationRead<T> = {
  resource: { kind: string; id: string; organizationId?: string }
  revision: string
  capabilities: readonly SettingsCapability[]
  value: T
  application: {
    state: 'applied' | 'pending' | 'failed' | 'unknown'
    desiredRevision: string
    effectiveRevision: string | null
    applyMode: 'immediate' | 'next-turn' | 'next-session' | 'executor-ack' | 'restart'
    scope: 'device' | 'unit' | 'workspace' | 'organization' | 'deployment'
    reasonCode?: string
    sessionObservations?: readonly {
      sessionId: string
      desiredRevision: string
      effectiveRevision: string | null
      state: 'applied' | 'pending' | 'unknown'
      observedAt: string | null
    }[]
    observations?: readonly {
      unitId: string
      replicaId: string
      generation?: string
      revision: string | null
      observedAt: string
      synchronization: 'disconnected' | 'synchronizing' | 'ready'
    }[]
  }
}
