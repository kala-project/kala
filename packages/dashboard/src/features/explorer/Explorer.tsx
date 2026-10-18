/**
 * Explorer — single left column that fuses the old Workspaces/Sessions
 * columns into a two-level tree: workspace parents with session children.
 *
 * "Workspace" here is the machine a session's tool calls run on
 * (see ADR 0013): a stable ULID that the executor announces on connect.
 * Sessions whose parent workspace has no attached executor are shown offline;
 * sessions without a workspaceId are ordinary chats and group under "Chats".
 */

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefCallback } from 'react'
import { createPortal } from 'react-dom'
import useMeasure from 'react-use-measure'
import { NodeApi, Tree } from 'react-arborist'
import type { NodeRendererProps, RowRendererProps } from 'react-arborist'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  GripVertical,
  GitFork,
  Info,
  LoaderCircle,
  Sparkles,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SquarePen,
  SquareTerminal,
  TriangleAlert,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js'
import { Button } from '../../components/ui/button.js'
import {
  PREF_AUTO_HIDE_OFFLINE_WORKSPACES,
  PREF_HIDE_SUB_AGENT_SESSIONS,
  PREF_SESSION_CHILDREN_OPEN,
  PREF_SESSION_ORDER,
  PREF_WORKSPACE_OPEN,
  PREF_WORKSPACE_ORDER,
  useBooleanPref,
} from '../../lib/prefs.js'
import { cn } from '../../lib/utils.js'
import { staticAssetUrl } from '../../lib/static-asset-url.js'
import { useMinuteClock } from '../../lib/minute-clock.js'
import {
  applyManualSessionOrder,
  applyManualWorkspaceOrder,
  buildInitialOpenState,
  buildTree,
  filterTree,
  isRootDropParent,
  reorderSessionIds,
  reorderWorkspaceIds,
  sessionStructureKeyFor,
  syncSessionOrder,
  syncWorkspaceOrder,
  toStructuralSessionSummary,
  workspaceDropIndex,
} from './tree-model.js'
import { useHiddenWorkspaces } from './useHiddenWorkspaces.js'
import { useHiddenSessions } from './useHiddenSessions.js'
import { SessionHoverPreview, type SessionPreviewAnchor } from './SessionHoverPreview.js'
import { useSessionHoverPreview } from './use-session-hover-preview.js'
import type { SessionPreviewStore } from './session-preview-store.js'
import type { CachedSessionView } from '../../session-view-cache.js'
import type {
  SessionNode,
  TreeNode,
  WorkspaceNode,
} from './tree-model.js'
import { readStoredSessionChildrenOpenState, readStoredSessionOrder, readStoredWorkspaceOpenState, readStoredWorkspaceOrder, writeStoredSessionChildrenOpenState, writeStoredSessionOrder, writeStoredWorkspaceOpenState, writeStoredWorkspaceOrder } from './persistence.js'
import { coarseSummaryStatus, isSessionWorkspaceOnline, sameExecutorListForExplorer, sameSessionListForExplorer, sameSessionStatusMap } from './comparators.js'
import { SessionRuntimeStore, useSessionRuntime } from './session-runtime-store.js'
import { useInterfaceScale } from '../../lib/interface-scale.js'

type Props = {
  executors: readonly AttachedExecutor[]
  sessions: readonly SessionSummary[]
  loading?: boolean
  /** Private Cloud should not hide historical sessions when their old Executor is offline. */
  autoHideOfflineWorkspacesByDefault?: boolean
  selectedSessionId: string | null
  sessionStatuses?: ReadonlyMap<string, SessionActivityStatus>
  onSelect(sessionId: string): void
  onClearSelection?(): void
  onNewSession(workspaceId?: string): void
  onConnectWorkspace?(): void
  onDelete(sessionId: string): void
  onRename(sessionId: string, label: string): void
  onRenameWorkspace?(workspaceId: string, workspaceName: string): void
  onOpenSessionInfo?(sessionId: string): void
  onWorkspaceInfo?(workspaceId: string): void
  onOpenWorkspaceTerminal?(workspace: WorkspaceNode): void
  onCollapse?(): void
  embeddedHeader?: boolean
  headerLeading?: ReactElement
  fontSizePx?: number
  previewStore?: SessionPreviewStore
  getCachedSessionView?: (sessionId: string) => CachedSessionView | null
  subscribeCachedSessionView?: (sessionId: string, listener: () => void) => () => void
}

const SESSION_ROW_HEIGHT = 38
const WORKSPACE_ROW_HEIGHT = 36
const PHONE_SESSION_ROW_HEIGHT = 56
const PHONE_WORKSPACE_ROW_HEIGHT = 54
const EXPLORER_ROW_GRID = 'ak-session-row grid items-center gap-x-2.5'
const WORKSPACE_ROW_GRID = 'grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2.5'
const EXPLORER_RAIL_CELL = 'flex h-5 w-5 flex-none items-center justify-center'

export type SessionActivityStatus = SessionSummary['status'] | 'loading'

function ExplorerImpl({
  executors,
  sessions,
  loading = false,
  autoHideOfflineWorkspacesByDefault = true,
  selectedSessionId,
  sessionStatuses,
  onSelect,
  onClearSelection,
  onNewSession,
  onConnectWorkspace,
  onDelete,
  onRename,
  onRenameWorkspace,
  onOpenSessionInfo,
  onWorkspaceInfo,
  onOpenWorkspaceTerminal,
  onCollapse,
  embeddedHeader = false,
  headerLeading,
  fontSizePx = 13,
  previewStore,
  getCachedSessionView,
  subscribeCachedSessionView,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const interfaceScale = useInterfaceScale()
  const [phoneLayout, setPhoneLayout] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 640)
  useEffect(() => {
    const update = (): void => setPhoneLayout(window.innerWidth <= 640)
    window.addEventListener('resize', update)
    update()
    return () => window.removeEventListener('resize', update)
  }, [])
  const rowHeightFor = useCallback((node: NodeApi<TreeNode>): number => {
    const workspace = node.data.kind === 'workspace'
    const height = phoneLayout
      ? workspace ? PHONE_WORKSPACE_ROW_HEIGHT : PHONE_SESSION_ROW_HEIGHT
      : workspace ? WORKSPACE_ROW_HEIGHT : SESSION_ROW_HEIGHT
    return Math.ceil(Math.max(height * interfaceScale, fontSizePx * 1.4 + 9 * interfaceScale))
  }, [fontSizePx, interfaceScale, phoneLayout])
  const [pendingDelete, setPendingDelete] = useState<SessionNode | null>(null)
  const [deleteConfirmationStep, setDeleteConfirmationStep] = useState<'review' | 'final'>('review')
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [workspaceOpenState, setWorkspaceOpenState] = useState<Record<string, boolean>>(() => readStoredWorkspaceOpenState())
  const [sessionChildrenOpenState, setSessionChildrenOpenState] = useState<Record<string, boolean>>(() => readStoredSessionChildrenOpenState())
  const [manualWorkspaceOrder, setManualWorkspaceOrder] = useState<readonly string[]>(() => readStoredWorkspaceOrder())
  const preview = useSessionHoverPreview(selectedSessionId)
  const pointerActivatedSessionRef = useRef<string | null>(null)
  const hiddenWorkspaces = useHiddenWorkspaces()
  const [autoHideOfflineWorkspaces] = useBooleanPref(PREF_AUTO_HIDE_OFFLINE_WORKSPACES, autoHideOfflineWorkspacesByDefault)
  const [hideSubAgentSessions] = useBooleanPref(PREF_HIDE_SUB_AGENT_SESSIONS, true)
  const [ref, bounds] = useMeasure({ debounce: 30 })

  const [manualSessionOrder, setManualSessionOrder] = useState<readonly string[]>(() =>
    syncSessionOrder(readStoredSessionOrder(), sessions),
  )
  const sessionStructureKey = useMemo(() => sessions.map(sessionStructureKeyFor).join('\u001f'), [sessions])
  const structuralSessions = useMemo(
    () => sessions.map(toStructuralSessionSummary),
    [sessionStructureKey],
  )
  const sessionRuntimeStoreRef = useRef<SessionRuntimeStore | null>(null)
  if (sessionRuntimeStoreRef.current === null) sessionRuntimeStoreRef.current = new SessionRuntimeStore()
  const sessionRuntimeStore = sessionRuntimeStoreRef.current
  // Notify row subscribers before paint, never while rendering ExplorerImpl:
  // render-time store notifications trigger React cross-component updates.
  useLayoutEffect(() => {
    sessionRuntimeStore.sync(sessions, sessionStatuses)
  }, [sessionRuntimeStore, sessions, sessionStatuses])
  useEffect(() => {
    setManualSessionOrder((prev) => syncSessionOrder(prev, structuralSessions))
  }, [structuralSessions])
  useEffect(() => {
    writeStoredSessionOrder(manualSessionOrder)
  }, [manualSessionOrder])
  const orderedSessions = useMemo(
    () => applyManualSessionOrder(structuralSessions, manualSessionOrder),
    [structuralSessions, manualSessionOrder],
  )
  const hiddenSessions = useHiddenSessions()
  // Hidden sessions are filtered out of the tree entirely (a local UI filter,
  // like hidden workspaces). Forked children of a hidden session re-parent to
  // the workspace root via buildTree's missing-parent handling.
  const visibleOrderedSessions = useMemo(
    () => orderedSessions.filter((s) =>
      !hiddenSessions.isHidden(s.sessionId) &&
      (!hideSubAgentSessions || !s.parentSessionId || s.sessionId === selectedSessionId),
    ),
    [orderedSessions, hiddenSessions, hideSubAgentSessions, selectedSessionId],
  )
  // Hidden session id → display label, for the "hidden sessions" unhide bar.
  const hiddenSessionEntries = useMemo(
    () =>
      sessions
        .filter((s) => hiddenSessions.isHidden(s.sessionId))
        .map((s) => ({
          sessionId: s.sessionId,
          label: (s.label?.trim() || s.firstUserMessage?.trim() || s.sessionId),
        })),
    [sessions, hiddenSessions],
  )
  const treeData = useMemo(
    () => buildTree(executors, visibleOrderedSessions),
    [executors, visibleOrderedSessions],
  )
  useEffect(() => {
    setManualWorkspaceOrder((prev) => syncWorkspaceOrder(prev, treeData))
  }, [treeData])
  useEffect(() => {
    writeStoredWorkspaceOrder(manualWorkspaceOrder)
  }, [manualWorkspaceOrder])
  const data = useMemo(
    () => applyManualWorkspaceOrder(treeData, manualWorkspaceOrder),
    [treeData, manualWorkspaceOrder],
  )
  const onlineWorkspaceIds = useMemo(
    () => new Set(executors.map((executor) => executor.workspaceId).filter((id): id is string => typeof id === 'string' && id.length > 0)),
    [executors],
  )
  const hiddenWorkspaceRows = useMemo(
    () => data.filter((workspace) => workspace.workspaceId !== null && hiddenWorkspaces.isHidden(workspace.workspaceId)),
    [data, hiddenWorkspaces],
  )
  const visibleWorkspaceData = useMemo(
    () => data.filter((workspace) =>
      workspace.workspaceId === null ||
      (!hiddenWorkspaces.isHidden(workspace.workspaceId) &&
        (!autoHideOfflineWorkspaces || workspace.online || workspaceContainsSession(workspace, selectedSessionId))),
    ),
    [data, hiddenWorkspaces, autoHideOfflineWorkspaces, selectedSessionId],
  )
  const deferredQuery = useDeferredValue(query)
  const visibleData = useMemo(() => filterTree(visibleWorkspaceData, deferredQuery), [visibleWorkspaceData, deferredQuery])
  const initialOpenState = useMemo(
    () => buildInitialOpenState(visibleData, workspaceOpenState, sessionChildrenOpenState),
    [visibleData, workspaceOpenState, sessionChildrenOpenState],
  )
  const pendingDeleteDescendantCount = pendingDelete
    ? countSessionSummaryDescendants(sessions, pendingDelete.sessionId)
    : 0

  const empty = executors.length === 0 && sessions.length === 0
  const filteredEmpty = !empty && query.trim().length > 0 && visibleData.length === 0
  const hiddenEmpty = !empty && query.trim().length === 0 && visibleData.length === 0 && hiddenWorkspaces.count > 0
  const selection = selectedSessionId ? `sess:${selectedSessionId}` : undefined
  const activate = (node: NodeApi<TreeNode>): void => {
    if (node.data.kind !== 'session') return
    if (pointerActivatedSessionRef.current === node.data.sessionId) {
      pointerActivatedSessionRef.current = null
      return
    }
    onSelect(node.data.sessionId)
  }
  const activateSessionOnPointerDown = useCallback((sessionId: string): void => {
    // A running Session can commit between pointerdown and click. If that
    // commit replaces a virtualized row, the browser drops the click that
    // react-arborist normally turns into onActivate. Honor the discrete
    // pointerdown immediately and suppress the matching normal activation.
    pointerActivatedSessionRef.current = sessionId
    onSelect(sessionId)
  }, [onSelect])

  const handleMove = useCallback((args: {
    dragIds: string[]
    dragNodes: NodeApi<TreeNode>[]
    parentId: string | null
    parentNode: NodeApi<TreeNode> | null
    index: number
  }) => {
    const movedWorkspaces = args.dragNodes
      .map((node) => node.data)
      .filter((node): node is WorkspaceNode => node.kind === 'workspace' && node.workspaceId !== null)
    if (movedWorkspaces.length > 0) {
      if (movedWorkspaces.length !== args.dragNodes.length || !isRootDropParent(args.parentNode)) return
      const targetIds = visibleData
        .filter((node) => node.workspaceId !== null)
        .map((node) => node.workspaceId as string)
      const movedIds = movedWorkspaces.map((node) => node.workspaceId as string)
      setManualWorkspaceOrder((prev) => reorderWorkspaceIds(prev, targetIds, movedIds, workspaceDropIndex(visibleData, args.index, movedIds)))
      return
    }
    const movedSessionIds = args.dragNodes
      .map((node) => node.data)
      .filter((node): node is SessionNode => node.kind === 'session')
      .map((node) => node.sessionId)
    if (movedSessionIds.length === 0) return
    const parent = args.parentNode?.data
    if (!parent || parent.kind !== 'workspace') return
    const targetWorkspaceId = parent.workspaceId ?? undefined
    const targetIds = parent.children
      .filter((node) => node.kind === 'session' && node.parentSessionId === undefined && node.workspaceId === targetWorkspaceId)
      .map((node) => node.sessionId)
    const movableIds = movedSessionIds.filter((id) => targetIds.includes(id))
    if (movableIds.length === 0) return
    setManualSessionOrder((prev) => reorderSessionIds(prev, targetIds, movableIds, args.index))
  }, [visibleData])

  // react-arborist treats its child renderer as a component type. An inline
  // function gives it a new type on every Explorer update, remounting every
  // visible row and resetting long-running spinner animations.
  const renderTreeNode = useCallback(({ node, style, dragHandle }: NodeRendererProps<TreeNode>) => (
    <Row
      node={node}
      style={style}
      dragHandle={dragHandle}
      editingSessionId={editingSessionId}
      onDeleteRequest={(sess) => {
        setPendingDelete(sess)
        setDeleteConfirmationStep('review')
      }}
      onStartEdit={(sess) => {
        if (!isSessionWorkspaceOnline(sess, onlineWorkspaceIds)) return
        setEditingSessionId(sess.sessionId)
      }}
      onCancelEdit={() => setEditingSessionId(null)}
      onSubmitEdit={(sess, next) => {
        setEditingSessionId(null)
        if (next.trim() !== sess.label.trim()) onRename(sess.sessionId, next)
      }}
      onOpenSessionInfo={onOpenSessionInfo}
      onHideSession={hiddenSessions.hide}
      onWorkspaceInfo={onWorkspaceInfo}
      onOpenWorkspaceTerminal={onOpenWorkspaceTerminal}
      onHideWorkspace={hiddenWorkspaces.hide}
      editingWorkspaceId={editingWorkspaceId}
      onStartWorkspaceEdit={(workspace) => setEditingWorkspaceId(workspace.workspaceId)}
      onCancelWorkspaceEdit={() => setEditingWorkspaceId(null)}
      onSubmitWorkspaceEdit={(workspace, next) => {
        setEditingWorkspaceId(null)
        if (workspace.workspaceId !== null && next.trim() !== workspace.name.trim()) {
          onRenameWorkspace?.(workspace.workspaceId, next)
        }
      }}
      onNewSession={onNewSession}
      query={query}
      sessionRuntimeStore={sessionRuntimeStore}
      onlineWorkspaceIds={onlineWorkspaceIds}
      fontSizePx={fontSizePx}
      onPreviewAnchorChange={preview.enter}
      onPreviewLeave={preview.leave}
      onPointerActivateSession={activateSessionOnPointerDown}
    />
  ), [editingSessionId, onlineWorkspaceIds, onRename, onOpenSessionInfo,
    hiddenSessions.hide, onWorkspaceInfo, onOpenWorkspaceTerminal,
    hiddenWorkspaces.hide, editingWorkspaceId, onRenameWorkspace, onNewSession,
    query, sessionRuntimeStore, fontSizePx, preview.enter, preview.leave,
    activateSessionOnPointerDown])

  return (
    <div ref={preview.explorerRef} className="@container flex h-full min-w-0 flex-col overflow-hidden bg-transparent text-foreground">
      <Header query={query} onQueryChange={setQuery} onNewSession={onNewSession} onConnectWorkspace={onConnectWorkspace} onCollapse={onCollapse} embedded={embeddedHeader} leading={headerLeading} />
      <div
        ref={ref}
        className="flex-1 min-h-0"
        data-testid="explorer-column"
        data-scroll-owner="react-arborist"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          onClearSelection?.()
        }}
      >
        {loading ? (
          <ExplorerLoading />
        ) : empty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground">
            {t('explorer.noChats')}
          </div>
        ) : filteredEmpty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground" data-testid="explorer-filter-empty">
            {t('explorer.noMatches', { query: query.trim() })}
          </div>
        ) : hiddenEmpty ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground" data-testid="explorer-hidden-empty">
            {t('explorer.allWorkspacesHidden')}
          </div>
        ) : bounds.height > 0 ? (
          <Tree<TreeNode>
            data={visibleData as unknown as TreeNode[]}
            childrenAccessor={(d) => {
              if (d.kind === 'workspace') return d.children
              return d.children.length > 0 ? d.children : null
            }}
            idAccessor="id"
            openByDefault
            initialOpenState={initialOpenState}
            onToggle={(id) => {
              if (id.startsWith('ws:')) {
                setWorkspaceOpenState((prev) => {
                  const next = { ...prev, [id]: !(prev[id] ?? true) }
                  writeStoredWorkspaceOpenState(next)
                  return next
                })
                return
              }
              if (id.startsWith('sess:')) {
                setSessionChildrenOpenState((prev) => {
                  const next = { ...prev, [id]: !(prev[id] ?? false) }
                  writeStoredSessionChildrenOpenState(next)
                  return next
                })
              }
            }}
            disableDrag={(d) => d.kind === 'workspace' ? d.workspaceId === null : d.parentSessionId !== undefined}
            disableDrop={({ parentNode, dragNodes }) => {
              const allWorkspaces = dragNodes.every((node) => node.data.kind === 'workspace')
              if (allWorkspaces) return !isRootDropParent(parentNode) || dragNodes.some((node) => node.data.kind === 'workspace' && node.data.workspaceId === null)
              if (parentNode.data.kind !== 'workspace') return true
              const targetWorkspaceId = parentNode.data.workspaceId ?? undefined
              return dragNodes.some((node) => {
                const data = node.data
                return data.kind !== 'session' || data.parentSessionId !== undefined || data.workspaceId !== targetWorkspaceId
              })
            }}
            disableEdit
            disableMultiSelection
            disableSelect={(d) => d.kind !== 'session'}
            selection={selection}
            onActivate={activate}
            onMove={handleMove}
            renderRow={TreeRow}
            rowHeight={rowHeightFor}
            indent={8}
            width={bounds.width}
            height={bounds.height}
          >
            {renderTreeNode}
          </Tree>
        ) : null}
        <SessionHoverPreview
          anchor={preview.anchor}
          previewRef={preview.previewRef}
          previewStore={previewStore}
          getCachedSessionView={getCachedSessionView}
          subscribeCachedSessionView={subscribeCachedSessionView}
          onHoverChange={preview.hoverPreview}
        />
      </div>
      {hiddenWorkspaces.count > 0 || hiddenSessions.count > 0 ? (
        <HiddenItemsBar
          workspaces={hiddenWorkspaceRows}
          hiddenIds={hiddenWorkspaces.hiddenIds}
          sessions={hiddenSessionEntries}
          onUnhideWorkspace={hiddenWorkspaces.unhide}
          onUnhideSession={hiddenSessions.unhide}
        />
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null)
            setDeleteConfirmationStep('review')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteConfirmationStep === 'review' ? t('explorer.deleteTitle') : t('explorer.deleteFinalTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">
                {pendingDelete?.label ?? ''}
              </span>
              <br />
              {t('explorer.deleteDescription')}
              {pendingDeleteDescendantCount > 0 ? (
                <>
                  <br />
                  <span className="mt-2 block text-amber-700 dark:text-amber-300">
                    {t('explorer.deleteChildrenDescription', { count: pendingDeleteDescendantCount })}
                  </span>
                </>
              ) : null}
              {deleteConfirmationStep === 'final' ? (
                <>
                  <br />
                  <span className="mt-2 block font-medium text-foreground">
                    {t('explorer.deleteFinalDescription')}
                  </span>
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            {deleteConfirmationStep === 'review' ? (
              <AlertDialogAction
                data-testid="confirm-delete-button"
                onClick={(event) => {
                  event.preventDefault()
                  setDeleteConfirmationStep('final')
                }}
              >
                {t('common.continue')}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                data-testid="confirm-delete-final-button"
                onClick={() => {
                  if (pendingDelete) onDelete(pendingDelete.sessionId)
                  setPendingDelete(null)
                  setDeleteConfirmationStep('review')
                }}
              >
                {t('explorer.delete')}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export const Explorer = memo(ExplorerImpl, areExplorerPropsEqual)

function workspaceContainsSession(workspace: WorkspaceNode, sessionId: string | null): boolean {
  if (!sessionId) return false
  const contains = (sessions: readonly SessionNode[]): boolean =>
    sessions.some((session) => session.sessionId === sessionId || contains(session.children))
  return contains(workspace.children)
}

function countSessionSummaryDescendants(sessions: readonly SessionSummary[], sessionId: string): number {
  const childIds = sessions
    .filter((session) => session.parentSessionId === sessionId)
    .map((session) => session.sessionId)
  return childIds.reduce(
    (count, childId) => count + 1 + countSessionSummaryDescendants(sessions, childId),
    0,
  )
}

/**
 * Returns true when the event originated inside an interactive control (button,
 * link, form field) or an element explicitly opted out of row activation via
 * `data-row-action`. Such clicks must run their own handler only and never
 * trigger react-arborist row selection/activation (which would switch session).
 */
function isRowActionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [role="button"], [data-row-action]',
    ),
  )
}

function TreeRow({ node, attrs, innerRef, children }: RowRendererProps<TreeNode>): ReactElement {
  return (
    <div
      {...attrs}
      ref={innerRef as RefCallback<HTMLDivElement>}
      onFocus={(e) => e.stopPropagation()}
      onClick={(e) => {
        // Guard: clicks on row action controls (rename/info/hide/delete, etc.)
        // must not activate the row and switch the selected session.
        if (isRowActionTarget(e.target)) return
        node.handleClick(e)
      }}
      className={cn(attrs.className, 'min-w-0 max-w-full overflow-hidden')}
      style={{ ...attrs.style, minWidth: 0, width: '100%' }}
    >
      {children}
    </div>
  )
}

function ExplorerLoading(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 p-3" data-testid="explorer-loading">
      <div className="flex items-center gap-2 rounded-lg bg-background/45 px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <span className="ak-loading-spinner h-3.5 w-3.5" aria-hidden="true" />
        <span>{t('app.loadingSessions')}</span>
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="ak-explorer-loading-row overflow-hidden rounded-lg bg-background/35 px-3 py-2"
          style={{ animationDelay: `${i * 70}ms` }}
        >
          <div className="flex items-center gap-2">
            <span className="h-7 w-7 rounded-md bg-muted/80" />
            <span className="h-2.5 w-24 rounded-full bg-muted/80" />
          </div>
          <div className="ml-9 mt-2 h-2 w-32 rounded-full bg-muted/50" />
        </div>
      ))}
    </div>
  )
}

function HiddenItemsBar({
  workspaces,
  hiddenIds,
  sessions,
  onUnhideWorkspace,
  onUnhideSession,
}: {
  workspaces: readonly WorkspaceNode[]
  hiddenIds: ReadonlySet<string>
  sessions: readonly { sessionId: string; label: string }[]
  onUnhideWorkspace(workspaceId: string): void
  onUnhideSession(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const restoredIds = new Set(workspaces.map((workspace) => workspace.workspaceId).filter((id): id is string => typeof id === 'string' && id.length > 0))
  const missingIds = Array.from(hiddenIds).filter((id) => !restoredIds.has(id))
  const workspaceCount = workspaces.length + missingIds.length
  const hiddenCount = workspaceCount + sessions.length
  return (
    <div className="relative z-10 flex-none border-t border-border/35 bg-card px-1.5 py-1" data-testid="hidden-items-bar">
      <button
        type="button"
        className="flex min-h-11 w-full min-w-0 items-center gap-1 rounded-md px-1 text-left text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        data-testid="hidden-items-toggle"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3 flex-none" aria-hidden="true" /> : <ChevronRight className="h-3 w-3 flex-none" aria-hidden="true" />}
        <EyeOff className="h-3 w-3 flex-none" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {t('explorer.hiddenItems', { count: hiddenCount })}
        </span>
      </button>
      {open ? (
        <div className="mt-1 max-h-[min(40vh,16rem)] space-y-2 overflow-y-auto overscroll-contain px-1 pb-1" data-testid="hidden-items-list">
          {workspaceCount > 0 ? <section data-testid="hidden-workspaces-group">
            <div className="px-1 pb-0.5 text-meta font-semibold uppercase tracking-wider text-muted-foreground">{t('explorer.hiddenWorkspacesGroup', { count: workspaceCount })}</div>
            {workspaces.map((workspace) => workspace.workspaceId === null ? null : (
              <HiddenWorkspaceItem key={workspace.workspaceId} workspaceId={workspace.workspaceId} label={workspace.name} onUnhide={onUnhideWorkspace} />
            ))}
            {missingIds.map((workspaceId) => (
              <HiddenWorkspaceItem key={workspaceId} workspaceId={workspaceId} label={workspaceId} onUnhide={onUnhideWorkspace} />
            ))}
          </section> : null}
          {sessions.length > 0 ? <section data-testid="hidden-sessions-group">
            <div className="px-1 pb-0.5 text-meta font-semibold uppercase tracking-wider text-muted-foreground">{t('explorer.hiddenSessionsGroup', { count: sessions.length })}</div>
            {sessions.map((entry) => <HiddenSessionItem key={entry.sessionId} sessionId={entry.sessionId} label={entry.label} onUnhide={onUnhideSession} />)}
          </section> : null}
        </div>
      ) : null}
    </div>
  )
}

function HiddenWorkspaceItem({
  workspaceId,
  label,
  onUnhide,
}: {
  workspaceId: string
  label: string
  onUnhide(workspaceId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md px-1 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="hidden-workspace-item">
      <span className="min-w-0 max-w-[14rem] flex-1 truncate" title={label} data-testid="hidden-workspace-label">{label}</span>
      <button
        type="button"
        className="inline-flex min-h-11 flex-none items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => onUnhide(workspaceId)}
        data-testid={`workspace-unhide-${workspaceId}`}
        title={t('explorer.unhideWorkspace')}
        aria-label={t('explorer.unhideWorkspaceAria', { workspaceId })}
      >
        <Eye className="h-4 w-4" aria-hidden="true" data-testid="workspace-unhide-icon" />
        <span>{t('explorer.unhideWorkspace')}</span>
      </button>
    </div>
  )
}

function HiddenSessionItem({
  sessionId,
  label,
  onUnhide,
}: {
  sessionId: string
  label: string
  onUnhide(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md px-1 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="hidden-session-item">
      <span className="min-w-0 max-w-[14rem] flex-1 truncate" title={label} data-testid="hidden-session-label">{label}</span>
      <button
        type="button"
        className="inline-flex min-h-11 flex-none items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => onUnhide(sessionId)}
        data-testid={`session-unhide-${sessionId}`}
        title={t('explorer.unhideSession')}
        aria-label={t('explorer.unhideSessionAria', { sessionId })}
      >
        <Eye className="h-4 w-4" aria-hidden="true" data-testid="session-unhide-icon" />
        <span>{t('explorer.unhideSession')}</span>
      </button>
    </div>
  )
}


export function NewChatButton({ onNewChat, className }: { onNewChat(): void; className?: string }): JSX.Element {
  const { t } = useTranslation()
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onNewChat()}
      data-testid="explorer-new-chat"
      className={cn('ak-new-chat-button h-9 justify-start gap-2.5 rounded-xl bg-muted/55 px-3 text-sm font-medium text-foreground hover:bg-muted', className)}
    >
      <SquarePen className="h-4 w-4 flex-none" aria-hidden="true" />
      <span className="ak-new-chat-label min-w-0 truncate">{t('dialogs.simpleChat')}</span>
    </Button>
  )
}

function Header({
  query,
  onQueryChange,
  onNewSession,
  onConnectWorkspace,
  onCollapse,
  embedded,
  leading,
}: {
  query: string
  onQueryChange(query: string): void
  onNewSession(): void
  onConnectWorkspace?: () => void
  onCollapse?: () => void
  embedded: boolean
  leading?: ReactElement
}): JSX.Element {
  const { t } = useTranslation()
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const closeSearch = (): void => {
    onQueryChange('')
    setSearchOpen(false)
  }

  return (
    <div className={cn(
      'relative z-30 flex flex-none items-center border-b px-3.5',
      embedded
        ? 'h-14 border-border/30 bg-card/35'
        : 'border-border/35 bg-card/30 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-card/25',
    )}>
      {searchOpen ? (
        <label className="flex h-10 w-full min-w-0 items-center gap-2 rounded-2xl bg-background/55 pl-3 text-sm ring-1 ring-border/35 transition-shadow focus-within:ring-primary/35">
          <Search className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch()
            }}
            placeholder={t('explorer.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="explorer-search"
            aria-label={t('explorer.searchLabel')}
          />
          <button
            type="button"
            onClick={closeSearch}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('explorer.clearSearch')}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </label>
      ) : (
        <div className="flex w-full min-w-0 flex-nowrap items-center gap-2" data-testid="explorer-header-actions">
          <div className="ak-primary-action-group flex min-w-0 flex-1 flex-nowrap items-center rounded-xl border border-border/35 bg-background/45 shadow-sm" data-testid="explorer-primary-action-group">
            {leading ? <div className="flex flex-none items-center border-r border-border/35" data-testid="explorer-header-leading">{leading}</div> : null}
            <NewChatButton onNewChat={onNewSession} className={cn('min-w-0 flex-1 bg-transparent hover:bg-muted/80', leading && 'rounded-l-none')} />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSearchOpen(true)}
            data-testid="explorer-search-button"
            title={t('explorer.searchPlaceholder')}
            aria-label={t('explorer.searchLabel')}
            className="ak-explorer-utility-action h-9 w-9 flex-none rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </Button>
          {onConnectWorkspace ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onConnectWorkspace}
              data-testid="connect-workspace-button"
              title={t('explorer.connectWorkspace')}
              aria-label={t('explorer.connectWorkspace')}
              className="ak-explorer-utility-action h-9 w-9 flex-none rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Cable className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          {onCollapse ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onCollapse}
              data-testid="explorer-collapse-button"
              title={t('explorer.collapsePanel')}
              aria-label={t('explorer.collapsePanel')}
              className="ak-explorer-utility-action h-9 w-9 flex-none rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function Row({
  node,
  style,
  dragHandle,
  editingSessionId,
  onDeleteRequest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onOpenSessionInfo,
  onWorkspaceInfo,
  onOpenWorkspaceTerminal,
  onHideWorkspace,
  onHideSession,
  editingWorkspaceId,
  onStartWorkspaceEdit,
  onCancelWorkspaceEdit,
  onSubmitWorkspaceEdit,
  onNewSession,
  query,
  sessionRuntimeStore,
  onlineWorkspaceIds,
  fontSizePx,
  onPreviewAnchorChange,
  onPreviewLeave,
  onPointerActivateSession,
}: {
  node: NodeApi<TreeNode>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
  editingSessionId: string | null
  onDeleteRequest(sess: SessionNode): void
  onStartEdit(sess: SessionNode): void
  onCancelEdit(): void
  onSubmitEdit(sess: SessionNode, label: string): void
  onOpenSessionInfo?(sessionId: string): void
  onWorkspaceInfo?(workspaceId: string): void
  onOpenWorkspaceTerminal?(workspace: WorkspaceNode): void
  onHideWorkspace(workspaceId: string): void
  onHideSession(sessionId: string): void
  editingWorkspaceId: string | null
  onStartWorkspaceEdit(workspace: WorkspaceNode): void
  onCancelWorkspaceEdit(): void
  onSubmitWorkspaceEdit(workspace: WorkspaceNode, label: string): void
  onNewSession(workspaceId?: string): void
  query: string
  sessionRuntimeStore: SessionRuntimeStore
  onlineWorkspaceIds: ReadonlySet<string>
  fontSizePx: number
  onPreviewAnchorChange(anchor: SessionPreviewAnchor | null): void
  onPreviewLeave(sessionId: string): void
  onPointerActivateSession(sessionId: string): void
}): JSX.Element {
  if (node.data.kind === 'workspace') {
    return (
        <WorkspaceRow
          node={node as NodeApi<WorkspaceNode>}
          style={style}
          dragHandle={dragHandle}
          onWorkspaceInfo={onWorkspaceInfo}
          onOpenWorkspaceTerminal={onOpenWorkspaceTerminal}
          onHideWorkspace={onHideWorkspace}
        editing={node.data.workspaceId !== null && editingWorkspaceId === node.data.workspaceId}
        onStartEdit={onStartWorkspaceEdit}
        onCancelEdit={onCancelWorkspaceEdit}
        onSubmitEdit={onSubmitWorkspaceEdit}
        onNewSession={onNewSession}
        query={query}
        fontSizePx={fontSizePx}
      />
    )
  }
  return (
    <SessionRow
      node={node as NodeApi<SessionNode>}
      style={style}
      dragHandle={dragHandle}
      editing={editingSessionId === (node.data as SessionNode).sessionId}
      onDeleteRequest={onDeleteRequest}
      onStartEdit={onStartEdit}
      onCancelEdit={onCancelEdit}
      onSubmitEdit={onSubmitEdit}
      onOpenSessionInfo={onOpenSessionInfo}
      onHideSession={onHideSession}
      query={query}
      runtimeStore={sessionRuntimeStore}
      renameDisabled={!isSessionWorkspaceOnline(node.data as SessionNode, onlineWorkspaceIds)}
      fontSizePx={fontSizePx}
      onPreviewAnchorChange={onPreviewAnchorChange}
      onPreviewLeave={onPreviewLeave}
      onPointerActivateSession={onPointerActivateSession}
    />
  )
}


function WorkspaceRow({
  node,
  style,
  dragHandle,
  onWorkspaceInfo,
  onOpenWorkspaceTerminal,
  onHideWorkspace,
  editing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onNewSession,
  query,
  fontSizePx,
}: {
  node: NodeApi<WorkspaceNode>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
  onWorkspaceInfo?(workspaceId: string): void
  onOpenWorkspaceTerminal?(workspace: WorkspaceNode): void
  onHideWorkspace(workspaceId: string): void
  editing: boolean
  onStartEdit(workspace: WorkspaceNode): void
  onCancelEdit(): void
  onSubmitEdit(workspace: WorkspaceNode, label: string): void
  onNewSession(workspaceId?: string): void
  query: string
  fontSizePx: number
}): JSX.Element {
  const { t } = useTranslation()
  const w = node.data
  const workspaceLabel = w.workspaceId === null ? t('explorer.chats') : w.name
  const statusLabel =
    w.workspaceId === null
      ? t('explorer.sessionsNoWorkspace')
      : w.online ? t('explorer.online') : t('explorer.offline')
  const osLabel = w.os === 'win32'
    ? t('explorer.os.windows')
    : w.os === 'darwin'
      ? t('explorer.os.macos')
      : w.os === 'linux'
        ? t('explorer.os.linux')
        : w.os === 'other'
          ? t('explorer.os.other')
          : t('explorer.os.unknown')
  const iconLabel = t('explorer.workspaceOsStatus', { os: osLabel, status: statusLabel })
  const workspaceIconCls = w.online
    ? 'text-emerald-600 dark:text-emerald-300'
    : 'text-muted-foreground/75'
  const canShowInfo = w.workspaceId !== null && onWorkspaceInfo
  const canOpenTerminal = w.workspaceId !== null && onOpenWorkspaceTerminal
  const canCreateSession = w.workspaceId !== null
  const canRename = w.workspaceId !== null
  const canReorder = w.workspaceId !== null
  const canHide = w.workspaceId !== null
  return (
    <div
      style={style}
      data-testid="workspace-row"
      data-workspace-id={w.workspaceId ?? 'unassigned'}
      data-online={w.online ? 'true' : 'false'}
      onClick={() => {
        if (!editing) node.toggle()
      }}
      className={cn(
        'ak-workspace-row group/ws relative min-w-0 cursor-pointer select-none rounded-lg px-2.5 py-1 transition-colors hover:bg-muted/35',
        WORKSPACE_ROW_GRID,
      )}
    >
      {canReorder ? (
        <div
          ref={dragHandle}
          className="group/drag absolute bottom-1 left-0 top-1 z-10 flex w-1.5 cursor-grab items-center justify-start active:cursor-grabbing"
          title={t('explorer.dragWorkspace')}
          aria-label={t('explorer.dragWorkspace')}
          data-testid="workspace-drag-handle"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-2.5 w-2.5 text-muted-foreground/70 opacity-0 transition-opacity group-hover/drag:opacity-100 group-active/drag:opacity-100" aria-hidden="true" />
        </div>
      ) : null}
      <div className={EXPLORER_RAIL_CELL}>
        {node.isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </div>
      {editing ? (
        <RenameInput
          initial={w.name}
          onSubmit={(next) => onSubmitEdit(w, next)}
          onCancel={onCancelEdit}
          testId="workspace-rename-input"
          ariaLabel={t('explorer.renameWorkspace')}
        />
      ) : (
        <div className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-2">
          {w.workspaceId === null ? <span className="inline-flex h-5 w-5 flex-none items-center justify-center text-muted-foreground/75"><Sparkles className="h-3.5 w-3.5" data-testid="chats-icon" aria-hidden="true" /><span className="sr-only">{statusLabel}</span></span> : <span className={cn('inline-flex h-5 w-5 flex-none items-center justify-center transition-colors', workspaceIconCls)} data-testid="workspace-status-icon" data-os={w.os ?? 'unknown'} title={iconLabel} role="img" aria-label={iconLabel}><WorkspaceOsIcon os={w.os} /></span>}
          <span
            className="ak-workspace-title-cell min-w-0 truncate font-medium leading-5 text-muted-foreground group-hover/ws:text-foreground"
            style={{ fontSize: Math.max(11, fontSizePx - 1), lineHeight: 1.35, '--ak-workspace-font-size': `${Math.max(11, fontSizePx - 1)}px` } as React.CSSProperties}
            title={canRename ? t('explorer.doubleClickRename') : undefined}
            onDoubleClick={(e) => {
              if (!canRename) return
              e.preventDefault()
              e.stopPropagation()
              onStartEdit(w)
            }}
          >
            <HighlightText text={workspaceLabel} query={query} />
          </span>
        </div>
      )}
      <div data-row-action className="ak-touch-reveal pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-md bg-card/95 pl-1 opacity-0 transition-opacity group-hover/ws:pointer-events-auto group-hover/ws:opacity-100 group-focus-within/ws:pointer-events-auto group-focus-within/ws:opacity-100">
        {canOpenTerminal && !editing ? (
          <button
            type="button"
            data-testid={`workspace-terminal-${w.workspaceId}`}
            title={w.online ? t('terminal.workspaceOpen') : t('explorer.workspaceOffline')}
            aria-label={t('terminal.workspaceOpen')}
            disabled={!w.online || w.children.length === 0}
            className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            onClick={(e) => {
              e.stopPropagation()
              if (w.online && w.children.length > 0) onOpenWorkspaceTerminal?.(w)
            }}
          >
            <SquareTerminal className="h-3.5 w-3.5" />
          </button>
        ) : null}
          {canRename && !editing ? (
            <button
              type="button"
              data-testid={`workspace-rename-${w.workspaceId}`}
              title={t('explorer.renameWorkspace')}
              aria-label={t('explorer.renameWorkspaceAria', { workspaceId: w.workspaceId })}
              className="flex-none rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onStartEdit(w)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canCreateSession ? (
            <button
              type="button"
              data-testid={`workspace-new-session-${w.workspaceId}`}
              title={w.online ? t('explorer.newSessionInWorkspace') : t('explorer.workspaceOffline')}
              aria-label={t('explorer.newSessionInWorkspace')}
              disabled={!w.online}
              className="flex-none rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                if (!w.online) return
                onNewSession(w.workspaceId ?? undefined)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canShowInfo ? (
            <button
              type="button"
              data-testid={`workspace-info-${w.workspaceId}`}
              title={t('explorer.workspaceInfo')}
              aria-label={t('explorer.workspaceInfo')}
              className="flex-none rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                if (w.workspaceId !== null) onWorkspaceInfo?.(w.workspaceId)
              }}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canHide ? (
            <button
              type="button"
              data-testid={`workspace-hide-${w.workspaceId}`}
              title={t('explorer.hideWorkspace')}
              aria-label={t('explorer.hideWorkspaceAria', { workspaceId: w.workspaceId })}
              className="flex-none rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                if (w.workspaceId !== null) onHideWorkspace(w.workspaceId)
              }}
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
          ) : null}
      </div>
    </div>
  )
}

function WorkspaceOsIcon({ os }: { os: WorkspaceNode['os'] }): JSX.Element {
  // Local OS artwork; shipped with the Dashboard and never loaded from a CDN.
  const icon = os === 'linux' ? 'linux' : os === 'darwin' ? 'macos' : os === 'win32' ? 'windows' : null
  if (icon) {
    return <img src={staticAssetUrl(`/icons/${icon}.svg`)} alt="" className="h-4 w-4 object-contain" data-testid="workspace-os-icon" data-os-icon={icon} aria-hidden="true" />
  }
  return <Monitor className="h-4 w-4" data-testid="workspace-os-icon" data-os-icon="generic" aria-hidden="true" />
}

function SessionRow({
  node,
  style,
  dragHandle,
  editing,
  onDeleteRequest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onOpenSessionInfo,
  onHideSession,
  query,
  runtimeStore,
  renameDisabled,
  fontSizePx,
  onPreviewAnchorChange,
  onPreviewLeave,
  onPointerActivateSession,
}: {
  node: NodeApi<SessionNode>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
  editing: boolean
  onDeleteRequest(sess: SessionNode): void
  onStartEdit(sess: SessionNode): void
  onCancelEdit(): void
  onSubmitEdit(sess: SessionNode, label: string): void
  onOpenSessionInfo?(sessionId: string): void
  onHideSession(sessionId: string): void
  query: string
  runtimeStore: SessionRuntimeStore
  renameDisabled?: boolean
  fontSizePx: number
  onPreviewAnchorChange(anchor: SessionPreviewAnchor | null): void
  onPreviewLeave(sessionId: string): void
  onPointerActivateSession(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const s = node.data
  const selected = node.isSelected
  const runtime = useSessionRuntime(runtimeStore, s.sessionId)
  const status = runtime?.status ?? s.status
  const currentCwd = runtime?.currentCwd ?? s.currentCwd
  const lastActivityIso = runtime?.lastActivityIso ?? s.lastActivityIso
  const minuteNow = useMinuteClock()
  const [touchMenuPosition, setTouchMenuPosition] = useState<{ right: number; top: number } | null>(null)
  useEffect(() => {
    if (!touchMenuPosition) return
    const close = (): void => setTouchMenuPosition(null)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [touchMenuPosition])
  return (
    <div
      style={style}
      data-testid="session-row"
      data-session-id={s.sessionId}
      data-selected={selected ? 'true' : 'false'}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'group relative min-w-0 cursor-pointer overflow-hidden rounded-xl py-1 pl-2.5 pr-2.5 transition-[background-color,color]',
        'hover:bg-muted/35',
        selected && 'bg-muted/55',
        EXPLORER_ROW_GRID,
      )}
      onClick={() => {
        // Keep a click fallback in addition to the eager pointerdown path. The
        // virtualized Tree may commit a controlled selection update between
        // pointerdown and its own onActivate callback; a row-local click keeps
        // the user action authoritative without depending on Tree internals.
        if (!editing) onPointerActivateSession(s.sessionId)
      }}
      onMouseDown={(e) => {
        // Suppress the second `click` in a native double-click sequence so it
        // doesn't reach the react-arborist row handler and re-activate the
        // session (which unmounts our rename input mid-edit).
        //
        // NOTE: do NOT tear the hover preview down here. Mutating Explorer
        // state during mousedown re-renders the react-arborist tree between
        // mousedown and click and swallows the activation, so the session only
        // loads on the *second* click. Preview teardown is handled by an effect
        // that watches the selected session id instead (see ExplorerImpl).
        if (e.detail >= 2) {
          e.preventDefault()
          return
        }
        // `mousedown` is the intentional eager desktop path. A touch/pen
        // gesture first reaches pointer events and is committed only by the
        // eventual click, after the browser has ruled out scrolling.
        if (e.button > 0 || editing || isRowActionTarget(e.target)) return
        onPointerActivateSession(s.sessionId)
      }}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (renameDisabled) return
        onStartEdit(s)
      }}
      onPointerEnter={(e) => {
        if (selected || editing || e.pointerType === 'touch' || !canUseHoverPreview()) return
        onPreviewAnchorChange({
          sessionId: s.sessionId,
          label: s.label,
          rect: e.currentTarget.getBoundingClientRect(),
        })
      }}
      onPointerLeave={() => {
        onPreviewLeave(s.sessionId)
      }}
    >
      {selected ? <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-r bg-primary/55" data-testid="session-selected-marker" aria-hidden="true" /> : null}
      <div className={EXPLORER_RAIL_CELL}>
        {s.children.length > 0 ? (
          <button
            type="button"
            className="flex h-5 w-4 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title={node.isOpen ? t('explorer.collapseSubAgents') : t('explorer.expandSubAgents')}
            aria-label={node.isOpen ? t('explorer.collapseSubAgents') : t('explorer.expandSubAgents')}
            data-testid="session-children-toggle"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              node.toggle()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {node.isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        ) : !s.parentSessionId && !s.workspaceId ? null : !s.parentSessionId ? (
          <div
            ref={dragHandle}
            data-row-action
            className="flex h-4 w-3.5 flex-none cursor-grab items-center justify-center text-muted-foreground/70 opacity-25 transition-opacity active:cursor-grabbing group-hover:opacity-80 group-focus-within:opacity-80"
            title={t('explorer.dragSession')}
            aria-label={t('explorer.dragSession')}
            data-testid="session-drag-handle"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3 w-3" aria-hidden="true" />
          </div>
        ) : (
          <GitFork
            className="h-3 w-3 flex-none text-amber-600 dark:text-amber-400"
            aria-label={t('explorer.forkedSession')}
          />
        )}
      </div>
      {editing ? (
        <RenameInput
          initial={s.label}
          onSubmit={(next) => onSubmitEdit(s, next)}
          onCancel={onCancelEdit}
        />
      ) : (
        <div
          className={cn(
            'ak-session-title-cell flex min-w-0 items-center gap-1.5 truncate font-normal leading-5',
            selected ? 'text-foreground' : 'text-foreground/88',
          )}
          style={{ fontSize: fontSizePx, lineHeight: 1.35, '--ak-session-font-size': `${fontSizePx}px` } as React.CSSProperties}
          title={currentCwd || t('explorer.doubleClickRename')}
        >
          {showsInlineSessionStatus(status) && !isRunningSessionStatus(status)
            ? <SessionStatusIndicator status={status} phaseKey={s.sessionId} />
            : null}
          <span
            className={cn(
              'ak-session-label min-w-0 truncate',
              isRunningSessionStatus(status) ? 'font-semibold' : selected ? 'font-medium' : 'font-normal',
              isRunningSessionStatus(status) && 'ak-thinking-text ak-session-running-label',
            )}
            data-testid={isRunningSessionStatus(status) ? 'running-session-label' : undefined}
          >
            <HighlightText text={s.label} query={query} />
          </span>
          {isRunningSessionStatus(status)
            ? <span className="sr-only">{statusIndicatorLabel(status, t)}</span>
            : null}
        </div>
      )}
      {editing ? null : (
        <div data-row-action className="ak-session-row-actions ak-touch-reveal pointer-events-none z-10 flex min-w-0 items-center justify-end opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            data-testid="session-more-button"
            title={t('common.more')}
            aria-label={t('common.more')}
            aria-expanded={touchMenuPosition !== null}
            className="ak-session-more-button h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:h-6 sm:w-6"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              setTouchMenuPosition((current) => current ? null : {
                right: Math.max(8, window.innerWidth - rect.right),
                top: Math.min(window.innerHeight - 192, rect.bottom + 4),
              })
            }}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {touchMenuPosition && typeof document !== 'undefined' ? createPortal(
            <>
              <button type="button" className="pointer-events-auto fixed inset-0 z-[55] cursor-default" aria-label={t('common.close')} onClick={(e) => { e.stopPropagation(); setTouchMenuPosition(null) }} />
              <div
                className="pointer-events-auto fixed z-[60] min-w-40 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                style={{ right: touchMenuPosition.right, top: touchMenuPosition.top }}
                data-testid="session-action-menu"
                onClick={(e) => e.stopPropagation()}
              >
                <button type="button" data-testid="session-menu-rename" className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted" onClick={() => { setTouchMenuPosition(null); if (!renameDisabled) onStartEdit(s) }}><Pencil className="h-4 w-4" />{t('explorer.renameSession')}</button>
                {onOpenSessionInfo ? <button type="button" data-testid="session-menu-info" className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted" onClick={() => { setTouchMenuPosition(null); onOpenSessionInfo(s.sessionId) }}><Info className="h-4 w-4" />{t('explorer.sessionInfoTitle')}</button> : null}
                <button type="button" data-testid="session-menu-hide" className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted" onClick={() => { setTouchMenuPosition(null); onHideSession(s.sessionId) }}><EyeOff className="h-4 w-4" />{t('explorer.hideSession')}</button>
                <button type="button" data-testid="session-menu-delete" className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted" onClick={() => { setTouchMenuPosition(null); onDeleteRequest(s) }}><Trash2 className="h-4 w-4" />{t('explorer.deleteSessionTitle')}</button>
              </div>
            </>,
            document.body,
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              if (renameDisabled) return
              onStartEdit(s)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            data-testid="session-rename-button"
            title={t('explorer.renameSession')}
            aria-label={t('explorer.renameSessionAria', { sessionId: s.sessionId })}
            disabled={renameDisabled}
            className="hidden"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
          {onOpenSessionInfo ? (
            <Button
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onOpenSessionInfo(s.sessionId)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              data-testid="session-info-button"
              title={t('explorer.sessionInfoTitle')}
              aria-label={t('explorer.sessionInfoAria', { sessionId: s.sessionId })}
              className="hidden"
            >
              <Info className="h-3.5 w-3.5" strokeWidth={2.2} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onHideSession(s.sessionId)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            data-testid="session-hide-button"
            title={t('explorer.hideSession')}
            aria-label={t('explorer.hideSessionAria', { sessionId: s.sessionId })}
            className="hidden"
          >
            <EyeOff className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDeleteRequest(s)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            data-testid="session-delete-button"
            title={t('explorer.deleteSessionTitle')}
            aria-label={t('explorer.deleteSessionAria', { sessionId: s.sessionId })}
            className="hidden"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.2} />
          </Button>
        </div>
      )}
      <div className="ak-session-last-activity ak-touch-hide pointer-events-none col-start-3 row-start-1 flex min-w-0 items-center justify-end overflow-hidden whitespace-nowrap text-caption leading-4 text-muted-foreground/85 group-hover:opacity-0">
        <span className="min-w-0 max-w-full truncate tabular-nums opacity-70" title={formatWhen(lastActivityIso, t, minuteNow * 60_000)} data-testid="session-last-activity">{formatWhen(lastActivityIso, t, minuteNow * 60_000)}</span>
      </div>
    </div>
  )
}

function showsInlineSessionStatus(status: SessionActivityStatus | undefined): boolean {
  return status === 'loading' || status === 'thinking' || status === 'executing_tools' || status === 'awaiting_approval' || status === 'error'
}

function isRunningSessionStatus(status: SessionActivityStatus | undefined): boolean {
  return status === 'loading' || status === 'thinking' || status === 'executing_tools'
}

export const SessionStatusIndicator = memo(function SessionStatusIndicator({
  status,
  selected = false,
  compact = false,
  phaseKey,
}: {
  status: SessionActivityStatus | undefined
  selected?: boolean
  compact?: boolean
  phaseKey?: string
}): JSX.Element {
  const { t } = useTranslation()
  const phase = useRef<{ key: string; delayMs: number } | null>(null)
  const label = statusIndicatorLabel(status, t)
  if (selected) return <ToolbarSessionStatus status={status} label={label} compact={compact} />
  const base = 'inline-flex h-3.5 w-3.5 flex-none items-center justify-center'
  if (status === 'loading' || status === 'thinking' || status === 'executing_tools') {
    const key = phaseKey ?? status
    // React-arborist virtualizes rows: a scrolling row may unmount/remount.
    // Align its animation to a stable session-specific timeline, not mount time.
    if (phase.current?.key !== key) phase.current = { key, delayMs: sessionStatusAnimationPhaseMs(key, performance.now()) }
    const phaseMs = phase.current.delayMs
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        data-animation-phase-ms={String(phaseMs)}
        aria-label={label}
        title={label}
      >
        <span className="ak-session-status-spinner" style={{ '--ak-session-status-phase': `${phaseMs}ms` } as React.CSSProperties} data-testid="session-status-spinner" aria-hidden="true">
          <LoaderCircle
            className="h-3 w-3 text-sky-500 dark:text-sky-400"
            strokeWidth={2.4}
          />
        </span>
      </span>
    )
  }
  phase.current = null
  if (status === 'awaiting_approval') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <TriangleAlert
          className="h-3 w-3 text-amber-500 dark:text-amber-400"
          strokeWidth={2.4}
        />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status}
        aria-label={label}
        title={label}
      >
        <AlertCircle
          className="h-3 w-3 text-rose-500 dark:text-rose-400"
          strokeWidth={2.4}
        />
      </span>
    )
  }
  if (status === 'done' || status === 'idle' || status === undefined) {
    return (
      <span
        className={base}
        data-testid="session-status-indicator"
        data-status={status ?? 'unknown'}
        aria-label={label}
        title={label}
      >
        <span className="sr-only">{label}</span>
      </span>
    )
  }
  return (
    <span
      className={base}
      data-testid="session-status-indicator"
      data-status="unknown"
      aria-label={label}
      title={label}
    >
      <span className="sr-only">{label}</span>
    </span>
  )
})

function ToolbarSessionStatus({ status, label, compact }: { status: SessionActivityStatus | undefined; label: string; compact?: boolean }): JSX.Element {
  const running = status === 'thinking' || status === 'executing_tools' || status === 'loading'
  const tone = status === 'error'
    ? 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300'
    : status === 'awaiting_approval'
      ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : status === 'executing_tools'
        ? 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'
        : running
          ? 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : status === 'done'
            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-border/70 bg-muted/45 text-muted-foreground'
  const Icon = status === 'executing_tools'
    ? Wrench
    : status === 'awaiting_approval'
      ? TriangleAlert
      : status === 'error'
        ? AlertCircle
        : running
          ? LoaderCircle
          : Circle
  return (
    <span className={cn('inline-flex h-6 flex-none items-center gap-1.5 rounded-md border text-caption font-medium', compact ? 'w-6 justify-center px-0 sm:w-auto sm:justify-start sm:px-2' : 'px-2', tone)} data-testid="session-status-indicator" data-status={status ?? 'unknown'} aria-label={label}>
      <span className={cn('inline-flex', running && 'ak-session-status-spinner')} data-testid={running ? 'session-status-spinner' : undefined} aria-hidden="true">
        <Icon className="h-3 w-3" strokeWidth={2.3} />
      </span>
      <span className={cn(compact && 'sr-only sm:not-sr-only')}>{label}</span>
    </span>
  )
}

function sessionStatusAnimationPhaseMs(key: string, nowMs: number): number {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = ((hash * 31) + key.charCodeAt(i)) >>> 0
  return -((Math.floor(nowMs) + hash) % 900)
}

function statusIndicatorLabel(status: SessionActivityStatus | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  switch (status) {
    case 'loading':
      return t('explorer.status.loading')
    case 'thinking':
      return t('explorer.status.thinking')
    case 'executing_tools':
      return t('explorer.status.executingTools')
    case 'awaiting_approval':
      return t('explorer.status.awaitingApproval')
    case 'error':
      return t('explorer.status.error')
    case 'done':
      return t('explorer.status.done')
    case 'idle':
      return t('explorer.status.idle')
    default:
      return t('explorer.status.unknown')
  }
}

function formatWhen(iso: string, t: ReturnType<typeof useTranslation>['t'], now = Date.now()): string {
  try {
    const d = new Date(iso)
    const delta = now - d.getTime()
    if (delta < 60_000) return t('explorer.time.justNow')
    if (delta < 3_600_000) return t('explorer.time.minutesAgo', { count: Math.floor(delta / 60_000) })
    if (delta < 86_400_000) return t('explorer.time.hoursAgo', { count: Math.floor(delta / 3_600_000) })
    if (delta < 15 * 86_400_000) return t('explorer.time.daysAgo', { count: Math.floor(delta / 86_400_000) })
    return d.toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
  testId = 'session-rename-input',
  ariaLabel,
}: {
  initial: string
  onSubmit(label: string): void
  onCancel(): void
  testId?: string
  ariaLabel?: string
}): JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)
  const submit = (): void => {
    if (submitted.current) return
    submitted.current = true
    onSubmit(value)
  }
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          submitted.current = true
          onCancel()
        }
      }}
      onBlur={submit}
      data-testid={testId}
      aria-label={ariaLabel ?? t('explorer.renameSession')}
      spellCheck={false}
      className="min-w-0 flex-1 rounded-sm bg-background px-1.5 py-0.5 text-meta font-medium text-foreground shadow-inner outline-none ring-1 ring-primary/40 focus:ring-2"
    />
  )
}









function areExplorerPropsEqual(prev: Props, next: Props): boolean {
  return prev.loading === next.loading &&
    prev.autoHideOfflineWorkspacesByDefault === next.autoHideOfflineWorkspacesByDefault &&
    prev.selectedSessionId === next.selectedSessionId &&
    prev.embeddedHeader === next.embeddedHeader &&
    prev.headerLeading === next.headerLeading &&
    prev.fontSizePx === next.fontSizePx &&
    prev.onSelect === next.onSelect &&
    prev.onClearSelection === next.onClearSelection &&
    prev.onNewSession === next.onNewSession &&
    prev.onConnectWorkspace === next.onConnectWorkspace &&
    prev.onDelete === next.onDelete &&
    prev.onRename === next.onRename &&
    prev.onRenameWorkspace === next.onRenameWorkspace &&
    prev.onOpenSessionInfo === next.onOpenSessionInfo &&
    prev.onWorkspaceInfo === next.onWorkspaceInfo &&
    prev.onOpenWorkspaceTerminal === next.onOpenWorkspaceTerminal &&
    prev.onCollapse === next.onCollapse &&
    prev.previewStore === next.previewStore &&
    prev.getCachedSessionView === next.getCachedSessionView &&
    prev.subscribeCachedSessionView === next.subscribeCachedSessionView &&
    sameExecutorListForExplorer(prev.executors, next.executors) &&
    sameSessionListForExplorer(prev.sessions, next.sessions) &&
    sameSessionStatusMap(prev.sessionStatuses, next.sessionStatuses)
}



/** Collapse running session-summary statuses so tool-step flips don't churn. */


function canUseHoverPreview(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function HighlightText({ text, query }: { text: string; query: string }): JSX.Element {
  const needle = query.trim()
  if (!needle) return <>{text}</>
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (index === -1) return <>{text}</>
  const before = text.slice(0, index)
  const match = text.slice(index, index + needle.length)
  const after = text.slice(index + needle.length)
  return (
    <>
      {before}
      <mark className="rounded bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-500/30" data-testid="explorer-search-highlight">
        {match}
      </mark>
      {after}
    </>
  )
}
