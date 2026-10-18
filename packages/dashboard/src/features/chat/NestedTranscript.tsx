/**
 * Slim, read-only transcript renderer used inside SubAgentCard.
 *
 * The parent uses the full [[ChatPanel]] (avatars, bubbles, wide bodies).
 * That treatment is too heavy when the transcript is a child sub-agent shown
 * in a small card — especially in matrix mode where 4 rows share a row of
 * `sm:grid-cols-2`. This component renders the same [[Message]] shape but
 * plain: no user bubble, no avatar column, condensed tool-call rows.
 *
 * We intentionally do NOT hide the first user turn even though the parent
 * card header already shows the prompt (user directive: keep it visible so
 * the transcript reads top-to-bottom without implied context).
 *
 * Virtualised via [[VirtualTranscript]] — child sessions can produce hundreds
 * of tool calls, and matrix mode stacks 4 of them side-by-side. Without
 * virtualisation each parent turn re-mounts every nested row on every diff.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'
import {
  collectAllToolResults,
  groupConsecutiveToolCalls,
  makeToolCallGroup,
  type GroupedContentItem,
  type ToolCallGroup,
} from './grouping.js'
import { firstLine, pickRenderer, previewValue, truncate, type SummaryRow } from './toolSummaries/index.js'
import { VirtualTranscript } from './VirtualTranscript.js'
import { normalizeThinkingDisplayText } from './normalize-thinking-text.js'

type Props = {
  messages: readonly Message[]
  compact?: boolean
  virtualized?: boolean
}

type NestedRenderItem =
  | { kind: 'message'; message: Message; messageIndex: number }
  | { kind: 'tool_activity'; group: ToolCallGroup; messageIndex: number }

type NestedSummaryRow = SummaryRow & { toolName: string }

// A long run of tool calls/results can collapse to one visible activity row.
// Size the parent viewport from rendered rows, never from raw message count.
export function nestedTranscriptRowCount(messages: readonly Message[]): number {
  const visible = messages.filter((message) => message.role !== 'system')
  const results = collectAllToolResults(visible)
  return collectNestedRenderItems(visible, results).length
}

export function NestedTranscript({ messages, compact = false, virtualized = true }: Props): JSX.Element {
  const { resultsByCallId, groupedCallIds, renderItems } = useMemo(() => {
    const visible = messages.filter((message) => message.role !== 'system')
    const results = collectAllToolResults(visible)
    return {
      resultsByCallId: results,
      groupedCallIds: collectNestedGroupedResultCallIds(visible, results),
      renderItems: collectNestedRenderItems(visible, results),
    }
  }, [messages])
  const [pinned, setPinned] = useState(true)

  const renderItem = useCallback(
    (item: NestedRenderItem): JSX.Element => {
      if (item.kind === 'tool_activity') {
        return <NestedToolGroup group={item.group} />
      }
      return (
        <NestedMessage
          message={item.message}
          messageIndex={item.messageIndex}
          resultsByCallId={resultsByCallId}
          groupedCallIds={groupedCallIds}
          compact={compact}
        />
      )
    },
    [resultsByCallId, groupedCallIds, compact],
  )

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col text-ui leading-relaxed',
        virtualized && 'flex-1',
        compact && 'text-meta',
      )}
      data-testid="nested-transcript"
      data-virtualized={virtualized ? 'true' : 'false'}
    >
      {virtualized ? (
        <VirtualTranscript<NestedRenderItem>
          items={renderItems}
          renderItem={renderItem}
          keyFor={(item, i) => item.kind === 'tool_activity' ? `tool-${item.group.firstCallId}` : `msg-${item.messageIndex}-${i}`}
          pinnedToBottom={pinned}
          onPinnedChange={setPinned}
          itemClassName={cn('px-3 py-1', compact && 'px-2 py-0.5')}
          defaultItemHeight={40}
        />
      ) : (
        <div>
          {renderItems.map((item, index) => (
            <div
              key={item.kind === 'tool_activity' ? `tool-${item.group.firstCallId}` : `msg-${item.messageIndex}-${index}`}
              className={cn('px-3 py-1', compact && 'px-2 py-0.5')}
            >
              {renderItem(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function collectNestedGroupedResultCallIds(
  messages: readonly Message[],
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
): ReadonlySet<string> {
  const set = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const g of groupConsecutiveToolCalls(m.content, resultsByCallId)) {
      if (g.kind === 'tool_call_group') for (const c of g.calls) set.add(c.callId)
    }
  }
  return set
}

function collectNestedRenderItems(
  messages: readonly Message[],
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
): NestedRenderItem[] {
  const out: NestedRenderItem[] = []
  let i = 0

  while (i < messages.length) {
    const group = collectNestedToolActivity(messages, i, resultsByCallId)
    if (group) {
      out.push({ kind: 'tool_activity', group, messageIndex: i })
      i = skipNestedToolActivity(messages, i, new Set(group.calls.map((call) => call.callId)))
      continue
    }

    const message = messages[i]!
    out.push({ kind: 'message', message, messageIndex: i })
    i += 1
  }
  return out
}

function collectNestedToolActivity(
  messages: readonly Message[],
  startIndex: number,
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
): ToolCallGroup | null {
  if (!isPureToolCallAssistantMessage(messages[startIndex])) return null

  const calls: ToolCallContent[] = []
  const knownCallIds = new Set<string>()
  let i = startIndex

  while (i < messages.length) {
    const assistantMessage = messages[i]
    if (!isPureToolCallAssistantMessage(assistantMessage)) break
    for (const content of assistantMessage.content) {
      calls.push(content)
      knownCallIds.add(content.callId)
    }
    i += 1

    while (i < messages.length && isToolResultMessageForKnownCalls(messages[i], knownCallIds)) {
      i += 1
    }
  }

  if (calls.length < 2) return null
  return makeToolCallGroup(calls, resultsByCallId, true)
}

function skipNestedToolActivity(
  messages: readonly Message[],
  startIndex: number,
  knownCallIds: ReadonlySet<string>,
): number {
  let i = startIndex
  while (i < messages.length) {
    if (!isPureToolCallAssistantMessage(messages[i])) break
    i += 1
    while (i < messages.length && isToolResultMessageForKnownCalls(messages[i], knownCallIds)) {
      i += 1
    }
  }
  return i
}

function isPureToolCallAssistantMessage(
  message: Message | undefined,
): message is Message & { role: 'assistant'; content: ToolCallContent[] } {
  if (!message || message.role !== 'assistant' || message.content.length === 0) return false
  return message.content.every((content) => content.type === 'tool_call')
}

function isToolResultMessageForKnownCalls(
  message: Message | undefined,
  knownCallIds: ReadonlySet<string>,
): boolean {
  if (!message || message.role !== 'tool' || message.content.length === 0) return false
  return message.content.every(
    (content) => content.type === 'tool_result' && knownCallIds.has(content.callId),
  )
}

function NestedMessage({
  message,
  messageIndex,
  resultsByCallId,
  groupedCallIds,
  compact,
}: {
  message: Message
  messageIndex: number
  resultsByCallId: ReadonlyMap<string, ToolResultContent>
  groupedCallIds: ReadonlySet<string>
  compact: boolean
}): JSX.Element | null {
  const { t } = useTranslation()
  const visibleContent: MessageContent[] =
    message.role === 'tool'
      ? message.content.filter(
          (c) => c.type !== 'tool_result' || !groupedCallIds.has(c.callId),
        )
      : [...message.content]
  if (visibleContent.length === 0) return null

  if (message.role === 'user') {
    return (
      <RoleColumn label={messageIndex === 0 ? t('chat.subAgent.prompt') : t('chat.subAgent.followUp')} tone="user" compact={compact}>
        {visibleContent.map((c, i) => (
          <NestedContent key={i} content={c} role="user" compact={compact} />
        ))}
      </RoleColumn>
    )
  }

  if (message.role === 'tool') {
    return (
      <RoleColumn label="Tool" tone="tool" compact={compact}>
        {visibleContent.map((c, i) => (
          <NestedContent key={i} content={c} role="tool" compact={compact} />
        ))}
      </RoleColumn>
    )
  }

  const grouped = groupConsecutiveToolCalls(visibleContent, resultsByCallId)
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="nested-assistant-content">
      {grouped.map((item, i) => (
        <NestedGroupItem key={i} item={item} compact={compact} />
      ))}
    </div>
  )
}

function RoleColumn({
  label,
  tone,
  compact,
  children,
}: {
  label: string
  tone: 'user' | 'tool'
  compact: boolean
  children: React.ReactNode
}): JSX.Element {
  const labelTone =
    tone === 'user'
      ? 'text-sky-700 dark:text-sky-400'
      : 'text-emerald-700 dark:text-emerald-400'
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className={cn(
          'text-[0.75rem] font-semibold uppercase tracking-[0.08em]',
          labelTone,
          compact && 'text-[0.75rem]',
        )}
      >
        {label}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
      </div>
    </div>
  )
}

function NestedContent({
  content,
  role,
  compact,
}: {
  content: MessageContent
  role: Message['role']
  compact: boolean
}): JSX.Element | null {
  if (content.type === 'text') {
    return <NestedPreviewText text={content.text} compact={compact} preserveWhitespace={role === 'user'} />
  }
  if (content.type === 'tool_call') {
    return <NestedToolCall call={content} />
  }
  if (content.type === 'tool_result') {
    return <NestedToolResult result={content} />
  }
  if (content.type === 'thinking') {
    return (
      <div className="text-muted-foreground" data-testid="nested-thinking-markdown">
        <NestedPreviewText text={normalizeThinkingDisplayText(content.text)} compact={compact} muted />
      </div>
    )
  }
  return null
}

function NestedGroupItem({
  item,
  compact,
}: {
  item: GroupedContentItem
  compact: boolean
}): JSX.Element | null {
  if (item.kind === 'single') {
    return <NestedContent content={item.content} role="assistant" compact={compact} />
  }
  if (item.kind === 'thinking_group') {
    return (
      <div className="space-y-2">
        {item.updates.map((update, index) => (
          <NestedContent key={`${index}:${update.text}`} content={update} role="assistant" compact={compact} />
        ))}
      </div>
    )
  }
  return <NestedToolGroup group={item} />
}

function NestedToolGroup({ group }: { group: ToolCallGroup }): JSX.Element {
  const { t } = useTranslation()
  const rows = group.mixed
    ? group.calls.map((call) => {
        const renderer = pickRenderer(call.name)
        const row = renderer({ calls: [call], results: group.results })[0]
        return row ? { ...row, toolName: call.name } : null
      }).filter((row): row is NonNullable<typeof row> => !!row)
    : pickRenderer(group.toolName)({ calls: group.calls, results: group.results }).map((row) => ({
        ...row,
        toolName: group.toolName,
      }))
  const [open, setOpen] = useState(false)
  const failed = group.calls.filter((call) => group.results.get(call.callId)?.ok === false).length
  const succeeded = group.calls.filter((call) => group.results.get(call.callId)?.ok === true).length
  const running = group.calls.length - failed - succeeded
  const toolMix = summarizeNestedToolMix(group.calls)

  if (group.mixed) {
    return (
      <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/45 shadow-sm" data-testid={`nested-tool-group-${group.firstCallId}`}>
        <button
          type="button"
          className="flex min-h-9 min-w-0 items-center gap-2 border-b border-transparent bg-muted/30 px-2.5 py-1.5 text-left text-meta text-muted-foreground hover:bg-muted/55 aria-expanded:border-border/45 aria-expanded:bg-muted/45"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="nested-tool-group-toggle"
        >
          <span className="flex-none font-semibold text-foreground">
            Tool activity
          </span>
          <span className="flex-none rounded-md bg-background/70 px-1.5 py-0.5 font-mono text-[0.75rem] text-foreground">{group.calls.length} ops</span>
          <span className="hidden min-w-0 flex-1 truncate sm:block" title={toolMix}>{toolMix}</span>
          {failed > 0 ? <NestedStatusBadge tone="failed" label={`${failed} ${t('chat.transcript.failed')}`} /> : null}
          {succeeded > 0 ? <NestedStatusBadge tone="succeeded" label={`${succeeded} Succeeded`} /> : null}
          {running > 0 ? <NestedStatusBadge tone="running" label={`${running} Running`} /> : null}
        </button>
        {open ? <NestedToolRows rows={rows} group={group} /> : null}
      </div>
    )
  }

  return <NestedToolRows rows={rows} group={group} />
}

function NestedToolRows({
  rows,
  group,
}: {
  rows: NestedSummaryRow[]
  group: ToolCallGroup
}): JSX.Element {
  const rowsByCallId = new Map(rows.map((row) => [row.callId, row]))
  return (
    <div className="flex min-w-0 flex-col divide-y divide-border/35" data-testid={`nested-tool-rows-${group.firstCallId}`}>
      {group.calls.map((call) => (
        <NestedToolDetail
          key={call.callId}
          call={call}
          result={group.results.get(call.callId)}
          summary={rowsByCallId.get(call.callId)}
        />
      ))}
    </div>
  )
}

function NestedToolDetail({
  call,
  result,
  summary,
}: {
  call: ToolCallContent
  result?: ToolResultContent
  summary?: NestedSummaryRow
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ok = result?.ok !== false
  const preview = call.intent ?? summary?.primary ?? previewToolInput(call.input) ?? call.callId
  return (
    <div
      className={cn(
        'min-w-0 bg-background/20 text-meta',
        ok ? 'text-muted-foreground' : 'bg-destructive/5 text-foreground',
      )}
      data-testid={`nested-tool-detail-${call.callId}`}
    >
      <button
        type="button"
        className="grid w-full min-w-0 grid-cols-[minmax(4.5rem,auto)_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/30"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span
          className={cn(
            'min-w-0 truncate rounded-md border border-border/55 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.75rem]',
            ok ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300',
          )}
        >
          {call.name}
        </span>
        <span className="min-w-0 truncate font-sans text-meta text-foreground" title={preview} data-testid={`nested-tool-intention-${call.callId}`}>{preview}</span>
        <span className="flex-none font-sans text-[0.75rem] text-muted-foreground">{!ok ? t('chat.transcript.failed') : open ? '⌄' : '›'}</span>
      </button>
      {open ? (
        <div className="mx-1.5 mb-1.5 grid min-w-0 gap-2 rounded-md border border-border/60 bg-background/70 p-2 text-[0.75rem]">
          <NestedToolPayload label={t('chatCommon.inputs')} value={formatCompleteInput(call.input)} />
          {result ? (
            <NestedToolPayload
              label={t('chatCommon.result')}
              value={result.content || t('chatCommon.noOutput')}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function NestedToolPayload({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="mb-1 font-sans text-caption font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <pre className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-muted/45 p-2 text-foreground [overflow-wrap:anywhere]">
        {value}
      </pre>
    </div>
  )
}

function previewToolInput(input: ToolCallContent['input']): string | undefined {
  const preview = Object.entries(input)
    .slice(0, 2)
    .map(([key, value]) => `${key}=${truncate(previewValue(value), 40)}`)
    .join(' · ')
  return preview || undefined
}

function formatCompleteInput(input: ToolCallContent['input']): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function NestedStatusBadge({
  tone,
  label,
}: {
  tone: 'failed' | 'succeeded' | 'running'
  label: string
}): JSX.Element {
  const className = tone === 'failed'
    ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
    : tone === 'succeeded'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      : 'bg-background/80 text-muted-foreground'
  return (
    <span className={cn('flex-none rounded px-1 text-[0.75rem] uppercase tracking-wider', className)}>
      {label}
    </span>
  )
}

function summarizeNestedToolMix(calls: readonly ToolCallContent[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(', ')
}

function NestedToolCall({ call }: { call: ToolCallContent }): JSX.Element {
  const preview = Object.entries(call.input)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${truncate(previewValue(v), 40)}`)
    .join(' · ')
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[0.75rem] text-muted-foreground">
      <span className="flex-none rounded bg-background/70 px-1 text-[0.75rem] uppercase tracking-wider">
        {call.name}
      </span>
      <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]" title={call.intent ?? undefined}>
        {call.intent ?? (preview || call.callId)}
      </span>
    </div>
  )
}

function NestedToolResult({ result }: { result: ToolResultContent }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const preview = truncate(firstLine(result.content), 140)
  return (
    <div
      className={cn(
        'min-w-0 rounded font-mono text-[0.75rem]',
        result.ok ? 'text-muted-foreground' : 'bg-muted/55 text-foreground',
      )}
      data-testid={`nested-tool-result-${result.callId}`}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-1.5 px-1.5 py-0.5 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span
          className={cn(
            'flex-none rounded bg-background/70 px-1 text-[0.75rem] uppercase tracking-wider',
            result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300',
          )}
        >
          {result.ok ? '✓' : '✗'}
        </span>
        <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">{preview}</span>
        <span className="flex-none text-muted-foreground">{open ? '⌄' : '›'}</span>
      </button>
      {open ? (
        <div className="mx-1.5 mb-1.5">
          <NestedToolPayload
            label={t('chatCommon.result')}
            value={result.content || t('chatCommon.noOutput')}
          />
        </div>
      ) : null}
    </div>
  )
}

const NESTED_MARKDOWN_TEXT_LIMIT = 12_000
const NESTED_USER_PROMPT_LIMIT = 1_800

function NestedPreviewText({
  text,
  compact,
  muted = false,
  preserveWhitespace = false,
}: {
  text: string
  compact: boolean
  muted?: boolean
  preserveWhitespace?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const limit = preserveWhitespace ? NESTED_USER_PROMPT_LIMIT : NESTED_MARKDOWN_TEXT_LIMIT
  const truncated = text.length > limit
  const markdown = truncated && !expanded
    ? `${text.slice(0, limit)}…`
    : text
  return (
    <div
      className={cn(
        'ak-markdown-body min-w-0 max-w-full break-words [overflow-wrap:anywhere]',
        muted ? 'text-muted-foreground' : 'text-foreground',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border/70 [&_pre]:bg-muted/45 [&_pre]:p-3',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border/70 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border/70 [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
        preserveWhitespace && '[&_p]:whitespace-pre-wrap',
        compact ? 'text-meta' : 'text-ui',
      )}
      data-testid="nested-markdown"
      data-preserve-whitespace={preserveWhitespace ? 'true' : undefined}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          img({ alt }) {
            return (
              <span className="inline-flex rounded-md border border-dashed border-border/70 bg-muted/40 px-2 py-1 text-[0.75rem] text-muted-foreground">
                {alt || t('chatCommon.complexContentOmitted')}
              </span>
            )
          },
          a({ children, ...props }) {
            return <a {...props} target="_blank" rel="noreferrer">{children}</a>
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
      {truncated ? (
        <button
          type="button"
          className="mt-2 rounded-md border border-border/70 bg-background px-2.5 py-1 text-[0.75rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
          data-testid="nested-markdown-toggle"
        >
          {expanded ? t('chatCommon.showLessContent') : t('chatCommon.showFullContent')}
        </button>
      ) : null}
    </div>
  )
}
