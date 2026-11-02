import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEDICATED_DEPLOYMENT, FULL_RUNTIME_CAPABILITIES, PRIVATE_CLOUD_DEPLOYMENT, type ServerSettingsPayload } from '@agent-kernel/shared'

import { StorageSection } from './StorageSection.js'

describe('StorageSection', () => {
  it.each([
    ['dedicated', DEDICATED_DEPLOYMENT],
    ['private-cloud', PRIVATE_CLOUD_DEPLOYMENT],
  ] as const)('shows tenant object accounting without host inventory or cleanup in %s', (product, deployment) => {
    const emit = vi.fn()
    const payload: ServerSettingsPayload = {
      providers: [], defaultModel: '', hooks: [],
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
      mcp: { supported: false },
      deployment: { product, deployment, capabilities: FULL_RUNTIME_CAPABILITIES },
      storage: { kind: 'postgres-s3', organizationId: 'org-owned', objectBytes: 123, objectLimitBytes: 456 },
    }
    render(<StorageSection socket={{ emit } as never} payload={payload} />)
    expect(screen.getByText('org-owned')).toBeTruthy()
    expect(screen.getByText('123 / 456 bytes')).toBeTruthy()
    expect(screen.getByText('PostgreSQL')).toBeTruthy()
    expect(screen.getByText('S3')).toBeTruthy()
    expect(emit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /clean/i })).toBeNull()
  })

  it('does not fall back to host inventory when Platform accounting is unavailable', () => {
    const emit = vi.fn()
    render(<StorageSection socket={{ emit } as never} payload={{
      providers: [], defaultModel: '', hooks: [], mcp: { supported: false },
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
      deployment: { product: 'dedicated', deployment: DEDICATED_DEPLOYMENT, capabilities: FULL_RUNTIME_CAPABILITIES },
    }} />)
    expect(screen.getByText('Organization storage usage unavailable')).toBeTruthy()
    expect(emit).not.toHaveBeenCalled()
  })

  it('selects only safe cleanup candidates and requires two confirmations', async () => {
    const emit = vi.fn((event: string, payload: unknown, ack: (result: unknown) => void) => {
      if (event === 'client:get_global_storage') {
        ack({
          ok: true,
          value: {
            totalBytes: 3_072,
            totalFiles: 5,
            categories: {
              jsonl: { bytes: 2_048, files: 2 },
              snapshot: { bytes: 512, files: 1 },
              summary: { bytes: 0, files: 0 },
              context: { bytes: 0, files: 0 },
              artifacts: { bytes: 0, files: 0 },
              'orphan-artifacts': { bytes: 512, files: 2 },
              corrupt: { bytes: 0, files: 0 },
            },
            largestSessionTrees: [
              {
                sessionId: 'root-session',
                sessionLabel: 'Storage investigation',
                workspaceId: 'workspace-one',
                workspaceName: 'Main workspace',
                directBytes: 1_024,
                treeBytes: 2_048,
                descendantCount: 2,
                categories: {},
                treeCategories: {},
              },
              {
                sessionId: 'alpha-session',
                sessionLabel: 'Alpha archive',
                workspaceId: 'workspace-one',
                workspaceName: 'Main workspace',
                directBytes: 1_024,
                treeBytes: 3_072,
                descendantCount: 0,
                categories: {},
                treeCategories: {},
              },
              {
                sessionId: 'zebra-session',
                sessionLabel: 'Zebra diagnostics',
                workspaceId: 'workspace-one',
                workspaceName: 'Main workspace',
                directBytes: 512,
                treeBytes: 1_024,
                descendantCount: 1,
                categories: {},
                treeCategories: {},
              },
            ],
            orphanCandidates: [
              { id: 'orphan-one', category: 'orphan-artifacts', bytes: 512, files: 2 },
              { id: 'snapshot-one', category: 'snapshot', bytes: 512, files: 1 },
            ],
            state: {
              measuredAt: '2026-09-30T00:00:00.000Z',
              generation: 1,
              stale: false,
              scan: { status: 'idle' },
            },
          },
        })
      } else if (event === 'client:prepare_storage_cleanup') {
        ack({
          ok: true,
          value: {
            planId: '00000000-0000-4000-8000-000000000001',
            operation: 'orphan-artifacts',
            targetId: (payload as { targetId: string }).targetId,
            sessionIds: [],
            estimatedBytes: 512,
            itemCount: 3,
            expiresAt: '2026-09-30T00:05:00.000Z',
          },
        })
      } else if (event === 'client:execute_storage_cleanup') {
        ack({
          ok: true,
          value: {
            planId: '00000000-0000-4000-8000-000000000001',
            operation: 'orphan-artifacts',
            targetId: 'orphan-one',
            logicalDeletion: true,
            bytesQuarantined: 512,
            completedAt: '2026-09-30T00:01:00.000Z',
          },
        })
      }
    })

    render(<StorageSection socket={{ emit } as never} />)

    expect((await screen.findAllByText('3.00 KiB')).length).toBeGreaterThan(0)
    expect(screen.getByText('What uses space').parentElement?.parentElement?.textContent).toContain('Total 3.00 KiB')
    fireEvent.click(screen.getByTestId('settings-storage-category-chart'))
    expect(screen.getByTestId('settings-storage-category-chart-view')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Pie chart of 3.00 KiB total storage across 3 categories' })).toBeTruthy()
    expect(screen.queryByTestId('settings-storage-category-list-view')).toBeNull()
    fireEvent.click(screen.getByTestId('settings-storage-category-list'))
    expect(screen.getByText('Storage investigation')).toBeTruthy()
    expect(screen.getByText('Main workspace · 2 sub-agents')).toBeTruthy()
    expect(screen.getByText('root-session')).toBeTruthy()
    const rowOrder = (): string[] => screen.getAllByTestId('settings-storage-file-set-row').map((row) => row.getAttribute('data-session-id') ?? '')
    const nameSort = screen.getByTestId('settings-storage-sort-name')
    const sizeSort = screen.getByTestId('settings-storage-sort-size')
    expect(sizeSort.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    expect(nameSort.closest('th')?.getAttribute('aria-sort')).toBe('none')
    expect(rowOrder()).toEqual(['alpha-session', 'root-session', 'zebra-session'])
    fireEvent.click(nameSort)
    expect(nameSort.closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    expect(rowOrder()).toEqual(['alpha-session', 'root-session', 'zebra-session'])
    fireEvent.click(nameSort)
    expect(nameSort.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    expect(rowOrder()).toEqual(['zebra-session', 'root-session', 'alpha-session'])
    fireEvent.click(sizeSort)
    expect(sizeSort.closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    expect(rowOrder()).toEqual(['zebra-session', 'root-session', 'alpha-session'])
    fireEvent.click(sizeSort)
    expect(sizeSort.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    expect(rowOrder()).toEqual(['alpha-session', 'root-session', 'zebra-session'])
    fireEvent.click(screen.getByTestId('settings-storage-cleanup-tab'))
    await waitFor(() => expect(emit.mock.calls.filter(([event]) => event === 'client:get_global_storage')).toHaveLength(2))
    expect(emit.mock.calls.filter(([event]) => event === 'client:get_global_storage')[1]?.[1]).toEqual({ refresh: true })
    expect(screen.getByText('1 additional diagnostic entry is excluded from cleanup.')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Artifact directory' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Files' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Stored size' })).toBeTruthy()
    expect(screen.getByText('Directory has no matching session record')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all cleanup candidates' }))
    expect(screen.getByTestId('settings-storage-selection-bar').textContent).toContain('1 selected')
    fireEvent.click(screen.getByRole('button', { name: 'Review cleanup…' }))
    await screen.findByTestId('settings-storage-cleanup-confirmation')
    expect(emit.mock.calls.filter(([event]) => event === 'client:prepare_storage_cleanup')).toHaveLength(1)
    expect(emit.mock.calls.find(([event]) => event === 'client:prepare_storage_cleanup')?.[1]).toEqual({
      operation: 'orphan-artifacts',
      targetId: 'orphan-one',
    })
    fireEvent.click(screen.getByTestId('settings-storage-cleanup-first-confirm'))
    expect(emit.mock.calls.some(([event]) => event === 'client:execute_storage_cleanup')).toBe(false)
    fireEvent.click(screen.getByTestId('settings-storage-cleanup-final-confirm'))
    await waitFor(() => expect(emit.mock.calls.filter(([event]) => event === 'client:execute_storage_cleanup')).toHaveLength(1))
  })

  it('keeps cleanup preparation failures local and explains unreadable records', async () => {
    const rawError = 'missing or corrupt first-line header in old.jsonl: Unterminated string in JSON'
    const emit = vi.fn((event: string, _payload: unknown, ack: (result: unknown) => void) => {
      if (event === 'client:get_global_storage') {
        ack({
          ok: true,
          value: {
            totalBytes: 512,
            totalFiles: 2,
            categories: {
              jsonl: { bytes: 0, files: 0 },
              snapshot: { bytes: 0, files: 0 },
              summary: { bytes: 0, files: 0 },
              context: { bytes: 0, files: 0 },
              artifacts: { bytes: 0, files: 0 },
              'orphan-artifacts': { bytes: 512, files: 2 },
              corrupt: { bytes: 0, files: 0 },
            },
            largestSessionTrees: [],
            orphanCandidates: [{ id: 'orphan-one', category: 'orphan-artifacts', bytes: 512, files: 2 }],
            state: { measuredAt: null, generation: 1, stale: false, scan: { status: 'idle' } },
          },
        })
      } else if (event === 'client:prepare_storage_cleanup') {
        ack({ ok: false, error: rawError })
      }
    })

    render(<StorageSection socket={{ emit } as never} />)
    expect((await screen.findAllByText('512 B')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('settings-storage-cleanup-tab'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all cleanup candidates' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review cleanup…' }))

    const notice = await screen.findByTestId('settings-storage-cleanup-error')
    expect(notice.textContent).toContain('Cleanup was not started')
    expect(notice.textContent).toContain('unreadable session record')
    expect(notice.textContent).toContain(rawError)
    expect(screen.getByTestId('settings-storage-selection-bar').contains(notice)).toBe(true)
  })
})
