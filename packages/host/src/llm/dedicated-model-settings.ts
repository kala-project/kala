import type {
  ClientAddManualModel, ClientAddManualProvider, ClientDeleteManualModel,
  ClientDeleteManualProvider, ClientSetDefaultModel, ClientUpdateManualProvider, ClientUpdateManualModel,
} from '@agent-kernel/shared'
import type { DashboardActor } from '../auth-control.js'
import type { PostgresTenantStateStore } from '../tenant-runtime/postgres-state.js'
import { createRuntimeLogger, type RuntimeLogger } from '../logger.js'
import { ExplicitLLMClientFactory, type LLMClientFactory, type SecretResolver } from './client-factory.js'
import {
  createRuntimeProviderRuntime, parseRuntimeProviderCatalog,
  type RuntimeProviderCatalog, type RuntimeProviderRuntime,
} from './runtime-provider-catalog.js'

export const DEDICATED_MODEL_SETTINGS_CREDENTIAL = 'dedicated-model-settings:v1'
export const DEDICATED_MODEL_SETTINGS_CHANNEL = 'kala_dedicated_model_settings'
type Document = { version: 1; catalog: RuntimeProviderCatalog; keys: Record<string, string> }
type Snapshot = { document: Document; runtime: RuntimeProviderRuntime }

/**
 * The catalog and write-only keys share one tenant-encrypted transaction.
 * Post-commit invalidation refreshes replicas; adapters retain immutable snapshots.
 */
export class DedicatedModelSettings {
  private snapshot!: Snapshot
  private pending: Promise<unknown> = Promise.resolve()
  private stopListening?: () => Promise<void>
  private retry?: ReturnType<typeof setTimeout>
  private reloadQueued = false
  private closed = false
  private synchronizationFailed = false
  private readonly listeners = new Set<() => void>()
  readonly llm = {
    name: 'dedicated-live-models',
    call: (params: Parameters<RuntimeProviderRuntime['llm']['call']>[0]) => {
      if (this.closed || this.synchronizationFailed) return Promise.reject(new Error('Model configuration synchronization is unavailable'))
      const { runtime } = this.snapshot
      return runtime.llm.call({ ...params, model: params.model ?? runtime.defaultModel })
    },
  }

  constructor(
    private readonly state: PostgresTenantStateStore,
    private readonly organizationId: string,
    private readonly seed: RuntimeProviderCatalog,
    private readonly seedSecrets: SecretResolver,
    private readonly factory: (resolver: SecretResolver) => LLMClientFactory = resolver => new ExplicitLLMClientFactory(resolver),
    private readonly logger: Pick<RuntimeLogger, 'warn' | 'info'> = createRuntimeLogger('dedicated-model-settings'),
  ) {}

  get models() { return this.snapshot.runtime.models }
  get defaultModel() { return this.snapshot.runtime.defaultModel }
  get providers() {
    return this.snapshot.document.catalog.providers.map(provider => ({
      id: provider.id, label: provider.label ?? provider.id, wire: provider.wire,
      baseUrl: provider.baseUrl, source: 'manual' as const,
      models: this.models.filter(model => model.providerId === provider.id),
    }))
  }

  async load(): Promise<void> {
    this.snapshot = await this.state.withCredentialLock(DEDICATED_MODEL_SETTINGS_CREDENTIAL, async transaction => {
      const saved = await this.state.getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL, transaction)
      if (saved) return this.compile(JSON.parse(saved.secret) as Document)
      const keys: Record<string, string> = Object.create(null) as Record<string, string>
      for (const provider of this.seed.providers) keys[provider.id] = await this.seedSecrets.resolve(provider.credentialRef)
      const snapshot = await this.compile({ version: 1, catalog: structuredClone(this.seed), keys })
      await this.state.setCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL, JSON.stringify(snapshot.document), {}, undefined, transaction)
      return snapshot
    })
    if (!this.state.database.listen) throw new Error('Dedicated model settings require PostgreSQL notification support')
    this.stopListening = await this.state.database.listen(DEDICATED_MODEL_SETTINGS_CHANNEL, payload => {
      if (payload !== undefined) {
        try {
          if ((JSON.parse(payload) as { organizationId?: unknown }).organizationId !== this.organizationId) return
        } catch { return }
      }
      this.queueReload()
    })
    await this.pending
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    await this.stopListening?.()
    await this.pending.catch(() => undefined)
    this.listeners.clear()
  }

  private publish(snapshot: Snapshot): void {
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
    if (this.synchronizationFailed) {
      this.logger.info({ event: 'model_settings_synchronization_recovered', organizationId: this.organizationId },
        'Model configuration synchronized after a failed invalidation')
    }
    this.synchronizationFailed = false
  }

  private queueReload(): void {
    if (this.closed || this.reloadQueued) return
    this.reloadQueued = true
    const operation = this.pending.catch(() => undefined).then(async () => {
      this.reloadQueued = false
      if (this.closed) return
      const saved = await this.state.getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL)
      if (!saved) throw new Error('model settings not initialized')
      if (saved.secret !== JSON.stringify(this.snapshot.document)) {
        const next = await this.compile(JSON.parse(saved.secret) as Document)
        if (!this.closed) this.publish(next)
      }
      this.markSynchronized()
    })
    this.pending = operation.catch((error: unknown) => {
      this.synchronizationFailed = true
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
  }

  addProvider(input: ClientAddManualProvider, actor: DashboardActor): Promise<void> {
    return this.mutate(actor, document => {
      if (document.catalog.providers.some(provider => provider.id === input.id)) throw new Error('provider already exists')
      if (!input.apiKey.trim()) throw new Error('API key is required')
      document.catalog.providers = [...document.catalog.providers, {
        id: input.id, label: input.label, wire: input.wire, baseUrl: input.baseUrl,
        credentialRef: `dedicated:${input.id}`, models: [],
      }]
      document.keys[input.id] = input.apiKey.trim()
    })
  }

  updateProvider(input: ClientUpdateManualProvider, actor: DashboardActor): Promise<void> {
    return this.mutate(actor, document => {
      const provider = this.provider(document, input.providerId)
      if (input.label !== undefined) provider.label = input.label
      if (input.wire !== undefined) provider.wire = input.wire
      if (input.baseUrl !== undefined) provider.baseUrl = input.baseUrl
      if (input.apiKey?.trim()) document.keys[input.providerId] = input.apiKey.trim()
    })
  }

  deleteProvider(input: ClientDeleteManualProvider, actor: DashboardActor): Promise<void> {
    return this.mutate(actor, document => {
      const provider = this.provider(document, input.providerId)
      if (provider.models.some(model => (model.ref ?? `${provider.id}:${model.id}`) === document.catalog.defaultModel)) {
        throw new Error('Choose another default model before deleting its provider')
      }
      document.catalog.providers = document.catalog.providers.filter(provider => provider.id !== input.providerId)
      delete document.keys[input.providerId]
    })
  }

  addModel(input: ClientAddManualModel, actor: DashboardActor): Promise<void> {
    return this.mutate(actor, document => {
      const provider = this.provider(document, input.providerId)
      if (provider.models.some(model => model.id === input.id)) throw new Error('model already exists')
      provider.models = [...provider.models, { id: input.id, label: input.label, contextWindow: input.contextWindow }]
    })
  }

  updateModel(input: ClientUpdateManualModel, actor: DashboardActor): Promise<void> {
    return this.mutate(actor, document => {
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

  deleteModel(input: ClientDeleteManualModel, actor: DashboardActor): Promise<void> {
    return this.mutate(actor, document => {
      const provider = this.provider(document, input.providerId)
      const model = provider.models.find(model => model.id === input.id)
      if (!model) throw new Error('unknown model')
      if ((model.ref ?? `${provider.id}:${model.id}`) === document.catalog.defaultModel) {
        throw new Error('Choose another default model before deleting this model')
      }
      provider.models = provider.models.filter(model => model.id !== input.id)
    })
  }

  setDefault(input: ClientSetDefaultModel, actor: DashboardActor): Promise<void> {
    return this.mutate(actor, document => { document.catalog.defaultModel = input.model })
  }

  private provider(document: Document, id: string) {
    const provider = document.catalog.providers.find(provider => provider.id === id)
    if (!provider) throw new Error('unknown provider')
    return provider
  }

  private mutate(actor: DashboardActor, change: (document: Document) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error('model settings are closed'))
    if (actor.kind !== 'ingress' || actor.organizationId !== this.organizationId
      || (actor.role !== 'owner' && actor.role !== 'admin')) {
      return Promise.reject(Object.assign(new Error('tenant_forbidden'), { status: 403 }))
    }
    const operation = this.pending.then(async () => {
      const next = await this.state.withCredentialLock(DEDICATED_MODEL_SETTINGS_CREDENTIAL, async transaction => {
        const saved = await this.state.getCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL, transaction)
        if (!saved) throw new Error('model settings not initialized')
        const document = JSON.parse(saved.secret) as Document
        document.keys = Object.assign(Object.create(null) as Record<string, string>, document.keys)
        change(document)
        const snapshot = await this.compile(document)
        await this.state.setCredential(DEDICATED_MODEL_SETTINGS_CREDENTIAL, JSON.stringify(snapshot.document), {}, undefined, transaction)
        await transaction.query('SELECT pg_notify($1, $2)', [
          DEDICATED_MODEL_SETTINGS_CHANNEL, JSON.stringify({ organizationId: this.organizationId }),
        ])
        return snapshot
      })
      this.publish(next)
    })
    this.pending = operation.catch(() => undefined)
    return operation
  }

  private async compile(document: Document): Promise<Snapshot> {
    if (document.version !== 1 || !document.keys || typeof document.keys !== 'object') throw new Error('invalid model settings version')
    const catalog = parseRuntimeProviderCatalog(document.catalog, { allowEmptyProviders: true })
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
      ...catalog, providers: catalog.providers.map(provider => ({ ...provider, credentialRef: `dedicated:${provider.id}` })),
    }
    const keys = { ...document.keys }
    const compiled = await createRuntimeProviderRuntime(normalized, this.factory({
      resolve: async reference => {
        const id = reference.slice('dedicated:'.length)
        if (!Object.hasOwn(keys, id)) throw new Error('unknown provider credential')
        return keys[id]!
      },
    }))
    const runtime = { ...compiled, models: compiled.models.map(model => ({ ...model, source: 'manual' as const })) }
    return { document: { version: 1, catalog: normalized, keys }, runtime }
  }
}
