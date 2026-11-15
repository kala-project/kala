export type SettingsRoute =
  | { kind: 'page'; path: string; workspaceId?: string }
  | { kind: 'not-found'; path: string }

const pages = new Set([
  'personal/interface', 'personal/notifications', 'personal/connection', 'personal/account',
  'organization/members', 'organization/models/providers', 'organization/models/prompts', 'organization/models/engines',
  'organization/workspaces', 'organization/integrations/search', 'organization/integrations/speech',
  'organization/integrations/hooks', 'organization/integrations/skills', 'organization/integrations/webhooks',
  'organization/policies/execution', 'organization/policies/attachments', 'organization/policies/retention',
  'organization/access/usage', 'organization/access/storage', 'organization/access/service-accounts',
  'organization/access/sessions', 'organization/access/audit', 'organization/diagnostics',
  'deployment/services', 'deployment/storage', 'deployment/consoles', 'deployment/configuration',
])
const defaults: Readonly<Record<string, string>> = {
  '': 'personal/interface', personal: 'personal/interface', organization: 'organization/models/providers',
  'organization/models': 'organization/models/providers', 'organization/integrations': 'organization/integrations/search',
  'organization/policies': 'organization/policies/execution', 'organization/access': 'organization/access/usage',
  deployment: 'deployment/services',
}
const RETURN_KEY = 'kalaSettingsReturnHash'

export function settingsTargetMatchesOrigin(host: string, origin: string): boolean {
  try {
    const target = new URL(host || origin)
    return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password
      && target.origin === origin && target.pathname === '/' && !target.search && !target.hash
  } catch { return false }
}

export function parseSettingsRoute(hash: string): SettingsRoute | null {
  if (hash !== '#/settings' && !hash.startsWith('#/settings/')) return null
  const raw = hash.slice('#/settings'.length).replace(/^\//u, '')
  const path = defaults[raw] ?? raw
  if (pages.has(path)) return { kind: 'page', path }
  const match = /^organization\/workspaces\/([^/]+)(?:\/(overview|access|mcp))?$/u.exec(path)
  if (match) {
    try {
      const workspaceId = decodeURIComponent(match[1]!)
      if (workspaceId && workspaceId.length <= 512 && !/[\u0000-\u001f\u007f/\\]/u.test(workspaceId)) {
        return { kind: 'page', path: `organization/workspaces/${encodeURIComponent(workspaceId)}/${match[2] ?? 'overview'}`, workspaceId }
      }
    } catch { /* Invalid percent encoding is a Settings-local missing route. */ }
  }
  return { kind: 'not-found', path: raw }
}

export function settingsHash(path = 'personal/interface'): string {
  const parsed = parseSettingsRoute(`#/settings/${path}`)
  if (!parsed || parsed.kind !== 'page') throw new TypeError('Unknown Settings route')
  return `#/settings/${parsed.path}`
}

function validReturnHash(value: unknown): value is string {
  return typeof value === 'string' && /^#\/(?:agent|operations|artifacts|pipeline|docs|memo)$/u.test(value)
}

export function rememberSettingsReturn(): void {
  if (!validReturnHash(window.location.hash)) return
  const previous: unknown = window.history.state
  const state = previous && typeof previous === 'object' ? previous : {}
  window.history.replaceState({ ...state, [RETURN_KEY]: window.location.hash }, '', window.location.href)
}

export function openSettings(path = 'personal/interface'): void {
  const hash = settingsHash(path)
  if (window.location.hash === hash) return
  rememberSettingsReturn()
  const state: unknown = window.history.state
  window.location.hash = hash
  window.history.replaceState(state, '', window.location.href)
}

export function settingsReturnHash(): string {
  const state: unknown = window.history.state
  const candidate = state && typeof state === 'object' && RETURN_KEY in state ? state[RETURN_KEY] : undefined
  return validReturnHash(candidate) ? candidate : '#/agent'
}

export function returnFromSettings(): void {
  window.location.hash = settingsReturnHash()
}
