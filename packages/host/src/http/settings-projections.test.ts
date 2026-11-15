import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { PRIVATE_CLOUD_DEPLOYMENT, PORTABLE_DEPLOYMENT } from '@agent-kernel/shared'
import { attachJsonRoutes } from './routes.js'

it.each([PORTABLE_DEPLOYMENT, PRIVATE_CLOUD_DEPLOYMENT])('publishes the operator-configured Portable bootstrap layout without granting a hosted Runtime layout authority: $architecture', async deployment => {
  const server = createServer()
  attachJsonRoutes(server, { deployment, settingsLayout: 'unified', auth: { sharedToken: 'fictional-layout-owner' } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    expect((await fetch(`${origin}/runtime/capabilities`)).status).toBe(200)
    const response = await fetch(`${origin}/runtime/capabilities`, { headers: { authorization: 'Bearer fictional-layout-owner' } })
    expect(response.status).toBe(200)
    if (deployment.architecture === 'portable') expect(await response.json()).toMatchObject({ settingsLayout: 'unified' })
    else expect(await response.json()).not.toHaveProperty('settingsLayout')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('authorizes scoped projections without consulting the broad settings snapshot', async () => {
  const broad = vi.fn(() => { throw new Error('broad settings snapshot must not run') })
  const projected = vi.fn(async (section: string) => section === 'models'
    ? { providers: [], defaultModel: '' } : { agentSettingsResourceId: 'organization-agent', desktopAccess: { manualAuthorizationRequired: false } })
  const server = createServer()
  attachJsonRoutes(server, { deployment: PRIVATE_CLOUD_DEPLOYMENT, auth: { requireIngressIdentity: true }, settings: broad, settingsSection: projected })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const origin = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${origin}/settings/capabilities`)).status).toBe(401)
    const headers = { 'x-agent-runlab-principal': 'viewer', 'x-agent-runlab-organization-id': 'org-one', 'x-agent-runlab-organization-role': 'viewer' }
    const capabilities = await fetch(`${origin}/settings/capabilities`, { headers })
    expect(capabilities.headers.get('cache-control')).toBe('no-store')
    expect(await capabilities.json()).toMatchObject({ product: 'private-cloud', organizationId: 'org-one',
      capabilities: expect.arrayContaining([expect.objectContaining({ id: 'models.configure', supported: false, canWrite: false })]) })
    const models = await fetch(`${origin}/settings/sections/models`, { headers })
    expect(models.status).toBe(200)
    expect(models.headers.get('cache-control')).toBe('no-store')
    expect(await models.json()).toEqual({ providers: [], defaultModel: '' })
    expect(projected).toHaveBeenCalledExactlyOnceWith('models', expect.objectContaining({ organizationId: 'org-one' }))
    expect((await fetch(`${origin}/settings/sections/agent`, { headers })).status).toBe(403)
    expect(projected).toHaveBeenCalledTimes(1)
    expect((await fetch(`${origin}/settings/sections/unknown`, { headers })).status).toBe(404)
    const execution = await fetch(`${origin}/settings/sections/execution`, { headers: { ...headers, 'x-agent-runlab-organization-role': 'owner' } })
    expect(execution.status).toBe(200)
    expect(await execution.json()).not.toHaveProperty('agentPrompt')
    expect(broad).not.toHaveBeenCalled()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('preserves an explicitly unconfigured nullable projected default without changing the legacy model-list wire', async () => {
  const server = createServer()
  attachJsonRoutes(server, { deployment: PRIVATE_CLOUD_DEPLOYMENT, auth: { requireIngressIdentity: true },
    models: [], defaultModel: () => null, settingsSection: () => ({ providers: [], defaultModel: null }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const headers = { 'x-agent-runlab-principal': 'owner', 'x-agent-runlab-organization-id': 'org-unconfigured',
      'x-agent-runlab-organization-role': 'owner' }
    const projection = await fetch(`${origin}/settings/sections/models`, { headers })
    expect(await projection.json()).toMatchObject({ providers: [], defaultModel: null })
    const legacy = await fetch(`${origin}/models`, { headers, signal: AbortSignal.timeout(3_000) })
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toMatchObject({ models: [], defaultModel: '' })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('does not advertise a loaded policy snapshot after its fresh authority becomes unavailable', async () => {
  const section = vi.fn(() => ({ providers: [], defaultModel: null }))
  const ready = vi.fn(async () => { throw new Error('fictional policy transition') })
  const server = createServer()
  attachJsonRoutes(server, { deployment: PRIVATE_CLOUD_DEPLOYMENT, auth: { requireIngressIdentity: true },
    assertSettingsReady: ready, settingsSection: section })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const headers = { 'x-agent-runlab-principal': 'owner', 'x-agent-runlab-organization-id': 'org-one',
      'x-agent-runlab-organization-role': 'owner' }
    for (const path of ['/settings/capabilities', '/settings/sections/models']) {
      expect((await fetch(`${origin}${path}`, { headers })).status).toBe(503)
    }
    expect(section).not.toHaveBeenCalled()
    ready.mockResolvedValue(undefined)
    expect((await fetch(`${origin}/settings/sections/models`, { headers })).status).toBe(200)
    expect(section).toHaveBeenCalledOnce()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
