import { describe, expect, it, vi } from 'vitest'
import { ConfigurationClient, configurationSnapshot, type ConfigurationSnapshot } from './configuration-client.js'

const first = `"${'a'.repeat(43)}"`, second = `"${'b'.repeat(43)}"`
const snapshot = (revision = '1', organizationId?: string) => ({
  resource: { kind: 'agent', id: 'runtime', ...(organizationId ? { organizationId } : {}) },
  revision, capabilities: [], value: { agentSettingsResourceId: 'agent-fixture', desktopAccess: { manualAuthorizationRequired: false } },
  application: { state: 'unknown', desiredRevision: revision, effectiveRevision: null, applyMode: 'next-turn', scope: 'device' },
})
const json = (body: unknown, status = 200, etag?: string): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) } })

describe('revision-aware configuration client', () => {
  it('uses the displayed revision, couples readback value to the next ETag and shares Agent/execution identity', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json(snapshot('2'), 200, second)).mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json(snapshot('3'), 200, first))
    const observed: ConfigurationSnapshot[] = []
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'agent', readPath: '/settings/sections/execution',
      fetch, onSnapshot: value => observed.push(value) })
    client.seed(first)
    const response = await client.request('/settings/desktop-access', { method: 'POST', body: '{"manualAuthorizationRequired":true}' })
    expect(await response.json()).toEqual(snapshot('2').value)
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get('if-match')).toBe(first)
    expect(observed[0]?.configuration?.revision).toBe('2')
    await client.request('/settings/agent-prompt', { method: 'POST', body: '{}' })
    expect(new Headers(fetch.mock.calls[2]?.[1].headers).get('if-match')).toBe(second)
    expect(fetch.mock.calls.map(call => call[1].method ?? 'GET')).toEqual(['POST', 'GET', 'POST', 'GET'])
  })

  it('does not refresh or replay a conflict; retains the original draft precondition', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: 'configuration_conflict' }, 412))
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'models', readPath: '/settings/sections/models', fetch })
    client.seed(first)
    expect((await client.request('/settings/providers', { method: 'PATCH', body: '{"apiKey":"fixture-only"}' })).status).toBe(412)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(client.etag).toBe(first)
    expect(client.outcome).toBe('conflict')
  })

  it('does not dispatch another mutation while the same resource transaction is in flight', async () => {
    let release: (response: Response) => void = () => {}
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
      .mockResolvedValueOnce(json(snapshot('2'), 200, second))
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'agent', readPath: '/settings/sections/agent', fetch })
    client.seed(first, '1')
    const pending = client.request('/settings/agent-prompt', { method: 'POST', body: '{}' })
    await expect(client.request('/settings/desktop-access', { method: 'POST', body: '{}' })).rejects.toThrow('configuration_write_in_progress')
    expect(fetch).toHaveBeenCalledTimes(1)
    release(json({}))
    await pending
    expect(client.etag).toBe(second)
    expect(client.outcome).toBe('idle')
  })

  it('does not rebase remaining drafts onto an intervening write after its own successful commit', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(snapshot('3'), 200, second))
    const observed: ConfigurationSnapshot[] = []
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'agent', readPath: '/settings/sections/agent',
      fetch, onSnapshot: value => observed.push(value) })
    client.seed(first, '1')
    expect((await client.request('/settings/agent-prompt', { method: 'POST', body: '{}' })).status).toBe(200)
    expect(observed[0]?.configuration?.revision).toBe('3')
    expect(observed[0]?.etag).toBeUndefined()
    expect(client.outcome).toBe('conflict')
    await expect(client.request('/settings/agent-prompt', { method: 'POST', body: '{}' })).rejects.toThrow('configuration_refresh_required')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fences unknown outcomes instead of replaying or reusing a potentially committed revision', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('lost response'))
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'speech', readPath: '/settings/speech', fetch })
    client.seed(first)
    await expect(client.request('/settings/speech', { method: 'PUT', body: '{}' })).rejects.toThrow('configuration_outcome_unknown')
    expect(client.outcome).toBe('outcome-unknown')
    expect(client.etag).toBeUndefined()
    await expect(client.request('/settings/speech', { method: 'PUT', body: '{}' })).rejects.toThrow('configuration_refresh_required')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('treats a truncated successful response as outcome unknown instead of guessing from the HTTP status', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"')); controller.error(new Error('truncated body')) },
    })
    const fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'agent', readPath: '/settings/sections/agent', fetch })
    client.seed(first, '1')
    await expect(client.request('/settings/agent-prompt', { method: 'POST', body: '{}' })).rejects.toThrow('configuration_outcome_unknown')
    expect(client.outcome).toBe('outcome-unknown')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful commit successful when readback fails, but blocks another write', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ configured: true })).mockRejectedValueOnce(new Error('readback unavailable'))
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'search', readPath: '/settings/web-search', fetch })
    client.seed(first)
    expect(await (await client.request('/settings/web-search', { method: 'PUT', body: '{}' })).json()).toEqual({ configured: true })
    expect(client.outcome).toBe('saved-pending')
    expect(client.etag).toBeUndefined()
  })

  it('learns integration revisions from existing status DTOs without sending If-Match to connection tests', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ configured: false }, 200, first))
      .mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json({ configured: true }))
      .mockResolvedValueOnce(json({ configured: true }, 200, second))
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'search', readPath: '/settings/web-search',
      authorization: 'Bearer fixture-only', fetch })
    await client.request('/settings/web-search')
    await client.request('/settings/web-search/test', { method: 'POST' })
    expect(new Headers(fetch.mock.calls[1]?.[1].headers).has('if-match')).toBe(false)
    await client.request('/settings/web-search', { method: 'PUT', body: '{}' })
    expect(new Headers(fetch.mock.calls[2]?.[1].headers).get('if-match')).toBe(first)
    expect(new Headers(fetch.mock.calls[2]?.[1].headers).get('authorization')).toBe('Bearer fixture-only')
    expect(client.etag).toBe(second)
  })

  it('rejects cross-target, normalized escape and unrelated resource requests before forwarding credentials', async () => {
    const fetch = vi.fn()
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'agent', readPath: '/settings/sections/agent',
      authorization: 'Bearer fixture-only', fetch })
    client.seed(first)
    await expect(client.request('https://elsewhere.test/settings/agent-prompt', { method: 'POST' })).rejects.toThrow()
    await expect(client.request('/settings/../auth/login')).rejects.toThrow('configuration_target_mismatch')
    await expect(client.request('/settings/../organization/retention')).rejects.toThrow('configuration_target_mismatch')
    await expect(client.request('/settings/speech', { method: 'PUT' })).rejects.toThrow('configuration_resource_mismatch')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses a bounded request signal and fences a submitted mutation when its caller cancels without proving rejection', async () => {
    const timeout = new AbortController()
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const request = vi.fn((_path: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request deadline')), { once: true })
    }))
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'agent', readPath: '/settings/sections/agent', fetch: request })
    client.seed(first, '1')
    const pending = client.request('/settings/agent-prompt', { method: 'POST', body: '{}' })
    timeout.abort()
    await expect(pending).rejects.toThrow('configuration_outcome_unknown')
    expect(deadline).toHaveBeenCalledWith(30_000)
    expect(client.etag).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
    deadline.mockRestore()
  })

  it('keeps legacy projections readable but does not invent a revision or permit unconditional writes', async () => {
    expect(configurationSnapshot({ providers: [] }, first, 'models')).toEqual({ value: { providers: [] } })
    expect(configurationSnapshot(snapshot(), `W/${first}`, 'agent').etag).toBeUndefined()
    expect(() => configurationSnapshot(snapshot('1', 'another-org'), first, 'agent', 'expected-org')).toThrow('configuration_identity_mismatch')
    expect(() => configurationSnapshot(snapshot(), first, 'models')).toThrow('configuration_identity_mismatch')
    const fetch = vi.fn()
    const client = new ConfigurationClient({ origin: 'https://kala.test', kind: 'models', readPath: '/settings/sections/models', fetch })
    await expect(client.request('/settings/models', { method: 'POST' })).rejects.toThrow('configuration_refresh_required')
    expect(fetch).not.toHaveBeenCalled()
  })
})
