import { readFile } from 'node:fs/promises'

import type { ModelInfo } from '@agent-kernel/shared'

import type { LLMAdapter } from './adapter.js'
import type { LLMClientFactory, LLMProviderConfig, SecretResolver } from './client-factory.js'
import { routerAdapter } from './router.js'

export type RuntimeProviderCatalog = {
  version: 1
  defaultModel: string
  providers: readonly RuntimeProviderCatalogEntry[]
}

export type RuntimeProviderCatalogEntry = {
  id: string
  label?: string
  wire: 'openai' | 'anthropic'
  baseUrl: string
  credentialRef: string
  models: readonly RuntimeProviderModel[]
}

export type RuntimeProviderModel = {
  id: string
  ref?: string
  label?: string
  contextWindow?: number
}

export type RuntimeProviderRuntime = {
  llm: LLMAdapter
  models: readonly ModelInfo[]
  defaultModel: string
}

export type OrganizationProviderCatalog = Omit<RuntimeProviderCatalog, 'defaultModel'> & { defaultModel: string | null }
export type OrganizationProviderRuntime = Omit<RuntimeProviderRuntime, 'defaultModel'> & { defaultModel: string | null }

export async function loadRuntimeProviderCatalog(path: string): Promise<RuntimeProviderCatalog> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  return parseRuntimeProviderCatalog(parsed)
}

export function parseRuntimeProviderCatalog(value: unknown, options: { allowEmptyProviders?: boolean } = {}): RuntimeProviderCatalog {
  const parsed = parseCatalog(value, options)
  if (parsed.defaultModel === null) throw new Error('Runtime Provider Catalog defaultModel is required')
  return { ...parsed, defaultModel: parsed.defaultModel }
}

export function parseOrganizationProviderCatalog(value: unknown): OrganizationProviderCatalog {
  return parseCatalog(value, { allowEmptyProviders: true, organizationOwned: true })
}

function parseCatalog(value: unknown, options: { allowEmptyProviders?: boolean; organizationOwned?: boolean }): OrganizationProviderCatalog {
  if (!value || typeof value !== 'object') throw new Error('Runtime Provider Catalog must be an object')
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('Runtime Provider Catalog version must be 1')
  const defaultModel = input.defaultModel === null && options.organizationOwned ? null : requiredString(input.defaultModel, 'defaultModel')
  if (!Array.isArray(input.providers) || !options.organizationOwned && input.providers.length === 0) throw new Error('Runtime Provider Catalog providers must not be empty')
  const providers = input.providers.map((raw, index) => parseProvider(raw, index, options.allowEmptyProviders))
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('Runtime Provider Catalog provider ids must be unique')
  const refs = providers.flatMap((provider) => provider.models.map((model) => model.ref ?? `${provider.id}:${model.id}`))
  if (new Set(refs).size !== refs.length) throw new Error('Runtime Provider Catalog model refs must be unique')
  if (defaultModel !== null && !refs.includes(defaultModel)) throw new Error(`Runtime Provider Catalog defaultModel is unknown: ${defaultModel}`)
  return { version: 1, defaultModel, providers }
}

export async function createRuntimeProviderRuntime(
  catalog: RuntimeProviderCatalog,
  factory: LLMClientFactory,
): Promise<RuntimeProviderRuntime> {
  const { routes, models } = await createProviderRoutes(catalog, factory)
  const defaultRoute = routes.find((route) => route.prefix === catalog.defaultModel)
  if (!defaultRoute) throw new Error('Runtime Provider Catalog defaultModel is unknown')
  return {
    llm: routerAdapter({ defaultAdapter: defaultRoute.adapter, byPrefix: routes }),
    models,
    defaultModel: catalog.defaultModel,
  }
}

export async function createOrganizationProviderRuntime(
  catalog: OrganizationProviderCatalog, factory: LLMClientFactory,
): Promise<OrganizationProviderRuntime> {
  const { routes, models } = await createProviderRoutes(catalog, factory)
  const byModel = new Map(routes.map(route => [route.prefix, route]))
  if (catalog.defaultModel !== null && !byModel.has(catalog.defaultModel)) throw new Error('organization_model_default_unknown')
  return {
    defaultModel: catalog.defaultModel, models,
    llm: {
      name: 'organization-models',
      call: params => {
        const selected = params.model ?? catalog.defaultModel
        if (selected === null) return Promise.reject(new Error('model_not_configured'))
        const route = byModel.get(selected)
        if (!route) return Promise.reject(new Error('organization_model_unknown'))
        return route.adapter.call({ ...params, model: route.routedModel })
      },
    },
  }
}

async function createProviderRoutes(catalog: OrganizationProviderCatalog, factory: LLMClientFactory): Promise<{
  routes: Array<{ prefix: string; adapter: LLMAdapter; routedModel: string }>; models: ModelInfo[]
}> {
  const routes: Array<{ prefix: string; adapter: LLMAdapter; routedModel: string }> = []
  const models: ModelInfo[] = []
  for (const provider of catalog.providers) {
    if (provider.models.length === 0) continue
    // One adapter per Provider is enough: adapters accept a per-call model id.
    const seed = provider.models[0]!
    const config: LLMProviderConfig = {
      id: provider.id,
      wire: provider.wire,
      model: seed.id,
      baseUrl: provider.baseUrl,
      credentialRef: provider.credentialRef,
    }
    const adapter = await factory.create(config)
    for (const model of provider.models) {
      const ref = model.ref ?? `${provider.id}:${model.id}`
      routes.push({ prefix: ref, adapter, routedModel: model.id })
      models.push({
        id: model.id,
        ref,
        label: model.label ?? model.id,
        providerId: provider.id,
        provider: provider.label ?? provider.id,
        ...(model.contextWindow ? { contextWindow: model.contextWindow, limits: { context: model.contextWindow } } : {}),
      })
    }
  }
  return { routes, models }
}

export class FileSecretResolver implements SecretResolver {
  constructor(private readonly root: string) {}
  async resolve(reference: string): Promise<string> {
    if (!reference.startsWith('file:')) throw new Error(`unsupported Runtime Provider credential reference: ${reference}`)
    const name = reference.slice(5)
    if (!/^[a-zA-Z0-9_.-]+$/u.test(name)) throw new Error('invalid Runtime Provider credential reference')
    const value = (await readFile(`${this.root.replace(/\/$/u, '')}/${name}`, 'utf8')).trim()
    if (!value) throw new Error(`Runtime Provider credential is empty: ${name}`)
    return value
  }
}

function parseProvider(value: unknown, index: number, allowEmpty = false): RuntimeProviderCatalogEntry {
  if (!value || typeof value !== 'object') throw new Error(`providers[${index}] must be an object`)
  const input = value as Record<string, unknown>
  const id = requiredString(input.id, `providers[${index}].id`)
  const wire = input.wire
  if (wire !== 'openai' && wire !== 'anthropic') throw new Error(`providers[${index}].wire must be openai or anthropic`)
  if (!Array.isArray(input.models) || (!allowEmpty && input.models.length === 0)) throw new Error(`providers[${index}].models must not be empty`)
  return {
    id,
    wire,
    baseUrl: requiredString(input.baseUrl, `providers[${index}].baseUrl`),
    credentialRef: requiredString(input.credentialRef, `providers[${index}].credentialRef`),
    ...(typeof input.label === 'string' && input.label.trim() ? { label: input.label.trim() } : {}),
    models: input.models.map((raw, modelIndex) => parseModel(raw, index, modelIndex)),
  }
}

function parseModel(value: unknown, providerIndex: number, modelIndex: number): RuntimeProviderModel {
  if (!value || typeof value !== 'object') throw new Error(`providers[${providerIndex}].models[${modelIndex}] must be an object`)
  const input = value as Record<string, unknown>
  const contextWindow = input.contextWindow
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || Number(contextWindow) <= 0)) throw new Error('model contextWindow must be a positive integer')
  return {
    id: requiredString(input.id, `providers[${providerIndex}].models[${modelIndex}].id`),
    ...(typeof input.ref === 'string' && input.ref.trim() ? { ref: input.ref.trim() } : {}),
    ...(typeof input.label === 'string' && input.label.trim() ? { label: input.label.trim() } : {}),
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Runtime Provider Catalog ${field} is required`)
  return value.trim()
}
