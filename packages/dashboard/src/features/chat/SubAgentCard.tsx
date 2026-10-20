/**
 * A row that renders a single `agent` tool_call inline in the parent's
 * transcript. Four modes, chosen from `lifecycle.status`:
 *
 *   pending   — the parent LLM emitted the tool_call but no child session
 *               has spawned yet (waiting for `server:control_update`)
 *   running   — child is live; [[NestedTranscript]] mirrors its
 *               state.messages in a slim, bubble-free layout
 *   completed — envelope arrived and parsed; header shows agent_type,
 *               turn count, elapsed
 *   failed    — same header, plus the error body from `<error>`
 *
 * The card intercepts the `agent` toolName in ChatPanel's group dispatcher;
 * see [[sub-agent-envelope]] for the parser that reads terminal state from
 * `tool_result.content` on replay.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  MoreHorizontal,
  Shield,
  Square,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { Message, ToolCallContent } from '@agent-kernel/kernel'
import type { ApprovalRequiredEvent, ToolCardMode } from '@agent-kernel/shared'

import { cn } from '../../lib/utils.js'
import { withViewTransition } from '../../lib/viewTransition.js'
import type { DashboardSocket } from '../../session.js'
import type { ToolCallGroup } from './grouping.js'
import { NestedTranscript, nestedTranscriptRowCount } from './NestedTranscript.js'
import { parseSubAgentEnvelope } from './subAgentEnvelope.js'
import {
  useSubAgentSession,
  type SubAgentLifecycle,
} from './useSubAgentSession.js'
import { useSubAgentPolicy, type SubAgentPolicyView } from './useSubAgentPolicy.js'

const VIRTUALIZED_TRANSCRIPT_THRESHOLD = 6
const VIRTUALIZED_ROW_HEIGHT_PX = 32
const VIRTUALIZED_TRANSCRIPT_MIN_HEIGHT_PX = 160
const VIRTUALIZED_TRANSCRIPT_MAX_HEIGHT_PX = 320

type Props = {
  parentSessionId: string
  socket: DashboardSocket | null
  group: ToolCallGroup
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  toolCardMode?: ToolCardMode
  timestamp?: string
}

export function SubAgentCard(props: Props): JSX.Element {
  const { t } = useTranslation()
  const calls = props.group.calls
  if (calls.length >= 2) {
    return (
      <div
        className="min-w-0"
        data-testid={`sub-agent-group-${props.group.firstCallId}`}
      >
        <div className="mb-1.5 flex min-h-7 items-center gap-2 px-1 text-muted-foreground">
          <Workflow className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <span className="text-[0.75rem] font-medium">{t('chat.subAgent.groupLabel')}</span>
          <span className="font-mono text-caption text-muted-foreground/80">{calls.length}</span>
        </div>
        <div
          className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/35 divide-y divide-border/40"
          data-testid={`sub-agent-group-list-${props.group.firstCallId}`}
        >
          {calls.map((call) => (
            <SubAgentRow
              key={call.callId}
              grouped
              compact
              call={call}
              parentSessionId={props.parentSessionId}
              socket={props.socket}
              result={props.group.results.get(call.callId) ?? null}
              approval={props.approvalByCallId.get(call.callId) ?? null}
              timestamp={props.timestamp}
            />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {calls.map((call) => (
        <SubAgentRow
          key={call.callId}
          call={call}
          parentSessionId={props.parentSessionId}
          socket={props.socket}
          result={props.group.results.get(call.callId) ?? null}
          approval={props.approvalByCallId.get(call.callId) ?? null}
          timestamp={props.timestamp}
        />
      ))}
    </div>
  )
}

type RowProps = {
  call: ToolCallContent
  parentSessionId: string
  socket: DashboardSocket | null
  result:
    | import('@agent-kernel/kernel').ToolResultContent
    | null
  approval: ApprovalRequiredEvent | null
  timestamp?: string
  /**
   * Matrix mode: shrink the nested transcript and default-collapse
   * completed rows so a grid of 4 stays readable.
   */
  compact?: boolean
  grouped?: boolean
}

const SubAgentRow = memo(function SubAgentRow({
  call,
  parentSessionId,
  socket,
  result,
  timestamp,
  compact = false,
  grouped = false,
}: RowProps): JSX.Element {
  const { t } = useTranslation()
  const envelope = result ? parseSubAgentEnvelope(result.content) : null
  const promptInput = readPrompt(call)
  const intentionInput = readIntention(call)
  const agentTypeInput = readAgentType(call)
  const modelInput = readModel(call)
  const roleInput = readRole(call)

  const seededLifecycle: SubAgentLifecycle | undefined = envelope
    ? envelope.status === 'completed'
      ? {
          status: 'completed',
          childSessionId: envelope.sessionId,
          turns: envelope.turns,
          durationMs: envelope.durationMs,
          finishedAt: '',
        }
      : {
          status: envelope.status === 'timed_out_with_partial_result' ? 'failed' : envelope.status,
          childSessionId: envelope.sessionId,
          error: envelope.status === 'timed_out_with_partial_result'
            ? t('chat.subAgent.timedOutPartial')
            : envelope.body || 'sub-agent failed',
          turns: envelope.turns,
          durationMs: envelope.durationMs,
          finishedAt: '',
        }
    : undefined

  // A running child can project hundreds of kilobytes on every state change.
  // Keep the summary live from the parent room and join the child room only
  // after the user asks to inspect its transcript.
  const [open, setOpen] = useState(
    seededLifecycle?.status === 'failed' || seededLifecycle?.status === 'cancelled',
  )
  const view = useSubAgentSession({
    socket,
    parentSessionId,
    parentCallId: call.callId,
    mirrorMessages: open,
    ...(envelope ? { initialChildSessionId: envelope.sessionId } : {}),
    ...(seededLifecycle ? { initialLifecycle: seededLifecycle } : {}),
    ...(envelope?.agentType ? { initialAgentType: envelope.agentType } : {}),
    ...(envelope?.intention ? { initialIntention: envelope.intention } : {}),
  })

  const policy = useSubAgentPolicy({
    parentSessionId,
    parentCallId: call.callId,
    enabled: roleInput !== undefined,
  })

  const status = view.lifecycle.status
  const runningChildSessionId = view.lifecycle.status === 'running' ? view.lifecycle.childSessionId : null
  const agentType = view.agentType ?? agentTypeInput
  const prompt = view.prompt ?? promptInput
  const model = view.model ?? modelInput
  const intention = readableIntention(view.intention)
    ?? readableIntention(policy?.intention)
    ?? readableIntention(policy?.objective)
    ?? readableIntention(envelope?.intention)
    ?? intentionInput
    ?? readableHistoricalPrompt(prompt)
    ?? t('chat.subAgent.fallbackIntention', { type: agentType ?? roleInput ?? t('chat.subAgent.label').toLowerCase() })

  const startedAtMs = startedAtOf(view.lifecycle)
  const settledDurationMs =
    status === 'completed' || status === 'failed' || status === 'cancelled'
      ? view.lifecycle.durationMs
      : 0
  const turns =
    status === 'completed' || status === 'failed' || status === 'cancelled'
      ? view.lifecycle.turns
      : view.messages.length

  const failureText =
    status === 'failed' || status === 'cancelled'
      ? view.lifecycle.error
      : envelope?.status === 'failed' || envelope?.status === 'cancelled'
        ? envelope.body
        : null
  const displayedMessages: readonly Message[] = view.messages.length > 0
    ? view.messages
    : envelope?.body && (envelope.status === 'completed' || envelope.status === 'timed_out_with_partial_result')
      ? [{ role: 'assistant', content: [{ type: 'text', text: envelope.body }] }]
      : []
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  const renderedRows = nestedTranscriptRowCount(displayedMessages)
  const virtualizeTranscript = renderedRows > VIRTUALIZED_TRANSCRIPT_THRESHOLD
  const transcriptViewportHeight = virtualizeTranscript
    ? Math.min(
        VIRTUALIZED_TRANSCRIPT_MAX_HEIGHT_PX,
        Math.max(
          VIRTUALIZED_TRANSCRIPT_MIN_HEIGHT_PX,
          renderedRows * VIRTUALIZED_ROW_HEIGHT_PX,
        ),
      )
    : undefined

  const intentionRef = useRef<HTMLSpanElement>(null)
  const [intentionTruncated, setIntentionTruncated] = useState(false)
  useLayoutEffect(() => {
    const element = intentionRef.current
    if (!element) return
    const measure = (): void => setIntentionTruncated(element.scrollWidth > element.clientWidth + 1)
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [intention])
  useEffect(() => {
    if (!grouped && (status === 'failed' || status === 'cancelled')) setOpen(true)
    if (compact && terminal) setOpen(false)
  }, [status, compact, grouped])

  const childSessionId = view.lifecycle.status === 'idle'
    ? envelope?.sessionId
    : view.lifecycle.childSessionId

  return (
    <div
      className={cn(
        'ak-sub-agent-card relative min-w-0 max-w-full overflow-hidden transition-colors',
        grouped ? 'w-full' : 'rounded-xl border border-border/70 bg-card/55',
        open && !grouped && 'border-border bg-card/80',
      )}
      data-testid={`sub-agent-row-${call.callId}`}
      data-sub-agent-status={status}
    >
      <div className={cn(
        'group/subagent flex min-w-0 items-center text-sm text-foreground transition-colors hover:bg-muted/45',
        open && 'bg-muted/30',
      )}>
        <button
          type="button"
          onClick={() => withViewTransition(() => setOpen((v) => !v))}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            compact ? 'px-3 py-2' : 'px-3 py-2.5',
          )}
          data-testid={`sub-agent-toggle-${call.callId}`}
        >
          {status === 'running' || status === 'idle' ? null : (
            <span className="flex h-5 w-5 flex-none items-center justify-center">
              <StatusIcon status={status} />
            </span>
          )}
          <span className={cn(
            'flex-none font-semibold',
            compact ? 'text-meta' : 'text-sm',
            status === 'running' ? 'ak-thinking-text' : 'text-foreground',
            status === 'idle' && 'text-muted-foreground',
          )} data-testid={`sub-agent-role-${call.callId}`}>
            {agentType ?? t('chat.subAgent.label')}
          </span>
          <span ref={intentionRef} className="min-w-0 flex-1 truncate text-meta text-muted-foreground" title={intention} data-testid={`sub-agent-header-intention-${call.callId}`}>
            {intention}
          </span>
          <SubAgentDuration
            callId={call.callId}
            durationMs={settledDurationMs}
            startedAtMs={status === 'running' ? startedAtMs : null}
            title={t('chat.subAgent.duration')}
          />
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          )}
        </button>
        <div className="hidden flex-none sm:block">
          <StatusBadge status={status} turns={turns} />
        </div>
        <SubAgentDetails
          callId={call.callId}
          agentType={agentType}
          model={model}
          role={roleInput}
          status={status}
          turns={turns}
          durationMs={settledDurationMs}
          startedAtMs={status === 'running' ? startedAtMs : null}
          childSessionId={childSessionId}
          policy={policy}
        />
        {runningChildSessionId && socket ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              socket.emit('client:interrupt_sub_agent', {
                parentSessionId,
                parentCallId: call.callId,
                childSessionId: runningChildSessionId,
              })
            }}
            className="mr-2 inline-flex h-7 w-7 flex-none items-center justify-center rounded-md text-muted-foreground opacity-65 transition hover:bg-rose-500/10 hover:text-rose-700 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:text-rose-300"
            title={t('chat.subAgent.interrupt')}
            aria-label={t('chat.subAgent.interrupt')}
            data-testid={`sub-agent-interrupt-${call.callId}`}
          >
            <Square className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-border/50 bg-background/45 px-2 pb-2 pt-1.5">
          {timestamp && Number.isFinite(Date.parse(timestamp)) ? (
            <div className="mb-1 flex justify-end px-1 text-caption tabular-nums text-muted-foreground">
              <time dateTime={timestamp} data-testid={`sub-agent-timestamp-${call.callId}`}>
                {new Date(timestamp).toLocaleString()}
              </time>
            </div>
          ) : null}
          {intentionTruncated ? <div
            className="mb-1.5 min-w-0 rounded-lg border border-border/45 bg-muted/25 px-3 py-2"
            data-testid={`sub-agent-task-${call.callId}`}
          >
            <div className="text-caption font-medium uppercase tracking-wider text-muted-foreground">{t('chat.subAgent.task')}</div>
            <p className="mt-1 whitespace-pre-wrap break-words text-meta leading-5 text-foreground [overflow-wrap:anywhere]">
              {intention}
            </p>
          </div> : null}
          {failureText ? (
            <div className="my-1 rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground">
              <strong className="font-semibold">{status === 'cancelled' ? t('chat.subAgent.cancelled') : t('chat.subAgent.failed')}</strong> {failureText}
            </div>
          ) : null}
          {displayedMessages.length > 0 ? (
            <div
              className={cn(
                'flex min-h-0 flex-col py-1',
                virtualizeTranscript
                  ? 'max-h-[min(20rem,55dvh)]'
                  : compact ? 'max-h-[22rem] overflow-y-auto' : 'max-h-96 overflow-y-auto',
              )}
              style={transcriptViewportHeight === undefined ? undefined : { height: transcriptViewportHeight }}
              data-testid={`sub-agent-transcript-frame-${call.callId}`}
              data-layout={virtualizeTranscript ? 'viewport' : 'content'}
            >
              <NestedTranscript
                messages={displayedMessages}
                compact={false}
                virtualized={virtualizeTranscript}
              />
            </div>
          ) : (
            <EmptyChild status={status} />
          )}
        </div>
      ) : null}
    </div>
  )
})

function EmptyChild({ status }: { status: SubAgentLifecycle['status'] }): JSX.Element | null {
  const { t } = useTranslation()
  if (status === 'running') return null
  const label =
    status === 'idle'
      ? t('chat.subAgent.waiting')
      : t('chat.subAgent.noMessages')
  return (
    <div className="px-3 py-4 text-center text-sm italic text-muted-foreground">
      {label}
    </div>
  )
}

function StatusIcon({ status }: { status: SubAgentLifecycle['status'] }): JSX.Element {
  if (status === 'completed')
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 flex-none text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    )
  return (
    <AlertCircle
      className="h-3.5 w-3.5 flex-none text-rose-600 dark:text-rose-400"
      aria-hidden="true"
    />
  )
}

function StatusBadge({
  status,
  turns,
}: {
  status: SubAgentLifecycle['status']
  turns: number
}): JSX.Element {
  const { t } = useTranslation()
  const label = statusLabel(status, t)
  const suffix = suffixFor(status, turns, t)
  return (
    <span
      className={cn(
        'flex-none whitespace-nowrap px-1.5 py-0.5 text-caption font-medium',
        badgeClassFor(status),
      )}
      data-testid="sub-agent-status-badge"
    >
      {label}
      {suffix ? <span className="ml-1 opacity-80">{suffix}</span> : null}
    </span>
  )
}

function badgeClassFor(status: SubAgentLifecycle['status']): string {
  switch (status) {
    case 'completed':
      return 'text-emerald-700 dark:text-emerald-300'
    case 'failed':
      return 'text-rose-700 dark:text-rose-300'
    case 'cancelled':
      return 'text-amber-700 dark:text-amber-300'
    case 'running':
      return 'text-sky-700 dark:text-sky-300'
    default:
      return 'text-muted-foreground'
  }
}

function statusLabel(status: SubAgentLifecycle['status'], t: ReturnType<typeof useTranslation>['t']): string {
  switch (status) {
    case 'completed':
      return t('chat.subAgent.completed')
    case 'failed':
      return t('chat.subAgent.failed').replace(/:$/, '')
    case 'cancelled':
      return t('chat.subAgent.cancelled').replace(/:$/, '')
    case 'running':
      return t('chat.subAgent.running')
    default:
      return t('chat.subAgent.pending')
  }
}

function suffixFor(
  status: SubAgentLifecycle['status'],
  turns: number,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (status === 'idle') return null
  const parts: string[] = []
  if (turns > 0) parts.push(t('chat.subAgent.turn', { count: turns }))
  return parts.length > 0 ? `· ${parts.join(' · ')}` : null
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}

function startedAtOf(lifecycle: SubAgentLifecycle): number | null {
  if (lifecycle.status !== 'running') return null
  const t = Date.parse(lifecycle.startedAt)
  return Number.isFinite(t) ? t : null
}

function useElapsedMs(startedAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAtMs === null) return
    let handle: number | undefined
    const tick = (): void => {
      setNow(Date.now())
      handle = window.setTimeout(tick, 1_000)
    }
    handle = window.setTimeout(tick, 1_000)
    return () => { if (handle !== undefined) window.clearTimeout(handle) }
  }, [startedAtMs])
  return startedAtMs === null ? 0 : Math.max(0, Math.max(now, Date.now()) - startedAtMs)
}

function SubAgentDuration({
  callId,
  durationMs,
  startedAtMs,
  title,
}: {
  callId: string
  durationMs: number
  startedAtMs: number | null
  title: string
}): JSX.Element | null {
  const elapsedMs = useElapsedMs(startedAtMs)
  const displayedDurationMs = startedAtMs === null ? durationMs : elapsedMs
  if (displayedDurationMs <= 0) return null
  return (
    <span className="ak-sub-agent-duration hidden flex-none items-center gap-1 text-caption tabular-nums text-muted-foreground" data-testid={`sub-agent-duration-${callId}`} title={title}>
      <Clock3 className="h-3.5 w-3.5" data-testid="sub-agent-duration-icon" aria-hidden="true" />
      {formatDuration(displayedDurationMs)}
    </span>
  )
}

function readPrompt(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['prompt']
  return typeof raw === 'string' ? raw : undefined
}

function readIntention(call: ToolCallContent): string | undefined {
  const input = call.input as Record<string, unknown>
  for (const key of ['intention', 'objective', '_intent'] as const) {
    const raw = input[key]
    const intention = readableIntention(raw)
    if (intention) return intention
  }
  return undefined
}

function readableIntention(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 240 && !/[\r\n]/.test(trimmed) ? trimmed : undefined
}

function readableHistoricalPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined
  const trimmed = prompt.trim()
  if (trimmed.length === 0 || trimmed.length > 160 || /[\r\n]/.test(trimmed)) return undefined
  if (/^(?:[a-z]:[\\/]|[\\/]|file:|\.\.?[\\/])/i.test(trimmed)) return undefined
  return trimmed
}

function readAgentType(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['agent_type']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function readModel(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['model']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function readRole(call: ToolCallContent): string | undefined {
  const raw = (call.input as Record<string, unknown>)['role']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function SubAgentDetails({
  agentType,
  model,
  role,
  status,
  turns,
  durationMs,
  startedAtMs,
  childSessionId,
  policy,
  callId,
}: {
  agentType?: string
  model?: string
  role?: string
  status: SubAgentLifecycle['status']
  turns: number
  durationMs: number
  startedAtMs: number | null
  childSessionId?: string
  policy: SubAgentPolicyView | null
  callId: string
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const elapsedMs = useElapsedMs(open ? startedAtMs : null)
  const displayedDurationMs = startedAtMs === null ? durationMs : elapsedMs
  return (
    <details
      className="relative flex-none"
      data-testid={`sub-agent-details-${callId}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground opacity-55 transition hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        title={t('chat.subAgent.executionDetails')}
        aria-label={t('chat.subAgent.executionDetails')}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </summary>
      <div
        className="absolute right-0 top-full z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border/70 bg-popover p-3 text-popover-foreground shadow-xl"
        data-sub-agent-details-popover
      >
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          {t('chat.subAgent.executionDetails')}
        </div>
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <DetailRow label={t('chat.subAgent.agentType')} value={agentType ?? t('chat.subAgent.label')} />
          {model ? <DetailRow label={t('chat.subAgent.model')} value={model} mono /> : null}
          {role || policy?.role ? <DetailRow label={t('chat.subAgent.role')} value={policy?.role ?? role!} /> : null}
          <DetailRow label={t('chat.subAgent.status')} value={statusLabel(status, t)} />
          <DetailRow label={t('chat.subAgent.context')} value={t('chat.subAgent.freshContext')} />
          {turns > 0 ? <DetailRow label={t('chat.subAgent.turns')} value={String(turns)} /> : null}
          {displayedDurationMs > 0 ? <DetailRow label={t('chat.subAgent.duration')} value={formatDuration(displayedDurationMs)} /> : null}
          {childSessionId ? <DetailRow label={t('chat.subAgent.childSession')} value={childSessionId} mono /> : null}
          {policy?.maxTurns !== undefined ? <DetailRow label={t('chat.subAgent.maxTurns')} value={String(policy.maxTurns)} /> : null}
          {policy?.idleTimeoutMs !== undefined ? <DetailRow label="Idle timeout" value={formatPolicyDuration(policy.idleTimeoutMs)} /> : null}
          {policy?.toolIdleTimeoutMs !== undefined ? <DetailRow label="Tool idle" value={formatPolicyDuration(policy.toolIdleTimeoutMs)} /> : null}
          {policy?.timeoutMs !== undefined ? <DetailRow label={t('chat.subAgent.timeout')} value={formatPolicyDuration(policy.timeoutMs)} /> : null}
          {policy?.gracePeriodMs !== undefined ? <DetailRow label="Grace" value={formatPolicyDuration(policy.gracePeriodMs)} /> : null}
          {policy?.maxDepth !== undefined ? (
            <DetailRow
              label={t('chat.subAgent.depth')}
              value={policy.resolvedDepth !== undefined ? `${policy.resolvedDepth}/${policy.maxDepth}` : String(policy.maxDepth)}
            />
          ) : null}
          {policy?.maxFanOut !== undefined ? (
            <DetailRow
              label={t('chat.subAgent.fanOut')}
              value={policy.concurrentSiblingCount !== undefined ? `${policy.concurrentSiblingCount}/${policy.maxFanOut}` : String(policy.maxFanOut)}
            />
          ) : null}
          {policy?.allowedTools && policy.allowedTools.length > 0 ? (
            <DetailRow label={t('chat.subAgent.tools')} value={policy.allowedTools.join(', ')} mono />
          ) : null}
        </dl>
        {policy ? <div data-testid={`sub-agent-policy-${callId}`}>
        {policy.intention ?? policy.objective ? (
        <div className="mt-3 border-t border-border/50 pt-2 text-xs leading-5">
          <span className="font-medium text-foreground/80">{t('chat.subAgent.intention')}</span>{' '}
          <span className="text-muted-foreground">{policy.intention ?? policy.objective}</span>
        </div>
        ) : null}
        {policy.expectedOutput ? (
        <div className="mt-2 text-xs leading-5">
          <span className="font-medium text-foreground/80">{t('chat.subAgent.expectedOutput')}</span>{' '}
          <span className="text-muted-foreground">{policy.expectedOutput}</span>
        </div>
        ) : null}
        {policy.reasons.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 border-t border-border/50 pt-2">
          {policy.reasons.map((reason) => (
            <span
              key={reason}
              className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-caption text-muted-foreground"
            >
              {reason}
            </span>
          ))}
        </div>
        ) : null}
        </div> : null}
      </div>
    </details>
  )
}

function formatPolicyDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-all text-foreground', mono && 'font-mono text-caption')}>{value}</dd>
    </>
  )
}
