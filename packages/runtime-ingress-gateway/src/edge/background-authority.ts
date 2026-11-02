import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BackgroundAuthority, BackgroundAuthorityInput } from '../organizations/background-authority.js'

export async function handleBackgroundAuthority(request: IncomingMessage, response: ServerResponse, secret: string, authority?: BackgroundAuthority): Promise<void> {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  if (Buffer.byteLength(secret) < 32) { send(503, { error: 'background_authority_unavailable' }); return }
  const supplied = request.headers['x-agent-runlab-ingress-secret']
  const digest = (value: string) => createHash('sha256').update(value).digest()
  if (typeof supplied !== 'string' || request.headers.cookie || request.headers.authorization || request.headers.origin
    || !timingSafeEqual(digest(supplied), digest(secret))) { send(403, { error: 'service_authentication_required' }); return }
  if (request.method !== 'POST' || request.url !== '/internal/background-authority') { send(400, { error: 'invalid_request' }); return }
  if (!authority) { send(503, { error: 'background_authority_unavailable' }); return }
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort(); request.destroy() }, 5_000)
  try {
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      if (Buffer.byteLength(body) > 4_096) { send(413, { error: 'invalid_request' }); return }
    }
    let input: BackgroundAuthorityInput
    try { input = JSON.parse(body) as BackgroundAuthorityInput } catch { send(400, { error: 'invalid_request' }); return }
    if (!input || !['organizationId', 'unitId', 'principal'].every((key) => {
      const value = input[key as keyof BackgroundAuthorityInput]
      return typeof value === 'string' && value.length > 0 && value.length <= 1_024
    })) { send(400, { error: 'invalid_request' }); return }
    const decision = await Promise.race([
      authority.authorize(input),
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('authority timeout')), { once: true })),
    ])
    if (decision) send(200, { role: decision })
    else send(403, { error: 'background_principal_denied' })
  } catch {
    if (!response.headersSent && !response.destroyed) send(503, { error: 'background_authority_unavailable' })
  } finally { clearTimeout(timeout) }
}
