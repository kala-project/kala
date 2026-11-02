import { describe, expect, it, vi } from 'vitest'

import { runWebSearch, type WebSearchCredentialStore } from './index.js'

const credentials: WebSearchCredentialStore = { get: () => 'test-key' }

describe('host web search', () => {
  it('uses the injected Serper credential and formats results', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      organic: [{ title: 'Primary source', link: 'https://example.test/source', snippet: 'Details' }],
    })) as unknown as typeof fetch

    const result = await runWebSearch({ query: 'current docs', limit: 2 }, { credentials, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith('https://google.serper.dev/search', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-API-KEY': 'test-key' }),
      body: JSON.stringify({ q: 'current docs', num: 2, page: 1 }),
    }))
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Page: 1; requested: 2; returned: 1')
    expect(result.content).toContain('1. Primary source\n   https://example.test/source\n   Details')
  })

  it('fails without a configured credential and does not fall back', async () => {
    const fetchImpl = vi.fn()
    const result = await runWebSearch({ query: 'query' }, {
      credentials: { get: () => undefined },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, failure: { code: 'ESEARCH_CREDENTIAL', outcome: 'blocked' } })
  })

  it('does not fall back when Serper fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch

    const result = await runWebSearch({ query: 'query' }, { credentials, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, failure: { code: 'EHTTP', responsibility: 'provider' } })
  })

  it.each([
    ['Not enough credits', 'ESEARCH_QUOTA', 'precondition'],
    ['Invalid API key', 'ESEARCH_CREDENTIAL', 'precondition'],
    ['unknown-private-provider-detail', 'EHTTP', 'infrastructure'],
  ])('classifies a provider rejection without copying its body: %s', async (message, code, category) => {
    const fetchImpl = vi.fn(async () => Response.json({ message, privateData: 'must-not-be-exported' }, { status: 400 })) as unknown as typeof fetch
    const result = await runWebSearch({ query: 'docs' }, { credentials, fetchImpl })
    expect(result).toMatchObject({ ok: false, failure: { code, category, retryable: false } })
    expect(result.content).not.toContain('must-not-be-exported')
    expect(result.content).not.toContain('unknown-private-provider-detail')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('bounds provider diagnostic reads and gives bounded rate-limit guidance without retrying', async () => {
    const oversized = vi.fn(async () => Response.json({ padding: 'x'.repeat(4_096), message: 'Not enough credits' }, { status: 400 })) as unknown as typeof fetch
    expect(await runWebSearch({ query: 'docs' }, { credentials, fetchImpl: oversized })).toMatchObject({ failure: { code: 'EHTTP' } })
    const limited = vi.fn(async () => new Response('private response body', { status: 429, headers: { 'Retry-After': '120' } })) as unknown as typeof fetch
    const result = await runWebSearch({ query: 'docs' }, { credentials, fetchImpl: limited })
    expect(result).toMatchObject({ failure: { code: 'EHTTP', retryable: true } })
    expect(result.content).toContain('120 seconds')
    expect(result.content).not.toContain('private response body')
    expect(limited).toHaveBeenCalledTimes(1)
  })

  it('honors larger counts without silent clamping and bounds snippets', async () => {
    const fetchImpl = vi.fn(async (_url, init) => Response.json({
      organic: [{ title: 'Result', link: 'https://example.test', snippet: 'x'.repeat(700) }],
    })) as unknown as typeof fetch
    const result = await runWebSearch({ query: 'query', limit: 100 }, { credentials, fetchImpl })

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ q: 'query', num: 100, page: 1 })
    expect(result.content.length).toBeLessThan(900)
    expect(result.content.endsWith('...')).toBe(true)
  })

  it('forwards provider pages and counts, reporting empty pages without claiming exhaustion', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      return Response.json({ organic: request.page === 1 ? [{ title: 'First', link: 'https://example.test/first' }] : [] })
    }) as unknown as typeof fetch
    const first = await runWebSearch({ query: 'docs', limit: 20 }, { credentials, fetchImpl })
    const next = await runWebSearch({ query: 'docs', limit: 20, page: 2 }, { credentials, fetchImpl })
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { q: 'docs', num: 20, page: 1 }, { q: 'docs', num: 20, page: 2 },
    ])
    expect(first.content).toContain('page=2')
    expect(next.content).toContain('Page: 2; requested: 20; returned: 0')
    expect(next.content).toContain('no exhaustive-search claim')
  })

  it('preserves ordered successful batch sections when another query fails', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const { q } = JSON.parse(String(init?.body))
      return q === 'bad' ? new Response('', { status: 503 }) : Response.json({ organic: [{ title: q, link: 'https://example.test/' + q }] })
    }) as unknown as typeof fetch
    const result = await runWebSearch({ queries: ['good', 'bad', 'other'], limit: 10, page: 2 }, { credentials, fetchImpl })
    expect(result).toMatchObject({ ok: false, failure: { code: 'EHTTP' } })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(result.content).toContain('2/3 succeeded')
    expect(result.content).toContain('https://example.test/other')
    expect(result.content.indexOf('query[0]')).toBeLessThan(result.content.indexOf('query[1]'))
    expect(result.content.indexOf('query[1]')).toBeLessThan(result.content.indexOf('query[2]'))
  })

  it('rejects invalid requests and over-budget batches before credentials or network', async () => {
    const get = vi.fn(() => 'test-key'); const fetchImpl = vi.fn()
    for (const input of [
      {}, { query: '' }, { query: 'x', queries: ['y'] }, { queries: [] }, { queries: ['x', ' x '] },
      { queries: Array(6).fill('x') }, { queries: ['x', 'y'], limit: 51 },
      { query: 'x', page: 0 }, { query: 'x', page: 11 }, { query: 'x', page: 1.5 },
      { query: 'x', limit: 101 }, { query: 'x', limit: null }, { query: 'x', limit: 0 },
    ]) {
      expect(await runWebSearch(input, { credentials: { get }, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ ok: false, failure: { code: 'EINVAL' } })
    }
    expect(get).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetches multiple consecutive provider pages in one call within the shared budget', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const { page } = JSON.parse(String(init?.body))
      return Response.json({ organic: [{ title: 'Page ' + page, link: 'https://example.test/page/' + page }] })
    }) as unknown as typeof fetch
    const result = await runWebSearch({ query: 'docs', page: 2, pages: 3, limit: 20 }, { credentials, fetchImpl })
    expect(result.ok).toBe(true)
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { q: 'docs', num: 20, page: 2 }, { q: 'docs', num: 20, page: 3 }, { q: 'docs', num: 20, page: 4 },
    ])
    expect(result.content).toContain('3/3 succeeded')
    expect(result.content).toContain('https://example.test/page/4')
    const noFetch = vi.fn()
    for (const input of [{ query: 'docs', pages: 0 }, { query: 'docs', page: 10, pages: 2 }, { queries: ['a', 'b'], pages: 3 }, { query: 'docs', limit: 100, pages: 2 }]) {
      expect(await runWebSearch(input, { credentials, fetchImpl: noFetch as unknown as typeof fetch })).toMatchObject({ ok: false, failure: { code: 'EINVAL' } })
    }
    expect(noFetch).not.toHaveBeenCalled()
  })

})
