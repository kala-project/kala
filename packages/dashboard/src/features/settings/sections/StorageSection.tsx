import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Socket } from 'socket.io-client'
import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  GlobalStorageSnapshot,
  StorageCleanupPlanPreview,
  ServerSettingsPayload,
} from '@agent-kernel/shared'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { ProductState } from '../../../components/ui/product-state.js'
import { cn } from '../../../lib/utils.js'
import { SectionHeader } from '../controls.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
type SessionTreeSortField = 'name' | 'size'
type SortDirection = 'asc' | 'desc'

export function StorageSection({ socket, payload }: { socket?: DashboardSocket; payload?: ServerSettingsPayload }): JSX.Element {
  return payload?.deployment?.deployment.architecture === 'platform'
    ? <PlatformStorageSection storage={payload.storage} />
    : <LocalStorageSection socket={socket} />
}

function PlatformStorageSection({ storage }: { storage: ServerSettingsPayload['storage'] }): JSX.Element {
  const { t, i18n } = useTranslation()
  return (
    <div data-testid="platform-storage">
      <SectionHeader title={t('settings.sections.storage.label')} subtitle={t('settings.platformStorage.subtitle')} />
      {storage ? (
        <dl className="space-y-3 rounded-md bg-muted/40 p-4 text-sm">
          <div><dt className="text-muted-foreground">{t('settings.platformStorage.organization')}</dt><dd>{storage.organizationId}</dd></div>
          <div><dt className="text-muted-foreground">{t('settings.platformStorage.sessionAuthority')}</dt><dd>PostgreSQL</dd></div>
          <div><dt className="text-muted-foreground">{t('settings.platformStorage.objectAuthority')}</dt><dd>S3</dd></div>
          <div><dt className="text-muted-foreground">{t('settings.platformStorage.objectUsage')}</dt><dd>{storage.objectBytes.toLocaleString(i18n.language)} / {storage.objectLimitBytes.toLocaleString(i18n.language)} bytes</dd></div>
        </dl>
      ) : <ProductState kind="empty" title={t('settings.platformStorage.unavailable')} description={t('settings.platformStorage.unavailableDescription')} />}
      <p className="mt-4 text-sm text-muted-foreground">{t('settings.platformStorage.boundary')}</p>
    </div>
  )
}

function LocalStorageSection({ socket }: { socket?: DashboardSocket }): JSX.Element {
  const { t, i18n } = useTranslation()
  const [snapshot, setSnapshot] = useState<GlobalStorageSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const [cleanupError, setCleanupError] = useState<{ phase: 'prepare' | 'execute'; details: string } | null>(null)
  const [view, setView] = useState<'overview' | 'cleanup'>('overview')
  const [categoryView, setCategoryView] = useState<'list' | 'chart'>('list')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [cleanupPlans, setCleanupPlans] = useState<readonly StorageCleanupPlanPreview[]>([])
  const [confirmationStep, setConfirmationStep] = useState<'review' | 'final'>('review')
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [sessionTreeSort, setSessionTreeSort] = useState<{ field: SessionTreeSortField; direction: SortDirection }>({
    field: 'size',
    direction: 'desc',
  })

  const load = (refresh: boolean): void => {
    if (!socket) return
    setLoading(true)
    setInventoryError(null)
    socket.emit('client:get_global_storage', refresh ? { refresh: true } : {}, (result) => {
      setLoading(false)
      if (result.ok) setSnapshot(result.value)
      else setInventoryError(result.error)
    })
  }

  const prepareCleanup = async (): Promise<void> => {
    if (!socket || selectedIds.size === 0) return
    setCleanupBusy(true)
    setCleanupError(null)
    try {
      const plans = await Promise.all([...selectedIds].map((targetId) => new Promise<StorageCleanupPlanPreview>((resolve, reject) => {
        socket.emit('client:prepare_storage_cleanup', { operation: 'orphan-artifacts', targetId }, (result) => {
          if (result.ok) resolve(result.value)
          else reject(new Error(result.error))
        })
      })))
      setCleanupPlans(plans)
      setConfirmationStep('review')
    } catch (cleanupError) {
      setCleanupError({ phase: 'prepare', details: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) })
    } finally {
      setCleanupBusy(false)
    }
  }

  const executeCleanup = async (): Promise<void> => {
    if (!socket || cleanupPlans.length === 0) return
    setCleanupBusy(true)
    setCleanupError(null)
    let completed = 0
    let failed = false
    for (const plan of cleanupPlans) {
      const result = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
        socket.emit('client:execute_storage_cleanup', { planId: plan.planId }, (value) => {
          resolve(value.ok ? { ok: true } : value)
        })
      })
      if (!result.ok) {
        setCleanupError({
          phase: 'execute',
          details: completed > 0
            ? `${completed} cleanup ${completed === 1 ? 'plan completed' : 'plans completed'} before the remaining operation failed: ${result.error}`
            : result.error,
        })
        failed = true
        break
      }
      completed += 1
    }
    setCleanupBusy(false)
    if (!failed) {
      setCleanupPlans([])
      setConfirmationStep('review')
      setSelectedIds(new Set())
      load(true)
    }
  }

  useEffect(() => {
    load(false)
  }, [socket])

  const cleanupCandidates = snapshot?.orphanCandidates.filter((candidate) => candidate.category === 'orphan-artifacts') ?? []
  const informationalCandidates = snapshot?.orphanCandidates.filter((candidate) => candidate.category !== 'orphan-artifacts') ?? []
  const allSelected = cleanupCandidates.length > 0 && cleanupCandidates.every((candidate) => selectedIds.has(candidate.id))
  const someSelected = selectedIds.size > 0 && !allSelected
  const selectedBytes = cleanupCandidates
    .filter((candidate) => selectedIds.has(candidate.id))
    .reduce((total, candidate) => total + candidate.bytes, 0)
  const plannedBytes = cleanupPlans.reduce((total, plan) => total + plan.estimatedBytes, 0)
  const plannedItems = cleanupPlans.reduce((total, plan) => total + plan.itemCount, 0)
  const categoryEntries = snapshot
    ? Object.entries(snapshot.categories)
      .filter(([, value]) => value.bytes > 0 || value.files > 0)
      .sort((left, right) => right[1].bytes - left[1].bytes)
    : []
  const sortedSessionTrees = useMemo(() => {
    if (!snapshot) return []
    return snapshot.largestSessionTrees
      .map((entry, originalIndex) => ({ entry, originalIndex }))
      .sort((left, right) => {
        const primary = sessionTreeSort.field === 'size'
          ? left.entry.treeBytes - right.entry.treeBytes
          : sessionTreeName(left.entry).localeCompare(sessionTreeName(right.entry), i18n.language, {
              numeric: true,
              sensitivity: 'base',
            })
        if (primary !== 0) return sessionTreeSort.direction === 'asc' ? primary : -primary
        const secondary = sessionTreeName(left.entry).localeCompare(sessionTreeName(right.entry), i18n.language, {
          numeric: true,
          sensitivity: 'base',
        })
        if (secondary !== 0) return secondary
        return left.originalIndex - right.originalIndex
      })
      .map(({ entry }) => entry)
  }, [i18n.language, sessionTreeSort, snapshot])

  const toggleSessionTreeSort = (field: SessionTreeSortField): void => {
    setSessionTreeSort((current) => ({
      field,
      direction: current.field === field && current.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const openCleanupView = (): void => {
    setView('cleanup')
    setSelectedIds(new Set())
    setCleanupPlans([])
    setCleanupError(null)
    setConfirmationStep('review')
    load(true)
  }

  return (
    <div data-testid="settings-storage">
      <SectionHeader
        title="Storage"
        subtitle="Understand disk usage and safely clean records that no longer belong to a session."
      />
      {!socket ? (
        <ProductState kind="empty" title="Storage inventory unavailable" description="Connect to a Host session to inspect storage." />
      ) : inventoryError && !snapshot ? (
        <ProductState kind="error" title="Could not load storage" description={inventoryError} primary={{ label: 'Retry', onClick: () => load(false) }} />
      ) : snapshot ? (
        <div className="space-y-5">
          {inventoryError ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{inventoryError}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/15 p-4">
            <div>
              <div className="text-xs text-muted-foreground">Kala session storage</div>
              <div className="text-2xl font-semibold">{formatBytes(snapshot.totalBytes)}</div>
              <div className="text-caption text-muted-foreground">{snapshot.totalFiles.toLocaleString()} files</div>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => load(true)}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
              Refresh inventory
            </Button>
          </div>

          <div className="flex gap-1 border-b border-border/50 pb-2" role="tablist" aria-label="Storage views">
            <StorageViewTab active={view === 'overview'} testId="settings-storage-overview-tab" onClick={() => setView('overview')}>Overview</StorageViewTab>
            <StorageViewTab active={view === 'cleanup'} testId="settings-storage-cleanup-tab" onClick={openCleanupView}>Cleanup</StorageViewTab>
          </div>

          {view === 'overview' ? (
            <>
              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-1 text-sm font-medium">
                    What uses space
                    <HelpHint label="Storage categories">
                      Categories group files by purpose: conversation records, cached recovery state, compacted summaries, model context data, and tool or runtime artifacts.
                    </HelpHint>
                  </h3>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">Total <strong className="font-medium text-foreground">{formatBytes(snapshot.totalBytes)}</strong></span>
                    <div className="flex rounded-md border border-border/50 bg-muted/15 p-0.5" role="group" aria-label="Storage category presentation">
                      <CategoryViewButton active={categoryView === 'list'} testId="settings-storage-category-list" onClick={() => setCategoryView('list')}>List</CategoryViewButton>
                      <CategoryViewButton active={categoryView === 'chart'} testId="settings-storage-category-chart" onClick={() => setCategoryView('chart')}>Pie chart</CategoryViewButton>
                    </div>
                  </div>
                </div>
                {categoryView === 'list' ? (
                  <div className="grid gap-2 sm:grid-cols-2" data-testid="settings-storage-category-list-view">
                    {categoryEntries.map(([category, value]) => (
                      <div key={category} className="flex items-center justify-between gap-3 rounded-md border border-border/40 px-3 py-2 text-sm">
                        <span>{storageCategoryLabel(category)}</span>
                        <span className="text-right text-xs text-muted-foreground">{formatBytes(value.bytes)} · {value.files} files</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <StoragePieChart entries={categoryEntries} totalBytes={snapshot.totalBytes} />
                )}
              </section>

              <section>
                <h3 className="mb-2 flex items-center gap-1 text-sm font-medium">
                  Largest session groups
                  <HelpHint label="Largest session groups">
                    Each row combines a root session with all of its descendant sub-agents. Open that session's Session Info to inspect and selectively clean individual sub-agent records.
                  </HelpHint>
                </h3>
                <div className="overflow-hidden rounded-md border border-border/50">
                  <table className="w-full table-fixed text-sm" data-testid="settings-storage-file-sets">
                    <thead className="border-b border-border/50 bg-muted/20 text-xs text-muted-foreground">
                      <tr>
                        <SortableHeader
                          field="name"
                          label={t('settings.storageInventory.name')}
                          activeField={sessionTreeSort.field}
                          direction={sessionTreeSort.direction}
                          onSort={toggleSessionTreeSort}
                          className="w-auto"
                        />
                        <SortableHeader
                          field="size"
                          label={t('settings.storageInventory.size')}
                          activeField={sessionTreeSort.field}
                          direction={sessionTreeSort.direction}
                          onSort={toggleSessionTreeSort}
                          className="w-28 text-right"
                        />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {sortedSessionTrees.map((entry) => (
                        <tr key={entry.sessionId} data-testid="settings-storage-file-set-row" data-session-id={entry.sessionId}>
                          <td className="min-w-0 px-3 py-2">
                            <div className="truncate font-medium" title={entry.sessionLabel ?? t('settings.storageInventory.untitled')}>{entry.sessionLabel ?? t('settings.storageInventory.untitled')}</div>
                            <div className="truncate text-xs text-muted-foreground" title={entry.workspaceName ?? entry.workspaceId ?? t('settings.storageInventory.unknownWorkspace')}>
                              {entry.workspaceName ?? entry.workspaceId ?? t('settings.storageInventory.unknownWorkspace')} · {t('settings.storageInventory.subAgents', { count: entry.descendantCount })}
                            </div>
                            <div className="truncate font-mono text-caption text-muted-foreground/75" title={entry.sessionId}>{entry.sessionId}</div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums" data-testid="settings-storage-file-set-size">{formatBytes(entry.treeBytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            <section className="space-y-3" data-testid="settings-storage-cleanup">
              <h3 className="flex items-center gap-1 text-sm font-medium">
                Unattached artifacts
                <HelpHint label="Unattached artifacts" testId="settings-storage-cleanup-help">
                  These artifact directories no longer match any stored session. Selection never includes active session records. The Host creates and revalidates an exact cleanup plan before moving anything to quarantine.
                </HelpHint>
              </h3>
              {cleanupCandidates.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-border/50">
                  <table className="w-full table-fixed text-sm">
                    <thead className="border-b border-border/50 bg-muted/20 text-xs text-muted-foreground">
                      <tr>
                        <th className="w-10 px-3 py-2 text-left">
                          <input
                            type="checkbox"
                            aria-label="Select all cleanup candidates"
                            checked={allSelected}
                            ref={(input) => { if (input) input.indeterminate = someSelected }}
                            disabled={loading || cleanupBusy || cleanupPlans.length > 0}
                            onChange={(event) => setSelectedIds(event.target.checked ? new Set(cleanupCandidates.map((candidate) => candidate.id)) : new Set())}
                          />
                        </th>
                        <th className="px-1 py-2 text-left font-medium">Artifact directory</th>
                        <th className="w-16 px-2 py-2 text-right font-medium">Files</th>
                        <th className="w-24 px-3 py-2 text-right font-medium">Stored size</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {cleanupCandidates.slice(0, 50).map((candidate) => (
                        <tr key={candidate.id} className="hover:bg-muted/20">
                          <td className="px-3 py-2 align-middle">
                            <input
                              type="checkbox"
                              aria-label={`Select ${candidate.id}`}
                              checked={selectedIds.has(candidate.id)}
                              disabled={loading || cleanupBusy || cleanupPlans.length > 0}
                              onChange={(event) => {
                                setSelectedIds((current) => {
                                  const next = new Set(current)
                                  if (event.target.checked) next.add(candidate.id)
                                  else next.delete(candidate.id)
                                  return next
                                })
                              }}
                            />
                          </td>
                          <td className="min-w-0 px-1 py-2">
                            <div className="truncate font-mono text-xs" title={candidate.id}>{candidate.id}</div>
                            <div className="text-caption text-muted-foreground">Directory has no matching session record</div>
                          </td>
                          <td className="px-2 py-2 text-right text-xs tabular-nums">{candidate.files}</td>
                          <td className="px-3 py-2 text-right text-xs tabular-nums">{formatBytes(candidate.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selectedIds.size > 0 && cleanupPlans.length === 0 ? (
                    <div className="space-y-2 border-t border-border/50 bg-muted/20 px-3 py-2" data-testid="settings-storage-selection-bar">
                      {cleanupError?.phase === 'prepare' ? <CleanupErrorNotice error={cleanupError} /> : null}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="text-xs">{selectedIds.size} selected · {formatBytes(selectedBytes)}</span>
                        <Button type="button" size="sm" variant="destructive" disabled={loading || cleanupBusy} onClick={() => void prepareCleanup()}>
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                          Review cleanup…
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <ProductState kind="empty" title="No unattached artifacts" description="The latest inventory found nothing that can be safely selected for cleanup." />
              )}

              {informationalCandidates.length > 0 ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {informationalCandidates.length} additional diagnostic {informationalCandidates.length === 1 ? 'entry is' : 'entries are'} excluded from cleanup.
                  <HelpHint label="Excluded diagnostic entries">
                    Snapshot, summary, context, and corrupt-file candidates are shown in inventory totals but cannot be bulk-cleaned here because they require session-specific validation.
                  </HelpHint>
                </div>
              ) : null}

              {cleanupPlans.length > 0 ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid="settings-storage-cleanup-confirmation">
                  <div className="font-medium">{confirmationStep === 'review' ? 'Review selected cleanup' : 'Final confirmation required'}</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {cleanupPlans.length} artifact {cleanupPlans.length === 1 ? 'directory' : 'directories'}, {plannedItems} exact filesystem {plannedItems === 1 ? 'entry' : 'entries'}, and approximately {formatBytes(plannedBytes)} will be quarantined after Host revalidation.
                  </p>
                  {confirmationStep === 'final' ? <p className="mt-2 font-medium text-destructive">Confirm again. This operation cannot be undone from the Kala UI.</p> : null}
                  {cleanupError?.phase === 'execute' ? <div className="mt-3"><CleanupErrorNotice error={cleanupError} /></div> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {confirmationStep === 'review' ? (
                      <Button type="button" size="sm" variant="destructive" data-testid="settings-storage-cleanup-first-confirm" disabled={cleanupBusy} onClick={() => setConfirmationStep('final')}>Continue</Button>
                    ) : (
                      <Button type="button" size="sm" variant="destructive" data-testid="settings-storage-cleanup-final-confirm" disabled={cleanupBusy} onClick={() => void executeCleanup()}>Confirm cleanup</Button>
                    )}
                    <Button type="button" size="sm" variant="outline" disabled={cleanupBusy} onClick={() => {
                      setCleanupPlans([])
                      setConfirmationStep('review')
                    }}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </section>
          )}

          <p className="text-caption text-muted-foreground">
            Last measured: {snapshot.state.measuredAt ?? 'not yet'}. Inventory refreshes are lazy and do not read complete session logs.
          </p>
        </div>
      ) : (
        <ProductState kind="loading" title="Loading storage inventory" description="Reading cached measurements without scanning disk." />
      )}
    </div>
  )
}

function sessionTreeName(entry: GlobalStorageSnapshot['largestSessionTrees'][number]): string {
  return entry.sessionLabel ?? entry.sessionId
}

function SortableHeader({
  field,
  label,
  activeField,
  direction,
  onSort,
  className,
}: {
  field: SessionTreeSortField
  label: string
  activeField: SessionTreeSortField
  direction: SortDirection
  onSort: (field: SessionTreeSortField) => void
  className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const active = activeField === field
  const nextDirection: SortDirection = active && direction === 'asc' ? 'desc' : 'asc'
  const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  const actionLabel = t('settings.storageInventory.sortAction', {
    field: label,
    direction: t(`settings.storageInventory.${nextDirection}`),
  })
  return (
    <th scope="col" aria-sort={ariaSort} className={className}>
      <button
        type="button"
        className={cn('flex w-full items-center gap-1 px-3 py-2 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', field === 'size' && 'justify-end')}
        onClick={() => onSort(field)}
        aria-label={actionLabel}
        title={actionLabel}
        data-testid={`settings-storage-sort-${field}`}
      >
        {label}
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </button>
    </th>
  )
}

function StorageViewTab({
  active,
  children,
  testId,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  testId: string
  onClick(): void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      className={cn(
        'min-h-9 rounded-md px-3 text-sm font-medium transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function CategoryViewButton({
  active,
  children,
  testId,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  testId: string
  onClick(): void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        'min-h-7 rounded px-2 text-xs font-medium transition-colors',
        active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const PIE_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#4f46e5',
  '#64748b',
] as const

function StoragePieChart({
  entries,
  totalBytes,
}: {
  entries: readonly [string, { bytes: number; files: number }][]
  totalBytes: number
}): JSX.Element {
  const denominator = Math.max(1, totalBytes)
  let cursor = 0
  const slices = entries.map(([category, value], index) => {
    const start = cursor
    cursor += value.bytes / denominator * 100
    return {
      category,
      value,
      color: PIE_COLORS[index % PIE_COLORS.length]!,
      start,
      end: cursor,
    }
  })
  const gradient = slices.length > 0
    ? `conic-gradient(${slices.map((slice) => `${slice.color} ${slice.start.toFixed(4)}% ${slice.end.toFixed(4)}%`).join(', ')})`
    : 'var(--muted)'

  return (
    <div className="grid items-center gap-5 rounded-md border border-border/40 p-4 sm:grid-cols-[12rem_minmax(0,1fr)]" data-testid="settings-storage-category-chart-view">
      <div
        role="img"
        aria-label={`Pie chart of ${formatBytes(totalBytes)} total storage across ${entries.length} categories`}
        className="mx-auto aspect-square w-full max-w-48 rounded-full border border-border/30 shadow-inner"
        style={{ background: gradient }}
      />
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {slices.map((slice) => {
          const percentage = totalBytes > 0 ? slice.value.bytes / totalBytes * 100 : 0
          return (
            <div key={slice.category} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: slice.color }} aria-hidden />
              <span className="truncate" title={storageCategoryLabel(slice.category)}>{storageCategoryLabel(slice.category)}</span>
              <span className="text-right text-muted-foreground" title={`${formatBytes(slice.value.bytes)} · ${slice.value.files} files`}>
                {percentage < 0.1 && percentage > 0 ? '<0.1%' : `${percentage.toFixed(1)}%`}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CleanupErrorNotice({
  error,
}: {
  error: { phase: 'prepare' | 'execute'; details: string }
}): JSX.Element {
  const unreadableRecord = /missing or corrupt first-line header|unterminated string|corrupt-header/iu.test(error.details)
  return (
    <div className="rounded-md border border-destructive/35 bg-destructive/5 p-3 text-xs" role="alert" data-testid="settings-storage-cleanup-error">
      <div className="font-medium text-destructive">
        {error.phase === 'prepare' ? 'Cleanup was not started' : 'Cleanup could not finish'}
      </div>
      <p className="mt-1 text-muted-foreground">
        {unreadableRecord
          ? 'An unreadable session record prevented safe ownership validation. The record was not modified or deleted.'
          : error.phase === 'prepare'
            ? 'The Host could not create a safely revalidated cleanup plan. No cleanup was started.'
            : 'The Host stopped the operation when a safety check failed. Refresh the inventory before trying again.'}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Technical details</summary>
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-caption text-foreground">{error.details}</pre>
      </details>
    </div>
  )
}

function storageCategoryLabel(category: string): string {
  return ({
    jsonl: 'Conversation records',
    snapshot: 'Recovery snapshots',
    summary: 'Compacted summaries',
    context: 'Context data',
    'session-artifacts': 'Session artifacts',
    'orphan-artifacts': 'Unattached artifacts',
    backup: 'Recovery backups',
    corrupt: 'Unreadable records',
    other: 'Other stored data',
  } as Record<string, string>)[category] ?? category
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]!
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]!
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}
