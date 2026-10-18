import { randomId } from '../../lib/random-id.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronRight, File, Folder, FolderPlus, Home, Loader2, RefreshCw, Slash } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CreateDirectoryResult, DirListResult } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import type { DashboardSocket } from '../../session.js'

export type DirColumn = {
  path: string
  entries: DirListResult['entries']
  error?: string
}

type Props = {
  socket: DashboardSocket | null
  workspaceId: string
  initialPath: string | undefined
  value: string
  onChange(next: string): void
  inputId?: string
  inputTestId?: string
}

const MANUAL_LOAD_DEBOUNCE_MS = 400
const DIRECTORY_REQUEST_TIMEOUT_MS = 10_000

export function DirectoryPicker({
  socket,
  workspaceId,
  initialPath,
  value,
  onChange,
  inputId,
  inputTestId,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [columns, setColumns] = useState<DirColumn[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestTimeoutRef = useRef<number | null>(null)
  const finderScrollRef = useRef<HTMLDivElement | null>(null)
  const dirListHandlerRef = useRef<(result: DirListResult) => void>(() => {})
  const selectedPathRef = useRef(value)
  selectedPathRef.current = value

  const showDirectoryTimeout = (path: string): void => {
    activeRequestIdRef.current = null
    setLoadingPath(null)
    setColumns([{ path, entries: [], error: 'Directory request timed out. Check that this workspace executor is online and connected to the same Host.' }])
  }

  const requestPath = (path: string): void => {
    if (!socket || !workspaceId) return
    setLoadingPath(path)
    activeRequestIdRef.current = requestDirs(
      socket,
      workspaceId,
      path,
      (result) => dirListHandlerRef.current(result),
    )
    if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current)
    requestTimeoutRef.current = window.setTimeout(
      () => showDirectoryTimeout(path),
      DIRECTORY_REQUEST_TIMEOUT_MS,
    )
  }

  useEffect(() => {
    setColumns([])
    setRootPath(null)
    activeRequestIdRef.current = null
    if (!socket || !workspaceId) return
    const onDirList = (result: DirListResult): void => {
      if (result.workspaceId !== workspaceId) return
      if (result.requestId !== activeRequestIdRef.current) return
      activeRequestIdRef.current = null
      setLoadingPath(null)
      if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current)
      onChange(result.path)
      if (result.roots.length > 0) setRootPath(result.roots[0]!)
      setColumns((prev) => {
        const existing = prev.findIndex((col) => col.path === result.path)
        const nextColumn: DirColumn = {
          path: result.path,
          entries: result.entries,
          ...(result.error ? { error: result.error } : {}),
        }
        if (existing >= 0) return [...prev.slice(0, existing), nextColumn]
        const parentIndex = prev.findIndex((col) =>
          col.entries.some((entry) => entry.path === result.path),
        )
        if (parentIndex >= 0) return [...prev.slice(0, parentIndex + 1), nextColumn]
        return [nextColumn]
      })
    }
    dirListHandlerRef.current = onDirList
    socket.on('server:dir_list', onDirList)
    const onReconnect = (): void => {
      requestPath(selectedPathRef.current.trim() || initialPath || '')
    }
    socket.on('connect', onReconnect)
    requestPath(initialPath ?? '')
    return () => {
      socket.off('server:dir_list', onDirList)
      socket.off('connect', onReconnect)
      dirListHandlerRef.current = () => {}
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
      if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current)
    }
    // onChange is a plain setter from the parent; excluded intentionally to
    // avoid re-subscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, workspaceId, initialPath])

  // Auto-scroll the finder to the right so freshly-pushed columns are visible
  // instead of hiding behind the scroller. Runs when the column count grows.
  useLayoutEffect(() => {
    const el = finderScrollRef.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
  }, [columns.length])

  const loadPath = (path: string): void => {
    if (!socket || !workspaceId) return
    onChange(path)
    requestPath(path)
  }

  const scheduleManualLoad = (path: string): void => {
    if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
    if (!socket || !workspaceId) return
    if (!isAbsoluteWorkspacePath(path)) return
    manualTimerRef.current = setTimeout(() => {
      manualTimerRef.current = null
      requestPath(path)
    }, MANUAL_LOAD_DEBOUNCE_MS)
  }

  const openDir = (path: string): void => {
    if (manualTimerRef.current) {
      clearTimeout(manualTimerRef.current)
      manualTimerRef.current = null
    }
    loadPath(path)
  }

  const updateManualPath = (next: string): void => {
    // Invalidate any in-flight request so a late response can't stomp the
    // user's edit. The debounced load below will register a fresh request id
    // once the user stops typing.
    activeRequestIdRef.current = null
    setLoadingPath(null)
    onChange(next)
    scheduleManualLoad(next.trim())
  }

  const commitManualPath = (): void => {
    if (manualTimerRef.current) {
      clearTimeout(manualTimerRef.current)
      manualTimerRef.current = null
    }
    const trimmed = value.trim()
    if (trimmed.length === 0 || !isAbsoluteWorkspacePath(trimmed)) return
    loadPath(trimmed)
  }

  const goUp = (): void => {
    const parent = parentPath(value.trim())
    if (parent === null) return
    if (rootPath && !isWithinRoot(parent, rootPath)) return
    openDir(parent)
  }

  const goRoot = (): void => {
    if (!rootPath) return
    openDir(rootPath)
  }

  const refresh = (): void => {
    const target = value.trim()
    if (target.length === 0) return
    openDir(target)
  }

  const createFolder = (): void => {
    const parent = value.trim()
    const name = newFolderName.trim()
    if (!socket || !workspaceId || parent.length === 0 || name.length === 0) return
    setCreateError(null)
    const requestId = randomId()
    socket.emit('client:create_directory', {
      requestId,
      workspaceId,
      parentPath: parent,
      name,
    }, (result: CreateDirectoryResult) => {
      if (result.requestId !== requestId || result.workspaceId !== workspaceId) return
      if (result.error) {
        setCreateError(result.error)
        return
      }
      setCreatingFolder(false)
      setNewFolderName('')
      openDir(result.path)
    })
  }

  const atRoot =
    rootPath !== null && (value.trim() === rootPath || !isWithinRoot(value.trim(), rootPath))
  const canGoUp = parentPath(value.trim()) !== null && !atRoot
  const crumbs = buildBreadcrumbs(value.trim(), rootPath)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border/50 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="grid grid-cols-2 gap-1 sm:flex sm:flex-none" data-testid="dir-picker-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-w-0 gap-1 px-2 text-xs sm:h-9"
            onClick={goUp}
            disabled={!canGoUp}
            title={t('directory.goUp')}
            data-testid="dir-picker-up"
          >
            <ArrowUp className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{t('directory.parentShort')}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-w-0 gap-1 px-2 text-xs sm:h-9"
            onClick={goRoot}
            disabled={!rootPath}
            title={rootPath ? t('directory.jumpRoot', { root: rootPath }) : t('directory.rootUnknown')}
            data-testid="dir-picker-root"
          >
            <Home className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{t('directory.rootShort')}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-w-0 gap-1 px-2 text-xs sm:h-9"
            onClick={refresh}
            disabled={value.trim().length === 0}
            title={t('directory.refresh')}
            data-testid="dir-picker-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{t('directory.refreshShort')}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-w-0 gap-1 px-2 text-xs sm:h-9"
            onClick={() => {
              setCreatingFolder((current) => !current)
              setCreateError(null)
            }}
            disabled={!socket || !workspaceId || value.trim().length === 0}
            title={t('directory.newFolder')}
            data-testid="dir-picker-new-folder"
          >
            <FolderPlus className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{t('directory.newFolder')}</span>
          </Button>
          </div>
          <Input
            id={inputId}
            value={value}
            onChange={(e) => updateManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitManualPath()
              }
            }}
            onBlur={commitManualPath}
            placeholder={t('directory.placeholder')}
            data-testid={inputTestId}
            title={value}
            className="h-11 min-w-0 flex-1 truncate font-mono text-base sm:h-9 sm:text-sm"
          />
        </div>
        {creatingFolder ? (
          <div className="flex items-center gap-1" data-testid="dir-picker-create-folder-row">
            <Input
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  createFolder()
                } else if (event.key === 'Escape') {
                  setCreatingFolder(false)
                  setNewFolderName('')
                  setCreateError(null)
                }
              }}
              placeholder={t('directory.newFolderPlaceholder')}
              aria-label={t('directory.newFolderName')}
              data-testid="dir-picker-new-folder-name"
              className="h-11 min-w-0 flex-1 text-base sm:h-9 sm:text-sm"
              autoFocus
            />
            <Button type="button" size="sm" className="h-11 min-w-0 gap-1 px-2 text-xs sm:h-9" onClick={createFolder} disabled={newFolderName.trim().length === 0} data-testid="dir-picker-create-folder">
              {t('directory.createFolder')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-11 min-w-0 gap-1 px-2 text-xs sm:h-9" onClick={() => { setCreatingFolder(false); setNewFolderName(''); setCreateError(null) }} data-testid="dir-picker-cancel-create-folder">
              {t('common.cancel')}
            </Button>
          </div>
        ) : null}
        {createError ? (
          <div className="text-xs text-rose-600 dark:text-rose-300" data-testid="dir-picker-create-folder-error">{createError}</div>
        ) : null}
        {crumbs.length > 0 ? (
          <div
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
            data-testid="dir-picker-breadcrumbs"
          >
            {crumbs.map((crumb, i) => (
              <div key={`${crumb.path}-${i}`} className="flex flex-none items-center gap-0.5">
                {i > 0 ? (
                  <Slash className="h-3 w-3 flex-none text-muted-foreground" aria-hidden="true" />
                ) : null}
                <button
                  type="button"
                  onClick={() => openDir(crumb.path)}
                  disabled={crumb.path === value.trim()}
                  title={crumb.path}
                  data-testid={`dir-picker-breadcrumb-${i}`}
                  className={cn(
                    'max-w-[14rem] truncate rounded px-1.5 py-0.5 font-mono text-caption transition-colors',
                    crumb.path === value.trim()
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {crumb.label}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          ref={finderScrollRef}
          className="h-full overflow-x-auto overflow-y-hidden"
          data-testid="directory-picker-finder"
        >
          <div className="flex h-full min-h-0 min-w-full md:w-max">
            {columns.length === 0 ? (
              <div className="flex h-48 w-full items-center justify-center text-sm text-muted-foreground">
                {loadingPath !== null ? t('directory.loading') : t('directory.selectWorkspace')}
              </div>
            ) : null}
            {columns.map((column, index) => (
              <DirectoryColumn
                key={column.path}
                column={column}
                cwd={value}
                loadingPath={loadingPath}
                onOpen={openDir}
                mobileHidden={index !== columns.length - 1}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function DirectoryColumn({
  column,
  cwd,
  loadingPath,
  onOpen,
  mobileHidden,
}: {
  column: DirColumn
  cwd: string
  loadingPath: string | null
  onOpen(path: string): void
  mobileHidden: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={cn('flex h-full min-h-0 w-full min-w-0 shrink-0 flex-col overflow-hidden border-border/50 md:w-64 md:border-r', mobileHidden && 'hidden md:flex')} data-testid="finder-column">
      <div
        className="flex-none truncate border-b border-border/50 px-3 py-2 font-mono text-caption text-muted-foreground"
        title={column.path}
        data-testid="finder-column-header"
      >
        {directoryName(column.path)}
      </div>
      {column.error ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{column.error}</div>
      ) : column.entries.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs text-muted-foreground">{t('directory.noSubdirectories')}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" data-testid="finder-column-scroll">
          {column.entries.map((entry) => {
            // Older executors omitted `type` because the picker originally
            // returned directories only. Preserve that behavior for them.
            const isDirectory = entry.type !== 'file'
            return (
              <button
                key={entry.path}
                type="button"
                onClick={isDirectory ? () => onOpen(entry.path) : undefined}
                data-testid={isDirectory ? 'finder-dir' : 'finder-file'}
                className={cn(
                  'flex h-8 w-full items-center gap-2 px-2 text-left text-sm transition-colors',
                  isDirectory ? 'hover:bg-secondary' : 'cursor-default',
                  cwd === entry.path && 'bg-primary/10 text-foreground',
                )}
              >
                {isDirectory ? (
                  <Folder
                    data-testid="finder-folder-icon"
                    className="h-4 w-4 flex-none text-sky-600 dark:text-sky-300"
                  />
                ) : (
                  <File
                    data-testid="finder-file-icon"
                    className="h-4 w-4 flex-none text-muted-foreground"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {isDirectory && loadingPath === entry.path ? (
                  <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-muted-foreground" />
                ) : isDirectory ? (
                  <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function requestDirs(
  socket: DashboardSocket,
  workspaceId: string,
  path: string | undefined,
  onResult: (result: DirListResult) => void,
): string {
  const requestId = randomId()
  socket.emit('client:list_dirs', {
    requestId,
    workspaceId,
    ...(path !== undefined && path.length > 0 ? { path } : {}),
  }, onResult)
  return requestId
}

function parentPath(path: string): string | null {
  if (isWindowsPath(path)) {
    const normalized = path.replaceAll('/', '\\').replace(/\\+$/u, '')
    if (/^[a-z]:$/iu.test(normalized)) return null
    const index = normalized.lastIndexOf('\\')
    if (index <= 2) return `${normalized.slice(0, 2)}\\`
    return normalized.slice(0, index)
  }
  if (!path.startsWith('/')) return null
  if (path === '/') return null
  const segments = path.split('/').filter((s) => s.length > 0)
  if (segments.length <= 1) return '/'
  segments.pop()
  return `/${segments.join('/')}`
}

function isWithinRoot(path: string, root: string): boolean {
  const windows = isWindowsPath(path) || isWindowsPath(root)
  const normalize = (value: string): string => windows ? value.replaceAll('/', '\\').toLowerCase() : value
  const candidate = normalize(path)
  const normalizedRoot = normalize(root)
  const separator = windows ? '\\' : '/'
  return candidate === normalizedRoot || candidate.startsWith(normalizedRoot.endsWith(separator) ? normalizedRoot : normalizedRoot + separator)
}

type Breadcrumb = { label: string; path: string }

function buildBreadcrumbs(path: string, root: string | null): Breadcrumb[] {
  if (isWindowsPath(path)) {
    const normalized = path.replaceAll('/', '\\')
    const drive = normalized.slice(0, 2)
    const segments = normalized.slice(2).split('\\').filter(Boolean)
    const crumbs: Breadcrumb[] = [{ label: drive, path: `${drive}\\` }]
    for (let i = 0; i < segments.length; i += 1) crumbs.push({ label: segments[i]!, path: `${drive}\\${segments.slice(0, i + 1).join('\\')}` })
    if (!root || !isWithinRoot(path, root)) return crumbs
    const normalizedRoot = root.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase()
    const rootIndex = crumbs.findIndex((crumb) => crumb.path.replace(/\\+$/u, '').toLowerCase() === normalizedRoot)
    return rootIndex >= 0 ? crumbs.slice(rootIndex) : crumbs
  }
  if (!path.startsWith('/')) return []
  const segments = path.split('/').filter((s) => s.length > 0)
  const crumbs: Breadcrumb[] = []
  if (root && isWithinRoot(path, root)) {
    // Collapse ancestors above the workspace root into a single "root" chip so
    // deep paths inside /very/long/parents/workspace-root/... stay readable.
    const rootSegments = root.split('/').filter((s) => s.length > 0)
    const rootLabel = rootSegments.at(-1) ?? '/'
    crumbs.push({ label: rootLabel || '/', path: root })
    for (let i = rootSegments.length; i < segments.length; i += 1) {
      const p = `/${segments.slice(0, i + 1).join('/')}`
      crumbs.push({ label: segments[i]!, path: p })
    }
  } else {
    crumbs.push({ label: '/', path: '/' })
    for (let i = 0; i < segments.length; i += 1) {
      const p = `/${segments.slice(0, i + 1).join('/')}`
      crumbs.push({ label: segments[i]!, path: p })
    }
  }
  return crumbs
}

function isWindowsPath(path: string): boolean { return /^[a-z]:[\\/]/iu.test(path) }
function isAbsoluteWorkspacePath(path: string): boolean { return path.startsWith('/') || isWindowsPath(path) }

function directoryName(path: string): string {
  if (isWindowsPath(path)) {
    const normalized = path.replaceAll('/', '\\').replace(/\\+$/u, '')
    return normalized.slice(normalized.lastIndexOf('\\') + 1) || normalized
  }
  const normalized = path.replace(/\/+$/u, '') || '/'
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1)
}
