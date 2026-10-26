import { randomId } from '../../lib/random-id.js'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { DiffEditor } from '../../lib/monaco.js'
import { AlertCircle, ChevronDown, ChevronRight, Columns2, FileCode2, Folder, GitBranch, History, List, ListTree, Loader2, RefreshCw, Rows3 } from 'lucide-react'
import type { Socket } from 'socket.io-client'

import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  GitDiffResult,
  GitFileChange,
  GitStatusResult,
} from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { gitDiff, gitStatus } from '../../lib/git-client.js'
import { useTranslation } from 'react-i18next'
import { CommitHistory } from './CommitHistory.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

type SourceControlPanelProps = {
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId?: string | null
  cwd?: string
  fontSizePx?: number
}

type GitGroup = {
  id: string
  label: string
  files: GitFileChange[]
}

type GitTreeNode =
  | { kind: 'dir'; name: string; path: string; children: GitTreeNode[] }
  | { kind: 'file'; name: string; file: GitFileChange }

type GitTreeDraftNode =
  | { kind: 'dir'; name: string; path: string; children: Map<string, GitTreeDraftNode> }
  | { kind: 'file'; name: string; file: GitFileChange }

type GitViewMode = 'tree' | 'list'

const SOURCE_CONTROL_VIEW_MODE_PREFIX = 'ak-source-control-view-mode:'

const GIT_STATUS_LABEL: Record<GitFileChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflicted: 'U',
  typechanged: 'T',
}

function SourceControlPanelImpl({ socket, workspaceId, sessionId, cwd, fontSizePx = 12 }: SourceControlPanelProps): JSX.Element {
  const { t } = useTranslation()
  const tabsId = useId()
  const resourceKey = `${workspaceId ?? 'offline'}\0${cwd ?? ''}`
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [selected, setSelected] = useState<{ file: GitFileChange; staged: boolean } | null>(null)
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())
  const [viewMode, setViewMode] = useState<GitViewMode>(() => readGitViewMode(sourceControlViewModeKey(sessionId, workspaceId)))
  const statusGeneration = useRef(0)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // Socket.IO mutates connected in place; memoized props do not change when
  // an independently bound Session finishes connecting or reconnects.
  const [, refreshConnection] = useState(0)
  useEffect(() => {
    if (!socket) return
    const onConnectionChange = (): void => refreshConnection((revision) => revision + 1)
    socket.on('connect', onConnectionChange)
    socket.on('disconnect', onConnectionChange)
    onConnectionChange()
    return () => {
      socket.off('connect', onConnectionChange)
      socket.off('disconnect', onConnectionChange)
    }
  }, [socket])
  const online = Boolean(socket && workspaceId && socket.connected !== false)
  const viewModeKey = sourceControlViewModeKey(sessionId, workspaceId)

  const refresh = useCallback(async (): Promise<void> => {
    if (!socket || !workspaceId) return
    const generation = ++statusGeneration.current
    setLoading(true)
    const result = await requestGitStatus(socket, { workspaceId, sessionId: sessionIdRef.current ?? undefined, cwd })
    if (statusGeneration.current !== generation) return
    setStatus(result)
    setCollapsedDirs(new Set())
    setLoading(false)
  }, [cwd, resourceKey, socket, workspaceId])

  useEffect(() => {
    setStatus(null)
    setSelected(null)
    setLoading(false)
    if (online) void refresh()
    return () => { statusGeneration.current++ }
  }, [online, resourceKey, refresh])
  useEffect(() => { setViewMode(readGitViewMode(viewModeKey)) }, [viewModeKey])

  const groups = useMemo(() => groupGitFiles(status?.files ?? [], t), [status, t])
  const fileCount = status?.files.length ?? 0
  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const toggleViewMode = useCallback(() => {
    setViewMode((current) => {
      const next = current === 'tree' ? 'list' : 'tree'
      writeGitViewMode(viewModeKey, next)
      return next
    })
  }, [viewModeKey])

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground" data-testid="source-control-panel">
      <div className="flex-none space-y-3 border-b border-sidebar-border/50 bg-gradient-to-b from-muted/20 to-transparent p-3">
        <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-sidebar-border/60 bg-background/40 p-2.5 shadow-sm" data-testid="source-control-toolbar">
          <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-primary/10 text-primary"><GitBranch className="size-4" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 text-[10px] font-medium tracking-wide text-sidebar-foreground/50">{t('sourceControl.repository')}</div>
            <div className="truncate font-mono text-xs font-semibold text-sidebar-foreground" title={status?.repo?.branch ?? status?.repo?.head}>
              {status?.repo?.branch ?? status?.repo?.head ?? '—'}
            </div>
          </div>
          <div className="flex flex-none items-center gap-0.5 rounded-lg border border-sidebar-border/50 bg-sidebar/60 p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 flex-none rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              disabled={fileCount === 0}
              onClick={toggleViewMode}
              title={viewMode === 'tree' ? t('sourceControl.showList') : t('sourceControl.showTree')}
              aria-label={viewMode === 'tree' ? t('sourceControl.showList') : t('sourceControl.showTree')}
              aria-pressed={viewMode === 'tree'}
              data-testid="source-control-view-mode-toggle"
              data-view-mode={viewMode}
            >
              {viewMode === 'tree' ? <List className="size-3.5" /> : <ListTree className="size-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="size-7 flex-none rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground" disabled={!online || loading} onClick={() => void refresh()} title={t('sourceControl.refresh')} aria-label={t('sourceControl.refresh')}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/60 p-1" role="tablist" aria-label={t('sourceControl.repository')}>
          <button type="button" id={`${tabsId}-changes`} role="tab" aria-selected={tab === 'changes'} aria-controls={`${tabsId}-panel`} onClick={() => setTab('changes')} className={cn('flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === 'changes' ? 'bg-background text-sidebar-foreground shadow-sm ring-1 ring-sidebar-border/50 dark:bg-sidebar-accent' : 'text-sidebar-foreground/55 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground')}>
            <FileCode2 className="size-3.5 flex-none" aria-hidden="true" /><span className="truncate">{t('sourceControl.workingChanges')}</span>
            {fileCount > 0 ? <span className={cn('flex h-4 min-w-4 flex-none items-center justify-center rounded px-1 text-[10px] font-semibold tabular-nums', tab === 'changes' ? 'bg-primary/10 text-primary' : 'bg-sidebar-accent text-sidebar-foreground/60')}>{fileCount}</span> : null}
          </button>
          <button type="button" id={`${tabsId}-history`} role="tab" aria-selected={tab === 'history'} aria-controls={`${tabsId}-panel`} onClick={() => setTab('history')} className={cn('flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === 'history' ? 'bg-background text-sidebar-foreground shadow-sm ring-1 ring-sidebar-border/50 dark:bg-sidebar-accent' : 'text-sidebar-foreground/55 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground')}>
            <History className="size-3.5 flex-none" aria-hidden="true" /><span className="truncate">{t('sourceControl.history')}</span>
          </button>
        </div>
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} className="min-h-0 flex-1 overflow-auto p-2.5" style={{ fontSize: `${fontSizePx / 16}rem` }}>
        {tab === 'history' ? <CommitHistory socket={socket} workspaceId={workspaceId} cwd={cwd} /> : !online ? (
          <EmptyState message={t('sourceControl.offline')} />
        ) : loading && !status ? (
          <div className="flex min-h-28 items-center justify-center gap-2 p-3 text-xs text-sidebar-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('sourceControl.loadingChanges')}</div>
        ) : status?.error ? (
          <ErrorState message={status.error.message} />
        ) : fileCount === 0 ? (
          <EmptyState message={t('sourceControl.noChanges')} />
        ) : (
          <div className="space-y-2">
            {status?.truncated ? <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-caption text-amber-700 dark:text-amber-200">{t('sourceControl.truncatedFiles', { count: status.truncated.limit })}</div> : null}
            {groups.map((group) => (
              <div key={group.id}>
                <div className="mb-1 flex items-center justify-between gap-2 px-2 py-1.5 text-caption font-medium text-sidebar-foreground/60"><span>{group.label}</span><span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] tabular-nums text-sidebar-foreground/50">{group.files.length}</span></div>
                <div className="space-y-0.5">
                  {viewMode === 'tree' ? (
                    <GitFileTree
                      nodes={buildGitTree(group.files)}
                      collapsedDirs={collapsedDirs}
                      groupId={group.id}
                      depth={0}
                      onToggleDir={toggleDir}
                      onOpen={(file) => setSelected({ file, staged: group.id === 'staged' })}
                    />
                  ) : (
                    group.files.map((file) => (
                      <GitFileRow
                        key={`${group.id}:list:${file.path}:${file.oldPath ?? ''}`}
                        file={file}
                        depth={0}
                        label="path"
                        onOpen={() => setSelected({ file, staged: group.id === 'staged' })}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <GitDiffDialog
        open={selected !== null}
        onOpenChange={(open) => { if (!open) setSelected(null) }}
        socket={socket}
        workspaceId={workspaceId}
        sessionId={sessionId ?? undefined}
        cwd={cwd}
        target={selected}
      />
    </div>
  )
}

export const SourceControlPanel = memo(SourceControlPanelImpl)

function GitFileTree({
  nodes,
  collapsedDirs,
  groupId,
  depth,
  onToggleDir,
  onOpen,
}: {
  nodes: readonly GitTreeNode[]
  collapsedDirs: ReadonlySet<string>
  groupId: string
  depth: number
  onToggleDir: (path: string) => void
  onOpen: (file: GitFileChange) => void
}): JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const collapsed = collapsedDirs.has(node.path)
          return (
            <div key={`${groupId}:dir:${node.path}`}>
              <GitDirRow node={node} depth={depth} collapsed={collapsed} onToggle={() => onToggleDir(node.path)} />
              {!collapsed ? (
                <GitFileTree
                  nodes={node.children}
                  collapsedDirs={collapsedDirs}
                  groupId={groupId}
                  depth={depth + 1}
                  onToggleDir={onToggleDir}
                  onOpen={onOpen}
                />
              ) : null}
            </div>
          )
        }
        return <GitFileRow key={`${groupId}:file:${node.file.path}:${node.file.oldPath ?? ''}`} file={node.file} depth={depth} label="basename" onOpen={() => onOpen(node.file)} />
      })}
    </>
  )
}

function GitDirRow({ node, depth, collapsed, onToggle }: { node: Extract<GitTreeNode, { kind: 'dir' }>; depth: number; collapsed: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-left text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ paddingLeft: `${0.375 + depth * 0.875}rem` }}
      onClick={onToggle}
      title={node.path}
      aria-expanded={!collapsed}
      data-testid="source-control-dir"
    >
      {collapsed ? <ChevronRight className="h-3.5 w-3.5 flex-none text-sidebar-foreground/50" /> : <ChevronDown className="h-3.5 w-3.5 flex-none text-sidebar-foreground/50" />}
      <Folder className="h-3.5 w-3.5 flex-none text-sidebar-foreground/55" />
      <span className="min-w-0 flex-1 truncate font-mono text-[0.95em]">{node.name}</span>
    </button>
  )
}

function GitFileRow({ file, depth, label, onOpen }: { file: GitFileChange; depth: number; label: 'basename' | 'path'; onOpen: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-left transition-colors hover:bg-sidebar-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ paddingLeft: `${0.375 + depth * 0.875}rem` }}
      onClick={onOpen}
      title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
      data-testid="source-control-file"
    >
      <span className={cn('flex h-4 w-4 flex-none items-center justify-center rounded text-caption font-semibold', statusBadgeClass(file.status))}>{GIT_STATUS_LABEL[file.status]}</span>
      <FileCode2 className="h-3.5 w-3.5 flex-none text-sidebar-foreground/55" />
      <span className="min-w-0 flex-1 truncate font-mono text-[0.95em]">{label === 'basename' ? basename(file.path) : file.path}</span>
    </button>
  )
}

function GitDiffDialog({ open, onOpenChange, socket, workspaceId, sessionId, cwd, target }: { open: boolean; onOpenChange: (open: boolean) => void; socket: DashboardSocket | null; workspaceId?: string; sessionId?: string; cwd?: string; target: { file: GitFileChange; staged: boolean } | null }): JSX.Element {
  const { t } = useTranslation()
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [renderSideBySide, setRenderSideBySide] = useState(true)
  const path = target?.file.path

  useEffect(() => {
    if (!open) return
    if (window.innerWidth < 640) setRenderSideBySide(false)
  }, [open])

  useEffect(() => {
    if (!open || !socket || !workspaceId || !target) return
    let cancelled = false
    setLoading(true)
    setDiff(null)
    requestGitDiff(socket, { workspaceId, sessionId, cwd, path: target.file.path, staged: target.staged }).then((result) => {
      if (cancelled) return
      setDiff(result)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, socket, workspaceId, sessionId, cwd, target])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[96vw] max-w-[min(1180px,96vw)] gap-0 overflow-hidden p-0" data-testid="source-control-diff-dialog">
        <DialogHeader className="border-b border-border px-3 py-2.5 pr-10 sm:px-4">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate font-mono text-sm font-medium">{path ?? t('sourceControl.gitDiff')}</DialogTitle>
              <DialogDescription className="text-xs">{t('sourceControl.diffDescription')}</DialogDescription>
            </div>
            <div className="grid w-fit flex-none grid-cols-2 rounded-md border border-border bg-muted/40 p-0.5" aria-label={t('sourceControl.diffLayout')}>
              <button
                type="button"
                className={cn('flex h-7 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium', renderSideBySide ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
                onClick={() => setRenderSideBySide(true)}
                aria-pressed={renderSideBySide}
                data-testid="source-control-diff-side-by-side"
              >
                <Columns2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('sourceControl.sideBySide')}</span>
              </button>
              <button
                type="button"
                className={cn('flex h-7 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium', !renderSideBySide ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
                onClick={() => setRenderSideBySide(false)}
                aria-pressed={!renderSideBySide}
                data-testid="source-control-diff-inline"
              >
                <Rows3 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('sourceControl.inline')}</span>
              </button>
            </div>
          </div>
        </DialogHeader>
        <div className="h-[min(68dvh,760px)] min-h-0 sm:h-[min(74dvh,760px)]">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('sourceControl.loadingDiff')}</div>
          ) : diff?.error ? (
            <DiffError message={diff.error.message} />
          ) : diff ? (
            <div className="flex h-full min-h-0 flex-col">
              {diff.truncated ? <div className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('sourceControl.truncatedDiff', { size: formatBytes(diff.truncated.maxBytes) })}</div> : null}
              <div className="min-h-0 flex-1">
                <DiffEditor
                  original={diff.oldText ?? ''}
                  modified={diff.newText ?? ''}
                  language={diff.language ?? 'plaintext'}
                  theme="vs-dark"
                  options={{ readOnly: true, renderSideBySide, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true }}
                />
              </div>
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">{t('sourceControl.selectFile')}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function groupGitFiles(files: readonly GitFileChange[], t: ReturnType<typeof useTranslation>['t']): GitGroup[] {
  const conflicts = files.filter((file) => file.status === 'conflicted')
  const staged = files.filter((file) => file.staged && file.status !== 'conflicted')
  const untracked = files.filter((file) => file.status === 'untracked')
  const changes = files.filter((file) => file.unstaged && file.status !== 'untracked' && file.status !== 'conflicted')
  return [
    { id: 'staged', label: t('sourceControl.groups.staged'), files: staged },
    { id: 'changes', label: t('sourceControl.groups.changes'), files: changes },
    { id: 'untracked', label: t('sourceControl.groups.untracked'), files: untracked },
    { id: 'conflicts', label: t('sourceControl.groups.conflicts'), files: conflicts },
  ].filter((group) => group.files.length > 0)
}

function buildGitTree(files: readonly GitFileChange[]): GitTreeNode[] {
  const root = new Map<string, GitTreeDraftNode>()
  for (const file of [...files].sort(compareGitPath)) {
    const parts = file.path.split('/').filter(Boolean)
    const fileName = parts.pop() ?? file.path
    let current = root
    let currentPath = ''
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let node = current.get(part)
      if (!node || node.kind !== 'dir') {
        node = { kind: 'dir', name: part, path: currentPath, children: new Map() }
        current.set(part, node)
      }
      current = node.children
    }
    current.set(fileName, { kind: 'file', name: fileName, file })
  }
  return finalizeTreeNodes([...root.values()])
}

function finalizeTreeNodes(nodes: GitTreeDraftNode[]): GitTreeNode[] {
  return nodes
    .map((node): GitTreeNode => node.kind === 'dir'
      ? { kind: 'dir', name: node.name, path: node.path, children: finalizeTreeNodes([...node.children.values()]) }
      : node)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
}

function compareGitPath(a: GitFileChange, b: GitFileChange): number {
  return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function sourceControlViewModeKey(sessionId: string | null | undefined, workspaceId: string | undefined): string {
  if (sessionId) return `${SOURCE_CONTROL_VIEW_MODE_PREFIX}session:${sessionId}`
  if (workspaceId) return `${SOURCE_CONTROL_VIEW_MODE_PREFIX}workspace:${workspaceId}`
  return `${SOURCE_CONTROL_VIEW_MODE_PREFIX}global`
}

function readGitViewMode(key: string): GitViewMode {
  try {
    const stored = localStorage.getItem(key)
    return stored === 'list' ? 'list' : 'tree'
  } catch {
    return 'tree'
  }
}

function writeGitViewMode(key: string, mode: GitViewMode): void {
  try {
    localStorage.setItem(key, mode)
  } catch {
    // Ignore storage failures; the view toggle still works for this render.
  }
}

function statusBadgeClass(status: GitFileChange['status']): string {
  if (status === 'added' || status === 'untracked') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
  if (status === 'deleted') return 'bg-rose-500/15 text-rose-600 dark:text-rose-300'
  if (status === 'conflicted') return 'bg-amber-500/15 text-amber-700 dark:text-amber-200'
  return 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
}

function EmptyState({ message }: { message: string }): JSX.Element {
  return <div className="m-1 flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-sidebar-border/70 bg-muted/15 px-6 text-center text-xs leading-relaxed text-sidebar-foreground/55"><span className="flex size-11 items-center justify-center rounded-2xl bg-sidebar-accent/60"><GitBranch className="size-5 text-sidebar-foreground/45" aria-hidden="true" /></span><span>{message}</span></div>
}

function ErrorState({ message }: { message: string }): JSX.Element {
  return <div className="flex min-h-28 items-center justify-center gap-2 px-4 text-center text-xs text-sidebar-foreground/70"><AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none text-amber-500" /><span className="min-w-0 break-words">{message}</span></div>
}

function DiffError({ message }: { message: string }): JSX.Element {
  return <div className="flex gap-2 p-4 text-sm text-muted-foreground"><AlertCircle className="mt-0.5 h-4 w-4 flex-none text-amber-500" /><span className="min-w-0 break-words">{message}</span></div>
}

async function requestGitStatus(socket: DashboardSocket, payload: { workspaceId: string; sessionId?: string; cwd?: string }): Promise<GitStatusResult> {
  const requestId = randomId()
  try {
    return await gitStatus(socket, { requestId, ...payload })
  } catch (error) {
    return { requestId, workspaceId: payload.workspaceId, files: [], error: { code: 'executor_unavailable', message: error instanceof Error ? error.message : 'Workspace Executor is unavailable.' } }
  }
}

async function requestGitDiff(socket: DashboardSocket, payload: { workspaceId: string; sessionId?: string; cwd?: string; path: string; staged: boolean }): Promise<GitDiffResult> {
  const requestId = randomId()
  try {
    return await gitDiff(socket, { requestId, ...payload })
  } catch (error) {
    return { requestId, workspaceId: payload.workspaceId, error: { code: 'executor_unavailable', message: error instanceof Error ? error.message : 'Workspace Executor is unavailable.' } }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
