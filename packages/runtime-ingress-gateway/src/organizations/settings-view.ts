import type { OrganizationSettingsSection } from '@agent-kernel/shared'

export type SettingsPageRequest = { limit: number; after?: readonly [string, string]; workspaceId?: string }

export function parseSettingsPage(organizationId: string, section: OrganizationSettingsSection | 'service-accounts' | 'webhook-bindings', parameters: URLSearchParams): SettingsPageRequest {
  const rawLimit = parameters.get('limit')
  const limit = rawLimit === null ? 50 : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_page_limit')
  const workspaceId = parameters.get('workspaceId')
  if (workspaceId !== null && (section !== 'workspaces' || !/^ws_[A-Za-z0-9_-]{1,197}$/u.test(workspaceId))) throw new Error('invalid_workspace_resource')
  const cursor = parameters.get('cursor')
  if (workspaceId && cursor) throw new Error('invalid_page_cursor')
  if (!cursor) return { limit, ...(workspaceId ? { workspaceId } : {}) }
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('invalid_page_cursor')
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { throw new Error('invalid_page_cursor') }
  if (!Array.isArray(decoded) || decoded.length !== 5 || decoded[0] !== 1 || decoded[1] !== organizationId || decoded[2] !== section
    || typeof decoded[3] !== 'string' || typeof decoded[4] !== 'string'
    || !decoded[3] || !decoded[4] || decoded[3].length > 512 || decoded[4].length > 512) throw new Error('invalid_page_cursor')
  if (['members', 'audit', 'sessions', 'executors', 'service-accounts', 'webhooks'].includes(section) && !Number.isFinite(Date.parse(decoded[3]))) throw new Error('invalid_page_cursor')
  return { limit, after: [decoded[3], decoded[4]] }
}

export function settingsPageCursor(organizationId: string, section: OrganizationSettingsSection | 'service-accounts' | 'webhook-bindings', first: string, id: string): string {
  return Buffer.from(JSON.stringify([1, organizationId, section, first, id]), 'utf8').toString('base64url')
}
