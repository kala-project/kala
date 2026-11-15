import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { OperatorModelPolicyTransport } from './model-policy-transport.js'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })
async function listen(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const profile = (origin: string) => ({
  schemaVersion: 1 as const, installationIdFile: '/protected/installation',
  controlPlaneDatabaseUrlRef: 'file:/protected/control', internalCredentialRef: 'file:/protected/internal',
  planSigningKeyRef: 'file:/protected/signing', runtimeControlOrigin: origin,
  allowedOrganizations: ['org-a'], allowedResourceKinds: ['model-management' as const],
})

it('does not resolve or transmit the service credential to an unapproved replica or a redirect target', async () => {
  const target = vi.fn()
  const other = await listen((_request, response) => { target(); response.end('{}') })
  const initial = vi.fn()
  const origin = await listen((request, response) => {
    initial(request.headers['x-agent-runlab-ingress-secret'], request.headers.cookie, request.headers.authorization)
    response.writeHead(307, { location: `${other}/redirected` }); response.end()
  })
  const credential = vi.fn(async () => 'fictional-internal-credential-32bytes')
  const transport = new OperatorModelPolicyTransport({ profile: profile(origin), installationId: 'fixture', credential })
  await expect(transport.request('inspect', {}, other)).rejects.toThrow('unapproved_runtime_control_origin')
  expect(credential).not.toHaveBeenCalled()
  expect(target).not.toHaveBeenCalled()
  await expect(transport.request('inspect', {})).rejects.toThrow('runtime_model_policy_outcome_pending')
  expect(initial).toHaveBeenCalledExactlyOnceWith('fictional-internal-credential-32bytes', undefined, undefined)
  expect(target).not.toHaveBeenCalled()
})

it('bounds malformed responses and sanitizes upstream diagnostic text instead of reporting a receipt', async () => {
  const origin = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(`"${'fictional-secret-detail'.repeat(100_000)}"`)
  })
  const transport = new OperatorModelPolicyTransport({ profile: profile(origin), installationId: 'fixture',
    credential: async () => 'fictional-internal-credential-32bytes' })
  await expect(transport.request('observe', {})).rejects.toThrow('runtime_model_policy_outcome_pending')
})
