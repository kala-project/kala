import type { ProductVariant } from '@agent-kernel/shared'
import type { SettingsRequest } from './configuration-client.js'

let requestScope = 0

export type SettingsTargetRequest = {
  readonly origin: string
  readonly cacheKey: readonly string[]
  readonly request: SettingsRequest
}

export function resolveSettingsTargetRequest(input: {
  product: ProductVariant; host: string; browserOrigin: string; cacheNamespace: string
  organizationId?: string; organizationRole?: string; token?: string; fetch?: SettingsRequest
}): SettingsTargetRequest | undefined {
  let target: URL
  try { target = new URL(input.host || input.browserOrigin) } catch { return undefined }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash || !input.cacheNamespace
    || input.product !== 'portable' && target.origin !== input.browserOrigin) return undefined
  const origin = target.origin
  const product = input.product
  const organizationId = input.organizationId
  const organizationRole = input.organizationRole
  const browserOrigin = input.browserOrigin
  const authorization = product === 'portable' && input.token ? `Bearer ${input.token}` : undefined
  const perform = input.fetch ?? ((path, init) => fetch(path, init))
  const cacheKey = Object.freeze([input.cacheNamespace, origin, input.organizationId ?? '', input.organizationRole ?? '', product, `request:${++requestScope}`])
  const request: SettingsRequest = (path, init = {}) => {
    let url: URL
    try { url = new URL(path, origin) } catch { return Promise.reject(new Error('settings_target_mismatch')) }
    const webhook = /^\/organization\/(?:webhooks(?:\/[^/]+)?|webhook-secret-bindings)$/u.test(url.pathname)
      && product === 'private-cloud' && Boolean(organizationId)
    const pagination = webhook && ['/organization/webhooks', '/organization/webhook-secret-bindings'].includes(url.pathname)
      && [...url.searchParams.keys()].every(key => ['limit', 'cursor'].includes(key))
      && url.searchParams.getAll('limit').length <= 1 && url.searchParams.getAll('cursor').length <= 1
      && (!url.searchParams.has('limit') || /^(?:[1-9]\d?|100)$/u.test(url.searchParams.get('limit')!))
      && (!url.searchParams.has('cursor') || /^[A-Za-z0-9_-]{1,4096}$/u.test(url.searchParams.get('cursor')!))
    const pushDeviceQuery = url.pathname === '/push/devices' && [...url.searchParams].length === 1
      && url.searchParams.has('currentDeviceId') && /^[A-Za-z0-9_-]{1,200}$/u.test(url.searchParams.get('currentDeviceId')!)
    const nativeTask = /^\/(?:models|push\/(?:vapid-public-key|subscribe|unsubscribe|devices|device|test)|runtime\/(?:restart(?:\/abort)?|deployment\/(?:restart|operations\/[A-Za-z0-9_-]{1,200}(?:\/abort)?)))$/u.test(url.pathname)
    const storageCredentials = url.pathname === '/auth/silo/credentials' && product === 'dedicated'
      && Boolean(organizationId) && organizationRole === 'owner' && init.method === 'POST'
    if (url.origin !== origin || url.username || url.password || url.hash
      || /[\\\u0000-\u0020\u007f]/u.test(path)
      || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|%2f|%5c|$)/iu.test(path)
      || !webhook && !nativeTask && !storageCredentials && !/^\/(?:settings\/(?:capabilities|sections\/(?:models|agent|execution|hooks|engines|storage|diagnostics|services|skills)|models|providers|default-model|agent-prompt|desktop-access|web-search(?:\/test)?|speech(?:\/test)?|mcp|socket-admin\/(?:init|mode))|auth\/(?:executor-invites(?:\/[^/]+(?:\/(?:revoke|regenerate))?)?|aspire\/login-token)|runtime\/deployment\/(?:status|health))$/u.test(url.pathname)
      || url.search && !pagination && !pushDeviceQuery && (url.pathname !== '/settings/mcp' || [...url.searchParams].length !== 1
        || !url.searchParams.get('workspaceId') || url.searchParams.get('workspaceId')!.length > 512)) {
      return Promise.reject(new Error('settings_target_mismatch'))
    }
    const headers = new Headers(init.headers)
    if (authorization) headers.set('authorization', authorization)
    else headers.delete('authorization')
    return perform(origin === browserOrigin ? `${url.pathname}${url.search}` : url.href, {
      ...init, headers, credentials: origin === browserOrigin ? 'same-origin' : 'omit', cache: 'no-store', redirect: 'error',
    })
  }
  return Object.freeze({ origin, cacheKey, request })
}
