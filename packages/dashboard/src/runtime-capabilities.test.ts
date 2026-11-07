import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadRuntimeDeployment, useRuntimeDeployment } from './runtime-capabilities.js'

const authoritativePayload = {
  product: 'private-cloud',
  deployment: { schemaVersion: 1, architecture: 'platform', tenancy: 'multi-tenant', runtimeProfile: 'agent' },
  capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
}

describe('loadRuntimeDeployment', () => {
  it('accepts a valid authoritative payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      product: 'private-cloud',
      deployment: { schemaVersion: 1, architecture: 'platform', tenancy: 'multi-tenant', runtimeProfile: 'agent' },
      capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
      integrations: { evaluation: { url: 'https://evaluation.example.test/' } },
    }), { status: 200 }))
    await expect(loadRuntimeDeployment('http://host', undefined, fetcher)).resolves.toEqual({
      product: 'private-cloud', deployment: { schemaVersion: 1, architecture: 'platform', tenancy: 'multi-tenant', runtimeProfile: 'agent' }, loaded: true,
      capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
      evaluationUrl: 'https://evaluation.example.test',
    })

  })

  it.each([
    ['network failure', vi.fn().mockRejectedValue(new Error('offline')), 'offline'],
    ['HTTP failure', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })), 'Runtime capabilities request failed (503)'],
    ['malformed body', vi.fn().mockResolvedValue(new Response(JSON.stringify({ product: 'dedicated', capabilities: { agent: true } }), { status: 200 })), undefined],
  ])('fails closed on %s instead of inferring Dedicated', async (_label, fetcher, error) => {
    const result = await loadRuntimeDeployment('http://host', undefined, fetcher)
    expect(result).toEqual({
      product: null, deployment: null,
      loaded: true,
      capabilities: { agent: true, workspace: true, operations: false, artifacts: false, pipeline: false },
      ...(error ? { error } : {}),
    })
  })

  it('classifies an unauthenticated Platform response before protected clients start', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(loadRuntimeDeployment('http://host', undefined, fetcher)).resolves.toEqual({
      product: 'private-cloud', deployment: null, loaded: true, unauthorized: true,
      capabilities: { agent: true, workspace: true, operations: false, artifacts: false, pipeline: false },
    })
  })

  describe('useRuntimeDeployment', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('recovers automatically when the Runtime briefly returns 503', async () => {
      vi.useFakeTimers()
      const fetcher = vi.fn()
        .mockResolvedValueOnce(new Response('{}', { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(authoritativePayload), { status: 200 }))
      vi.stubGlobal('fetch', fetcher)
      const { result } = renderHook(() => useRuntimeDeployment())
      await act(async () => { await Promise.resolve() })
      expect(result.current.error).toBe('Runtime capabilities request failed (503)')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(result.current.product).toBe('private-cloud')
      expect(result.current.error).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('does not retry a real authentication failure', async () => {
      vi.useFakeTimers()
      const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
      vi.stubGlobal('fetch', fetcher)
      const { result } = renderHook(() => useRuntimeDeployment())
      await act(async () => { await Promise.resolve() })
      expect(result.current.unauthorized).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(35_000) })
      expect(fetcher).toHaveBeenCalledTimes(1)
    })
  })
})
