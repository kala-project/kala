import { ScrollArea } from '../../components/ui/scroll-area.js'
import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefCallback } from 'react'
import useMeasure from 'react-use-measure'
import { NodeApi, Tree } from 'react-arborist'
import type { RowRendererProps, TreeApi } from 'react-arborist'
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, Folder, RefreshCw, Search } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'
import { MarkdownTable } from '../../components/MarkdownTable.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '../../components/ui/button.js'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../../components/ui/resizable.js'
import { cn } from '../../lib/utils.js'
import { CodeBlock } from '../chat/CodeBlock.js'

type DocEntry = {
  path: string
  title: string
  size: number
  updatedAt: string
}

type DocContent = {
  path: string
  title: string
  body: string
  updatedAt: string
}

type DocTreeNode = DocFolderNode | DocFileNode

type DocFolderNode = {
  kind: 'folder'
  id: string
  name: string
  path: string
  children: DocTreeNode[]
}

type DocFileNode = {
  kind: 'file'
  id: string
  name: string
  path: string
  title: string
  updatedAt: string
}

export function DocsPage(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const wideLayout = useMinWidth(768)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [mobileReading, setMobileReading] = useState(false)
  const [query, setQuery] = useState('')
  const [allExpanded, setAllExpanded] = useState(true)
  const arboristRef = useRef<TreeApi<DocTreeNode> | null>(null)
  const [treeRef, treeBounds] = useMeasure({ debounce: 30 })

  const indexQuery = useQuery({
    queryKey: ['docs', 'index'],
    queryFn: async (): Promise<readonly DocEntry[]> => {
      const res = await fetch('/docs/index', { cache: 'no-store' })
      const body = (await res.json().catch(() => null)) as { docs?: DocEntry[]; error?: string } | null
      if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`)
      return body?.docs ?? []
    },
    staleTime: 30_000,
  })
  const docs = indexQuery.data ?? []
  const loadingIndex = indexQuery.isLoading

  useEffect(() => {
    if (docs.length === 0) return
    setSelectedPath((current) => current ?? docs[0]?.path ?? null)
  }, [docs])

  const contentQuery = useQuery({
    queryKey: ['docs', 'content', selectedPath],
    queryFn: async (): Promise<DocContent | null> => {
      if (!selectedPath) return null
      const res = await fetch(`/docs/content?path=${encodeURIComponent(selectedPath)}`, { cache: 'no-store' })
      const body = (await res.json().catch(() => null)) as (DocContent & { error?: string }) | null
      if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`)
      return body
    },
    enabled: Boolean(selectedPath),
    staleTime: 15_000,
  })
  const content = contentQuery.data ?? null
  const loadingContent = contentQuery.isFetching && Boolean(selectedPath)
  const error =
    (indexQuery.error as Error | undefined)?.message ??
    (contentQuery.error as Error | undefined)?.message ??
    null

  const refresh = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['docs'] })
  }, [queryClient])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return filterDocTree(buildDocTree(docs), needle)
  }, [docs, query])

  const filteredEmpty = !loadingIndex && query.trim().length > 0 && filtered.length === 0
  const treeHeight = treeBounds.height > 0 ? treeBounds.height : 560
  const treeWidth = treeBounds.width > 0 ? treeBounds.width : 280

  const activate = (node: NodeApi<DocTreeNode>): void => {
    if (node.data.kind === 'file') {
      setSelectedPath(node.data.path)
      setMobileReading(true)
    } else node.toggle()
  }
  const toggleAll = (): void => {
    const tree = arboristRef.current
    if (!tree) return
    if (allExpanded) {
      tree.closeAll()
      setAllExpanded(false)
      return
    }
    tree.openAll()
    setAllExpanded(true)
  }

  const sidebar = (
    <aside className="h-full min-h-0">
      <div className="border-b border-border/60 p-2">
        <label className="flex h-8 items-center gap-2 rounded border border-border/70 bg-background px-2 text-xs text-muted-foreground">
          <Search className="h-3.5 w-3.5" aria-hidden />
          <input
            aria-label={t('docs.page.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('docs.page.search')}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={toggleAll}
          disabled={filtered.length === 0}
          className="mt-1.5 h-7 w-full justify-start gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          title={allExpanded ? t('docs.page.collapseAll') : t('docs.page.expandAll')}
          aria-label={allExpanded ? t('docs.page.collapseAll') : t('docs.page.expandAll')}
          data-testid="docs-tree-toggle-all"
        >
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />}
          <span>{allExpanded ? t('docs.page.collapseAll') : t('docs.page.expandAll')}</span>
        </Button>
      </div>
      <div ref={treeRef} className="h-[calc(100%-84px)] min-h-0 overflow-hidden p-1.5" data-testid="docs-list" data-scroll-owner="react-arborist">
        {loadingIndex && docs.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground" role="status" aria-live="polite">{t('docs.page.loading')}</div>
        ) : null}
        {!loadingIndex && !filteredEmpty ? (
          <Tree<DocTreeNode>
            ref={arboristRef}
            data={filtered as DocTreeNode[]}
            childrenAccessor={(node) => node.kind === 'folder' ? node.children : null}
            idAccessor="id"
            openByDefault
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            disableSelect={(node) => node.kind !== 'file'}
            selection={selectedPath ? `file:${selectedPath}` : undefined}
            onActivate={activate}
            renderRow={DocTreeRow}
            rowHeight={30}
            indent={14}
            width={treeWidth}
            height={treeHeight}
          >
            {({ node, style }) => <DocRow node={node} style={style} selectedPath={selectedPath} />}
          </Tree>
        ) : null}
        {filteredEmpty || (!loadingIndex && docs.length === 0) ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            <p>{t('docs.page.empty')}</p>
            {query ? (
              <button type="button" className="mt-2 underline underline-offset-2" onClick={() => setQuery('')}>
                {t('docs.page.clearSearch')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  )

  const contentView = (
    <ScrollArea className="h-full min-h-0" data-testid="docs-content" contentClassName="min-h-full" role="main">
      {error ? (
        <div className="m-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300" role="alert">
          {t('docs.page.error', { message: error })}
        </div>
      ) : null}
      {!content && !error ? (
        <div className="p-4 text-xs text-muted-foreground" role={loadingContent ? 'status' : undefined} aria-live={loadingContent ? 'polite' : undefined}>{loadingContent ? t('docs.page.loading') : t('docs.page.select')}</div>
      ) : null}
      {content ? (
        <article className="mx-auto max-w-[88rem] px-4 py-4 sm:px-6 sm:py-5">
          <div className="mb-4 border-b border-border/60 pb-3">
            <div className="break-all font-mono text-caption text-muted-foreground">{content.path}</div>
            <div className="text-caption text-muted-foreground">{t('docs.page.updated', { value: new Date(content.updatedAt).toLocaleString() })}</div>
          </div>
          <DocsMarkdown body={content.body} />
        </article>
      ) : null}
    </ScrollArea>
  )

  return (
    <div className="flex h-full min-h-0 max-w-full flex-col overflow-x-hidden bg-background" data-testid="docs-page">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" aria-hidden />
          <h1 className="flex items-center gap-1 text-sm font-semibold" data-testid="docs-page-title">{t('docs.page.title')}<HelpHint label={t('docs.page.title')}>{t('docs.page.subtitle')}</HelpHint></h1>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { refresh() }}
            className="ml-auto h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            title={t('docs.page.refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (loadingIndex || loadingContent) && 'animate-spin')} aria-hidden />
            <span>{t('docs.page.refresh')}</span>
          </Button>
        </div>
      </header>
      {wideLayout ? (
        <ResizablePanelGroup direction="horizontal" dir="ltr" autoSaveId="ak-docs-cols-v2" className="min-h-0 flex-1">
          <ResizablePanel
            id="docs-sidebar"
            order={1}
            defaultSize={20}
            minSize={14}
            maxSize={38}
            className="min-w-[220px] bg-muted/20"
            data-testid="docs-sidebar-panel"
          >
            {sidebar}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="docs-content-panel" order={2} defaultSize={80} minSize={62} data-testid="docs-content-panel">
            {contentView}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden" data-testid="docs-mobile-layout">
          <div className={cn('h-full min-w-0 overflow-hidden bg-muted/20', mobileReading && 'hidden')} data-testid="docs-sidebar-panel">
            {sidebar}
          </div>
          <div className={cn('h-full min-w-0 overflow-hidden', !mobileReading && 'hidden')} data-testid="docs-content-panel">
            <button type="button" className="flex h-11 w-full items-center gap-2 border-b border-border/60 px-4 text-sm text-muted-foreground" onClick={() => setMobileReading(false)} data-testid="docs-mobile-back">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('common.back')}
            </button>
            <div className="h-[calc(100%-2.75rem)]">{contentView}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return matches
}

function DocsMarkdown({ body }: { body: string }): JSX.Element {
  const renderedBody = useMemo(() => linkReferenceCitations(body), [body])
  return (
    <div
      className={cn(
        'ak-markdown-body min-w-0 max-w-none break-words text-sm leading-7 text-foreground [overflow-wrap:anywhere]',
        '[&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:border-b [&_h1]:border-border/60 [&_h1]:pb-2 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-normal',
        '[&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:border-b [&_h2]:border-border/50 [&_h2]:pb-1.5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-normal',
        '[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mb-2 [&_h4]:mt-5 [&_h4]:text-sm [&_h4]:font-semibold',
        '[&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-border/60',
        '[&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent [&_pre]:p-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
      )}
      data-testid="docs-markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table({ children }) {
            return <MarkdownTable label="Documentation table">{children}</MarkdownTable>
          },
          pre({ children }) {
            return <MarkdownPre>{children}</MarkdownPre>
          },
          code({ inline, className, children, ...rest }: {
            inline?: boolean
            className?: string
            children?: React.ReactNode
          }) {
            if (inline) {
              return <code className={className} {...rest}>{children}</code>
            }
            return <code className={className} {...rest}>{children}</code>
          },
          p({ children }) {
            const reference = parseReferenceParagraph(children)
            if (reference) {
              return (
                <p id={`ref-${reference.number}`} className="scroll-mt-20">
                  <a href={`#ref-${reference.number}`} aria-label={`Reference ${reference.number}`}>
                    [{reference.number}]
                  </a>{' '}
                  <a href={reference.url} target="_blank" rel="noreferrer">
                    {reference.url}
                  </a>
                </p>
              )
            }
            return <p>{children}</p>
          },
        }}
      >
        {renderedBody}
      </ReactMarkdown>
    </div>
  )
}

function linkReferenceCitations(body: string): string {
  const lines = body.split(/\r?\n/u)
  let inCodeFence = false
  let inReferences = false
  return lines
    .map((line) => {
      if (/^\s*```/u.test(line)) {
        inCodeFence = !inCodeFence
        return line
      }
      if (!inCodeFence && /^##\s+References\s*$/u.test(line)) {
        inReferences = true
        return line
      }
      if (inCodeFence || inReferences) return line
      return line.replace(/(?<!!)\[(\d+)\](?!\()/gu, (_match, number: string) => `[[${number}]](#ref-${number})`)
    })
    .join('\n')
}

function parseReferenceParagraph(children: React.ReactNode): { number: string; url: string } | null {
  const text = reactNodeText(children).trim()
  const match = /^\[(\d+)\]\s+(https?:\/\/\S+)$/u.exec(text)
  if (!match) return null
  return { number: match[1]!, url: match[2]! }
}

function MarkdownPre({ children }: { children?: React.ReactNode }): JSX.Element {
  const code = Children.toArray(children).find((child) => isValidElement(child))
  if (code && isValidElement<{ className?: string; children?: React.ReactNode }>(code)) {
    const className = code.props.className
    const match = /language-([\w-]+)/u.exec(className ?? '')
    const raw = reactNodeText(code.props.children).replace(/\n$/u, '')
    return <CodeBlock code={raw} lang={match?.[1]} className="my-4 border border-border/60 bg-muted/40" />
  }
  return <CodeBlock code={reactNodeText(children).replace(/\n$/u, '')} className="my-4 border border-border/60 bg-muted/40" />
}

function reactNodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(node)) return reactNodeText(node.props.children)
  return ''
}

function DocTreeRow({ node, attrs, innerRef, children }: RowRendererProps<DocTreeNode>): ReactElement {
  return (
    <div
      {...attrs}
      ref={innerRef as RefCallback<HTMLDivElement>}
      onClick={node.handleClick}
      className={cn(attrs.className, 'min-w-0 max-w-full overflow-hidden')}
      style={{ ...attrs.style, minWidth: 0, width: '100%' }}
    >
      {children}
    </div>
  )
}

function DocRow({ node, style, selectedPath }: { node: NodeApi<DocTreeNode>; style: React.CSSProperties; selectedPath: string | null }): JSX.Element {
  const data = node.data
  const selected = data.kind === 'file' && data.path === selectedPath
  return (
    <div
      style={style}
      className={cn(
        'flex h-full min-w-0 items-center gap-1.5 rounded border border-transparent px-1.5 text-xs transition-colors',
        data.kind === 'folder'
          ? 'font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground'
          : selected
            ? 'border-primary/30 bg-primary/10 text-primary'
            : 'text-muted-foreground hover:border-border/70 hover:bg-background hover:text-foreground',
      )}
      data-testid={data.kind === 'folder' ? `docs-tree-folder-${data.path || 'root'}` : `docs-tree-file-${data.path}`}
      title={data.kind === 'file' ? data.path : data.path || 'docs'}
    >
      {data.kind === 'folder' ? (
        node.isOpen ? <ChevronDown className="h-3.5 w-3.5 flex-none opacity-70" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 flex-none opacity-70" aria-hidden />
      ) : (
        <span className="w-3.5 flex-none" />
      )}
      {data.kind === 'folder' ? (
        <Folder className="h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-300" aria-hidden />
      ) : (
        <FileText className="h-3.5 w-3.5 flex-none" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{data.kind === 'file' ? data.title : data.name}</span>
    </div>
  )
}

function buildDocTree(docs: readonly DocEntry[]): DocTreeNode[] {
  const root: DocFolderNode = { kind: 'folder', id: 'folder:', name: 'docs', path: '', children: [] }
  const folders = new Map<string, DocFolderNode>([['', root]])

  for (const doc of docs) {
    const parts = doc.path.split('/').filter(Boolean)
    let parent = root
    let currentPath = ''
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let folder = folders.get(currentPath)
      if (!folder) {
        folder = { kind: 'folder', id: `folder:${currentPath}`, name: part, path: currentPath, children: [] }
        folders.set(currentPath, folder)
        parent.children.push(folder)
      }
      parent = folder
    }
    parent.children.push({
      kind: 'file',
      id: `file:${doc.path}`,
      name: parts.at(-1) ?? doc.path,
      path: doc.path,
      title: doc.title,
      updatedAt: doc.updatedAt,
    })
  }

  sortTree(root.children)
  return root.children
}

function sortTree(nodes: DocTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.kind === 'folder') sortTree(node.children)
  }
}

function filterDocTree(nodes: readonly DocTreeNode[], needle: string): DocTreeNode[] {
  if (!needle) return nodes.map(cloneDocNode)
  const out: DocTreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (`${node.title} ${node.path}`.toLowerCase().includes(needle)) out.push({ ...node })
      continue
    }
    const children = filterDocTree(node.children, needle)
    if (children.length > 0 || `${node.name} ${node.path}`.toLowerCase().includes(needle)) {
      out.push({ ...node, children })
    }
  }
  return out
}

function cloneDocNode(node: DocTreeNode): DocTreeNode {
  if (node.kind === 'file') return { ...node }
  return { ...node, children: node.children.map(cloneDocNode) }
}
