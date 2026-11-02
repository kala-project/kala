import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Circle, CircleDashed, GitBranch, LockKeyhole, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ModalSizeToggle } from '../../components/ui/modal-size-toggle.js'
import { cn } from '../../lib/utils.js'
import type { TaskGraphNode, TaskGraphSnapshot, TaskGraphStatus } from './task-graph-from-timeline.js'

type Props = { graph: TaskGraphSnapshot | null; appearance?: 'icon' | 'menu' }

export function TaskGraphButton({ graph, appearance = 'icon' }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [graphView, setGraphView] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !popover.current?.contains(target)) setOpen(false)
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => {
    if (!open) setExpanded(false)
  }, [open])
  if (!graph || graph.nodes.length === 0) return null
  const { summary } = graph
  const done = summary.completed + summary.cancelled
  const allDone = done === summary.total
  const allBlocked = summary.blocked > 0 && summary.active === 0 && summary.ready === 0
  return <div className={cn('relative flex-none', appearance === 'menu' && 'w-full')} ref={root}>
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog" aria-label={t('taskGraph.summary', summary)} data-testid="task-graph-trigger"
      title={t('taskGraph.summary', summary)}
      className={cn(
        'relative inline-flex items-center text-muted-foreground transition-colors hover:bg-accent',
        appearance === 'menu' ? 'h-10 w-full gap-3 rounded-lg px-3 text-left text-sm' : 'h-11 w-10 justify-center rounded-xl sm:h-10 sm:w-10',
        open && 'bg-accent text-foreground',
        allDone && 'text-emerald-700 dark:text-emerald-300',
        allBlocked && 'text-amber-700 dark:text-amber-300',
      )}>
      <GitBranch className="h-[18px] w-[18px]" aria-hidden="true" />
      {summary.active > 0 && appearance !== 'menu' ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500 shadow-[0_0_0_2px_hsl(var(--background))]" aria-hidden="true" /> : null}
      {appearance === 'menu' ? <span className="min-w-0 flex-1">{t('taskGraph.title')}</span> : null}
    </button>
    {open && typeof document !== 'undefined' ? createPortal(<div ref={popover} role="dialog" aria-label={t('taskGraph.aria')} data-testid="task-graph-popover" data-expanded={expanded ? 'true' : 'false'} data-composer-tools-portal className={cn(
      'fixed z-[70] flex flex-col overflow-hidden rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-2xl',
      expanded
        ? 'inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] top-[max(0.75rem,env(safe-area-inset-top))] max-h-none'
        : 'inset-x-2 bottom-[5.5rem] max-h-[min(76dvh,42rem)] md:inset-x-4 md:bottom-4 lg:left-1/2 lg:right-auto lg:bottom-20 lg:w-[min(72rem,calc(100vw-2rem))] lg:-translate-x-1/2',
    )}>
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <GitBranch className="h-4 w-4" /><span className="text-sm font-medium">{t('taskGraph.title')}</span><span className="text-xs text-muted-foreground">{t('taskGraph.revision', { revision: graph.revision })}</span>
        <button className="ml-auto rounded px-2 py-1 text-xs hover:bg-accent" onClick={() => setGraphView((value) => !value)}>{graphView ? t('taskGraph.listView') : t('taskGraph.graphView')}</button>
        <ModalSizeToggle expanded={expanded} onToggle={() => setExpanded((value) => !value)} testId="task-graph-size-toggle" />
      </div>
      <ScrollArea className="min-h-0 flex-1" contentClassName="p-3 min-h-full">
        {graphView ? <GraphView graph={graph} /> : <GroupedList graph={graph} />}
      </ScrollArea>
    </div>, document.body) : null}
  </div>
}

function GroupedList({ graph }: { graph: TaskGraphSnapshot }): JSX.Element {
  const { t } = useTranslation()
  const blocked = new Map(graph.blocked.map((item) => [item.id, item.waitingOn]))
  const groups = [
    [t('taskGraph.active'), graph.nodes.filter((node) => node.status === 'in_progress')],
    [t('taskGraph.ready'), graph.nodes.filter((node) => graph.ready.includes(node.id))],
    [t('taskGraph.blocked'), graph.nodes.filter((node) => blocked.has(node.id))],
    [t('taskGraph.done'), graph.nodes.filter((node) => node.status === 'completed' || node.status === 'cancelled')],
  ] as const
  return <div className="space-y-3">{groups.map(([label, nodes]) => nodes.length ? <section key={label}>
    <h3 className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted-foreground">{label} ({nodes.length})</h3>
    <div className="space-y-1">{nodes.map((node) => <NodeRow key={node.id} node={node} waitingOn={blocked.get(node.id)} />)}</div>
  </section> : null)}</div>
}

function NodeRow({ node, waitingOn }: { node: TaskGraphNode; waitingOn?: readonly string[] }): JSX.Element {
  const { t } = useTranslation()
  return <div className="flex gap-2 rounded-md bg-muted/35 px-2.5 py-2 text-sm">
    <StatusIcon status={node.status} blocked={Boolean(waitingOn?.length)} />
    <div className="min-w-0"><div className={cn('break-words', (node.status === 'completed' || node.status === 'cancelled') && 'text-muted-foreground line-through')}>{node.content}</div>
      <div className="mt-0.5 text-caption text-muted-foreground"><code>{node.id}</code>{node.priority ? ` · ${node.priority}` : ''}{waitingOn?.length ? ` · ${t('taskGraph.waitingOn', { ids: waitingOn.join(', ') })}` : ''}</div>
    </div>
  </div>
}

const GRAPH_NODE_WIDTH = 184
const GRAPH_NODE_HEIGHT = 76
const GRAPH_COLUMN_GAP = 104
const GRAPH_ROW_GAP = 28
const GRAPH_PADDING = 28
const GRAPH_LEVEL_GAP_VERTICAL = 68

type PositionedNode = { node: TaskGraphNode; x: number; y: number }

function GraphView({ graph }: { graph: TaskGraphSnapshot }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const portrait = usePortraitGraphLayout()
  const layout = useMemo(() => graphLayout(graph, portrait ? 'vertical' : 'horizontal'), [graph, portrait])
  const related = useMemo(() => selected ? connectedNodeIds(graph, selected) : null, [graph, selected])
  return <div className="flex w-max min-w-full justify-center" data-testid="task-graph-scroll-content"><div className="relative shrink-0 overflow-hidden rounded-lg border border-border/50 bg-muted/10" style={{ width: layout.width, height: layout.height }} data-testid="task-graph-view" data-layout={layout.direction} data-canvas-width={layout.width} data-canvas-height={layout.height}>
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
      <defs>
        <marker id="todo-graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {graph.edges.map((edge) => {
        const from = layout.byId.get(edge.from); const to = layout.byId.get(edge.to)
        if (!from || !to) return null
        const vertical = layout.direction === 'vertical'
        const x1 = vertical ? from.x + GRAPH_NODE_WIDTH / 2 : from.x + GRAPH_NODE_WIDTH
        const y1 = vertical ? from.y + GRAPH_NODE_HEIGHT : from.y + GRAPH_NODE_HEIGHT / 2
        const x2 = vertical ? to.x + GRAPH_NODE_WIDTH / 2 : to.x
        const y2 = vertical ? to.y : to.y + GRAPH_NODE_HEIGHT / 2
        const bend = vertical ? Math.max(28, (y2 - y1) * 0.46) : Math.max(36, (x2 - x1) * 0.46)
        const path = vertical
          ? `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
        const highlighted = selected === null || (related?.has(edge.from) && related.has(edge.to))
        return <path key={`${edge.from}-${edge.to}`} d={path}
          fill="none" stroke="currentColor" strokeWidth={highlighted ? 2 : 1.25} markerEnd="url(#todo-graph-arrow)"
          className={cn('text-border transition-opacity', highlighted ? 'opacity-90' : 'opacity-15', selected && highlighted && 'text-sky-500')} />
      })}
    </svg>
    {layout.nodes.map(({ node, x, y }) => {
      const dimmed = related !== null && !related.has(node.id)
      const blocked = graph.blocked.some((item) => item.id === node.id)
      return <button key={node.id} type="button" onClick={() => setSelected((current) => current === node.id ? null : node.id)}
        className={cn('absolute flex flex-col overflow-hidden rounded-lg border border-border/50 bg-background px-3 py-2 text-left shadow-sm transition-all hover:shadow-md',
          node.status === 'completed' && 'border-emerald-500/60', node.status === 'in_progress' && 'ak-task-node-running border-sky-500/75 ring-1 ring-sky-500/20',
          blocked && 'border-amber-500/60', node.status === 'cancelled' && 'border-dashed opacity-60', selected === node.id && 'ring-2 ring-sky-500', dimmed && 'opacity-25')}
        style={{ left: x, top: y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }} data-node-id={node.id}>
        <span className="line-clamp-2 text-xs font-medium leading-snug">{node.content}</span>
        <span className="mt-auto flex items-center gap-1.5 text-caption text-muted-foreground"><StatusIcon status={node.status} blocked={blocked} /><code className="truncate">{node.id}</code></span>
      </button>
    })}
  </div></div>
}

function graphLayout(graph: TaskGraphSnapshot, direction: 'horizontal' | 'vertical'): { nodes: PositionedNode[]; byId: Map<string, PositionedNode>; width: number; height: number; direction: 'horizontal' | 'vertical' } {
  const levels = graphLevels(graph)
  if (direction === 'vertical') {
    const maxColumns = Math.max(1, ...levels.map((level) => level.length))
    const width = GRAPH_PADDING * 2 + maxColumns * GRAPH_NODE_WIDTH + (maxColumns - 1) * GRAPH_ROW_GAP
    const height = GRAPH_PADDING * 2 + levels.length * GRAPH_NODE_HEIGHT + Math.max(0, levels.length - 1) * GRAPH_LEVEL_GAP_VERTICAL
    const nodes: PositionedNode[] = []
    levels.forEach((level, row) => {
      const rowWidth = level.length * GRAPH_NODE_WIDTH + Math.max(0, level.length - 1) * GRAPH_ROW_GAP
      const startX = (width - rowWidth) / 2
      level.forEach((node, column) => nodes.push({ node, x: startX + column * (GRAPH_NODE_WIDTH + GRAPH_ROW_GAP), y: GRAPH_PADDING + row * (GRAPH_NODE_HEIGHT + GRAPH_LEVEL_GAP_VERTICAL) }))
    })
    return { nodes, byId: new Map(nodes.map((item) => [item.node.id, item])), width, height, direction }
  }
  const maxRows = Math.max(1, ...levels.map((level) => level.length))
  const height = GRAPH_PADDING * 2 + maxRows * GRAPH_NODE_HEIGHT + (maxRows - 1) * GRAPH_ROW_GAP
  const nodes: PositionedNode[] = []
  levels.forEach((level, column) => {
    const columnHeight = level.length * GRAPH_NODE_HEIGHT + Math.max(0, level.length - 1) * GRAPH_ROW_GAP
    const startY = (height - columnHeight) / 2
    level.forEach((node, row) => nodes.push({ node, x: GRAPH_PADDING + column * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP), y: startY + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP) }))
  })
  const width = GRAPH_PADDING * 2 + levels.length * GRAPH_NODE_WIDTH + Math.max(0, levels.length - 1) * GRAPH_COLUMN_GAP
  return { nodes, byId: new Map(nodes.map((item) => [item.node.id, item])), width, height, direction }
}

function usePortraitGraphLayout(): boolean {
  const query = '(max-width: 1023px) and (orientation: portrait)'
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (): void => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return matches
}

function connectedNodeIds(graph: TaskGraphSnapshot, selected: string): Set<string> {
  const connected = new Set([selected])
  for (const edge of graph.edges) {
    if (edge.from === selected) connected.add(edge.to)
    if (edge.to === selected) connected.add(edge.from)
  }
  return connected
}

function graphLevels(graph: TaskGraphSnapshot): TaskGraphNode[][] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const level = new Map<string, number>()
  const visit = (id: string): number => {
    const cached = level.get(id); if (cached !== undefined) return cached
    const parents = graph.edges.filter((edge) => edge.to === id).map((edge) => edge.from)
    const value = parents.length ? Math.max(...parents.map(visit)) + 1 : 0
    level.set(id, value); return value
  }
  graph.nodes.forEach((node) => visit(node.id))
  const out: TaskGraphNode[][] = []
  for (const [id, value] of level) { out[value] ??= []; out[value]!.push(byId.get(id)!) }
  return out
}

function StatusIcon({ status, blocked }: { status: TaskGraphStatus; blocked: boolean }): JSX.Element {
  const cls = 'mt-0.5 h-3.5 w-3.5 flex-none'
  if (blocked) return <LockKeyhole className={cn(cls, 'text-amber-600')} />
  if (status === 'completed') return <Check className={cn(cls, 'text-emerald-600')} />
  if (status === 'cancelled') return <X className={cn(cls, 'text-muted-foreground')} />
  if (status === 'in_progress') return <CircleDashed className={cn(cls, 'animate-pulse text-sky-600')} />
  return <Circle className={cn(cls, 'text-muted-foreground')} />
}
