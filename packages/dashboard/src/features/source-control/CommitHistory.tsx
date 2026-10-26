import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react'
import type { WorkspaceSocket } from '../../lib/workspace-exec.js'
import {
  gitHistory, gitCommitDetails, gitCommitDiff,
  type GitCommit, type GitCommitDetails, type GitCommitFile, type GitHistoryPage, type GitCommitPatch,
} from '../../lib/git-client.js'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.js'

type Props = { socket: WorkspaceSocket | null; workspaceId?: string; cwd?: string }

export function CommitHistory({ socket, workspaceId, cwd }: Props): JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState<GitHistoryPage>({ commits: [] })
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const previousOffsets = useRef<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GitCommit | null>(null)
  const generation = useRef(0)
  const online = Boolean(socket && workspaceId && socket.connected !== false)

  async function load(reset: boolean, nextOffset = 0) {
    if (!socket || !workspaceId || !online) return
    const current = ++generation.current
    setLoading(true)
    setError(null)
    const result = await gitHistory(socket, {
      workspaceId, cwd, ...(reset ? {} : { anchor: page.anchor, offset: nextOffset }),
    })
    if (generation.current !== current) return
    if (result.ok) {
      setPage(result.value)
      setOffset(reset ? 0 : nextOffset)
      if (reset) previousOffsets.current = []
      else if (nextOffset > offset) previousOffsets.current.push(offset)
      else previousOffsets.current.pop()
    }
    else setError(`${result.error.code}: ${result.error.message}`)
    setLoading(false)
  }

  useEffect(() => {
    setPage({ commits: [] })
    setOffset(0)
    previousOffsets.current = []
    setSelected(null)
    setError(null)
    setLoading(false)
    void load(true)
    return () => { generation.current++ }
  }, [socket, workspaceId, cwd, online])

  return (
    <section className="space-y-3" aria-label={t('sourceControl.history')}>
      <div className="flex items-center justify-between gap-2 px-1 py-1">
        <h2 className="text-[11px] font-medium text-muted-foreground">{t('sourceControl.history')}</h2>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={!online || loading} onClick={() => void load(true)}>{loading ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3" aria-hidden="true" />}{t('sourceControl.refreshHistory')}</button>
      </div>
      {!online ? <p className="p-3 text-xs text-muted-foreground">{t('sourceControl.offline')}</p> : null}
      {error ? <p role="alert" className="break-words p-2 text-xs text-destructive">{error}</p> : null}
      {online && !loading && !error && page.commits.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{t('sourceControl.noCommits')}</p> : null}
      <ol className="space-y-2">
        {page.commits.map((commit, index) => (
          <li key={commit.hash} className="relative flex gap-2">
            <div className="flex flex-none flex-col items-center pt-3">
              <span className="z-10 flex size-6 items-center justify-center rounded-full border border-sidebar-border/60 bg-sidebar text-primary/80"><GitCommitHorizontal className="size-3.5" aria-hidden="true" /></span>
              {index < page.commits.length - 1 ? <span className="-mb-5 mt-1 w-px flex-1 bg-sidebar-border/70" aria-hidden="true" /> : null}
            </div>
            <button type="button" className="group min-w-0 flex-1 rounded-xl border border-sidebar-border/50 bg-background/30 px-3 py-2.5 text-left transition-colors hover:border-sidebar-border hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelected(commit)}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium leading-relaxed" title={commit.message.split('\n')[0]}>{commit.message.split('\n')[0] || t('sourceControl.emptyMessage')}</span>
                <ChevronRight className="size-3.5 flex-none text-muted-foreground/40 transition-colors group-hover:text-foreground" aria-hidden="true" />
              </span>
              <span className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                <code className="flex-none rounded bg-muted/70 px-1.5 py-0.5 font-mono text-primary/80">{commit.hash.slice(0, 8)}</code>
                <span className="min-w-0 flex-1 truncate">{commit.authorName}</span>
                <time className="max-w-full flex-none break-words tabular-nums" dateTime={commit.committedAt}>{formatTime(commit.committedAt)}</time>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {loading ? <p role="status" className="p-2 text-xs text-muted-foreground">{t('sourceControl.loadingHistory')}</p> : null}
      <div className="flex items-center justify-between text-xs text-primary">
        {offset > 0 ? <button type="button" className="rounded-lg border border-sidebar-border/50 px-2.5 py-1.5 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={loading} onClick={() => void load(false, previousOffsets.current.at(-1) ?? 0)}>{t('sourceControl.newerCommits')}</button> : <span />}
        {page.nextOffset !== undefined ? <button type="button" className="rounded-lg border border-sidebar-border/50 px-2.5 py-1.5 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={loading} onClick={() => void load(false, page.nextOffset)}>{t('sourceControl.loadMore')}</button> : null}
      </div>
      <CommitDetailsDialog socket={socket} workspaceId={workspaceId} cwd={cwd} commit={selected} onClose={() => setSelected(null)} />
    </section>
  )
}

function CommitDetailsDialog({ socket, workspaceId, cwd, commit, onClose }: Props & { commit: GitCommit | null; onClose: () => void }): JSX.Element {
  const { t } = useTranslation()
  const [details, setDetails] = useState<GitCommitDetails | null>(null)
  const [file, setFile] = useState<GitCommitFile | null>(null)
  const [patch, setPatch] = useState<GitCommitPatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [patchError, setPatchError] = useState<string | null>(null)
  const [patchLoading, setPatchLoading] = useState(false)
  useEffect(() => {
    setDetails(null)
    setFile(null)
    setPatch(null)
    setError(null)
    if (!commit || !socket || !workspaceId) return
    let active = true
    void gitCommitDetails(socket, { workspaceId, cwd, hash: commit.hash }).then((result) => {
      if (!active) return
      if (result.ok) { setDetails(result.value); setFile(result.value.files[0] ?? null) }
      else setError(`${result.error.code}: ${result.error.message}`)
    })
    return () => { active = false }
  }, [commit, socket, workspaceId, cwd])
  useEffect(() => {
    setPatch(null)
    setPatchError(null)
    setPatchLoading(false)
    if (!commit || !socket || !workspaceId || !file) return
    let active = true
    setPatchLoading(true)
    void gitCommitDiff(socket, { workspaceId, cwd, hash: commit.hash, file }).then((result) => {
      if (!active) return
      if (result.ok) setPatch(result.value)
      else setPatchError(`${result.error.code}: ${result.error.message}`)
      setPatchLoading(false)
    })
    return () => { active = false }
  }, [commit, file, socket, workspaceId, cwd])
  const metadata = details?.commit ?? commit
  return (
    <Dialog open={commit !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="flex max-h-[92dvh] w-[96vw] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('sourceControl.commitDetails')}</DialogTitle>
          <DialogDescription>{t('sourceControl.readOnlyHistory')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-auto">
          {metadata ? (
            <div className="space-y-1 break-words text-xs">
              <p className="font-mono">{metadata.hash}</p>
              <p>{t('sourceControl.author')}: {metadata.authorName} &lt;{metadata.authorEmail}&gt; · {formatTime(metadata.authoredAt)}</p>
              <p>{t('sourceControl.committer')}: {metadata.committerName} &lt;{metadata.committerEmail}&gt; · {formatTime(metadata.committedAt)}</p>
              <p>{t('sourceControl.parents')}: <span className="font-mono">{metadata.parents.join(', ') || t('sourceControl.rootCommit')}</span></p>
              {metadata.parents.length > 1 ? <p className="text-amber-600 dark:text-amber-300">{t('sourceControl.mergeComparison')}</p> : null}
              {metadata.parents.length === 0 ? <p className="text-muted-foreground">{t('sourceControl.rootComparison')}</p> : null}
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 font-sans">{metadata.message || t('sourceControl.emptyMessage')}</pre>
            </div>
          ) : null}
          {error ? <p role="alert" className="py-3 text-xs text-destructive">{error}</p> : !details ? <p role="status" className="py-3 text-xs">{t('sourceControl.loadingHistory')}</p> : (
            <div className="mt-3 space-y-2">
              <h3 className="text-xs font-semibold">{t('sourceControl.changedFiles', { count: details.files.length })}</h3>
              {details.filesTruncated ? <p className="text-xs text-amber-600">{t('sourceControl.truncatedFiles', { count: details.files.length })}</p> : null}
              {details.files.length === 0 ? <p className="text-xs text-muted-foreground">{t('sourceControl.emptyCommit')}</p> : (
                <>
                  <div className="max-h-40 overflow-auto rounded border border-border">
                    {details.files.map((entry) => <button key={entry.path} type="button" aria-pressed={file?.path === entry.path} className="block w-full break-all px-2 py-1 text-left font-mono text-xs hover:bg-accent aria-pressed:bg-accent" onClick={() => setFile(entry)}>{entry.status} {entry.oldPath ? `${entry.oldPath} → ` : ''}{entry.path}</button>)}
                  </div>
                  {patchLoading ? <p role="status" className="text-xs">{t('sourceControl.loadingDiff')}</p> : null}
                  {patchError ? <p role="alert" className="text-xs text-destructive">{patchError}</p> : null}
                  {patch?.truncated ? <p className="text-xs text-amber-600">{t('sourceControl.patchTooLarge')}</p> : null}
                  {patch?.binary ? <p className="text-xs text-muted-foreground">{t('sourceControl.binaryPatch')}</p> : null}
                  {patch && !patch.truncated && !patch.text ? <p className="text-xs text-muted-foreground">{t('sourceControl.emptyPatch')}</p> : null}
                  {patch?.text ? <pre aria-label={t('sourceControl.gitDiff')} className="max-h-[45dvh] overflow-auto rounded bg-muted p-3 text-xs">{patch.text.split('\n').map((line, index) => <span key={index} className={`block min-h-[1em] ${line.startsWith('+') ? 'text-emerald-700 dark:text-emerald-300' : line.startsWith('-') ? 'text-rose-700 dark:text-rose-300' : line.startsWith('@@') ? 'text-sky-700 dark:text-sky-300' : ''}`}>{line}</span>)}</pre> : null}
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
