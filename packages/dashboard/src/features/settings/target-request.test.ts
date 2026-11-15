import { describe, expect, it, vi } from 'vitest'
import { resolveSettingsTargetRequest } from './target-request.js'
import type { SettingsRequest } from './configuration-client.js'

describe('immutable Settings target requests', () => {
  it('permits explicit storage credential reads only for the captured same-origin Dedicated Owner target', async () => {
    const fetch = vi.fn<SettingsRequest>(async () => Response.json({}))
    const input = { browserOrigin: 'https://kala.test', host: 'https://kala.test',
      cacheNamespace: 'fixture', organizationId: 'org_fixture', organizationRole: 'owner', fetch }
    const owner = resolveSettingsTargetRequest({ ...input, product: 'dedicated' })!
    await owner.request('/auth/silo/credentials', { method: 'POST' })
    expect(fetch).toHaveBeenCalledWith('/auth/silo/credentials', expect.objectContaining({ method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error' }))
    for (const product of ['portable', 'private-cloud'] as const) {
      await expect(resolveSettingsTargetRequest({ ...input, product })!.request('/auth/silo/credentials', { method: 'POST' })).rejects.toThrow('settings_target_mismatch')
    }
    for (const organizationRole of ['admin', 'member', 'viewer']) {
      await expect(resolveSettingsTargetRequest({ ...input, product: 'dedicated', organizationRole })!.request('/auth/silo/credentials', { method: 'POST' })).rejects.toThrow('settings_target_mismatch')
    }
    await expect(owner.request('/auth/silo/credentials')).rejects.toThrow('settings_target_mismatch')
    await expect(owner.request('/auth/silo/credentials?password=other', { method: 'POST' })).rejects.toThrow('settings_target_mismatch')
    await expect(owner.request('https://other.test/auth/silo/credentials', { method: 'POST' })).rejects.toThrow('settings_target_mismatch')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('keeps lifecycle, enrollment rotation and Push device operations on the same captured Portable authority', async () => {
    const fetch = vi.fn<SettingsRequest>(async () => Response.json({}))
    const target = resolveSettingsTargetRequest({ product: 'portable', browserOrigin: 'https://dashboard.test',
      host: 'https://portable.test', token: 'fictional-profile', cacheNamespace: 'a', fetch })!
    for (const path of ['/models', '/auth/executor-invites/invitation/regenerate', '/auth/executor-invites/invitation',
      '/runtime/restart', '/runtime/restart/abort', '/runtime/deployment/operations/operation-one/abort',
      '/push/vapid-public-key', '/push/subscribe', '/push/unsubscribe', '/push/devices?currentDeviceId=device-one',
      '/push/device', '/push/test']) await target.request(path, { method: 'POST', credentials: 'include' })
    expect(fetch.mock.calls.every(([path, init]) => path.startsWith('https://portable.test/')
      && init?.credentials === 'omit' && new Headers(init.headers).get('authorization') === 'Bearer fictional-profile')).toBe(true)
    for (const path of ['/push/devices?currentDeviceId=one&currentDeviceId=two', '/push/device?organizationId=other',
      '/runtime/restart?redirect=https://foreign.test', '/runtime/deployment/operations/../../other']) {
      await expect(target.request(path)).rejects.toThrow('settings_target_mismatch')
    }
    expect(fetch).toHaveBeenCalledTimes(12)
  })
  it('retains independent Portable targets, bearer credentials and cache scopes across later profile changes', async () => {
    const fetch = vi.fn<SettingsRequest>(async () => new Response('{}'))
    const input = { product: 'portable' as const, browserOrigin: 'https://dashboard.test', host: 'http://127.0.0.1:31001',
      token: 'fictional-a', cacheNamespace: 'profile-a', fetch }
    const a = resolveSettingsTargetRequest(input)!
    input.host = 'http://127.0.0.1:31002'; input.token = 'fictional-b'; input.cacheNamespace = 'profile-b'
    const b = resolveSettingsTargetRequest(input)!
    await b.request('/settings/sections/agent', { credentials: 'include' })
    await a.request('/settings/agent-prompt', { method: 'POST', headers: { authorization: 'Bearer not-from-this-target' } })
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['http://127.0.0.1:31002/settings/sections/agent', 'http://127.0.0.1:31001/settings/agent-prompt'])
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fictional-b')
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer fictional-a')
    expect(fetch.mock.calls.every(call => call[1]?.credentials === 'omit' && call[1]?.redirect === 'error')).toBe(true)
    expect(a.cacheKey.slice(0, 5)).toEqual(['profile-a', 'http://127.0.0.1:31001', '', '', 'portable'])
    expect(a.cacheKey).not.toEqual(b.cacheKey)
    expect(Object.isFrozen(a)).toBe(true)
  })

  it('never forwards hosted cookies or caller-provided tokens to another deployment', async () => {
    const fetch = vi.fn<SettingsRequest>(async () => new Response('{}'))
    const input = { product: 'dedicated' as const, browserOrigin: 'https://a.test', cacheNamespace: 'owner-a', fetch }
    expect(resolveSettingsTargetRequest({ ...input, host: 'https://b.test' })).toBeUndefined()
    const same = resolveSettingsTargetRequest({ ...input, host: 'https://a.test' })!
    await same.request('/settings/capabilities', { headers: { authorization: 'Bearer stale-profile-token' } })
    expect(fetch.mock.calls[0]?.[0]).toBe('/settings/capabilities')
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('same-origin')
  })

  it('does not reuse configuration cache authority when credentials change at the same Portable origin', () => {
    const input = { product: 'portable' as const, browserOrigin: 'https://dashboard.test',
      host: 'https://portable.test', cacheNamespace: 'local-operator' }
    const first = resolveSettingsTargetRequest({ ...input, token: 'fictional-a' })!
    const next = resolveSettingsTargetRequest({ ...input, token: 'fictional-b' })!
    expect(first.cacheKey).not.toEqual(next.cacheKey)
    expect(first.cacheKey.join()).not.toContain('fictional-a')
    expect(next.cacheKey.join()).not.toContain('fictional-b')
  })

  it('rejects target escapes and undeclared routes before attaching authentication', async () => {
    const fetch = vi.fn()
    const target = resolveSettingsTargetRequest({ product: 'portable', browserOrigin: 'https://dashboard.test',
      host: 'https://portable.test', token: 'fictional-a', cacheNamespace: 'a', fetch })!
    for (const path of ['//foreign.test/settings/capabilities', 'https://foreign.test/settings/capabilities',
      '/settings/../auth/aspire/login-token', '/settings/%2e%2e/auth/aspire/login-token', '/settings\\mcp',
      '/settings/mcp?workspaceId=a&workspaceId=b', '/settings/mcp?unexpected=1', '/settings/providers#fragment',
      '/auth/me', '/settings/capabilities?redirect=foreign', '/settings//capabilities']) {
      await expect(target.request(path)).rejects.toThrow('settings_target_mismatch')
    }
    expect(fetch).not.toHaveBeenCalled()
    await target.request('/settings/mcp?workspaceId=workspace-a')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('allows only organization-bound Private Cloud Webhook routes and bounded explicit pagination', async () => {
    const fetch = vi.fn<SettingsRequest>(async () => new Response('{}'))
    const input = { browserOrigin: 'https://kala.test', host: 'https://kala.test',
      cacheNamespace: 'fixture', organizationId: 'org_fixture', fetch }
    const target = resolveSettingsTargetRequest({ ...input, product: 'private-cloud' })!
    for (const path of ['/organization/webhooks?limit=50', '/organization/webhook-secret-bindings?cursor=abc',
      '/organization/webhooks/fixture']) await target.request(path)
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const path of ['/organization/webhooks?limit=101', '/organization/webhooks?cursor=a&cursor=b',
      '/organization/webhooks/fixture?cursor=a', '/organization/webhooks?organizationId=org_other']) {
      await expect(target.request(path)).rejects.toThrow('settings_target_mismatch')
    }
    for (const product of ['portable', 'dedicated'] as const) {
      await expect(resolveSettingsTargetRequest({ ...input, product })!.request('/organization/webhooks')).rejects.toThrow('settings_target_mismatch')
    }
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
