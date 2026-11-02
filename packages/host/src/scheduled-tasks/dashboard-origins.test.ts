import { describe, expect, it, vi } from 'vitest'
import { createDashboardScheduledOrigins, dashboardOriginsOwner } from './dashboard-origins.js'
import type { ScheduledRun } from './types.js'
import { occurrenceSessionId } from './scheduler.js'

const operationId = `schedule_${'a'.repeat(40)}`
const record = { sessionId: 'session-a', organizationId: 'org-a' }
const ledger = () => ({ origins: vi.fn().mockResolvedValue({}), claimedRuns: vi.fn().mockResolvedValue([]) })

describe('Dashboard durable scheduled attribution', () => {
  it('scopes historical mappings to the record owner and skips unowned records', async () => {
    const store = ledger()
    store.origins.mockResolvedValue({ [operationId]: 'task-a' })
    const attribution = createDashboardScheduledOrigins(store)
    expect(await attribution.snapshot(record)).toEqual({ [operationId]: 'task-a' })
    expect(store.origins).toHaveBeenLastCalledWith('organization:org-a', 'session-a')
    await attribution.snapshot({ sessionId: 'local', principal: 'alice' })
    expect(store.origins).toHaveBeenLastCalledWith('principal:alice', 'local')
    expect(await attribution.snapshot({ sessionId: 'unowned' })).toEqual({})
    expect(store.origins).toHaveBeenCalledTimes(2)
  })

  it('uses the authenticated Portable principal rather than missing or different record ownership', async () => {
    const store = ledger()
    const attribution = createDashboardScheduledOrigins(store)
    await attribution.snapshot({ sessionId: 'local' }, { kind: 'token' })
    expect(store.origins).toHaveBeenLastCalledWith('principal:token', 'local')
    await attribution.snapshot({ sessionId: 'local', principal: 'alice' }, { kind: 'github_user', login: 'bob' })
    expect(store.origins).toHaveBeenLastCalledWith('principal:bob', 'local')
    expect(await attribution.snapshot(record, { kind: 'ingress', organizationId: 'org-b', principal: 'bob', role: 'member' })).toEqual({})
    expect(store.origins).toHaveBeenCalledTimes(2)
    const portable = { sessionId: 'local' }
    store.origins.mockResolvedValue({ [operationId]: 'portable-task' })
    await attribution.prepare(portable, operationId, 'principal:alice')
    const live = attribution.take(portable, { kind: 'user_message', operationId })!
    expect(live.ownerKey).toBe(dashboardOriginsOwner(portable, { kind: 'github_user', login: 'alice' }))
    expect(live.ownerKey).not.toBe(dashboardOriginsOwner(portable, { kind: 'github_user', login: 'bob' }))
  })

  it('does no ledger lookup for ordinary operations and never trusts a scheduled-looking ID alone', async () => {
    const store = ledger()
    const attribution = createDashboardScheduledOrigins(store)
    await attribution.prepare(record, 'ordinary-operation')
    await attribution.prepare(record, 'schedule-not-the-durable-prefix')
    expect(store.origins).not.toHaveBeenCalled()
    await attribution.prepare(record, operationId)
    expect(attribution.take(record, { kind: 'user_message', operationId })).toBeUndefined()
    expect(store.claimedRuns).toHaveBeenCalledOnce()
  })

  it('attaches ledger attribution once, only to the matching record and user operation', async () => {
    const store = ledger()
    store.origins.mockResolvedValue({ [operationId]: 'durable-task' })
    const attribution = createDashboardScheduledOrigins(store)
    await attribution.prepare(record, operationId)
    expect(attribution.take({ ...record, organizationId: 'org-b' }, { kind: 'user_message', operationId })).toBeUndefined()
    expect(attribution.take(record, { kind: 'user_message', operationId: 'different' })).toBeUndefined()
    expect(attribution.take(record, { kind: 'user_message', operationId })).toEqual({ taskId: 'durable-task', ownerKey: 'organization:org-a' })
    expect(attribution.take(record, { kind: 'user_message', operationId })).toBeUndefined()
    expect(store.claimedRuns).not.toHaveBeenCalled()
  })

  it('leaves assistant and ordinary events synchronous while a ledger lookup is pending', async () => {
    let resolve!: (origins: Record<string, string>) => void
    const store = ledger()
    store.origins.mockReturnValue(new Promise((done) => { resolve = done }))
    const attribution = createDashboardScheduledOrigins(store)
    const preparing = attribution.prepare(record, operationId)
    const assistant = { kind: 'llm_response' as const, message: { role: 'assistant' as const, content: [] } }
    expect(attribution.take(record, assistant)).toBeUndefined()
    expect(attribution.take(record, { kind: 'user_message', operationId: 'ordinary' })).toBeUndefined()
    resolve({ [operationId]: 'durable-task' })
    await preparing
    expect(attribution.take(record, assistant)).toBeUndefined()
    expect(attribution.take(record, { kind: 'user_message', operationId })).toEqual({ taskId: 'durable-task', ownerKey: 'organization:org-a' })
    expect(attribution.take(record, { kind: 'user_message', operationId })).toBeUndefined()
  })

  it('handles the claimed-before-finish race without crossing organization or target scope', async () => {
    const store = ledger()
    const run = (ownerKey: string, sessionId: string): ScheduledRun => ({
      occurrenceId: 'occ-a', operationId, taskId: 'claimed-task', status: 'claimed',
      scheduledFor: '2026-11-02T00:00:00.000Z', claimedAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
      task: { id: 'claimed-task', generation: 1, ownerKey, createdBy: 'alice', prompt: 'Run', target: { kind: 'session', sessionId } },
    })
    store.claimedRuns.mockResolvedValue([
      run('organization:org-b', record.sessionId),
      run('organization:org-a', 'different-session'),
    ])
    const attribution = createDashboardScheduledOrigins(store)
    await attribution.prepare(record, operationId)
    expect(attribution.take(record, { kind: 'user_message', operationId })).toBeUndefined()
    const workspaceRun = run('organization:org-a', record.sessionId)
    workspaceRun.task.target = { kind: 'workspace', workspaceId: 'workspace-a' }
    store.claimedRuns.mockResolvedValue([workspaceRun])
    const workspaceRecord = { ...record, sessionId: occurrenceSessionId(workspaceRun.occurrenceId) }
    await attribution.prepare(workspaceRecord, operationId)
    expect(attribution.take(workspaceRecord, { kind: 'user_message', operationId })).toEqual({ taskId: 'claimed-task', ownerKey: 'organization:org-a' })
  })
})
