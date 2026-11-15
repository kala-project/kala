import { describe, expect, it, vi } from 'vitest'

import type { LLMAdapter } from './adapter.js'
import { createOrganizationProviderRuntime, createRuntimeProviderRuntime, parseOrganizationProviderCatalog, parseRuntimeProviderCatalog } from './runtime-provider-catalog.js'

describe('Runtime Provider Catalog', () => {
  const catalog = {
    version: 1 as const,
    defaultModel: 'box-openai:gpt-main',
    providers: [
      { id: 'box-openai', wire: 'openai' as const, baseUrl: 'http://box/v1', credentialRef: 'file:key', models: [{ id: 'gpt-main' }] },
      { id: 'box-anthropic', wire: 'anthropic' as const, baseUrl: 'http://box', credentialRef: 'file:key', models: [{ id: 'claude-main' }] },
    ],
  }

  it('validates unique refs and an existing default', () => {
    expect(parseRuntimeProviderCatalog(catalog)).toEqual(catalog)
    expect(() => parseRuntimeProviderCatalog({ ...catalog, defaultModel: 'missing' })).toThrow(/defaultModel is unknown/)
  })

  it('creates one adapter per provider and routes model refs to provider model ids', async () => {
    const calls: Array<{ adapter: string; model?: string }> = []
    const create = vi.fn(async (config: { id: string }) => ({
      name: config.id,
      call: async (params: { model?: string }) => {
        calls.push({ adapter: config.id, ...(params.model ? { model: params.model } : {}) })
        return { message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] } }
      },
    }) satisfies LLMAdapter)
    const runtime = await createRuntimeProviderRuntime(catalog, { create })
    expect(create).toHaveBeenCalledTimes(2)
    expect(runtime.models.map((model) => model.ref)).toEqual(['box-openai:gpt-main', 'box-anthropic:claude-main'])
    await runtime.llm.call({ messages: [], tools: [], signal: new AbortController().signal, model: 'box-anthropic:claude-main' })
    expect(calls).toEqual([{ adapter: 'box-anthropic', model: 'claude-main' }])
  })

  it('represents an unconfigured organization with null and never constructs a seeded/default adapter', async () => {
    const empty = { version: 1, defaultModel: null, providers: [] }
    expect(parseOrganizationProviderCatalog(empty)).toEqual(empty)
    expect(() => parseRuntimeProviderCatalog(empty)).toThrow()
    const create = vi.fn()
    const runtime = await createOrganizationProviderRuntime(parseOrganizationProviderCatalog(empty), { create })
    expect(runtime.defaultModel).toBeNull()
    expect(runtime.models).toEqual([])
    expect(create).not.toHaveBeenCalled()
    await expect(runtime.llm.call({ messages: [], tools: [] })).rejects.toThrow('model_not_configured')
    await expect(runtime.llm.call({ messages: [], tools: [], model: 'shared:model' })).rejects.toThrow('organization_model_unknown')
  })

  it('routes organization references exactly without shared/default fallback or accidental prefix matching', async () => {
    const call = vi.fn(async () => ({ message: { role: 'assistant' as const, content: [] } }))
    const create = vi.fn(async () => ({ name: 'fixture', call }))
    const unconfigured = parseOrganizationProviderCatalog({ ...catalog, defaultModel: null })
    const runtime = await createOrganizationProviderRuntime(unconfigured, { create })
    await expect(runtime.llm.call({ messages: [], tools: [] })).rejects.toThrow('model_not_configured')
    await expect(runtime.llm.call({ messages: [], tools: [], model: 'box-openai:gpt-main-suffix' })).rejects.toThrow('organization_model_unknown')
    expect(call).not.toHaveBeenCalled()
    await runtime.llm.call({ messages: [], tools: [], model: 'box-openai:gpt-main' })
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-main' }))
    expect(() => parseOrganizationProviderCatalog({ ...catalog, defaultModel: 'absent' })).toThrow(/defaultModel is unknown/)
  })
})
