import { describe, expect, it } from 'vitest'
import { loadOperatorObservability } from './observability.js'

describe('Owner observation projection', () => {
  it('projects real durations and correlation without forwarding identities or arbitrary attributes', async () => {
    const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } })
    const resource = { attributes: [attribute('service.name', 'kala-runtime'), attribute('private-key', 'private-value')] }
    const snapshot = await loadOperatorObservability(async path => {
      if (path === 'resources') return [{ name: 'kala-runtime', hasLogs: true, hasTraces: true, hasMetrics: true }]
      if (path.startsWith('logs')) return { totalCount: 1, data: { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{
        body: { stringValue: 'Agent turn completed' }, timeUnixNano: '1793534400000000000', traceId: '0123456789abcdef0123456789abcdef',
        attributes: [attribute('outcome', 'completed'), attribute('session.id', 'private-session')],
      }] }] }] } }
      return { totalCount: 1, data: { resourceSpans: [{ resource, scopeSpans: [{ spans: [{
        name: 'agent.turn', traceId: '0123456789abcdef0123456789abcdef',
        startTimeUnixNano: '1793534400000000000', endTimeUnixNano: '1793534407842000000',
        attributes: [attribute('agent.runtime', 'copilot'), attribute('session.id', 'private-session')],
      }] }] }] } }
    })
    expect(snapshot.spans[0]).toMatchObject({ name: 'agent.turn', durationMs: 7842, service: 'kala-runtime' })
    expect(snapshot.logs[0]?.traceId).toBe(snapshot.spans[0]?.traceId)
    expect(JSON.stringify(snapshot)).not.toMatch(/private-session|private-value/u)
  })
  it('rejects malformed responses rather than returning a successful empty snapshot', async () => {
    await expect(loadOperatorObservability(async () => ({ malformed: true }))).rejects.toThrow('invalid_observability_response')
  })
})
