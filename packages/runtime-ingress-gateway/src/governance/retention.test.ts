import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeHostRetentionClient, startRetentionScheduler } from './retention.js'

// Persistence/immutability/replica cases use the shared real-PG framework gate,
// not a FakeDatabase that pretends SQL string matching enforces transactions.
describe('retention transport and lifecycle', () => {
  it('pins the trusted Unit route and cutoff; refuses redirects, oversized replies and static fallback', async () => {
    const requests: { path?: string; body: unknown }[] = []
    let mode: 'ok' | 'redirect' | 'oversized' = 'ok'
    const runtime = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk)
      requests.push({ path: req.url, body: JSON.parse(body) })
      if (mode === 'redirect') { res.writeHead(302, { location: '/must-not-follow' }); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(mode === 'oversized' ? JSON.stringify({ sessions: 1, ignored: 'x'.repeat(20_000) }) : JSON.stringify({ sessions: 4 }))
    })
    await new Promise<void>((ready) => runtime.listen(0, '127.0.0.1', ready))
    const address = runtime.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable')
    const origin = `http://127.0.0.1:${address.port}`
    const resolved: string[] = []
    const input = { organizationId: 'org_acme', runtimeUnitId: 'unit_acme', before: new Date('2026-08-08T04:00:00Z') }
    const client = createRuntimeHostRetentionClient({ origin: 'http://127.0.0.1:9', ingressSecret: 'fixture-service-value',
      runtimeOriginResolver: { async resolve(unitId) { resolved.push(unitId); return origin } } })
    try {
      await expect(client.purgeOrganizationSessions(input)).resolves.toEqual({ sessions: 4 })
      expect(resolved).toEqual(['unit_acme'])
      expect(requests[0]).toEqual({ path: '/internal/retention/sessions', body: { organizationId: 'org_acme', unitId: 'unit_acme', before: '2026-08-08T04:00:00.000Z' } })
      mode = 'redirect'; await expect(client.purgeOrganizationSessions(input)).rejects.toThrow()
      expect(requests.some((r) => r.path === '/must-not-follow')).toBe(false)
      mode = 'oversized'; await expect(client.purgeOrganizationSessions(input)).rejects.toThrow('limit exceeded')
      const count = requests.length
      const unavailable = createRuntimeHostRetentionClient({ origin, ingressSecret: 'fixture-service-value', runtimeOriginResolver: { async resolve() { return undefined } } })
      await expect(unavailable.purgeOrganizationSessions(input)).rejects.toThrow('origin is unavailable')
      expect(requests).toHaveLength(count)
    } finally { runtime.closeAllConnections(); await new Promise<void>((done) => runtime.close(() => done())) }
  })

  it('stops new admission and drains its active sweep, leaving default time selection to PostgreSQL', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const gate = new Promise<void>((done) => { finish = done })
    const sweep = vi.fn(async (_now?: Date) => { await gate; return { purged: [], failures: [] } })
    try {
      expect(() => startRetentionScheduler({ service: { purgeAllOrganizations: sweep }, intervalMs: 59_999 })).toThrow('at least')
      const scheduler = startRetentionScheduler({ service: { purgeAllOrganizations: sweep }, intervalMs: 60_000 })
      let drained = false
      const stopping = scheduler.stop().then(() => { drained = true })
      await Promise.resolve(); expect(drained).toBe(false)
      finish(); await stopping
      await vi.advanceTimersByTimeAsync(120_000)
      expect(sweep).toHaveBeenCalledTimes(1)
      expect(sweep).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    } finally { finish?.(); vi.useRealTimers() }
  })
})
