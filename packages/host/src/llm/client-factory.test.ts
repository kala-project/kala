import { describe, expect, it, vi } from 'vitest'
import { EnvironmentSecretResolver, ExplicitLLMClientFactory } from './client-factory.js'

describe('ExplicitLLMClientFactory', () => {
  it('resolves credentials explicitly and creates provider adapters', async () => {
    const resolve = vi.fn().mockResolvedValue('secret')
    const factory = new ExplicitLLMClientFactory({ resolve })
    const adapter = await factory.create({ id: 'p', wire: 'openai', model: 'm', baseUrl: 'http://provider/v1', credentialRef: 'ref' })
    expect(resolve).toHaveBeenCalledWith('ref', undefined)
    expect(adapter.name).toBe('openai:m')
  })
})

describe('EnvironmentSecretResolver', () => {
  it('reads only the requested composition-root reference', async () => {
    const resolver = new EnvironmentSecretResolver({ LLM_KEY: 'value' })
    await expect(resolver.resolve('env:LLM_KEY')).resolves.toBe('value')
    await expect(resolver.resolve('env:MISSING')).rejects.toThrow('required secret environment variable')
  })
})
