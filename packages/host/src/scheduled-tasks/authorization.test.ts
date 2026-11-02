import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { BackgroundAuthorizationError, createScheduledPrincipalAuthorizer } from './authorization.js'

it('uses service-only HTTP, retains no positive decision and distinguishes denial from unavailable authority', async () => {
  let decision = 'member'
  let calls = 0
  const http = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    expect(request.url).toBe('/internal/background-authority')
    expect(request.headers['x-agent-runlab-ingress-secret']).toBe('fixture-service-secret')
    expect(request.headers.cookie).toBeUndefined()
    expect(JSON.parse(raw)).toEqual({ organizationId: 'org-a', principal: 'creator', unitId: 'unit-a' })
    calls += 1
    response.writeHead(decision === 'denied' ? 403 : decision === 'unavailable' ? 503 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(decision === 'denied' ? { error: 'background_principal_denied' } : { role: decision }))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture port')
  const authorize = createScheduledPrincipalAuthorizer({ origin: `http://127.0.0.1:${address.port}`, serviceSecret: 'fixture-service-secret', unitId: 'unit-a' })
  try {
    const input = { organizationId: 'org-a', principal: 'creator' }
    await expect(authorize(input)).resolves.toBe('member')
    decision = 'denied'
    await expect(authorize(input)).rejects.toMatchObject(new BackgroundAuthorizationError('denied'))
    decision = 'unavailable'
    await expect(authorize(input)).rejects.toMatchObject(new BackgroundAuthorizationError('unavailable'))
    decision = 'owner'
    await expect(authorize(input)).resolves.toBe('owner')
    expect(calls).toBe(4)
  } finally { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())) }
})
