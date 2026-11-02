import type { LLMAdapter } from './adapter.js'
import { anthropicAdapter } from './anthropic.js'
import { openaiAdapter } from './openai.js'
import type { SecretResolver } from '@agent-kernel/shared/secret-resolver'
export type { SecretResolver } from '@agent-kernel/shared/secret-resolver'

export type LLMProviderConfig = {
  id: string
  wire: 'openai' | 'anthropic'
  model: string
  baseUrl: string
  credentialRef: string
}
export interface LLMClientFactory { create(config: LLMProviderConfig): Promise<LLMAdapter> }

export class ExplicitLLMClientFactory implements LLMClientFactory {
  constructor(private readonly secrets: SecretResolver) {}
  async create(config: LLMProviderConfig): Promise<LLMAdapter> {
    const make = (apiKey: string) => config.wire === 'anthropic'
      ? anthropicAdapter({ apiKey, model: config.model, apiUrl: `${config.baseUrl.replace(/\/$/u, '')}/v1/messages` })
      : openaiAdapter({ apiKey, model: config.model, baseUrl: config.baseUrl })
    const resolve = async (signal?: AbortSignal) => {
      const value = await this.secrets.resolve(config.credentialRef, signal)
      if (!value) throw new Error('LLM credential could not be resolved')
      signal?.throwIfAborted()
      return value
    }
    // Validate startup readiness, but never retain the resolved credential in the adapter.
    const name = make(await resolve()).name
    return { name, call: async (params) => make(await resolve(params.signal)).call(params) }
  }
}

export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  async resolve(reference: string): Promise<string> {
    const name = reference.startsWith('env:') ? reference.slice(4) : reference
    const value = this.environment[name]?.trim()
    if (!value) throw new Error(`required secret environment variable is missing: ${name}`)
    return value
  }
}
