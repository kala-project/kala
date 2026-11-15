import type { ConfigurationRead, SettingsSectionValue } from '@agent-kernel/shared'

export type ConfigurationKind = 'models' | 'agent' | 'search' | 'speech' | 'retention' | 'attachment-policy'
export type ConfigurationSnapshot<Value extends object = SettingsSectionValue> = {
  value: Value
  configuration?: ConfigurationRead<Value>
  etag?: string
}
export type ConfigurationOutcome = 'idle' | 'saving' | 'conflict' | 'saved-pending' | 'outcome-unknown' | 'upgrade-required'
export type SettingsRequest = (path: string, init?: RequestInit) => Promise<Response>

const kindForPath = (path: string): ConfigurationKind | undefined => {
  if (path === '/organization/retention') return 'retention'
  if (path === '/organization/attachment-policy') return 'attachment-policy'
  if (/^\/settings\/(?:models|providers|default-model)$/u.test(path)) return 'models'
  if (/^\/settings\/(?:agent-prompt|desktop-access)$/u.test(path)) return 'agent'
  if (path === '/settings/web-search') return 'search'
  if (path === '/settings/speech') return 'speech'
  return undefined
}

export function configurationSnapshot<Value extends object = SettingsSectionValue>(
  body: unknown, etag: string | null, kind: ConfigurationKind, organizationId?: string,
): ConfigurationSnapshot<Value> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_configuration_response')
  if (!('resource' in body)) return { value: body as Value }
  const configuration = body as ConfigurationRead<Value>
  if (configuration.resource?.kind !== kind || configuration.resource.organizationId !== organizationId
    || !/^[1-9]\d*$/u.test(configuration.revision)
    || !configuration.value || typeof configuration.value !== 'object'
    || !configuration.application || !['applied', 'pending', 'failed', 'unknown'].includes(configuration.application.state)) {
    throw new Error('configuration_identity_mismatch')
  }
  return { value: configuration.value, configuration, etag: etag && /^"[\w-]{43}"$/u.test(etag) ? etag : undefined }
}

/** One instance belongs to one immutable target and one mounted configuration form. */
export class ConfigurationClient<Value extends object = SettingsSectionValue> {
  #etag: string | undefined
  #revision: string | undefined
  #outcome: ConfigurationOutcome = 'idle'
  constructor(private readonly options: {
    origin: string
    kind: ConfigurationKind
    readPath: string
    organizationId?: string
    authorization?: string
    fetch?: SettingsRequest
    onSnapshot?(snapshot: ConfigurationSnapshot<Value>): void
    onOutcome?(outcome: ConfigurationOutcome): void
  }) {}

  get outcome(): ConfigurationOutcome { return this.#outcome }
  get etag(): string | undefined { return this.#etag }
  seed(etag: string | undefined, revision?: string): void {
    this.#etag = etag
    this.#revision = revision
  }

  #setOutcome(outcome: ConfigurationOutcome): void {
    this.#outcome = outcome
    this.options.onOutcome?.(outcome)
  }

  #fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')
      || path !== new URL(path, this.options.origin).pathname
      || new URL(path, this.options.origin).origin !== this.options.origin
      || !/^\/(?:settings\/(?:sections\/(?:models|agent|execution)|models|providers|default-model|agent-prompt|desktop-access|web-search(?:\/test)?|speech(?:\/test)?)|organization\/(?:retention|attachment-policy(?:\/configuration)?))$/u.test(new URL(path, this.options.origin).pathname)) {
      return Promise.reject(new Error('configuration_target_mismatch'))
    }
    const headers = new Headers(init.headers)
    if (this.options.authorization) headers.set('authorization', this.options.authorization)
    return (this.options.fetch ?? ((url, input) => fetch(url, input)))(path, {
      ...init, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]),
      headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    })
  }

  async #read(init?: RequestInit, afterRevision?: string): Promise<{ response: Response; value: unknown; interveningWrite?: boolean }> {
    const response = await this.#fetch(this.options.readPath, init)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value: unknown = await response.clone().json()
    if (this.options.readPath.startsWith('/settings/sections/') || this.options.kind === 'retention' || this.options.kind === 'attachment-policy') {
      const snapshot = configurationSnapshot<Value>(value, response.headers.get('etag'), this.options.kind, this.options.organizationId)
      const interveningWrite = afterRevision !== undefined
        && snapshot.configuration?.revision !== (BigInt(afterRevision) + 1n).toString()
      if (interveningWrite) snapshot.etag = undefined
      this.#etag = snapshot.etag
      this.#revision = snapshot.configuration?.revision
      this.options.onSnapshot?.(snapshot)
      return { response, value: snapshot.value, interveningWrite }
    }
    const etag = response.headers.get('etag')
    this.#etag = etag && /^"[\w-]{43}"$/u.test(etag) ? etag : undefined
    return { response, value }
  }

  request: SettingsRequest = async (path, init = {}) => {
    const url = new URL(path, this.options.origin)
    if (path !== url.pathname || url.origin !== this.options.origin) throw new Error('configuration_target_mismatch')
    const method = (init.method ?? 'GET').toUpperCase()
    if (path === this.options.readPath && method === 'GET') return (await this.#read(init)).response
    const kind = kindForPath(url.pathname)
    if (method === 'GET' || !kind) return this.#fetch(path, init)
    if (kind !== this.options.kind) throw new Error('configuration_resource_mismatch')
    if (this.#outcome === 'saving') throw new Error('configuration_write_in_progress')
    if (!this.#etag) {
      if (this.#outcome === 'idle') this.#setOutcome('upgrade-required')
      throw new Error('configuration_refresh_required')
    }
    const headers = new Headers(init.headers)
    headers.set('if-match', this.#etag)
    this.#setOutcome('saving')
    const previousRevision = this.#revision
    let response: Response
    try {
      response = await this.#fetch(path, { ...init, headers })
      await response.clone().arrayBuffer()
    } catch {
      this.#etag = undefined
      this.#setOutcome('outcome-unknown')
      throw new Error('configuration_outcome_unknown')
    }
    if (!response.ok) {
      if (response.status === 412) this.#setOutcome('conflict')
      else if (response.status === 428) this.#setOutcome('upgrade-required')
      else {
        const body = await response.clone().json().catch(() => undefined) as { settingsSaved?: boolean } | undefined
        this.#setOutcome(body?.settingsSaved === true ? 'saved-pending' : 'idle')
        if (body?.settingsSaved === true) this.#etag = undefined
      }
      return response
    }
    // Never replay a mutation. A follow-up read couples the next edit's value to its ETag.
    this.#etag = undefined
    try {
      const fresh = await this.#read(undefined, previousRevision)
      this.#setOutcome(fresh.interveningWrite ? 'conflict' : this.#etag ? 'idle' : 'saved-pending')
      return new Response(JSON.stringify(fresh.value), { status: 200, headers: { 'content-type': 'application/json' } })
    } catch {
      this.#etag = undefined
      this.#setOutcome('saved-pending')
      return response
    }
  }
}
