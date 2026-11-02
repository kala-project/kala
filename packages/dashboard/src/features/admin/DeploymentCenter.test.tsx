import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeploymentCenter } from './DeploymentCenter.js'

const snapshot = {
  checkedAt: '2026-11-01T12:00:00Z', retainedLogs: 1, retainedSpans: 1,
  resources: [{ name: 'kala-runtime', hasLogs: true, hasTraces: true, hasMetrics: true }],
  logs: [{ service: 'kala-runtime', message: 'Agent turn completed', attributes: { outcome: 'completed', 'duration.ms': '7842' } }],
  spans: [{ name: 'agent.turn', service: 'kala-runtime', durationMs: 7842, attributes: { 'agent.runtime': 'copilot', outcome: 'completed' } }],
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('Dedicated management and observations', () => {
  it('loads observations once, exposes the same-origin identity entry and refreshes only on request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    render(<DeploymentCenter services={{ identityConsoleUrl: '/ui/console/instance', observability: true }} onClose={() => {}} />)
    await screen.findByText('Agent turn completed')
    expect(screen.getByTestId('deployment-identity-console').getAttribute('href')).toMatch(/\/ui\/console\/instance$/u)
    expect(screen.getByText('7842.0 ms')).toBeTruthy()
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observations' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })
  it('shows a real upstream failure rather than a healthy empty snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    render(<DeploymentCenter services={{ observability: true }} onClose={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toContain('503')
    expect(screen.queryByText('Agent turn completed')).toBeNull()
  })
})
