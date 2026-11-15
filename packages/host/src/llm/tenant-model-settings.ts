import type {
  ClientAddManualModel, ClientAddManualProvider, ClientDeleteManualModel,
  ClientDeleteManualProvider, ClientSetDefaultModel, ClientUpdateManualProvider, ClientUpdateManualModel,
} from '@agent-kernel/shared'
import type { DashboardActor } from '../auth-control.js'
import type { PostgresTenantStateStore } from '../tenant-runtime/postgres-state.js'
import type { HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import type { SettingsWriteOptions } from '../settings-concurrency.js'
import { createRuntimeLogger, type RuntimeLogger } from '../logger.js'
import { ExplicitLLMClientFactory, type LLMClientFactory, type SecretResolver } from './client-factory.js'
import {
  type RuntimeProviderCatalog, type RuntimeProviderRuntime,
} from './runtime-provider-catalog.js'

type Catalog<Default extends string | null> = Omit<RuntimeProviderCatalog, 'defaultModel'> & { defaultModel: Default }
type Runtime<Default extends string | null> = Omit<RuntimeProviderRuntime, 'defaultModel'> & { defaultModel: Default }
type Document<Default extends string | null> = { version: 1; catalog: Catalog<Default>; keys: Record<string, string> }
type Snapshot<Default extends string | null> = { document: Document<Default>; runtime: Runtime<Default>; revision?: string }

export type TenantModelSettingsAuthority<Default extends string | null> = {
  credential: string
  channel: string
  prefix: string
  parseCatalog(value: unknown): Catalog<Default>
  compileRuntime(catalog: Catalog<Default>, factory: LLMClientFactory): Promise<Runtime<Default>>
  beforeCall?(): Promise<void>
  beforeMutation?(transaction: HotStateSqlExecutor): Promise<void>
  beforeInitialize?(transaction: HotStateSqlExecutor): Promise<void>
}

/**
 * The catalog and write-only keys share one tenant-encrypted transaction.
 * Post-commit invalidation refreshes replicas; adapters retain immutable snapshots.
 */
export class TenantModelSettings<Default extends string | null> {
  private snapshot!: Snapshot<Default>
  private pending: Promise<unknown> = Promise.resolve()
  private stopListening?: () => Promise<void>
  private retry?: ReturnType<typeof setTimeout>
  private reloadQueued = false
  private closed = false
  private synchronizationFailed = false
  private subscriptionState: 'disconnected' | 'synchronizing' | 'ready' = 'synchronizing'
  private observedAt = new Date(0).toISOString()
  private readonly listeners = new Set<() => void>()
  private readonly observationListeners = new Set<() => void>()
  readonly llm = {
    name: 'tenant-live-models',
    call: (params: Parameters<RuntimeProviderRuntime['llm']['call']>[0]) => {
      const invoke = () => {
        if (this.closed || this.synchronizationFailed || this.subscriptionState !== 'ready') return Promise.reject(new Error('Model configuration synchronization is unavailable'))
        const { runtime } = this.snapshot
        const model = params.model ?? runtime.defaultModel
        return runtime.llm.call({ ...params, ...(model !== null ? { model } : {}) })
      }
      return this.authority.beforeCall ? this.authority.beforeCall().then(invoke) : invoke()
    },
  }

  constructor(
    private readonly authority: TenantModelSettingsAuthority<Default>,
    private readonly state: PostgresTenantStateStore,
    private readonly organizationId: string,
    private readonly seed: Catalog<Default>,
    private readonly seedSecrets: SecretResolver,
    private readonly factory: (resolver: SecretResolver) => LLMClientFactory = resolver => new ExplicitLLMClientFactory(resolver),
    private readonly logger: Pick<RuntimeLogger, 'warn' | 'info'> = createRuntimeLogger('tenant-model-settings'),
  ) {
    if (state.tenantId !== organizationId) throw new Error('model_settings_tenant_mismatch')
  }

  get models() { return this.snapshot.runtime.models }
  get defaultModel() { return this.snapshot.runtime.defaultModel }
  get effectiveRevision() { return this.snapshot.revision ?? null }
  get observationTime() { return this.observedAt }
  get synchronization() { return this.subscriptionState === 'ready' && !this.synchronizationFailed ? 'ready' : this.subscriptionState === 'disconnected' ? 'disconnected' : 'synchronizing' }
  async desiredRevision(): Promise<string | undefined> {
    return this.state.withCredentialLock(this.authority.credential, (transaction) =>
      this.state.credentialRevision(this.authority.credential, transaction))
  }
  async configuration() {
    return this.state.withCredentialLock(this.authority.credential, async (transaction) => {
      const revision = await this.state.credentialRevision(this.authority.credential, transaction)
      if (!revision) throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
      const record = await this.state.getCredential(this.authority.credential, transaction)
      if (!record) throw new Error('model settings not initialized')
      const desired = await this.compile(JSON.parse(record.secret) as Document<Default>)
      return { revision, defaultModel: desired.runtime.defaultModel, providers: this.projectProviders(desired) }
    })
  }
  get providers() {
    return this.projectProviders(this.snapshot)
  }

  private projectProviders(snapshot: Snapshot<Default>) {
    return snapshot.document.catalog.providers.map(provider => ({
      id: provider.id, label: provider.label ?? provider.id, wire: provider.wire,
      baseUrl: provider.baseUrl, source: 'manual' as const,
      models: snapshot.runtime.models.filter(model => model.providerId === provider.id),
    }))
  }

  async load(): Promise<void> {
    this.snapshot = await this.state.withCredentialLock(this.authority.credential, async transaction => {
      const saved = await this.state.getCredential(this.authority.credential, transaction)
      if (saved) return { ...await this.compile(JSON.parse(saved.secret) as Document<Default>),
        revision: await this.state.credentialRevision(this.authority.credential, transaction) }
      await this.authority.beforeInitialize?.(transaction)
      const keys: Record<string, string> = Object.create(null) as Record<string, string>
      for (const provider of this.seed.providers) keys[provider.id] = await this.seedSecrets.resolve(provider.credentialRef)
      const snapshot = await this.compile({ version: 1, catalog: structuredClone(this.seed), keys })
      await this.state.setCredential(this.authority.credential, JSON.stringify(snapshot.document), {}, undefined, transaction)
      return { ...snapshot, revision: await this.state.credentialRevision(this.authority.credential, transaction) }
    })
    if (!this.state.database.listen) throw new Error('Tenant model settings require PostgreSQL notification support')
    this.stopListening = await this.state.database.listen(this.authority.channel, payload => {
      if (payload !== undefined) {
        try {
          if ((JSON.parse(payload) as { organizationId?: unknown }).organizationId !== this.organizationId) return
        } catch { return }
      }
      return this.queueReload()
    }, { onState: state => {
      this.subscriptionState = state
      if (state !== 'ready') this.synchronizationFailed = true
      this.observe()
    } })
    await this.pending
    // Test/legacy adapters without lifecycle callbacks still perform the initial reread.
    if (this.subscriptionState === 'synchronizing' && !this.synchronizationFailed) this.subscriptionState = 'ready'
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  onObservationChange(listener: () => void): () => void {
    this.observationListeners.add(listener)
    return () => { this.observationListeners.delete(listener) }
  }
  private observe(): void {
    for (const listener of this.observationListeners) { try { listener() } catch { /* Diagnostics cannot undo a saved catalog. */ } }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    await this.stopListening?.()
    await this.pending.catch(() => undefined)
    this.listeners.clear()
    this.observationListeners.clear()
  }

  private publish(snapshot: Snapshot<Default>): void {
    this.snapshot = snapshot
    this.markSynchronized()
    for (const listener of this.listeners) {
      try { listener() } catch (error) {
        this.logger.warn({
          event: 'model_settings_observer_failed', organizationId: this.organizationId,
          errorType: error instanceof Error ? error.name : typeof error,
        }, 'Model settings observer failed after commit; the saved configuration remains effective')
      }
    }
  }

  private markSynchronized(): void {
    this.observedAt = new Date().toISOString()
    if (this.synchronizationFailed) {
      this.logger.info({ event: 'model_settings_synchronization_recovered', organizationId: this.organizationId },
        'Model configuration synchronized after a failed invalidation')
    }
    this.synchronizationFailed = false
    this.observe()
  }

  private queueReload(): Promise<void> {
    if (this.closed || this.reloadQueued) return this.pending.then(() => undefined)
    this.reloadQueued = true
    const operation = this.pending.catch(() => undefined).then(async () => {
      this.reloadQueued = false
      if (this.closed) return
      const next = await this.state.withCredentialLock(this.authority.credential, async transaction => {
        const saved = await this.state.getCredential(this.authority.credential, transaction)
        if (!saved) throw new Error('model settings not initialized')
        const revision = await this.state.credentialRevision(this.authority.credential, transaction)
        if (saved.secret !== JSON.stringify(this.snapshot.document) || revision !== this.snapshot.revision) {
          return { ...await this.compile(JSON.parse(saved.secret) as Document<Default>), revision }
        }
      })
      if (next && !this.closed) this.publish(next)
      this.markSynchronized()
    })
    this.pending = operation.catch((error: unknown) => {
      this.synchronizationFailed = true
      this.observe()
      // Error messages can contain resolver credentials; log only their type.
      this.logger.warn({
        event: 'model_settings_synchronization_failed', organizationId: this.organizationId,
        errorType: error instanceof Error ? error.name : typeof error,
        retryMs: this.closed ? null : 1_000,
      }, 'Model configuration reload failed; new model calls are blocked until invalidation retry succeeds')
      // Retry only failed invalidations, never poll healthy model configuration.
      if (!this.closed && !this.retry) {
        this.retry = setTimeout(() => { this.retry = undefined; this.queueReload() }, 1_000)
        this.retry.unref?.()
      }
    })
    return operation
  }

  addProvider(input: ClientAddManualProvider, actor: DashboardActor, write: SettingsWriteOptions = {}): Promise<void> {
    return this.mutate(actor, write, document => {
      if (document.catalog.providers.some(provider => provider.id === input.id)) throw new Error('provider already exists')
      if (!input.apiKey.trim()) throw new Error('API key is required')
      document.catalog.providers = [...document.catalog.providers, {
        id: input.id, label: input.label, wire: input.wire, baseUrl: input.baseUrl,
        credentialRef: `${this.authority.prefix}${input.id}`, models: [],
      }]
      document.keys[input.id] = input.apiKey.trim()
    })
  }

  updateProvider(input: ClientUpdateManualProvider, actor: DashboardActor, write: SettingsWriteOptions = {}): Promise<void> {
    return this.mutate(actor, write, document => {
      const provider = this.provider(document, input.providerId)
      if (input.label !== undefined) provider.label = input.label
      if (input.wire !== undefined) provider.wire = input.wire
      if (input.baseUrl !== undefined) provider.baseUrl = input.baseUrl
      if (input.apiKey?.trim()) document.keys[input.providerId] = input.apiKey.trim()
    })
  }

  deleteProvider(input: ClientDeleteManualProvider, actor: DashboardActor, write: SettingsWriteOptions = {}): Promise<void> {
    return this.mutate(actor, write, document => {
      const provider = this.provider(document, input.providerId)
      if (provider.models.some(model => (model.ref ?? `${provider.id}:${model.id}`) === document.catalog.defaultModel)) {
        throw new Error('Choose another default model before deleting its provider')
      }
      document.catalog.providers = document.catalog.providers.filter(provider => provider.id !== input.providerId)
      delete document.keys[input.providerId]
    })
  }

  addModel(input: ClientAddManualModel, actor: DashboardActor, write: SettingsWriteOptions = {}): Promise<void> {
    return this.mutate(actor, write, document => {
      const provider = this.provider(document, input.providerId)
      if (provider.models.some(model => model.id === input.id)) throw new Error('model already exists')
      provider.models = [...provider.models, { id: input.id, label: input.label, contextWindow: input.contextWindow }]
    })
  }

  updateModel(input: ClientUpdateManualModel, actor: DashboardActor, write: SettingsWriteOptions = {}): Promise<void> {
    return this.mutate(actor, write, document => {
      if (input.label === undefined && input.contextWindow === undefined) throw new Error('Model metadata patch is empty')
      const model = this.provider(document, input.providerId).models.find(model => model.id === input.id)
      if (!model) throw new Error('unknown model')
      if (input.label !== undefined) {
        if (input.label.trim()) model.label = input.label.trim()
        else delete model.label
      }
      if (input.contextWindow !== undefined) model.contextWindow = input.contextWindow
    })
  }

  deleteModel(input: ClientDeleteManualModel, actor: DashboardActor, write: SettingsWriteOptions = {}): Promise<void> {
    return this.mutate(actor, write, document => {
      const provider = this.provider(document, input.providerId)
      const model = provider.models.find(model => model.id === input.id)
      if (!model) throw new Error('unknown model')
      if ((model.ref ?? `${provider.id}:${model.id}`) === document.catalog.defaultModel) {
        throw new Error('Choose another default model before deleting this model')
      }
      provider.models = provider.models.filter(model => model.id !== input.id)
    })
  }

  setDefault(input: ClientSetDefaultModel, actor: DashboardActor, write: SettingsWriteOptions = {}): Promise<void> {
    return this.mutate(actor, write, document => { document.catalog.defaultModel = input.model as Default })
  }

  private provider(document: Document<Default>, id: string) {
    const provider = document.catalog.providers.find(provider => provider.id === id)
    if (!provider) throw new Error('unknown provider')
    return provider
  }

  private mutate(actor: DashboardActor, write: SettingsWriteOptions, change: (document: Document<Default>) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error('model settings are closed'))
    if (actor.kind !== 'ingress' || actor.organizationId !== this.organizationId
      || (actor.role !== 'owner' && actor.role !== 'admin')) {
      return Promise.reject(Object.assign(new Error('tenant_forbidden'), { status: 403 }))
    }
    const operation = this.pending.then(async () => {
      const next = await this.state.withCredentialLock(this.authority.credential, async transaction => {
        await this.authority.beforeMutation?.(transaction)
        const saved = await this.state.getCredential(this.authority.credential, transaction)
        if (!saved) throw new Error('model settings not initialized')
        const document = JSON.parse(saved.secret) as Document<Default>
        document.keys = Object.assign(Object.create(null) as Record<string, string>, document.keys)
        change(document)
        const snapshot = await this.compile(document)
        await this.state.setCredential(this.authority.credential, JSON.stringify(snapshot.document), {}, undefined, transaction, write)
        await transaction.query('SELECT pg_notify($1, $2)', [
          this.authority.channel, JSON.stringify({ organizationId: this.organizationId }),
        ])
        return { ...snapshot, revision: await this.state.credentialRevision(this.authority.credential, transaction) }
      })
      this.publish(next)
    })
    this.pending = operation.catch(() => undefined)
    return operation
  }

  private async compile(document: Document<Default>): Promise<Snapshot<Default>> {
    if (document.version !== 1 || !document.keys || typeof document.keys !== 'object' || Array.isArray(document.keys)) throw new Error('invalid model settings version')
    const catalog = this.authority.parseCatalog(document.catalog)
    for (const provider of catalog.providers) {
      const url = new URL(provider.baseUrl)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Provider base URL must be an HTTP(S) URL without credentials, query, or fragment')
      }
      if (!Object.hasOwn(document.keys, provider.id) || typeof document.keys[provider.id] !== 'string' || !document.keys[provider.id]?.trim()) {
        throw new Error('Provider API key is required')
      }
    }
    const normalized = {
      ...catalog, providers: catalog.providers.map(provider => ({ ...provider, credentialRef: `${this.authority.prefix}${provider.id}` })),
    }
    const keys = { ...document.keys }
    const compiled = await this.authority.compileRuntime(normalized, this.factory({
      resolve: async reference => {
        if (!reference.startsWith(this.authority.prefix)) throw new Error('foreign provider credential')
        const id = reference.slice(this.authority.prefix.length)
        if (!Object.hasOwn(keys, id)) throw new Error('unknown provider credential')
        return keys[id]!
      },
    }))
    const runtime = { ...compiled, models: compiled.models.map(model => ({ ...model, source: 'manual' as const })) }
    return { document: { version: 1, catalog: normalized, keys }, runtime }
  }
}
