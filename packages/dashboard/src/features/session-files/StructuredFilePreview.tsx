import { useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { cn } from '../../lib/utils.js'
import { buildPreviewModel, type LogLevel, type PreviewModel } from './file-preview-model.js'

export function StructuredFilePreview({ path, content, fontSize }: { path: string; content: string; fontSize: number }): JSX.Element | null {
  const model = useMemo(() => buildPreviewModel(path, content), [content, path])
  if (model.kind === 'source' || model.kind === 'json') return null
  return <PreviewBody model={model} fontSize={fontSize} />
}

function PreviewBody({ model, fontSize }: { model: Exclude<PreviewModel, { kind: 'source' | 'json' }>; fontSize: number }): JSX.Element {
  if (model.kind === 'table') return <TablePreview model={model} fontSize={fontSize} />
  if (model.kind === 'records') return <RecordPreview model={model} fontSize={fontSize} />
  if (model.kind === 'outline') return <OutlinePreview model={model} fontSize={fontSize} />
  if (model.kind === 'log') return <LogPreview model={model} fontSize={fontSize} />
  return <DiffPreview model={model} fontSize={fontSize} />
}

function Notice({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="border-b border-amber-300/50 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">{children}</div>
}
function VirtualRows({ count, itemContent, testId }: { count: number; itemContent: (index: number) => React.ReactNode; testId: string }): JSX.Element {
  return <Virtuoso className="min-h-0 flex-1" totalCount={count} itemContent={itemContent} data-testid={testId} />
}

function TablePreview({ model, fontSize }: { model: Extract<PreviewModel, { kind: 'table' }>; fontSize: number }): JSX.Element {
  const grid = `repeat(${Math.max(1, model.headers.length)}, minmax(8rem, 18rem))`
  return <div className="flex h-full min-h-0 flex-col" data-testid="session-file-table-preview">
    {model.warnings.map((warning) => <Notice key={warning}>{warning}</Notice>)}
    {model.omittedColumns > 0 || model.omittedRows > 0 ? <Notice>{`${model.omittedRows} rows and ${model.omittedColumns} columns omitted by preview limits.`}</Notice> : null}
    <div className="min-h-0 flex-1 overflow-x-auto">
      <div className="flex h-full min-w-max flex-col" style={{ width: `${Math.max(1, model.headers.length) * 12}rem`, fontSize }}>
        <div className="grid flex-none border-b border-border/50 bg-muted/80 font-semibold" style={{ gridTemplateColumns: grid }}>{model.headers.map((header, index) => <div key={`${index}:${header}`} className="truncate border-r border-border/50 px-2 py-1.5" title={header}>{header}</div>)}</div>
        <VirtualRows count={model.rows.length} testId="session-file-table-rows" itemContent={(index) => <div className="grid border-b border-border/50" style={{ gridTemplateColumns: grid }}>{model.rows[index]!.map((cell, column) => <div key={column} className="min-h-7 whitespace-pre-wrap break-words border-r border-border/40 px-2 py-1" title={cell}>{cell}</div>)}</div>} />
      </div>
    </div>
  </div>
}

function RecordPreview({ model, fontSize }: { model: Extract<PreviewModel, { kind: 'records' }>; fontSize: number }): JSX.Element {
  return <div className="flex h-full min-h-0 flex-col" data-testid="session-file-record-preview">
    {model.error ? <Notice>{model.error}</Notice> : null}{model.omittedNodes ? <Notice>{`${model.omittedNodes} nodes omitted.`}</Notice> : null}
    <VirtualRows count={model.rows.length} testId="session-file-record-rows" itemContent={(index) => { const row = model.rows[index]!; return <div className="grid grid-cols-[minmax(8rem,40%)_minmax(0,1fr)] border-b border-border/40 font-mono" style={{ fontSize }}><div className="truncate border-r border-border/40 px-2 py-1 text-muted-foreground" title={row.path}>{row.path}</div><div className="whitespace-pre-wrap break-all px-2 py-1">{row.value}</div></div> }} />
  </div>
}

function OutlinePreview({ model, fontSize }: { model: Extract<PreviewModel, { kind: 'outline' }>; fontSize: number }): JSX.Element {
  return <div className="flex h-full min-h-0 flex-col" data-testid="session-file-outline-preview">
    {model.error ? <Notice>{model.error} Source remains available.</Notice> : null}{model.omittedNodes ? <Notice>{`${model.omittedNodes} nodes omitted.`}</Notice> : null}
    <VirtualRows count={model.rows.length} testId="session-file-outline-rows" itemContent={(index) => { const row = model.rows[index]!; return <div className="flex min-h-7 items-start border-b border-border/40 px-2 py-1 font-mono" style={{ fontSize, paddingLeft: `${8 + Math.min(row.depth, 20) * 16}px` }}><span className="font-medium">{row.key}</span>{row.value !== undefined ? <span className="ml-2 break-all text-muted-foreground">{row.value}</span> : null}</div> }} />
  </div>
}

const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'other']
function LogPreview({ model, fontSize }: { model: Extract<PreviewModel, { kind: 'log' }>; fontSize: number }): JSX.Element {
  const [enabled, setEnabled] = useState<Set<LogLevel>>(() => new Set(LOG_LEVELS))
  const rows = useMemo(() => model.rows.filter((row) => enabled.has(row.level)), [enabled, model.rows])
  return <div className="flex h-full min-h-0 flex-col bg-[#0b0f14] text-slate-200" data-testid="session-file-log-preview">
    <div className="flex flex-wrap gap-1 border-b border-slate-700 p-2">{LOG_LEVELS.map((level) => <button key={level} type="button" onClick={() => setEnabled((current) => { const next = new Set(current); if (next.has(level)) next.delete(level); else next.add(level); return next })} className={cn('rounded border border-border/50 px-2 py-1 text-caption uppercase', enabled.has(level) ? 'border-slate-500 bg-slate-700' : 'border-slate-800 text-slate-500')} aria-pressed={enabled.has(level)}>{level}</button>)}</div>
    {model.omittedRows ? <Notice>{`Showing the newest ${model.rows.length} lines; ${model.omittedRows} older lines omitted.`}</Notice> : null}
    <VirtualRows count={rows.length} testId="session-file-log-rows" itemContent={(index) => { const row = rows[index]!; return <div className={cn('min-h-6 whitespace-pre-wrap break-all border-b border-slate-800/70 px-2 py-1 font-mono', row.level === 'error' && 'text-red-300', row.level === 'warn' && 'text-amber-300', row.level === 'debug' && 'text-slate-400')} style={{ fontSize }}>{row.text}</div> }} />
  </div>
}

function DiffPreview({ model, fontSize }: { model: Extract<PreviewModel, { kind: 'diff' }>; fontSize: number }): JSX.Element {
  return <div className="flex h-full min-h-0 flex-col bg-[#0d1117] text-slate-200" data-testid="session-file-diff-preview">{model.omittedRows ? <Notice>{`${model.omittedRows} lines omitted.`}</Notice> : null}<VirtualRows count={model.rows.length} testId="session-file-diff-rows" itemContent={(index) => { const row = model.rows[index]!; return <div className={cn('min-h-6 whitespace-pre font-mono', row.type === 'add' && 'bg-emerald-950/60 text-emerald-200', row.type === 'delete' && 'bg-red-950/60 text-red-200', row.type === 'hunk' && 'bg-blue-950/60 text-blue-200', row.type === 'meta' && 'font-semibold text-slate-300')} style={{ fontSize }}><span className="block px-2 py-0.5">{row.text}</span></div> }} /></div>
}
