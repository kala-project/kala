import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { schema } from '@agent-kernel/shared'
import { handleModelPolicyRead } from '../../../runtime-ingress-gateway/src/edge/model-policy.js'
import { ModelPolicyClient } from './model-policy-client.js'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve()); server.closeAllConnections()
}))) })
const installationId = randomUUID(), serviceSecret = 'fictional-model-policy-service-secret-only'
const request = { installationId, organizationId: 'organization-without-a-prefix', unitId: 'unit-policy' }
const initial = (): schema.SettingsModelPolicy => ({
  ...request, installed: true, desiredManagement: 'operator', desiredRevision: '1',
  effectiveManagement: 'operator', effectiveRevision: '1', state: 'active', operationId: null, requiredServingScope: [],
})
async function serve(read: (input: unknown) => Promise<schema.SettingsModelPolicy>) {
  const server = createServer((incoming, response) => { void handleModelPolicyRead(incoming, response, serviceSecret, { read }) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture not listening')
  const origin = `http://127.0.0.1:${address.port}`
  return { origin, client: new ModelPolicyClient({ origin, installationId, serviceSecret }) }
}

describe('fresh protected model-policy protocol', () => {
  it('uses actual HTTP without browser authority and fences each new call against current policy, not cached readiness', async () => {
    let policy = initial(), reads = 0
    const { client } = await serve(async input => {
      expect(input).toEqual(request); reads++; return policy
    })
    const expected = { ...request, effectiveManagement: 'operator' as const, effectiveRevision: '1' }
    await client.assertActive(expected)
    policy = { ...policy, desiredManagement: 'dashboard', desiredRevision: '2', state: 'preparing', operationId: randomUUID() }
    await expect(client.assertActive(expected)).rejects.toMatchObject({ status: 503, code: 'model_policy_transition_fenced' })
    policy = { ...policy, effectiveManagement: 'dashboard', effectiveRevision: '2', state: 'awaiting_runtime' }
    await expect(client.assertActive({ ...expected, effectiveManagement: 'dashboard', effectiveRevision: '2' })).rejects.toMatchObject({ status: 503 })
    policy = { ...policy, state: 'active' }
    await expect(client.assertActive(expected)).rejects.toMatchObject({ status: 503 })
    await client.assertActive({ ...expected, effectiveManagement: 'dashboard', effectiveRevision: '2' })
    expect(reads).toBe(5)
  })

  it('does not send credentials to a redirect and rejects wrong installation/organization/Unit receipts and loss of authority', async () => {
    for (const patch of [{ installationId: randomUUID() }, { organizationId: 'other-organization' }, { unitId: 'another-unit' }]) {
      const { client } = await serve(async () => ({ ...initial(), ...patch }))
      await expect(client.read(request.organizationId, request.unitId)).rejects.toMatchObject({ code: 'model_policy_scope_mismatch' })
    }
    const { client } = await serve(async () => { throw new Error('fictional resolver diagnostic must not escape') })
    await expect(client.read(request.organizationId, request.unitId)).rejects.toMatchObject({ code: 'model_policy_authority_unavailable' })
    const redirect = createServer((_incoming, response) => { response.writeHead(302, { location: 'http://127.0.0.1:1/leak' }); response.end() })
    servers.push(redirect)
    await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve))
    const port = (redirect.address() as { port: number }).port
    await expect(new ModelPolicyClient({ origin: `http://127.0.0.1:${port}`, installationId, serviceSecret })
      .read(request.organizationId, request.unitId)).rejects.toMatchObject({ code: 'model_policy_authority_unavailable' })
  })

  it('rejects Cookie, Authorization, Origin, missing/duplicate service credentials, query strings and wrong methods before reading policy', async () => {
    let reads = 0
    const { origin } = await serve(async () => { reads++; return initial() })
    const path = `${origin}/internal/settings/model-management/policy`
    for (const header of [{ cookie: 'fictional=browser' }, { authorization: 'Bearer fictional' },
      { origin: 'https://browser.invalid' }, { 'x-agent-runlab-ingress-secret': `${serviceSecret}, ${serviceSecret}` }]) {
      const response = await fetch(path, { method: 'POST', headers: { 'x-agent-runlab-ingress-secret': serviceSecret, ...header } })
      expect(response.status).toBe(403)
    }
    expect((await fetch(path, { method: 'POST' })).status).toBe(403)
    expect((await fetch(path, { headers: { 'x-agent-runlab-ingress-secret': serviceSecret } })).status).toBe(400)
    expect((await fetch(`${path}?organizationId=another`, { method: 'POST', headers: { 'x-agent-runlab-ingress-secret': serviceSecret } })).status).toBe(400)
    expect(reads).toBe(0)
  })

  it('rejects malformed state, unexpected fields, decreasing/noncanonical revisions and ambiguous serving identities', () => {
    const operationId = randomUUID()
    for (const value of [
      { ...initial(), effectiveRevision: '0' }, { ...initial(), effectiveRevision: '01' },
      { ...initial(), desiredRevision: '9223372036854775808' }, { ...initial(), state: 'preparing', operationId },
      { ...initial(), installed: false, effectiveManagement: 'dashboard', desiredManagement: 'dashboard' },
      { ...initial(), desiredRevision: '2', state: 'awaiting_runtime', operationId },
      { ...initial(), unexpected: true },
      { ...initial(), requiredServingScope: [0, 1].map(() => ({ replicaId: 'replica-a', generation: '1', origin: 'http://127.0.0.1:1', phase: 'drain' })) },
    ]) expect(schema.SettingsModelPolicySchema.safeParse(value).success).toBe(false)
    expect(schema.SettingsModelPolicySchema.safeParse({ ...initial(), installed: false }).success).toBe(true)
    expect(schema.SettingsModelPolicyReconcileSchema.safeParse({ operationId, organizationId: request.organizationId,
      unitId: request.unitId, expectedEffectivePolicyRevision: '1', desiredPolicyRevision: '2', management: 'dashboard' }).success).toBe(true)
  })
})
