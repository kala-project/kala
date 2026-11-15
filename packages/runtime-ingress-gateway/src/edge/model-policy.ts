import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PostgresModelPolicyReader } from '../settings/model-policy-reader.js'
import { ModelPolicyReadError } from '../settings/model-policy-reader.js'

export async function handleModelPolicyRead(request: IncomingMessage, response: ServerResponse,
  secret: string, reader?: Pick<PostgresModelPolicyReader, 'read'> & Partial<Pick<PostgresModelPolicyReader, 'resource' | 'executor'>>): Promise<void> {
  const send = (status: number, body: unknown) => {
    if (response.destroyed) return
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  const supplied = request.headers['x-agent-runlab-ingress-secret']
  const digest = (value: string) => createHash('sha256').update(value).digest()
  if (Buffer.byteLength(secret) < 32) { send(503, { error: 'model_policy_authority_unavailable' }); return }
  if (typeof supplied !== 'string' || request.headers.cookie || request.headers.authorization || request.headers.origin
    || !timingSafeEqual(digest(secret), digest(supplied))) { send(403, { error: 'service_authentication_required' }); return }
  const operational = request.url === '/internal/settings/operational-resource'
  const executor = request.url === '/internal/settings/executor-admission'
  if (request.method !== 'POST' || !operational && !executor && request.url !== '/internal/settings/model-management/policy') {
    send(400, { error: 'invalid_model_policy_request' }); return
  }
  if (!reader) { send(503, { error: 'model_policy_authority_unavailable' }); return }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    timer = setTimeout(() => { request.destroy(); response.destroy() }, 5_000)
    let raw = ''
    for await (const chunk of request) {
      raw += String(chunk)
      if (Buffer.byteLength(raw) > 4_096) { send(413, { error: 'invalid_model_policy_request' }); return }
    }
    let input: unknown
    try { input = JSON.parse(raw) } catch { send(400, { error: 'invalid_model_policy_request' }); return }
    if (operational && !reader.resource) { send(503, { error: 'operational_authority_unavailable' }); return }
    if (executor && !reader.executor) { send(503, { error: 'operational_authority_unavailable' }); return }
    send(200, executor ? await reader.executor!(input) : operational ? await reader.resource!(input) : await reader.read(input))
  } catch (error) {
    send(error instanceof ModelPolicyReadError ? error.status : 503,
      { error: error instanceof ModelPolicyReadError ? error.code : 'model_policy_authority_unavailable' })
  } finally { if (timer) clearTimeout(timer) }
}
