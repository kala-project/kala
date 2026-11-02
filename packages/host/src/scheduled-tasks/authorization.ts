export type ScheduledPrincipal = { organizationId: string; principal: string }
export type ScheduledPrincipalAuthorizer = (input: ScheduledPrincipal) => Promise<'owner' | 'admin' | 'member'>

export class BackgroundAuthorizationError extends Error {
  constructor(readonly reason: 'denied' | 'unavailable') {
    super(reason === 'denied' ? 'background principal is no longer authorized' : 'background authorization authority is unavailable')
    this.name = 'BackgroundAuthorizationError'
  }
}

/** No browser credential or positive authorization cache is retained. */
export function createScheduledPrincipalAuthorizer(input: { origin?: string; serviceSecret: string; unitId: string }): ScheduledPrincipalAuthorizer {
  const target = input.origin ? new URL(input.origin) : undefined
  if (target && (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash)) {
    throw new Error('background authority must be an HTTP(S) origin without credentials or a path')
  }
  return async (principal) => {
    if (!target) throw new BackgroundAuthorizationError('unavailable')
    try {
      const response = await fetch(new URL('/internal/background-authority', target), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': input.serviceSecret },
        body: JSON.stringify({ ...principal, unitId: input.unitId }),
      })
      const body = await response.json() as { role?: unknown; error?: unknown }
      if (response.status === 403 && body.error === 'background_principal_denied') throw new BackgroundAuthorizationError('denied')
      if (!response.ok || !['owner', 'admin', 'member'].includes(String(body.role))) throw new BackgroundAuthorizationError('unavailable')
      return body.role as 'owner' | 'admin' | 'member'
    } catch (error) {
      if (error instanceof BackgroundAuthorizationError) throw error
      throw new BackgroundAuthorizationError('unavailable')
    }
  }
}
