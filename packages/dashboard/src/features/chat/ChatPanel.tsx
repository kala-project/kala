import {
  Children,
  createContext,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArrowRight,
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  Code2,
  Copy,
  FileText,
  FileSearch,
  Globe,
  GripVertical,
  Image,
  Lightbulb,
  ListChecks,
  Loader2,
  Maximize2,
  Pencil,
  PenLine,
  RotateCcw,
  Search,
  Sparkles,
  Terminal,
  Eye,
  Brain,
  Bot,
  CalendarClock,
  Wrench,
  X,
  XCircle,
  UserRound,
} from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import type {
  Message,
  MessageContent,
  ReasoningContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'
import type { ApprovalRequiredEvent, ChapterReadingMode, ToolCardMode } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { ReadonlyImagePreviewDialog } from '../../components/ReadonlyImagePreview.js'
import { Textarea } from '../../components/ui/textarea.js'
import { Typewriter } from '../../components/Typewriter.js'
import { MarkdownTable } from '../../components/MarkdownTable.js'
import { formatTokens } from '../../lib/format.js'
import { DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT, DEFAULT_TOOL_ACTIVITY_ICON_SCALE, PREF_CHAPTER_READING_MODE, PREF_EXPAND_THINKING_BY_DEFAULT, PREF_MESSAGE_TIMESTAMPS, PREF_SMOOTH_STREAMING_TEXT, PREF_TOOL_ACTIVITY_ICON_SCALE, useBooleanPref, useNumberPref, useStringPref } from '../../lib/prefs.js'
import { useInterfaceScale } from '../../lib/interface-scale.js'
import { cn } from '../../lib/utils.js'
import { writeTextToClipboard } from '../../lib/clipboard.js'
import type { TranscriptItem } from '../../transcript.js'
import { DiffPreview, hasDiffPreviewForTool } from './DiffPreview.js'
import { CodeBlock } from './CodeBlock.js'
import { MermaidBlock } from './MermaidBlock.js'
import { CompactFeedbackRow, formatElapsedDuration, useElapsedSeconds, type CompactStatus } from './InlineStatusRow.js'
import {
  type GroupedContentItem,
  type ToolCallGroup,
  collectAllToolResults,
  groupConsecutiveToolCalls,
  makeToolCallGroup,
} from './grouping.js'
import { SubAgentCard } from './SubAgentCard.js'
import { GroupSummaryPreview, GroupSummaryRow, firstLine, pickRenderer, truncate, type SummaryDelta, type SummaryRow } from './toolSummaries/index.js'
import type { DashboardSocket } from '../../session.js'
import { messageAttachmentUrl } from '../../admission-client.js'
import { RevealCursor, RevealTail, canFadeRevealTail } from './text-reveal/index.js'
import { VirtualTranscript, type TranscriptViewportAnchor, type VirtualTranscriptHandle } from './VirtualTranscript.js'
import { chatDisplayStyle, type ChatDisplayPrefs } from './chatDisplayPrefs.js'
import { transcriptItemKey } from './transcript-key.js'
import { groupConsecutiveToolDots, toolDotNodeWidth, toolDotRailBudget, toolPreviewGeometry, visibleToolDots, type ToolPreviewGeometry } from './tool-dot-layout.js'
import { useIsMobile } from '../../app-logic/use-viewport.js'
import { nextSearchMatchIndex, searchMatchSnippet, searchTranscript, type TranscriptSearchCategory, type TranscriptSearchMatch } from './transcript-search.js'
import { normalizeMarkdownEmphasisAdjacency, remarkStripEmphasisAdjacencyMarker } from './normalize-markdown.js'
import { normalizeThinkingDisplayText } from './normalize-thinking-text.js'

// Keep the Markdown parser out of the initial chat bundle.
const ChapterReader = lazy(() => import('./ChapterReader.js'))

type Props = {
  messages?: readonly Message[]
  items?: readonly TranscriptItem[]
  highlightIndex?: number | null
  onEditAndRerun?: (seq: number, text: string) => void
  onSuggest?: (text: string) => void
  pendingApprovals?: readonly ApprovalRequiredEvent[]
  /** Authoritative live calls from AgentState.pendingCalls. */
  activeToolCallIds?: readonly string[]
  /** Tool Intention currently owned by the persistent Agent activity Badge. */
  badgeIntentionCallId?: string
  /** Persisted scheduled-run provenance keyed by user_message operationId. */
  scheduledMessageTasks?: Readonly<Record<string, string>>
  onOpenScheduledTask?: (taskId: string) => void
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  onReadOverflow?: (callId: string) => Promise<{ content?: string; error?: string }>
  footerSlot?: JSX.Element | null
  userMessageNavigationPortalTarget?: Element | null
  topRightAccessory?: JSX.Element | null
  /**
   * Wiring for inline `SubAgentCard`s. When both are present, tool_call
   * groups with `toolName === 'agent'` render as a live nested view (with
   * child transcript mirrored via socket) instead of the generic
   * ToolCallGroupBlock. Optional so nested read-only panels — which pass
   * no socket — degrade to a static replay from the `<sub_agent>` envelope.
   */
  parentSessionId?: string
  sessionId?: string | null
  chapterReadingModeOverride?: ChapterReadingMode
  onChapterReadingModeChange?: (mode: ChapterReadingMode | null) => void
  attachmentHost?: string
  attachmentToken?: string
  socket?: DashboardSocket | null
  /**
   * Two-way pinned-to-bottom binding. `pinned` starts true and flips as the
   * user scrolls away from / back to the bottom. When true, appending items
   * (new messages, streaming) auto-scrolls. Caller resets this when the
   * session changes so a fresh conversation starts pinned.
   */
  pinnedToBottom?: boolean
  onPinnedChange?: (pinned: boolean) => void
  showPinnedMessage?: boolean
  /** Bump this to make ChatPanel scroll to the current bottom. */
  scrollToBottomToken?: number
  /** UI-level compaction operation status rendered inline at transcript tail. */
  compactStatus?: CompactStatus
  liveToolActivityTailCount?: number
  toolExecutionStartedAt?: number | null
  toolCardMode?: ToolCardMode
  displayPrefs?: ChatDisplayPrefs
  onDismissCompactStatus?: () => void
  loading?: boolean
  onOpenWorkspaceFile?: (target: WorkspaceFileTarget) => void
  searchOpen?: boolean
  onSearchOpenChange?: (open: boolean) => void
}

export type WorkspaceFileTarget = {
  path: string
  line?: number
  column?: number
}

const WorkspaceFileLinkContext = createContext<((target: WorkspaceFileTarget) => void) | null>(null)
const ArtifactSessionContext = createContext<string | null>(null)
const AttachmentAccessContext = createContext<{ host?: string; token?: string }>({})
type MessageTimestampVisibility = 'auto' | 'always' | 'hidden'
const MessageTimestampContext = createContext<MessageTimestampVisibility>('auto')
const ThinkingExpandedByDefaultContext = createContext(false)

type RenderTranscriptItem = TranscriptItem | {
  kind: 'compact_feedback'
  status: Exclude<CompactStatus, { kind: 'idle' }>
} | {
  kind: 'tool_activity'
  group: ToolCallGroup
  firstMessageIndex: number
  lastMessageIndex: number
  seq?: number
  ts?: string
} | {
  kind: 'thinking_cluster'
  updates: ReasoningContent[]
  firstMessageIndex: number
  lastMessageIndex: number
  streaming: boolean
  seq?: number
  ts?: string
  turnTiming?: import('@agent-kernel/shared').TurnTimingSummary
}

type MessageRerunTarget = {
  seq: number
  text: string
}

type OverflowReader = (callId: string) => Promise<{ content?: string; error?: string }>
const OverflowReaderContext = createContext<OverflowReader | null>(null)

const EMPTY_SUGGESTIONS: ReadonlyArray<{
  icon: typeof Sparkles
  title: string
  prompt: string
}> = [
  {
    icon: Code2,
    title: 'Explain this repo',
    prompt: 'Give me a quick tour of this repository — what does it do, and where should I start reading?',
  },
  {
    icon: Terminal,
    title: 'Run tests and fix failures',
    prompt: 'Run the tests. If any fail, propose a fix.',
  },
  {
    icon: FileText,
    title: 'Draft a change plan',
    prompt: 'I want to add a new feature. Ask me a few clarifying questions, then draft an implementation plan.',
  },
  {
    icon: Lightbulb,
    title: 'Suggest improvements',
    prompt: 'Read the main source files and suggest three concrete improvements I could make today.',
  },
]

export function ChatPanel({
  messages,
  items,
  highlightIndex,
  onEditAndRerun,
  onSuggest,
  pendingApprovals,
  activeToolCallIds,
  badgeIntentionCallId,
  scheduledMessageTasks,
  onOpenScheduledTask,
  onApprovalDecision,
  onReadOverflow,
  footerSlot,
  userMessageNavigationPortalTarget,
  topRightAccessory,
  parentSessionId,
  sessionId,
  chapterReadingModeOverride,
  onChapterReadingModeChange,
  attachmentHost,
  attachmentToken,
  socket,
  pinnedToBottom,
  onPinnedChange,
  showPinnedMessage = true,
  scrollToBottomToken,
  compactStatus,
  liveToolActivityTailCount = DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  toolExecutionStartedAt,
  toolCardMode = 'dots',
  displayPrefs,
  onDismissCompactStatus,
  loading = false,
  onOpenWorkspaceFile,
  searchOpen = false,
  onSearchOpenChange,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [storedTimestampVisibility] = useStringPref(PREF_MESSAGE_TIMESTAMPS, 'auto')
  const [expandThinkingByDefault] = useBooleanPref(PREF_EXPAND_THINKING_BY_DEFAULT, false)
  const [storedChapterMode] = useStringPref(PREF_CHAPTER_READING_MODE, 'chapters')
  const globalChapterMode: ChapterReadingMode = storedChapterMode === 'continuous' ? 'continuous' : 'chapters'
  const timestampVisibility: MessageTimestampVisibility =
    storedTimestampVisibility === 'always' || storedTimestampVisibility === 'hidden'
      ? storedTimestampVisibility
      : 'auto'
  const fallbackItems = useMemo<TranscriptItem[]>(() => (messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => ({ kind: 'message', message })), [messages])
  const rawItems = items ?? fallbackItems
  const displayItems = rawItems
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCategory, setSearchCategory] = useState<TranscriptSearchCategory>('all')
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1)
  const [searchNavigationToken, setSearchNavigationToken] = useState(0)
  const [viewportAnchor, setViewportAnchor] = useState<TranscriptViewportAnchor>({ firstVisibleIndex: null, firstVisibleAligned: false })
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchMatches = useMemo(() => searchTranscript(displayItems, searchQuery, searchCategory), [displayItems, searchQuery, searchCategory])
  useEffect(() => {
    if (!searchOpen) return
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [searchOpen])
  useEffect(() => {
    setActiveSearchIndex((current) => searchMatches.length === 0 ? -1 : Math.min(Math.max(current, 0), searchMatches.length - 1))
  }, [searchMatches])
  useEffect(() => {
    setSearchQuery('')
    setActiveSearchIndex(-1)
    setViewportAnchor({ firstVisibleIndex: null, firstVisibleAligned: false })
  }, [sessionId])
  const { toolNameByCallId, allMessages, resultsByCallId, intraMessageGroupedCallIds } = useMemo(() => {
    const names = new Map<string, string>()
    const messageItems = displayItems
      .filter((item): item is Extract<TranscriptItem, { kind: 'message' }> => item.kind === 'message')
      .map((item) => item.message)
    for (const message of messageItems) {
      for (const content of message.content) {
        if (content.type === 'tool_call') names.set(content.callId, content.name)
      }
    }
    const results = collectAllToolResults(messageItems)
    const groupedIds = new Set<string>()
    for (const message of messageItems) {
      if (message.role !== 'assistant') continue
      for (const group of groupConsecutiveToolCalls(message.content, results)) {
        if (group.kind === 'tool_call_group') for (const call of group.calls) groupedIds.add(call.callId)
      }
    }
    return { toolNameByCallId: names, allMessages: messageItems, resultsByCallId: results, intraMessageGroupedCallIds: groupedIds }
  }, [displayItems])
  const approvalByCallId = useMemo(() => new Map((pendingApprovals ?? []).map((approval) => [approval.callId, approval])), [pendingApprovals])
  const effectiveParentSessionId = parentSessionId ?? sessionId ?? undefined
  // Null preserves the isolated/demo fallback. The product App always
  // supplies the authoritative set so an unpaired historical call cannot be
  // mistaken for live work after compaction, interruption, or recovery.
  const activeToolCallIdSet = useMemo(() => activeToolCallIds === undefined ? null : new Set(activeToolCallIds), [activeToolCallIds])

  // Drop tool messages whose every tool_result is already rendered inline in a
  // grouped assistant tool-call card. Otherwise MessageRow returns null but
  // Virtuoso's per-item wrapper still occupies `py-2 sm:py-3` — with 5+ tool
  // calls per group that stacks up to a screen of blank space between groups.
  //
  // messageIndex (used for msg-* anchors + highlight) must still count against
  // the ORIGINAL sequence so callers that pass a highlight seq still land on
  // the right row.
  const { transcriptItems, messageIndexByItem, hideHeaderByItem, groupedCallIds } = useMemo(() => {
    const kept: RenderTranscriptItem[] = []
    const mapping: number[] = []
    const hideHeader: boolean[] = []
    const groupedIds = new Set(intraMessageGroupedCallIds)
    let mi = -1
    let prevRole: 'user' | 'assistant' | 'tool' | null = null
    let i = 0
    while (i < displayItems.length) {
      const transcriptGroup = collectTranscriptToolActivity(
        displayItems,
        i,
        mi,
        resultsByCallId,
        {
          absorbReasoning: toolCardMode === 'dots',
          preserveAgentCalls: Boolean(effectiveParentSessionId),
        },
      )
      if (transcriptGroup) {
        for (const entry of transcriptGroup.before) {
          kept.push(entry.item)
          mapping.push(entry.messageIndex)
          hideHeader.push(prevRole === 'assistant')
          prevRole = 'assistant'
        }
        kept.push({
          kind: 'tool_activity',
          group: transcriptGroup.group,
          firstMessageIndex: transcriptGroup.firstMessageIndex,
          lastMessageIndex: transcriptGroup.lastMessageIndex,
          seq: transcriptGroup.seq,
          ts: transcriptGroup.ts,
        })
        mapping.push(transcriptGroup.firstMessageIndex)
        hideHeader.push(prevRole === 'assistant')
        prevRole = 'assistant'
        for (const entry of transcriptGroup.after) {
          kept.push(entry.item)
          mapping.push(entry.messageIndex)
          hideHeader.push(true)
        }
        for (const call of transcriptGroup.group.calls) groupedIds.add(call.callId)
        mi = transcriptGroup.lastMessageIndex
        i = transcriptGroup.nextIndex
        continue
      }

      const it = displayItems[i]!
      if (it.kind === 'message') {
        mi += 1
        const m = it.message
        const visibleMessageContent = messageContentAfterGroupedResults(m, groupedIds)
        if (!visibleMessageContent.some(isRenderableMessageContent)) {
          i += 1
          continue
        }
        kept.push(it)
        mapping.push(mi)
        hideHeader.push(prevRole === m.role)
        prevRole = m.role as 'user' | 'assistant' | 'tool'
      } else if (it.kind === 'pending_user_message') {
        kept.push(it)
        mapping.push(-1)
        hideHeader.push(prevRole === 'user')
        prevRole = 'user'
      } else {
        kept.push(it)
        mapping.push(-1)
        hideHeader.push(false)
        prevRole = null
      }
      i += 1
    }
    if (compactStatus && compactStatus.kind !== 'idle') {
      kept.push({ kind: 'compact_feedback', status: compactStatus })
      mapping.push(-1)
      hideHeader.push(false)
    }
    const clustered = clusterVisibleThinkingItems(kept, mapping, hideHeader, groupedIds)
    return {
      transcriptItems: clustered.items,
      messageIndexByItem: clustered.messageIndexes,
      hideHeaderByItem: clustered.hideHeaders,
      groupedCallIds: groupedIds,
    }
  }, [displayItems, intraMessageGroupedCallIds, resultsByCallId, compactStatus, effectiveParentSessionId, toolCardMode])

  // Translate message-index highlight into item-index so VirtualTranscript
  // can scroll to the right row. -1 means "no highlight" or unresolved.
  const highlightItemIndex = useMemo(() => {
    if (highlightIndex == null || highlightIndex < 0) return null
    for (let i = 0; i < messageIndexByItem.length; i += 1) {
      if (messageIndexByItem[i] === highlightIndex) return i
      const item = transcriptItems[i]
      if (
        (item?.kind === 'tool_activity' || item?.kind === 'thinking_cluster')
        && highlightIndex >= item.firstMessageIndex
        && highlightIndex <= item.lastMessageIndex
      ) {
        return i
      }
    }
    return null
  }, [highlightIndex, messageIndexByItem, transcriptItems])

  const activeSearchMatch = activeSearchIndex >= 0 ? searchMatches[activeSearchIndex] ?? null : null
  const searchItemIndex = useMemo(() => {
    const match = activeSearchMatch
    if (!match) return null
    if (match.messageIndex >= 0) {
      for (let index = 0; index < messageIndexByItem.length; index += 1) {
        if (messageIndexByItem[index] === match.messageIndex) return index
        const item = transcriptItems[index]
        if (
          (item?.kind === 'tool_activity' || item?.kind === 'thinking_cluster')
          && match.messageIndex >= item.firstMessageIndex
          && match.messageIndex <= item.lastMessageIndex
        ) return index
      }
    }
    const raw = displayItems[match.rawItemIndex]
    if (raw?.kind === 'pending_user_message') return transcriptItems.findIndex((item) => item.kind === 'pending_user_message' && item.id === raw.id)
    if (raw?.kind === 'compact_boundary') return transcriptItems.findIndex((item) => item.kind === 'compact_boundary' && item.seq === raw.seq)
    if (raw?.kind === 'compact_progress') return transcriptItems.findIndex((item) => item.kind === 'compact_progress' && item.attemptId === raw.attemptId)
    return null
  }, [activeSearchMatch, messageIndexByItem, displayItems, transcriptItems])

  const isEmpty = transcriptItems.length === 0
  const userMessageAnchors = useMemo(() => transcriptItems.flatMap((item, index) =>
    item.kind === 'message' && item.message.role === 'user' ? [index] : []
  ), [transcriptItems])

  const transcriptRef = useVirtualTranscriptScrollToken(scrollToBottomToken, transcriptItems.length)
  const [localPinned, setLocalPinned] = useState(true)
  const effectivePinned = pinnedToBottom ?? localPinned
  const effectiveOnPinnedChange = onPinnedChange ?? setLocalPinned
  const navigateChapter = useCallback((itemIndex: number) => {
    effectiveOnPinnedChange(false)
    transcriptRef.current?.scrollToIndex(itemIndex, { behavior: 'auto', align: 'start' })
  }, [effectiveOnPinnedChange, transcriptRef])

  const renderItem = useCallback(
    (item: RenderTranscriptItem, itemIndex: number): JSX.Element => {
      if (item.kind === 'compact_progress') {
        return item.phase === 'running'
          ? <CompactProgressRow startedAt={Date.parse(item.startedAt)} tokensBefore={item.tokensBefore} />
          : <CompactFeedbackTranscriptRow status={{ kind: 'error', message: item.error ?? t('chatStatus.compactFailed') }} />
      }
      if (item.kind === 'compact_boundary') {
        return <CompactBoundaryRow boundary={item} />
      }
      if (item.kind === 'compact_feedback') {
        return <CompactFeedbackTranscriptRow status={item.status} onDismiss={onDismissCompactStatus} />
      }
      const hideHeader = hideHeaderByItem[itemIndex] ?? false
      if (item.kind === 'tool_activity') {
        return (
          <ToolActivityTranscriptRow
            item={item}
            highlighted={
              (highlightIndex != null &&
              highlightIndex >= item.firstMessageIndex &&
              highlightIndex <= item.lastMessageIndex) || searchItemIndex === itemIndex
            }
            hideHeader={hideHeader}
            approvalByCallId={approvalByCallId}
            onApprovalDecision={onApprovalDecision}
            liveToolActivityTailCount={liveToolActivityTailCount}
            toolExecutionStartedAt={toolExecutionStartedAt}
            toolCardMode={toolCardMode}
            activeToolCallIds={activeToolCallIdSet}
            badgeIntentionCallId={badgeIntentionCallId}
            parentSessionId={effectiveParentSessionId}
            socket={socket ?? null}
          />
        )
      }
      if (item.kind === 'thinking_cluster') {
        return (
          <MessageRow
            index={item.firstMessageIndex}
            message={{ role: 'assistant', content: item.updates }}
            streaming={item.streaming}
            highlighted={
              (highlightIndex != null
                && highlightIndex >= item.firstMessageIndex
                && highlightIndex <= item.lastMessageIndex)
              || searchItemIndex === itemIndex
            }
            toolNameByCallId={toolNameByCallId}
            approvalByCallId={approvalByCallId}
            onApprovalDecision={onApprovalDecision}
            resultsByCallId={resultsByCallId}
            groupedCallIds={groupedCallIds}
            seq={item.seq}
            ts={item.ts}
            hideHeader={hideHeader}
            parentSessionId={effectiveParentSessionId}
            socket={socket ?? null}
            liveToolActivityTailCount={liveToolActivityTailCount}
            toolExecutionStartedAt={toolExecutionStartedAt}
            toolCardMode={toolCardMode}
            activeToolCallIds={activeToolCallIdSet}
            badgeIntentionCallId={badgeIntentionCallId}
            turnTiming={item.turnTiming}
          />
        )
      }
      if (item.kind === 'model_changed') {
        return (
          <div
            className="flex justify-center py-2 text-xs text-muted-foreground"
            data-testid="model-changed-notice"
          >
            Model changed{item.from ? `: ${item.from} → ${item.to}` : ` to ${item.to}`}
          </div>
        )
      }
      if (item.kind === 'pending_user_message') {
        return <PendingUserMessageRow item={item} />
      }
      const currentMessageIndex = messageIndexByItem[itemIndex] ?? 0
      const assistantRerunTarget =
        item.message.role === 'assistant'
          ? previousUserRerunTarget(transcriptItems, itemIndex)
          : null
      return (
        <MessageRow
          index={currentMessageIndex}
          message={item.message}
          streaming={item.streaming === true}
          highlighted={highlightIndex === currentMessageIndex || searchItemIndex === itemIndex}
          toolNameByCallId={toolNameByCallId}
          approvalByCallId={approvalByCallId}
          onApprovalDecision={onApprovalDecision}
          resultsByCallId={resultsByCallId}
          groupedCallIds={groupedCallIds}
          seq={item.seq}
          ts={item.ts}
          hideHeader={hideHeader}
          onEditAndRerun={onEditAndRerun}
          parentSessionId={effectiveParentSessionId}
          socket={socket ?? null}
          liveToolActivityTailCount={liveToolActivityTailCount}
          toolExecutionStartedAt={toolExecutionStartedAt}
          toolCardMode={toolCardMode}
          activeToolCallIds={activeToolCallIdSet}
          badgeIntentionCallId={badgeIntentionCallId}
          assistantRerunTarget={assistantRerunTarget}
          turnTiming={item.turnTiming}
          scheduledTaskId={item.operationId ? scheduledMessageTasks?.[item.operationId] : undefined}
          onOpenScheduledTask={onOpenScheduledTask}
          chapterSessionId={sessionId}
          globalChapterMode={globalChapterMode}
          chapterModeOverride={chapterReadingModeOverride}
          onChapterModeChange={onChapterReadingModeChange}
          onChapterNavigate={() => navigateChapter(itemIndex)}
        />
      )
    },
    [
      messageIndexByItem,
      hideHeaderByItem,
      highlightIndex,
      toolNameByCallId,
      approvalByCallId,
      onApprovalDecision,
      resultsByCallId,
      groupedCallIds,
      onEditAndRerun,
      effectiveParentSessionId,
      socket,
      onDismissCompactStatus,
      liveToolActivityTailCount,
      toolExecutionStartedAt,
      toolCardMode,
      activeToolCallIdSet,
      badgeIntentionCallId,
      scheduledMessageTasks,
      onOpenScheduledTask,
      searchItemIndex,
      sessionId,
      globalChapterMode,
      chapterReadingModeOverride,
      onChapterReadingModeChange,
      navigateChapter,
    ],
  )

  const keyFor = useCallback(
    (item: RenderTranscriptItem, itemIndex: number): string =>
      item.kind === 'compact_boundary'
        ? `compact-${item.seq ?? item.attemptId ?? itemIndex}`
        : item.kind === 'compact_progress'
          ? `compact-progress-${item.attemptId}`
        : item.kind === 'compact_feedback'
          ? `compact-feedback-${item.status.kind}`
        : item.kind === 'tool_activity'
          ? `tool-activity-${item.group.firstCallId}`
        : item.kind === 'thinking_cluster'
          ? `thinking-cluster-${item.firstMessageIndex}`
        : transcriptItemKey(item, itemIndex),
    [],
  )

  useEffect(() => {
    if (!searchOpen || searchItemIndex == null || searchItemIndex < 0) return
    effectiveOnPinnedChange(false)
    transcriptRef.current?.scrollToIndex(searchItemIndex, { behavior: 'auto' })
  }, [effectiveOnPinnedChange, searchItemIndex, searchNavigationToken, searchOpen, transcriptRef])
  const navigateSearch = useCallback((direction: 1 | -1) => {
    setActiveSearchIndex((current) => nextSearchMatchIndex(current, searchMatches.length, direction))
    setSearchNavigationToken((token) => token + 1)
  }, [searchMatches.length])
  const scrollToBottom = useCallback(() => {
    transcriptRef.current?.scrollToBottom()
    effectiveOnPinnedChange(true)
  }, [effectiveOnPinnedChange, transcriptRef])
  const viewportIndex = viewportAnchor.firstVisibleIndex
  const previousUserAnchor = viewportIndex === null ? undefined : [...userMessageAnchors].reverse().find((index) =>
    index < viewportIndex || (index === viewportIndex && !viewportAnchor.firstVisibleAligned)
  )
  const nextUserAnchor = viewportIndex === null ? undefined : userMessageAnchors.find((index) => index > viewportIndex)
  const stickyPrompt = useMemo(
    () => showPinnedMessage ? currentStickyUserPrompt(transcriptItems, viewportAnchor) : undefined,
    [showPinnedMessage, transcriptItems, viewportAnchor],
  )
  const navigateUserMessage = useCallback((target: number | undefined) => {
    if (target === undefined) return
    effectiveOnPinnedChange(false)
    // An immediate aligned jump makes repeated clicks deterministic. Smooth
    // scrolling leaves the viewport callback behind the animation and can
    // make a fast second click repeat or reverse the first target.
    setViewportAnchor({ firstVisibleIndex: target, firstVisibleAligned: true })
    transcriptRef.current?.scrollToIndex(target, { behavior: 'auto', align: 'start' })
  }, [effectiveOnPinnedChange, transcriptRef])
  const userMessageNavigation = !isEmpty && userMessageAnchors.length > 1 ? (
    <div className="flex flex-col gap-1.5" data-testid="user-message-navigation">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={previousUserAnchor === undefined}
        onClick={() => navigateUserMessage(previousUserAnchor)}
        className="h-9 w-9 rounded-full border border-border/70 bg-background/92 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-foreground disabled:opacity-30"
        aria-label={t('chat.transcript.previousUserMessage')}
        title={t('chat.transcript.previousUserMessage')}
        data-testid="previous-user-message"
      >
        <ChevronUp className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={nextUserAnchor === undefined}
        onClick={() => navigateUserMessage(nextUserAnchor)}
        className="h-9 w-9 rounded-full border border-border/70 bg-background/92 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-foreground disabled:opacity-30"
        aria-label={t('chat.transcript.nextUserMessage')}
        title={t('chat.transcript.nextUserMessage')}
        data-testid="next-user-message"
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  ) : null
  const renderedUserMessageNavigation = userMessageNavigationPortalTarget && userMessageNavigation
    ? createPortal(userMessageNavigation, userMessageNavigationPortalTarget)
    : userMessageNavigation
  const renderedFooterSlot = footerSlot
  const displayStyle = chatDisplayStyle(displayPrefs)

  return (
    <ThinkingExpandedByDefaultContext.Provider value={expandThinkingByDefault}>
    <MessageTimestampContext.Provider value={timestampVisibility}>
    <ArtifactSessionContext.Provider value={sessionId ?? parentSessionId ?? null}>
    <AttachmentAccessContext.Provider value={{ ...(attachmentHost ? { host: attachmentHost } : {}), ...(attachmentToken ? { token: attachmentToken } : {}) }}>
    <WorkspaceFileLinkContext.Provider value={onOpenWorkspaceFile ?? null}>
      <OverflowReaderContext.Provider value={onReadOverflow ?? null}>
      <div className="relative flex h-full w-full min-w-0 max-w-full flex-1 flex-col overflow-x-hidden" style={displayStyle}>
        {searchOpen ? (
          <TranscriptSearchBar
            inputRef={searchInputRef}
            query={searchQuery}
            category={searchCategory}
            current={activeSearchIndex}
            matches={searchMatches}
            onQueryChange={setSearchQuery}
            onCategoryChange={setSearchCategory}
            onNavigate={navigateSearch}
            onClose={() => onSearchOpenChange?.(false)}
          />
        ) : null}
        {(!searchOpen && stickyPrompt) || topRightAccessory ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 px-2 pt-2 sm:px-4 sm:pt-3" data-testid="chat-top-overlay-row">
            {!searchOpen && stickyPrompt ? (
              <StickyUserPrompt
                prompt={stickyPrompt}
                onClick={() => navigateUserMessage(stickyPrompt.itemIndex)}
              />
            ) : <span className="min-w-0 flex-1" />}
            {topRightAccessory ? <div className="pointer-events-auto flex-none" data-testid="chat-top-right-accessory">{topRightAccessory}</div> : null}
          </div>
        ) : null}
        {loading ? (
          <div className="ak-chat-container mx-auto w-full py-4 sm:py-6">
            <TranscriptLoadingState />
            {renderedFooterSlot ? <div className="pl-0 pt-2 sm:pl-10">{renderedFooterSlot}</div> : null}
          </div>
        ) : isEmpty ? (
          <div className="ak-chat-container mx-auto w-full py-4 sm:py-6">
            <EmptyState onSuggest={onSuggest} />
            {renderedFooterSlot ? <div className="pl-0 pt-6 sm:pl-10">{renderedFooterSlot}</div> : null}
          </div>
        ) : (
          <VirtualTranscript<RenderTranscriptItem>
            ref={transcriptRef}
            items={transcriptItems}
            renderItem={renderItem}
            keyFor={keyFor}
            pinnedToBottom={effectivePinned}
            onPinnedChange={effectiveOnPinnedChange}
            highlightIndex={highlightItemIndex}
            footerSlot={
              renderedFooterSlot ? (
                // Status rows share the content edge used by headerless live
                // replies and the Composer. Labelled rows add their own avatar rail.
                <div className="w-full pt-1" data-testid="transcript-footer-content">{renderedFooterSlot}</div>
              ) : null
            }
            itemClassName="ak-chat-container ak-chat-item mx-auto w-full min-w-0 overflow-x-hidden py-2 sm:py-3"
            defaultItemHeight={80}
            dataTestId="virtual-transcript"
            onViewportAnchorChange={setViewportAnchor}
          />
        )}
        {renderedUserMessageNavigation ? (
          userMessageNavigationPortalTarget ? renderedUserMessageNavigation : (
            <div className="absolute bottom-4 left-2 z-20 sm:left-3">
              {renderedUserMessageNavigation}
            </div>
          )
        ) : null}
        {!isEmpty && !effectivePinned ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-20 h-9 w-9 rounded-full bg-background/95 text-muted-foreground shadow-lg ring-1 ring-border/70 backdrop-blur hover:text-foreground sm:bottom-5 sm:right-6"
            aria-label={t('chat.transcript.scrollToBottom')}
            title={t('chat.transcript.scrollToBottom')}
            data-testid="scroll-to-bottom"
          >
            <ChevronsDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      </OverflowReaderContext.Provider>
    </WorkspaceFileLinkContext.Provider>
    </AttachmentAccessContext.Provider>
    </ArtifactSessionContext.Provider>
    </MessageTimestampContext.Provider>
    </ThinkingExpandedByDefaultContext.Provider>
  )
}

function TranscriptSearchBar({
  inputRef,
  query,
  category,
  current,
  matches,
  onQueryChange,
  onCategoryChange,
  onNavigate,
  onClose,
}: {
  inputRef: { current: HTMLInputElement | null }
  query: string
  category: TranscriptSearchCategory
  current: number
  matches: readonly TranscriptSearchMatch[]
  onQueryChange(value: string): void
  onCategoryChange(value: TranscriptSearchCategory): void
  onNavigate(direction: 1 | -1): void
  onClose(): void
}): JSX.Element {
  const { t } = useTranslation()
  const active = current >= 0 ? matches[current] : undefined
  const categories: readonly TranscriptSearchCategory[] = ['all', 'user', 'assistant', 'thinking', 'tools']
  return (
    <div className="z-20 flex flex-none flex-col gap-2 border-b bg-background/95 px-3 py-2 shadow-sm backdrop-blur" data-testid="transcript-search" role="search">
      <div className="flex min-w-0 items-center gap-2">
        <Search className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onNavigate(event.shiftKey ? -1 : 1) }
            if (event.key === 'Escape') { event.preventDefault(); onClose() }
          }}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={t('chat.transcript.searchPlaceholder')}
          aria-label={t('chat.transcript.searchLabel')}
          data-testid="transcript-search-input"
        />
        <span className="min-w-[4.5rem] text-center text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="transcript-search-count">
          {matches.length > 0 ? `${current + 1} / ${matches.length}` : t('chat.transcript.searchNoResults')}
        </span>
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => onNavigate(-1)} disabled={matches.length === 0} aria-label={t('chat.transcript.searchPrevious')}>↑</Button>
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => onNavigate(1)} disabled={matches.length === 0} aria-label={t('chat.transcript.searchNext')}>↓</Button>
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={onClose} aria-label={t('common.close')}><X className="h-4 w-4" /></Button>
      </div>
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {categories.map((value) => (
          <button key={value} type="button" onClick={() => onCategoryChange(value)} aria-pressed={category === value} className={cn('rounded-full border px-2 py-0.5 text-meta', category === value ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
            {t(`chat.transcript.searchCategories.${value}`)}
          </button>
        ))}
        {active ? <span className="ml-2 min-w-0 truncate text-meta text-muted-foreground" title={active.text}>{searchMatchSnippet(active)}</span> : null}
      </div>
    </div>
  )
}

type StickyUserPromptModel = {
  itemIndex: number
  text: string
  imageCount: number
  fileNames: readonly string[]
  extraFileCount: number
}

function currentStickyUserPrompt(
  items: readonly RenderTranscriptItem[],
  viewportAnchor: TranscriptViewportAnchor,
): StickyUserPromptModel | null {
  const viewportIndex = viewportAnchor.firstVisibleIndex
  if (viewportIndex == null || viewportIndex <= 0) return null
  let promptIndex: number | null = null
  for (let index = Math.min(viewportIndex, items.length - 1); index >= 0; index -= 1) {
    const item = items[index]
    if (!item || item.kind !== 'message' || item.message.role !== 'user') continue
    promptIndex = index
    break
  }
  if (promptIndex == null) return null
  // Avoid duplicating the original bubble while any part of that user row is
  // the first visible transcript item. Once the reader is in the assistant/tool
  // portion of the turn, the prompt becomes a useful context anchor.
  if (promptIndex === viewportIndex) return null
  const item = items[promptIndex]
  if (!item || item.kind !== 'message') return null
  return summarizeStickyUserPrompt(item.message, promptIndex)
}

function summarizeStickyUserPrompt(message: Message, itemIndex: number): StickyUserPromptModel | null {
  const text = message.content
    .filter((content): content is Extract<MessageContent, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const imageCount = message.content.filter((content) => content.type === 'image').length
  const files = message.content.filter((content): content is import('@agent-kernel/kernel').FileContent => content.type === 'file')
  const fileNames = files.slice(0, 2).map((file) => file.name)
  const extraFileCount = Math.max(0, files.length - fileNames.length)
  if (!text && imageCount === 0 && files.length === 0) return null
  return { itemIndex, text, imageCount, fileNames, extraFileCount }
}

function StickyUserPrompt({
  prompt,
  onClick,
}: {
  prompt: StickyUserPromptModel
  onClick: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const hasAttachments = prompt.imageCount > 0 || prompt.fileNames.length > 0 || prompt.extraFileCount > 0
  return (
    <div className="pointer-events-none min-w-0 flex-1" data-testid="sticky-user-prompt">
      <button
        type="button"
        onClick={onClick}
        className="ak-chat-container ak-sticky-user-prompt-surface pointer-events-auto mx-auto grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border/45 bg-card/88 px-2.5 py-1.5 text-left text-card-foreground shadow-sm backdrop-blur-lg transition-colors hover:border-border/70 sm:max-w-[min(var(--ak-chat-content-width,84rem),calc(100%-2rem))] sm:px-3"
        aria-label={t('chat.transcript.currentPromptJump')}
      >
        <span className="flex h-5 w-5 flex-none items-center justify-center self-center text-primary/80">
          <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 border-l border-border/50 pl-2.5">
          {prompt.text ? (
            <span className="ak-chat-text line-clamp-1 whitespace-pre-wrap break-words text-[0.9375rem] font-medium leading-6 tracking-[-0.01em] [overflow-wrap:anywhere] sm:text-base">
              {prompt.text}
            </span>
          ) : (
            <span className="block truncate text-[0.9375rem] font-medium leading-6 text-foreground sm:text-base">
              {t('chat.transcript.attachmentOnlyPrompt')}
            </span>
          )}
          {hasAttachments ? (
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {prompt.imageCount > 0 ? (
                <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-meta text-muted-foreground">
                  <Image className="h-3 w-3 flex-none" aria-hidden="true" />
                  {t('chat.transcript.imageAttachmentCount', { count: prompt.imageCount })}
                </span>
              ) : null}
              {prompt.fileNames.map((name) => (
                <span key={name} className="inline-flex max-w-[11rem] items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-meta text-muted-foreground">
                  <FileText className="h-3 w-3 flex-none" aria-hidden="true" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
              {prompt.extraFileCount > 0 ? (
                <span className="inline-flex items-center rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-meta text-muted-foreground">
                  {t('chat.transcript.moreAttachments', { count: prompt.extraFileCount })}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <ArrowRight className="h-4 w-4 flex-none self-center text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  )
}

function previousUserRerunTarget(items: readonly RenderTranscriptItem[], beforeIndex: number): MessageRerunTarget | null {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (!item || item.kind !== 'message') continue
    if (item.message.role !== 'user') continue
    if (item.seq === undefined) return null
    const text = messagePlainText(item.message.content).trim()
    return text.length > 0 ? { seq: item.seq, text } : null
  }
  return null
}

function CompactFeedbackTranscriptRow({
  status,
  onDismiss,
}: {
  status: Exclude<CompactStatus, { kind: 'idle' }>
  onDismiss?: () => void
}): JSX.Element {
  if (status.kind === 'running') {
    return <CompactProgressRow startedAt={status.startedAt} tokensBefore={status.tokensBefore} />
  }
  if (status.kind === 'done') {
    return (
      <div className="pl-0 sm:pl-10" data-testid="compact-feedback-transcript-row">
        <CompactResultRow
          trigger={status.trigger ?? 'unknown'}
          tokensBefore={status.tokensBefore}
          tokensAfter={status.tokensAfter}
          replacedCount={status.replacedCount}
          summary={status.summary}
          testId="compact-completed-result"
        />
      </div>
    )
  }

  return (
    <div className="pl-0 sm:pl-10" data-testid="compact-feedback-transcript-row">
      <CompactFeedbackRow
        kind={status.kind}
        message={status.kind === 'empty' || status.kind === 'error' ? status.message : undefined}
        onDismiss={status.kind === 'queued' ? undefined : onDismiss}
      />
    </div>
  )
}

function CompactProgressRow({
  startedAt,
  tokensBefore,
}: {
  startedAt: number
  tokensBefore: number
}): JSX.Element {
  const { t } = useTranslation()
  const elapsed = useElapsedSeconds(true, startedAt)
  return (
    <div className="flex items-center gap-3 py-2" data-testid="compact-feedback-transcript-row">
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
      <div
        className="inline-flex min-w-0 items-center gap-2 px-1 py-1 text-ui text-muted-foreground"
        data-testid="inline-compact-running"
        role="status"
      >
        <span className="ak-thinking-text truncate font-semibold leading-5" data-testid="inline-compact-progress-label">
          {t('chatStatus.compacting')}
        </span>
        <span className="flex-none tabular-nums text-muted-foreground/75">
          {elapsed === undefined ? null : `${formatElapsedDuration(elapsed)} · `}
          context {formatCompactTokens(tokensBefore)} tokens
        </span>
      </div>
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>
  )
}

function PendingUserMessageRow({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'pending_user_message' }>
}): JSX.Element {
  const { t } = useTranslation()
  const content = item.content ?? [{ type: 'text' as const, text: item.text }]
  const statusLabel = item.status === 'queued'
    ? t('composer.queued.queueLabel')
    : t('chat.transcript.sendingMessage')
  const shellState = item.shell?.state
  const effectiveStatusLabel = shellState
    ? item.shell?.error ?? `Shell command ${shellState === 'nonzero' ? 'completed with a nonzero exit' : shellState}`
    : statusLabel
  return (
    <div className="group relative flex min-w-0 max-w-full justify-end" data-testid={`pending-user-message-${item.id}`} data-status={item.status}>
      <div
        className="relative min-w-0 max-w-[92%] overflow-hidden rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm motion-safe:animate-[ak-pending-pulse_1.6s_ease-in-out_infinite] sm:max-w-[85%]"
        title={effectiveStatusLabel}
        aria-label={effectiveStatusLabel}
        data-testid={`pending-user-message-status-${item.id}`}
      >
        <InlineTimestamp
          ts={item.createdAt}
          className="absolute right-full top-1/2 mr-2 -translate-y-1/2 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-col gap-2">
          {content.map((c, i) => (
            <ContentBlock
              key={i}
              content={c}
              role="user"
              streaming={false}
              toolNameByCallId={new Map()}
              approvalByCallId={new Map()}
            />
          ))}
          {shellState ? (
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-80" data-testid={`shell-command-status-${item.id}`}>
              {shellState === 'running' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Terminal className="h-3 w-3" aria-hidden="true" />}
              {shellState === 'nonzero' ? 'nonzero exit' : shellState}
            </div>
          ) : null}
          {item.shell?.error ? (
            <div className="text-xs leading-relaxed opacity-90" role="alert" data-testid={`shell-command-error-${item.id}`}>
              {item.shell.error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

type ShellResultView = {
  operationId?: string
  state: 'completed' | 'nonzero' | 'failed'
}

function parseShellResultView(text: string): ShellResultView | null {
  if (!text.startsWith('Shell command result (explicit operator request; command execution can modify the workspace):\n')) return null
  const header = text.split('\n', 6)
  const status = header.find((line) => line.startsWith('Status: '))?.slice('Status: '.length)
  if (status !== 'completed' && status !== 'nonzero' && status !== 'failed') return null
  const operationId = header.find((line) => line.startsWith('Operation: '))?.slice('Operation: '.length)
  return { state: status, ...(operationId ? { operationId } : {}) }
}

function ShellResultMessage({ text, ts }: { text: string; ts?: string }): JSX.Element {
  const result = parseShellResultView(text)!
  const label = result.state === 'nonzero' ? 'Completed with nonzero exit' : result.state === 'failed' ? 'Failed' : 'Completed'
  return (
    <div className="flex min-w-0 max-w-full justify-end" data-testid="shell-result-message" data-operation-id={result.operationId} data-status={result.state}>
      <div className="relative min-w-0 max-w-[92%] overflow-hidden rounded-xl border border-border bg-muted/40 shadow-sm sm:max-w-[85%]">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-semibold"><Terminal className="h-3.5 w-3.5" aria-hidden="true" />Shell command</div>
          <span className={cn('text-[11px] font-semibold uppercase tracking-wide', result.state === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : result.state === 'nonzero' ? 'text-amber-600 dark:text-amber-400' : 'text-destructive')}>
            {label}
          </span>
        </div>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs leading-relaxed" data-testid="shell-result-output">{text}</pre>
        <InlineTimestamp ts={ts} className="px-3 pb-2 text-muted-foreground" />
      </div>
    </div>
  )
}

type TranscriptToolActivity = {
  group: ToolCallGroup
  firstMessageIndex: number
  lastMessageIndex: number
  nextIndex: number
  before: TranscriptToolActivityMessage[]
  after: TranscriptToolActivityMessage[]
  seq?: number
  ts?: string
}

type TranscriptToolActivityMessage = {
  item: Extract<TranscriptItem, { kind: 'message' }>
  messageIndex: number
}

function collectTranscriptToolActivity(
  items: readonly TranscriptItem[],
  startIndex: number,
  previousMessageIndex: number,
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
  options: { absorbReasoning: boolean; preserveAgentCalls: boolean },
): TranscriptToolActivity | null {
  const initialCalls = toolActivityAssistantCalls(items[startIndex], options.absorbReasoning)
  if (
    options.preserveAgentCalls
    && initialCalls?.length
    && initialCalls.every((call) => call.name === 'agent')
  ) {
    return collectTranscriptSubAgentActivity(
      items,
      startIndex,
      previousMessageIndex,
      resultsByCallId,
      options.absorbReasoning,
    )
  }
  if (options.absorbReasoning) {
    return collectDotsTranscriptToolActivity(
      items,
      startIndex,
      previousMessageIndex,
      resultsByCallId,
      options.preserveAgentCalls,
    )
  }

  function collectTranscriptSubAgentActivity(
    items: readonly TranscriptItem[],
    startIndex: number,
    previousMessageIndex: number,
    resultsByCallId: ReadonlyMap<string, ToolResultContent>,
    absorbReasoning: boolean,
  ): TranscriptToolActivity | null {
    const calls: ToolCallContent[] = []
    const knownCallIds = new Set<string>()
    let i = startIndex
    let messageIndex = previousMessageIndex
    let firstMessageIndex: number | null = null
    let lastMessageIndex = previousMessageIndex
    let firstSeq: number | undefined
    let firstTs: string | undefined

    while (i < items.length) {
      const assistantItem = items[i]
      const itemCalls = toolActivityAssistantCalls(assistantItem, absorbReasoning)
      if (
        !itemCalls?.length
        || itemCalls.some((call) => call.name !== 'agent')
        || !assistantItem
        || assistantItem.kind !== 'message'
      ) break
      messageIndex += 1
      if (firstMessageIndex === null) firstMessageIndex = messageIndex
      lastMessageIndex = messageIndex
      if (firstSeq === undefined) firstSeq = assistantItem.seq
      if (firstTs === undefined) firstTs = assistantItem.ts
      for (const call of itemCalls) {
        calls.push(call)
        knownCallIds.add(call.callId)
      }
      i += 1
      while (i < items.length && isToolResultItemForKnownCalls(items[i], knownCallIds)) {
        messageIndex += 1
        lastMessageIndex = messageIndex
        i += 1
      }
    }

    if (calls.length === 0 || firstMessageIndex === null) return null
    return {
      group: makeToolCallGroup(calls, resultsByCallId, false),
      firstMessageIndex,
      lastMessageIndex,
      nextIndex: i,
      before: [],
      after: [],
      ...(firstSeq !== undefined ? { seq: firstSeq } : {}),
      ...(firstTs !== undefined ? { ts: firstTs } : {}),
    }
  }

  const start = items[startIndex]
  const startCalls = toolActivityAssistantCalls(start, false)
  if (!startCalls || startCalls.length === 0) return null

  const calls: ToolCallContent[] = []
  let i = startIndex
  let messageIndex = previousMessageIndex
  let firstMessageIndex: number | null = null
  let lastMessageIndex = previousMessageIndex
  let firstSeq: number | undefined
  let firstTs: string | undefined
  const knownCallIds = new Set<string>()

  while (i < items.length) {
    const assistantItem = items[i]
    const itemCalls = toolActivityAssistantCalls(assistantItem, false)
    if (!itemCalls || !assistantItem || assistantItem.kind !== 'message') break
    if (options.preserveAgentCalls && itemCalls.some((call) => call.name === 'agent')) break
    messageIndex += 1
    if (firstMessageIndex === null) firstMessageIndex = messageIndex
    lastMessageIndex = messageIndex
    if (firstSeq === undefined) firstSeq = assistantItem.seq
    if (firstTs === undefined) firstTs = assistantItem.ts

    for (const call of itemCalls) {
      calls.push(call)
      knownCallIds.add(call.callId)
    }
    i += 1

    while (i < items.length && isToolResultItemForKnownCalls(items[i], knownCallIds)) {
      messageIndex += 1
      lastMessageIndex = messageIndex
      i += 1
    }
  }

  if (
    calls.length === 0
    || firstMessageIndex === null
    || (!options.absorbReasoning && calls.length < 2)
  ) return null

  return {
    group: makeToolCallGroup(calls, resultsByCallId, calls.length > 1),
    firstMessageIndex,
    lastMessageIndex,
    nextIndex: i,
    before: [],
    after: [],
    ...(firstSeq !== undefined ? { seq: firstSeq } : {}),
    ...(firstTs !== undefined ? { ts: firstTs } : {}),
  }
}

function collectDotsTranscriptToolActivity(
  items: readonly TranscriptItem[],
  startIndex: number,
  previousMessageIndex: number,
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
  preserveAgentCalls: boolean,
): TranscriptToolActivity | null {
  const start = items[startIndex]
  if (!isDotsAssistantMessageWithToolCalls(start, preserveAgentCalls)) return null

  const calls: ToolCallContent[] = []
  const knownCallIds = new Set<string>()
  const narratives: Array<TranscriptToolActivityMessage & { callsSeen: number }> = []
  let i = startIndex
  let messageIndex = previousMessageIndex
  let firstMessageIndex: number | null = null
  let lastMessageIndex = previousMessageIndex
  let firstSeq: number | undefined
  let firstTs: string | undefined

  while (i < items.length) {
    const item = items[i]
    if (!item || item.kind !== 'message') break

    if (item.message.role === 'assistant') {
      if (preserveAgentCalls && item.message.content.some(
        (content) => content.type === 'tool_call' && content.name === 'agent',
      )) break

      messageIndex += 1
      lastMessageIndex = messageIndex
      const narrativeContent: MessageContent[] = []
      const flushNarrative = (): void => {
        if (narrativeContent.length === 0) return
        narratives.push({
          item: withMessageContent(item, [...narrativeContent]),
          messageIndex,
          callsSeen: calls.length,
        })
        narrativeContent.length = 0
      }
      for (const content of item.message.content) {
        if (content.type === 'tool_call') {
          flushNarrative()
          if (firstMessageIndex === null) {
            firstMessageIndex = messageIndex
            firstSeq = item.seq
            firstTs = item.ts
          }
          calls.push(content)
          knownCallIds.add(content.callId)
          continue
        }
        narrativeContent.push(content)
      }
      flushNarrative()
      i += 1
      continue
    }

    if (item.message.role === 'tool' && isToolResultItemForKnownCalls(item, knownCallIds)) {
      messageIndex += 1
      lastMessageIndex = messageIndex
      i += 1
      continue
    }

    break
  }

  if (calls.length === 0 || firstMessageIndex === null) return null
  const before = narratives
    .filter((entry) => entry.callsSeen < calls.length)
    .map(({ callsSeen: _callsSeen, ...entry }) => entry)
  const after = narratives
    .filter((entry) => entry.callsSeen === calls.length)
    .map(({ callsSeen: _callsSeen, ...entry }) => entry)
  return {
    group: makeToolCallGroup(calls, resultsByCallId, calls.length > 1),
    firstMessageIndex,
    lastMessageIndex,
    nextIndex: i,
    before,
    after,
    ...(firstSeq !== undefined ? { seq: firstSeq } : {}),
    ...(firstTs !== undefined ? { ts: firstTs } : {}),
  }
}

function isDotsAssistantMessageWithToolCalls(
  item: TranscriptItem | undefined,
  preserveAgentCalls: boolean,
): item is Extract<TranscriptItem, { kind: 'message' }> {
  if (!item || item.kind !== 'message' || item.message.role !== 'assistant') return false
  return item.message.content.some(
    (content) => content.type === 'tool_call' && (!preserveAgentCalls || content.name !== 'agent'),
  )
}

function withMessageContent(
  item: Extract<TranscriptItem, { kind: 'message' }>,
  content: MessageContent[],
): Extract<TranscriptItem, { kind: 'message' }> {
  return {
    ...item,
    message: { ...item.message, content },
  }
}

function toolActivityAssistantCalls(
  item: TranscriptItem | undefined,
  absorbReasoning: boolean,
): ToolCallContent[] | null {
  if (!item || item.kind !== 'message' || item.message.role !== 'assistant') return null
  if (item.message.content.length === 0) return null
  const calls: ToolCallContent[] = []
  for (const content of item.message.content) {
    if (content.type === 'tool_call') {
      calls.push(content)
      continue
    }
    if (content.type === 'text' && content.text.trim().length === 0) {
      continue
    }
    if (content.type === 'thinking' && (absorbReasoning || content.text.trim().length === 0)) {
      continue
    }
    return null
  }
  return calls
}

function isToolResultItemForKnownCalls(
  item: TranscriptItem | undefined,
  knownCallIds: ReadonlySet<string>,
): item is Extract<TranscriptItem, { kind: 'message' }> {
  if (!item || item.kind !== 'message' || item.message.role !== 'tool') return false
  if (item.message.content.length === 0) return false
  const hasKnownResult = item.message.content.some(
    (content) => content.type === 'tool_result' && knownCallIds.has(content.callId),
  )
  return hasKnownResult && item.message.content.every(
    (content) => (content.type === 'tool_result' && knownCallIds.has(content.callId)) || !isRenderableMessageContent(content),
  )
}

function ToolActivityTranscriptRow({
  item,
  highlighted,
  hideHeader,
  approvalByCallId,
  onApprovalDecision,
  liveToolActivityTailCount,
  toolExecutionStartedAt,
  toolCardMode,
  activeToolCallIds,
  badgeIntentionCallId,
  parentSessionId,
  socket,
}: {
  item: Extract<RenderTranscriptItem, { kind: 'tool_activity' }>
  highlighted: boolean
  hideHeader: boolean
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  liveToolActivityTailCount: number
  toolExecutionStartedAt?: number | null
  toolCardMode: ToolCardMode
  activeToolCallIds: ReadonlySet<string> | null
  badgeIntentionCallId?: string
  parentSessionId?: string
  socket?: DashboardSocket | null
}): JSX.Element {
  const { t } = useTranslation()
  const timestampVisibility = useContext(MessageTimestampContext)
  if (parentSessionId && item.group.calls.every((call) => call.name === 'agent')) {
    return (
      <div
        id={`msg-${item.firstMessageIndex}`}
        data-message-index={item.firstMessageIndex}
        className={cn(
          'group relative flex min-w-0 gap-3',
          highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
        )}
      >
        <AssistantAvatarRail hidden={hideHeader} label={t('chat.transcript.searchCategories.assistant')} />
        <div className="relative min-w-0 flex-1">
          {hideHeader ? null : (
            <div className="mb-1 flex min-w-0 items-center justify-between gap-2 text-meta font-medium uppercase tracking-wider text-muted-foreground">
              <span>{t('chat.transcript.searchCategories.assistant')}</span>
              <InlineTimestamp ts={item.ts} />
            </div>
          )}
          <SubAgentCard
            parentSessionId={parentSessionId}
            socket={socket ?? null}
            group={item.group}
            approvalByCallId={approvalByCallId}
            toolCardMode={toolCardMode}
            timestamp={hideHeader && timestampVisibility !== 'hidden' ? item.ts : undefined}
          />
        </div>
      </div>
    )
  }
  if (toolCardMode === 'dots') {
    return (
      <div
        id={`msg-${item.firstMessageIndex}`}
        data-message-index={item.firstMessageIndex}
        className={cn(
          'group relative flex min-w-0 gap-3',
          highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
        )}
      >
        <AssistantAvatarRail hidden={hideHeader} label={t('chat.transcript.searchCategories.assistant')} />
        <div className="relative min-w-0 flex-1">
          <ToolCallGroupBlock
            group={item.group}
            messageIndex={item.firstMessageIndex}
            timestamp={item.ts}
            approvalByCallId={approvalByCallId}
            onApprovalDecision={onApprovalDecision}
            liveToolActivityTailCount={liveToolActivityTailCount}
            toolExecutionStartedAt={toolExecutionStartedAt}
            toolCardMode={toolCardMode}
            activeToolCallIds={activeToolCallIds}
            badgeIntentionCallId={badgeIntentionCallId}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      id={`msg-${item.firstMessageIndex}`}
      data-message-index={item.firstMessageIndex}
      className={cn(
        'group relative flex min-w-0 gap-3',
        highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
      )}
    >
      <AssistantAvatarRail hidden={hideHeader} label={t('chat.transcript.searchCategories.assistant')} />
      <div className="relative min-w-0 flex-1">
        {hideHeader ? null : (
          <div className="mb-1 flex min-w-0 items-center justify-between gap-2 text-meta font-medium uppercase tracking-wider text-muted-foreground">
            <span>{t('chat.transcript.searchCategories.assistant')}</span>
            <InlineTimestamp ts={item.ts} />
          </div>
        )}
        <ToolCallGroupBlock
          group={item.group}
          messageIndex={item.firstMessageIndex}
          approvalByCallId={approvalByCallId}
          onApprovalDecision={onApprovalDecision}
          liveToolActivityTailCount={liveToolActivityTailCount}
          toolExecutionStartedAt={toolExecutionStartedAt}
          toolCardMode={toolCardMode}
          activeToolCallIds={activeToolCallIds}
        />
        {hideHeader && item.ts && timestampVisibility !== 'hidden' ? <div className="mt-1 flex justify-end"><InlineTimestamp ts={item.ts} /></div> : null}
      </div>
    </div>
  )
}

function AssistantAvatarRail({ hidden, label, tool = false }: { hidden: boolean; label: string; tool?: boolean }): JSX.Element {
  return (
    <div className="hidden w-7 flex-none items-start justify-center pt-0.5 sm:flex" data-testid="message-avatar-rail" data-avatar-visible={hidden ? 'false' : 'true'}>
      {hidden ? null : tool ? (
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-emerald-500/20 dark:bg-emerald-950/40 dark:text-emerald-300" aria-label={label}>
          <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500/20 via-violet-500/20 to-fuchsia-500/20 text-violet-600 ring-1 ring-violet-500/25 shadow-sm dark:text-violet-300" aria-label={label}>
          <img src="/icons/octopus-web.svg" alt="" className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}

function GripHandle(): JSX.Element {
  return (
    <div
      className="pointer-events-none flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
      aria-hidden="true"
    >
      <GripVertical className="h-3 w-3 text-muted-foreground/60" />
    </div>
  )
}

function InlineTimestamp({
  ts,
  className,
}: {
  ts: string | undefined
  className?: string
}): JSX.Element | null {
  const visibility = useContext(MessageTimestampContext)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const formatted = useMemo(() => {
    if (!ts) return null
    const parsed = Date.parse(ts)
    if (!Number.isFinite(parsed)) return null
    const date = new Date(parsed)
    const today = new Date(todayStart)
    const label = date.toLocaleString()
    const sameDay =
      date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate()
    return {
      label,
      short: sameDay
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }
  }, [todayStart, ts])
  if (visibility === 'hidden') return null
  if (!formatted) return null
  return (
    <span
      className={cn(
        'pointer-events-none select-none whitespace-nowrap text-meta tabular-nums text-muted-foreground transition-opacity',
        visibility === 'always'
          ? 'opacity-65'
          : 'opacity-55 sm:opacity-0 sm:group-hover:opacity-65 sm:group-focus-within:opacity-65',
        className,
      )}
      title={formatted.label}
      aria-label={formatted.label}
      data-testid="message-timestamp"
    >
      {formatted.short}
    </span>
  )
}

/**
 * Bumping `scrollToBottomToken` forces the transcript to jump to the bottom
 * (e.g. after a session switch). The first non-empty mount also jumps so an
 * opened historical session starts at the latest message, not at row 0.
 * Multi-frame retries are limited to those explicit jumps because ordinary
 * appends are handled by Virtuoso's pinned followOutput path.
 */
function useVirtualTranscriptScrollToken(
  scrollToBottomToken: number | undefined,
  itemCount: number,
): React.RefObject<VirtualTranscriptHandle> {
  const ref = useRef<VirtualTranscriptHandle>(null)
  const lastToken = useRef<number | undefined>(scrollToBottomToken)
  const didInitialScroll = useRef(false)
  useEffect(() => {
    if (itemCount === 0) return
    const tokenChanged = scrollToBottomToken !== lastToken.current
    if (!tokenChanged && didInitialScroll.current) return
    didInitialScroll.current = true
    if (tokenChanged) lastToken.current = scrollToBottomToken
    const handle = ref.current
    if (!handle) return
    handle.scrollToBottom()
    // Virtuoso measures row/footer heights lazily. When a user sends a message,
    // the pending bubble and footer status can mount across several React/layout
    // turns, so repeat the explicit bottom jump longer than a single frame.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      handle.scrollToBottom()
      raf2 = requestAnimationFrame(() => handle.scrollToBottom())
    })
    const timeouts = [
      window.setTimeout(() => handle.scrollToBottom(), 60),
      window.setTimeout(() => handle.scrollToBottom(), 180),
      window.setTimeout(() => handle.scrollToBottom(), 360),
    ]
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      for (const timeout of timeouts) window.clearTimeout(timeout)
    }
  }, [itemCount, scrollToBottomToken])
  return ref
}

function TranscriptLoadingState(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="mx-auto flex min-h-20 w-full items-center justify-center py-3" data-testid="transcript-loading-state">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground" data-testid="transcript-history-loading-indicator" role="status">
        <span className="ak-session-status-spinner flex-none" aria-hidden="true">
          <Loader2 className="h-3.5 w-3.5" />
        </span>
        <span className="truncate">{t('chat.transcript.loadingHistory')}</span>
      </div>
    </div>
  )
}

function EmptyState({ onSuggest }: { onSuggest?: (text: string) => void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-6 py-10 text-center sm:gap-8 sm:py-16" data-testid="chat-empty-state">
      <div className="flex flex-col items-center gap-3">
        <div className="ak-empty-state-mark flex h-12 w-12 items-center justify-center rounded-2xl">
          <Sparkles className="h-6 w-6 text-primary/80" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          <Typewriter text={t('chat.transcript.emptyTitle')} charMs={38} startDelayMs={120} />
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t('chat.transcript.emptyDescription')}
        </p>
      </div>
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {EMPTY_SUGGESTIONS.map((s) => {
          const Icon = s.icon
          const clickable = typeof onSuggest === 'function'
          return (
            <button
              key={s.title}
              type="button"
              onClick={() => onSuggest?.(s.prompt)}
              disabled={!clickable}
              className={cn(
                'ak-empty-suggestion group flex min-w-0 items-start gap-3 rounded-xl p-3 text-left transition-[background-color,box-shadow,border-color] sm:p-4',
                clickable
                  ? 'hover:bg-muted cursor-pointer'
                  : 'cursor-default opacity-70',
              )}
              data-testid={`empty-suggestion-${s.title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-background text-muted-foreground group-hover:text-foreground">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-sm font-medium text-foreground">{s.title}</div>
                <div className="line-clamp-2 text-xs text-muted-foreground">{s.prompt}</div>
              </div>
            </button>
          )
        })}
      </div>
      <div className="text-xs text-muted-foreground" data-testid="empty-state-hint">
        {t('chat.transcript.empty')}
      </div>
    </div>
  )
}

type CompactTrigger = Extract<TranscriptItem, { kind: 'compact_boundary' }>['trigger']

function compactTriggerLabel(trigger: CompactTrigger, t: TFunction): string {
  switch (trigger) {
    case 'auto': return t('chat.transcript.automaticCompact')
    case 'manual': return t('chat.transcript.manualCompact')
    case 'preflight': return t('chat.transcript.preflightCompact')
    case 'tool_result': return t('chat.transcript.toolResultCompact')
    default: return t('chat.transcript.contextCompacted')
  }
}

function compactTriggerLabelShort(trigger: CompactTrigger, t: TFunction): string {
  switch (trigger) {
    case 'auto': return t('chat.transcript.automaticCompactShort')
    case 'manual': return t('chat.transcript.manualCompactShort')
    case 'preflight': return t('chat.transcript.preflightCompactShort')
    case 'tool_result': return t('chat.transcript.toolResultCompactShort')
    default: return t('chat.transcript.contextCompactedShort')
  }
}

/**
 * Format a token count for the compact-boundary label. `null` means the
 * runtime didn't emit the metadata (older sessions or in-flight upgrade);
 * render `—` rather than `0` so we don't imply the compaction was a no-op.
 */
function formatCompactTokens(value: number | null): string {
  if (value === null) return '—'
  return formatTokens(value)
}

function CompactBoundaryRow({
  boundary,
}: {
  boundary: Extract<TranscriptItem, { kind: 'compact_boundary' }>
}): JSX.Element {
  return (
    <CompactResultRow
      trigger={boundary.trigger}
      tokensBefore={boundary.tokensBefore}
      tokensAfter={boundary.tokensAfter}
      replacedCount={boundary.replacedCount}
      seq={boundary.seq}
      summary={boundary.summary}
      testId="compact-boundary"
    />
  )
}

function CompactResultRow({
  trigger: triggerKind,
  tokensBefore,
  tokensAfter,
  replacedCount,
  seq,
  summary,
  testId,
}: {
  trigger: Extract<TranscriptItem, { kind: 'compact_boundary' }>['trigger']
  tokensBefore: number | null
  tokensAfter: number | null
  replacedCount?: number
  seq?: number
  summary?: string
  testId: string
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const trigger = compactTriggerLabel(triggerKind, t)
  const shortTrigger = compactTriggerLabelShort(triggerKind, t)
  const before = formatCompactTokens(tokensBefore)
  const after = formatCompactTokens(tokensAfter)
  const description = seq !== undefined && replacedCount !== undefined
    ? t('chat.transcript.compactSummary', { trigger, seq, before, after, count: replacedCount })
    : [
        t('chat.transcript.compactSummaryShort', { trigger: shortTrigger, before, after }),
        replacedCount === undefined ? null : t('chat.transcript.compactReplacedCount', { count: replacedCount }),
      ].filter(Boolean).join(' · ')
  return (
    <div className="flex items-center gap-3 py-2" data-testid={testId}>
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-0 items-center gap-2 rounded-full bg-muted/60 px-3 py-1 text-meta text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="compact-boundary-open"
      >
        <Archive className="h-3 w-3 flex-none" aria-hidden="true" />
        <span className="font-medium text-foreground">{t('chat.transcript.contextCompacted')}</span>
        <span className="hidden truncate sm:inline">
          · {description}
        </span>
        <span className="truncate sm:hidden">
          {t('chat.transcript.compactSummaryShort', { trigger: shortTrigger, before, after })}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid h-[82vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 gap-0">
          <DialogHeader className="bg-card px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {t('chat.transcript.contextCompacted')}
            </DialogTitle>
            <DialogDescription>
              {description}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 bg-background">
            <div className="px-5 py-4" data-testid="compact-summary-modal">
              {summary?.trim()
                ? <AssistantMarkdown text={summary} />
                : <p className="text-sm text-muted-foreground">{t('chat.transcript.compactSummaryUnavailable')}</p>}
            </div>
          </ScrollArea>
          <DialogFooter className="bg-card px-4 py-3">
            <DialogClose asChild>
              <Button variant="outline" className="mt-0">{t('common.close')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>
  )
}

function messageContentAfterGroupedResults(
  message: Message,
  groupedCallIds: ReadonlySet<string>,
): MessageContent[] {
  if (message.role !== 'tool') return [...message.content]
  return message.content.filter(
    (content) => content.type !== 'tool_result' || !groupedCallIds.has(content.callId),
  )
}

function isRenderableMessageContent(content: MessageContent): boolean {
  if (content.type === 'text' || content.type === 'thinking') return content.text.trim().length > 0
  return true
}

function clusterVisibleThinkingItems(
  items: readonly RenderTranscriptItem[],
  messageIndexes: readonly number[],
  hideHeaders: readonly boolean[],
  groupedCallIds: ReadonlySet<string>,
): {
  items: RenderTranscriptItem[]
  messageIndexes: number[]
  hideHeaders: boolean[]
} {
  const clusteredItems: RenderTranscriptItem[] = []
  const clusteredIndexes: number[] = []
  const clusteredHeaders: boolean[] = []

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex]!
    const messageIndex = messageIndexes[itemIndex] ?? -1
    const thinkingUpdates = visibleThinkingUpdates(item, groupedCallIds)
    const previous = clusteredItems.at(-1)

    if (thinkingUpdates && item.kind === 'message') {
      if (previous?.kind === 'thinking_cluster') {
        previous.updates.push(...thinkingUpdates)
        previous.lastMessageIndex = messageIndex
        // The newest update determines whether the cluster is still live.
        previous.streaming = item.streaming === true
        if (item.seq !== undefined) previous.seq = item.seq
        if (item.ts !== undefined) previous.ts = item.ts
        if (item.turnTiming !== undefined) previous.turnTiming = item.turnTiming
      } else {
        clusteredItems.push({
          kind: 'thinking_cluster',
          updates: [...thinkingUpdates],
          firstMessageIndex: messageIndex,
          lastMessageIndex: messageIndex,
          streaming: item.streaming === true,
          seq: item.seq,
          ts: item.ts,
          turnTiming: item.turnTiming,
        })
        clusteredIndexes.push(messageIndex)
        clusteredHeaders.push(hideHeaders[itemIndex] ?? false)
      }
      continue
    }

    clusteredItems.push(item)
    clusteredIndexes.push(messageIndex)
    clusteredHeaders.push(hideHeaders[itemIndex] ?? false)
  }

  return {
    items: clusteredItems,
    messageIndexes: clusteredIndexes,
    hideHeaders: clusteredHeaders,
  }
}

function visibleThinkingUpdates(
  item: RenderTranscriptItem,
  groupedCallIds: ReadonlySet<string>,
): ReasoningContent[] | null {
  if (item.kind !== 'message' || item.message.role !== 'assistant') return null
  const visibleContent = messageContentAfterGroupedResults(item.message, groupedCallIds)
    .filter(isRenderableMessageContent)
  if (visibleContent.length === 0 || !visibleContent.every((content) => content.type === 'thinking')) {
    return null
  }
  return visibleContent as ReasoningContent[]
}

function MessageRow({
  index,
  message,
  streaming,
  highlighted,
  toolNameByCallId,
  approvalByCallId,
  onApprovalDecision,
  resultsByCallId,
  groupedCallIds,
  seq,
  ts,
  hideHeader,
  onEditAndRerun,
  parentSessionId,
  socket,
  liveToolActivityTailCount,
  toolExecutionStartedAt,
  toolCardMode,
  activeToolCallIds,
  badgeIntentionCallId,
  assistantRerunTarget,
  turnTiming,
  scheduledTaskId,
  onOpenScheduledTask,
  chapterSessionId,
  globalChapterMode = 'chapters',
  chapterModeOverride,
  onChapterModeChange,
  onChapterNavigate,
}: {
  index: number
  message: Message
  streaming: boolean
  highlighted: boolean
  toolNameByCallId: ReadonlyMap<string, string>
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  resultsByCallId: ReadonlyMap<string, ToolResultContent>
  groupedCallIds: ReadonlySet<string>
  seq?: number
  ts?: string
  hideHeader: boolean
  onEditAndRerun?: (seq: number, text: string) => void
  parentSessionId?: string
  socket?: DashboardSocket | null
  liveToolActivityTailCount: number
  toolExecutionStartedAt?: number | null
  toolCardMode: ToolCardMode
  activeToolCallIds: ReadonlySet<string> | null
  badgeIntentionCallId?: string
  assistantRerunTarget?: MessageRerunTarget | null
  turnTiming?: import('@agent-kernel/shared').TurnTimingSummary
  scheduledTaskId?: string
  onOpenScheduledTask?: (taskId: string) => void
  chapterSessionId?: string | null
  globalChapterMode?: ChapterReadingMode
  chapterModeOverride?: ChapterReadingMode
  onChapterModeChange?: (mode: ChapterReadingMode | null) => void
  onChapterNavigate?: () => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const messageText = messagePlainText(message.content)
  const editable =
    message.role === 'user' &&
    seq !== undefined &&
    typeof onEditAndRerun === 'function'
  const initialText = editable ? messageText : ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialText)
  const [chapterHeaderTarget, setChapterHeaderTarget] = useState<HTMLDivElement | null>(null)

  if (editing && editable) {
    return (
      <div
        id={`msg-${index}`}
        data-message-index={index}
        className={cn(
          'group relative flex flex-col gap-2 rounded-2xl bg-muted/40 p-4 transition-colors',
          highlighted ? 'bg-amber-50/60 dark:bg-amber-950/20' : '',
        )}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[80px] resize-none border-0 bg-transparent p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          data-testid={`edit-message-input-${index}`}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-3 text-xs"
            onClick={() => {
              setEditing(false)
              setDraft(initialText)
            }}
            data-testid={`edit-message-cancel-${index}`}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            {t('chat.transcript.editCancel')}
          </Button>
          <Button
            type="button"
            className="h-7 px-3 text-xs"
            disabled={draft.trim().length === 0}
            onClick={() => {
              if (seq === undefined) return
              onEditAndRerun?.(seq, draft.trim())
              setEditing(false)
            }}
            data-testid={`edit-message-submit-${index}`}
          >
            {t('chat.transcript.rerun')}
          </Button>
        </div>
      </div>
    )
  }

  if (message.role === 'user') {
    if (parseShellResultView(messageText)) return <ShellResultMessage text={messageText} ts={ts} />
    const cancelledUserTurn = turnTiming?.status === 'cancelled'
    const metadata = (
      <div className={cn(
        'pointer-events-auto z-10 flex items-center gap-1.5',
        cancelledUserTurn
          ? 'relative max-w-full flex-wrap justify-end text-muted-foreground'
          : 'absolute bottom-1 left-2 max-w-[calc(100%-1rem)] rounded-md bg-primary/85 px-1 backdrop-blur-sm sm:bottom-0 sm:left-auto sm:right-full sm:mr-2 sm:max-w-[18rem] sm:bg-transparent sm:px-0 sm:backdrop-blur-none',
      )} data-testid="user-message-metadata">
        {scheduledTaskId ? (
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-inherit transition-colors hover:bg-primary-foreground/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Open scheduled task details"
            title="Open scheduled task details"
            data-testid="scheduled-message-badge"
            onClick={() => onOpenScheduledTask?.(scheduledTaskId)}
          >
            <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Scheduled</span>
          </button>
        ) : null}
        <MessageActions
          align="end"
          copyText={messageText}
          editAction={editable ? {
            label: t('chat.transcript.editMessage'),
            onClick: () => {
              setDraft(initialText)
              setEditing(true)
            },
            testId: `edit-message-${index}`,
          } : undefined}
        />
        {turnTiming ? <TurnTimingFooter summary={turnTiming} userMessage cancelledUserMessage={cancelledUserTurn} /> : null}
        <InlineTimestamp ts={ts} className={cancelledUserTurn
          ? 'min-w-0'
          : 'absolute bottom-full left-0 mb-0.5 rounded bg-primary/90 px-1 text-primary-foreground sm:bottom-1/2 sm:left-auto sm:right-full sm:mb-0 sm:mr-2 sm:translate-y-1/2 sm:bg-background/90 sm:text-muted-foreground'} />
      </div>
    )
    return (
      <div
        id={`msg-${index}`}
        data-message-index={index}
        className={cn(
          'group relative flex min-w-0 max-w-full justify-end gap-2',
          cancelledUserTurn && 'flex-col items-end gap-1',
          highlighted ? 'rounded-2xl bg-amber-50/60 p-1 dark:bg-amber-950/20' : '',
        )}
      >
        <div className="relative min-w-0 max-w-[92%] sm:max-w-[85%]">
          <div className={cn('relative max-w-full overflow-hidden rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm sm:pb-2.5', cancelledUserTurn ? 'pb-2.5' : 'pb-9')} data-testid="user-message-surface">
            <div className="flex min-w-0 flex-col gap-2">
              {message.content.map((c, i) => (
                <ContentBlock
                  key={i}
                  content={c}
                  role={message.role}
                  streaming={false}
                  toolNameByCallId={toolNameByCallId}
                  approvalByCallId={approvalByCallId}
                  onApprovalDecision={onApprovalDecision}
                />
              ))}
            </div>
          </div>
          {!cancelledUserTurn ? metadata : null}
        </div>
        {cancelledUserTurn ? metadata : null}
      </div>
    )
  }

  // Assistant + tool messages: no bubble, avatar-labeled row with generous line height.
  const roleTextColor =
    message.role === 'tool'
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-muted-foreground'
  const label = message.role === 'assistant' ? 'Assistant' : 'Tool result'

  const visibleContent = messageContentAfterGroupedResults(message, groupedCallIds)
    .filter(isRenderableMessageContent)

  if (visibleContent.length === 0) return null
  const assistantActions = assistantMessageActions(message, visibleContent)

  const groupedItems: GroupedContentItem[] =
    message.role === 'assistant'
      ? groupConsecutiveToolCalls(visibleContent, resultsByCallId)
      : visibleContent.map((c) => ({ kind: 'single', content: c }))
  const chapterText = !streaming && message.role === 'assistant' && groupedItems.length === 1
    && groupedItems[0]?.kind === 'single' && groupedItems[0].content.type === 'text'
    && groupedItems[0].content.text.length >= 2_000
      ? groupedItems[0].content.text
      : null
  // A single prose paragraph can carry its actions at the end of the text;
  // inline layout wraps them only if the remaining line is too narrow.
  const inlineActionsText = !streaming && !turnTiming && !chapterText && assistantActions && groupedItems.length === 1
    && groupedItems[0]?.kind === 'single' && groupedItems[0].content.type === 'text'
    && !/[\r\n]/.test(groupedItems[0].content.text)
    && !/^\s*(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3,}|~{3,})/.test(groupedItems[0].content.text)
    && !/!\[[^\]]*\]\(/.test(groupedItems[0].content.text)
      ? groupedItems[0].content.text
      : null

  return (
    <div
      id={`msg-${index}`}
      data-message-index={index}
      className={cn(
        'group relative flex min-w-0 gap-3',
        highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
      )}
    >
      <AssistantAvatarRail hidden={hideHeader} label={label} tool={message.role === 'tool'} />
      <div className="relative min-w-0 max-w-full flex-1" data-testid="assistant-content-column">
        {!hideHeader || chapterText ? (
          <div className={cn('mb-1 flex min-w-0 items-center justify-between gap-2 text-meta font-medium uppercase tracking-wider', roleTextColor)}>
            <span className="shrink-0">{label}</span>
            {chapterText ? <div ref={setChapterHeaderTarget} className="flex min-w-0 items-center justify-end" data-testid="assistant-chapter-controls" /> : null}
          </div>
        ) : null}
        <div className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden">
          {groupedItems.map((item, i) => {
            if (item.kind === 'tool_call_group') {
              if (parentSessionId && item.calls.every((call) => call.name === 'agent')) {
                return (
                  <SubAgentCard
                    key={`sub-agent-${item.firstCallId}`}
                    parentSessionId={parentSessionId}
                    socket={socket ?? null}
                    group={item}
                    approvalByCallId={approvalByCallId}
                    toolCardMode={toolCardMode}
                  />
                )
              }
              return (
                <ToolCallGroupBlock
                  key={`group-${item.firstCallId}`}
                  group={item}
                  messageIndex={index}
                  approvalByCallId={approvalByCallId}
                  onApprovalDecision={onApprovalDecision}
                  liveToolActivityTailCount={liveToolActivityTailCount}
                  toolExecutionStartedAt={toolExecutionStartedAt}
                  toolCardMode={toolCardMode}
                  activeToolCallIds={activeToolCallIds}
                  badgeIntentionCallId={badgeIntentionCallId}
                />
              )
            }
            if (item.kind === 'thinking_group') {
              return <ThinkingBlock key={`thinking-${i}`} updates={item.updates} active={streaming} />
            }
            if (inlineActionsText && item.kind === 'single' && item.content.type === 'text') {
              return <AssistantMarkdown key={i} text={inlineActionsText} trailingAction={<MessageActions
                align="start"
                inline
                copyText={assistantActions!.copyText}
                tryAgainAction={assistantRerunTarget && onEditAndRerun ? {
                  label: t('chat.transcript.tryAgain'),
                  onClick: () => onEditAndRerun(assistantRerunTarget.seq, assistantRerunTarget.text),
                  testId: `try-again-message-${index}`,
                } : undefined}
              />} />
            }
            if (chapterText && item.kind === 'single' && item.content.type === 'text') {
              return <Suspense key={i} fallback={<AssistantMarkdown text={chapterText} />}>
                <ChapterReader
                  key={chapterSessionId ?? 'local'}
                  text={chapterText}
                  headerTarget={chapterHeaderTarget}
                  defaultMode={globalChapterMode}
                  sessionMode={chapterModeOverride}
                  onSessionModeChange={onChapterModeChange}
                  onChapterNavigate={onChapterNavigate}
                  revealAll={highlighted}
                  renderMarkdown={(text) => <AssistantMarkdown text={text} />}
                />
              </Suspense>
            }
            return (
              <ContentBlock
                key={i}
                content={item.content}
                role={message.role}
                streaming={streaming}
                toolNameByCallId={toolNameByCallId}
                approvalByCallId={approvalByCallId}
                onApprovalDecision={onApprovalDecision}
              />
            )
          })}
          {!streaming && (ts || turnTiming || (message.role === 'assistant' && assistantActions && !inlineActionsText)) ? (
            <div className={cn(
              'message-metadata-row relative flex min-w-0 max-w-full items-center gap-1 overflow-visible',
              (assistantActions && !inlineActionsText) || turnTiming ? 'min-h-7' : 'h-0',
            )} data-testid="assistant-message-footer">
              {assistantActions && !inlineActionsText ? <MessageActions
                align="start"
                copyText={assistantActions.copyText}
                tryAgainAction={assistantRerunTarget && onEditAndRerun ? {
                  label: t('chat.transcript.tryAgain'),
                  onClick: () => onEditAndRerun(assistantRerunTarget.seq, assistantRerunTarget.text),
                  testId: `try-again-message-${index}`,
                } : undefined}
              /> : null}
              {turnTiming ? <TurnTimingFooter summary={turnTiming} /> : null}
              <InlineTimestamp ts={ts} className={cn(
                'absolute right-0 rounded bg-background/90 px-1 backdrop-blur-sm sm:right-auto sm:left-full sm:ml-2',
                (assistantActions && !inlineActionsText) || turnTiming ? 'bottom-1/2 translate-y-1/2' : 'top-0',
              )} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function TurnTimingFooter({ summary, userMessage = false, cancelledUserMessage = false }: { summary: import('@agent-kernel/shared').TurnTimingSummary; userMessage?: boolean; cancelledUserMessage?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const statusLabel = t(`chatCommon.turnTiming.status.${summary.status === 'completed' || summary.status === 'failed' || summary.status === 'cancelled' || summary.status === 'interrupted' ? summary.status : 'running'}`)
  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])
  const detailsId = `turn-timing-details-${summary.turnId}`
  const totalCalls = summary.llm.requestCount + summary.tools.callCount
  return (
    <div
      ref={rootRef}
      className={cn('flex flex-none items-center whitespace-nowrap', userMessage && 'relative', cancelledUserMessage && 'max-w-full flex-wrap justify-end whitespace-normal')}
      data-testid={`turn-timing-${summary.turnId}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'flex h-7 flex-none items-center gap-1.5 rounded-md px-2 text-left text-meta text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
          open && 'bg-muted/60 text-foreground',
        )}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`${statusLabel} · ${formatTurnDuration(summary.wallDurationMs)}`}
        title={statusLabel}
      >
        <span aria-hidden="true" className={cn(summary.status === 'failed' && 'text-destructive', summary.status === 'interrupted' && 'text-amber-600 dark:text-amber-400')}>{summary.status === 'completed' ? '✓' : summary.status === 'failed' ? '!' : summary.status === 'interrupted' ? '⊘' : '◌'}</span>
        <span className="tabular-nums">{formatTurnDuration(summary.wallDurationMs)}</span>
        {open ? <ChevronLeft className="h-3.5 w-3.5 flex-none" /> : <ChevronRight className="h-3.5 w-3.5 flex-none" />}
      </button>
      {open ? (
        <div
          id={detailsId}
          role="group"
          aria-label={`${statusLabel} · ${formatTurnDuration(summary.wallDurationMs)}`}
          className={cn(
            'flex min-w-0 animate-in items-center text-meta text-muted-foreground fade-in slide-in-from-left-1',
            cancelledUserMessage
              ? 'order-first max-w-full flex-wrap justify-end whitespace-normal'
              : userMessage
                ? 'absolute bottom-full right-0 z-20 mb-1 w-max max-w-[min(18rem,calc(100vw-2rem))] flex-wrap rounded-lg border border-border bg-popover px-2 py-1.5 shadow-md'
                : 'h-7 flex-none whitespace-nowrap',
          )}
          data-testid={detailsId}
        >
          <span className="px-1.5 text-border" aria-hidden="true">·</span>
          <span className="tabular-nums">
            {formatTimestamp(summary.startedAt)}
            <span className="px-1 text-muted-foreground/60" aria-hidden="true">→</span>
            {summary.completedAt ? formatTimestamp(summary.completedAt) : '…'}
          </span>
          {totalCalls > 0 ? (
            <>
              <span className="px-1.5 text-border" aria-hidden="true">·</span>
              <span className="tabular-nums">{t('chatCommon.turnTiming.calls')} {totalCalls}</span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function formatTurnDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (ms > 0 && seconds === 0) return '<1s'
  if (seconds < 60) return `${seconds}s`
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${remainder}s`
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function assistantMessageActions(
  message: Message,
  visibleContent: readonly MessageContent[],
): { copyText: string } | null {
  if (message.role !== 'assistant') return null
  if (visibleContent.some((content) => content.type === 'tool_call' || content.type === 'tool_result')) return null
  const text = visibleContent
    .filter((content): content is Extract<MessageContent, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
    .trim()
  return text.length > 0 ? { copyText: text } : null
}

function ContentBlock({
  content,
  role,
  streaming,
  toolNameByCallId,
  approvalByCallId,
  onApprovalDecision,
}: {
  content: MessageContent
  role: Message['role']
  streaming?: boolean
  toolNameByCallId: ReadonlyMap<string, string>
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
}): JSX.Element {
  if (content.type === 'text') {
    if (role === 'assistant') {
      const terminalMarker = splitAssistantTerminalMarker(content.text)
      if (terminalMarker) return <TerminalAssistantMessage text={terminalMarker.text} kind={terminalMarker.kind} />
      return <AssistantMarkdown text={content.text} streaming={streaming === true} />
    }
    if (role === 'user') {
      return (
        <div className="ak-chat-text min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {content.text}
        </div>
      )
    }
    return (
      <div className="ak-chat-text min-w-0 whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]">
        {content.text}
      </div>
    )
  }
  if (content.type === 'tool_call') {
    return (
      <ToolCallBlock
        call={content}
        approval={approvalByCallId.get(content.callId) ?? null}
        onApprovalDecision={onApprovalDecision}
      />
    )
  }
  if (content.type === 'tool_result') {
    return (
      <ToolResultBlock
        result={content}
        toolName={toolNameByCallId.get(content.callId)}
      />
    )
  }
  if (content.type === 'thinking') return <ThinkingBlock updates={[content]} active={streaming === true} />
  if (content.type === 'image') return <ImageBlock content={content} />
  return <FileBlock content={content} />
}

function MessageActions({
  align,
  inline = false,
  copyText,
  editAction,
  tryAgainAction,
}: {
  align: 'start' | 'end'
  inline?: boolean
  copyText: string
  editAction?: { label: string; onClick: () => void; testId: string }
  tryAgainAction?: { label: string; onClick: () => void; testId: string }
}): JSX.Element | null {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const canCopy = copyText.trim().length > 0
  if (!canCopy && !editAction && !tryAgainAction) return null
  const Container = inline ? 'span' : 'div'
  return (
    <Container
      className={cn(
        'items-center gap-1 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
        inline ? 'inline-flex align-middle' : 'flex',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
      data-testid={`message-actions-${align}`}
    >
      {canCopy ? (
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            inline ? 'h-6 w-6' : 'h-7 w-7',
            copied && 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 hover:text-emerald-700 dark:text-emerald-400',
          )}
          title={copied ? t('common.copied') : t('common.copy')}
          aria-label={copied ? t('common.copied') : t('common.copy')}
          data-testid="copy-message"
          onClick={() => {
            void writeTextToClipboard(copyText).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            }).catch(() => setCopied(false))
          }}
        >
          {copied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      ) : null}
      {editAction ? (
        <button
          type="button"
          className={cn('inline-flex items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring', inline ? 'h-6 w-6' : 'h-7 w-7')}
          title={editAction.label}
          aria-label={editAction.label}
          data-testid={editAction.testId}
          onClick={editAction.onClick}
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      {tryAgainAction ? (
        <button
          type="button"
          className={cn('inline-flex items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring', inline ? 'h-6 w-6' : 'h-7 w-7')}
          title={tryAgainAction.label}
          aria-label={tryAgainAction.label}
          data-testid={tryAgainAction.testId}
          onClick={tryAgainAction.onClick}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </Container>
  )
}

function messagePlainText(content: readonly MessageContent[]): string {
  return content
    .map((item) => {
      if (item.type === 'text' || item.type === 'thinking') return item.text
      if (item.type === 'tool_call') return `${item.name} ${formatMessageActionValue(item.input)}`.trim()
      if (item.type === 'tool_result') return item.content
      if (item.type === 'image') return '[image]'
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

function formatMessageActionValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function splitAssistantTerminalMarker(text: string): { text: string; kind: 'cancelled' | 'interrupted' } | null {
  const match = text.match(/(?:\n\n)?\[(cancelled|interrupted)\]\s*$/i)
  if (!match) return null
  return {
    text: text.slice(0, match.index).trimEnd(),
    kind: match[1]?.toLowerCase() === 'interrupted' ? 'interrupted' : 'cancelled',
  }
}

function TerminalAssistantMessage({ text, kind }: { text: string; kind: 'cancelled' | 'interrupted' }): JSX.Element {
  const { t } = useTranslation()
  const interrupted = kind === 'interrupted'
  return (
    <div className="min-w-0 space-y-3">
      {text.length > 0 ? <AssistantMarkdown text={text} /> : null}
      <div
        className={cn(
          'inline-flex max-w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ring-1',
          interrupted
            ? 'bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:text-orange-300'
            : 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300',
        )}
        data-testid={interrupted ? 'assistant-message-interrupted' : 'assistant-message-cancelled'}
      >
        <Ban className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <span>{interrupted ? 'Response interrupted before completion' : t('chat.transcript.cancelledMessage')}</span>
      </div>
    </div>
  )
}

function ImageBlock({
  content,
}: {
  content: import('@agent-kernel/kernel').ImageContent
}): JSX.Element {
  const src = content.source.kind === 'base64'
    ? `data:${content.source.mediaType};base64,${content.source.data}`
    : content.source.path
  return <ImagePreviewBlock src={src} />
}

function DurableImagePreviewBlock({ url, token, name, mediaType }: { url: string; token?: string; name: string; mediaType: string }): JSX.Element {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setSrc('')
    setFailed(false)
    void fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      credentials: 'include',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`attachment image returned ${response.status}`)
      objectUrl = URL.createObjectURL(await response.blob())
      setSrc(objectUrl)
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true)
    })
    return () => {
      controller.abort()
      if (objectUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl)
    }
  }, [token, url])
  if (failed) return <AttachmentFileChip name={name} mediaType={mediaType} />
  if (!src) return <div className="h-28 w-40 max-w-full animate-pulse rounded-lg bg-muted/40 sm:h-32 sm:w-48" data-testid="message-image-preview-loading" />
  return <ImagePreviewBlock src={src} />
}

function ImagePreviewBlock({ src }: { src: string }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const label = t('chat.transcript.openImagePreview')
  return (
    <>
      <button
        type="button"
        className="group/image relative block h-28 w-40 max-w-full cursor-zoom-in overflow-hidden rounded-lg bg-background/20 p-0.5 text-left shadow-sm transition-colors hover:bg-background/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-32 sm:w-48"
        onClick={() => setOpen(true)}
        aria-label={label}
        data-testid="message-image-preview-trigger"
      >
        <img
          src={src}
          alt=""
          className="h-full w-full rounded-md object-contain"
        />
        <span className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-black/45 text-white opacity-0 shadow-lg transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100">
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </button>
      <ReadonlyImagePreviewDialog
        open={open}
        onOpenChange={setOpen}
        src={src}
        alt=""
        title={t('chat.transcript.imagePreview')}
        description={t('chat.transcript.imagePreviewDescription')}
        dialogTestId="message-image-preview-dialog"
        closeTestId="message-image-preview-close"
        imageTestId="message-image-preview-full"
      />
    </>
  )
}

function FileBlock({
  content,
}: {
  content: import('@agent-kernel/kernel').FileContent
}): JSX.Element {
  const sessionId = useContext(ArtifactSessionContext)
  const attachmentAccess = useContext(AttachmentAccessContext)
  if ('source' in content && content.source.kind === 'host_ref' && content.mediaType.startsWith('image/') && sessionId) {
    const url = messageAttachmentUrl(attachmentAccess.host ?? '', sessionId, content.source.attachmentId)
    return <DurableImagePreviewBlock url={url} token={attachmentAccess.token} name={content.name} mediaType={content.mediaType} />
  }
  return <AttachmentFileChip name={content.name} mediaType={content.mediaType} />
}

function AttachmentFileChip({ name, mediaType }: { name: string; mediaType: string }): JSX.Element {
  return (
    <div
      className="flex max-w-sm items-center gap-2 rounded-lg border border-border/50 bg-background/30 px-3 py-2"
      data-testid="message-file-attachment"
    >
      <FileText className="h-5 w-5 flex-none text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-meta text-muted-foreground">{mediaType}</span>
      </span>
    </div>
  )
}

function ThinkingBlock({
  updates,
  active = false,
}: {
  updates: readonly ReasoningContent[]
  active?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const expandByDefault = useContext(ThinkingExpandedByDefaultContext)
  const [open, setOpen] = useState(expandByDefault)
  useEffect(() => setOpen(expandByDefault), [expandByDefault])
  const count = updates.length
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, count - 1))
  const previousCountRef = useRef(count)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    setActiveIndex((currentIndex) => {
      const wasFollowingLatest = currentIndex >= previousCountRef.current - 1
      previousCountRef.current = count
      return wasFollowingLatest
        ? Math.max(0, count - 1)
        : Math.min(currentIndex, Math.max(0, count - 1))
    })
  }, [count])
  const presentations = updates.map((update) => thinkingPresentation(normalizeThinkingDisplayText(update.text)))
  const selectedUpdate = updates[activeIndex] ?? updates.at(-1)
  const selectedPresentation = presentations[activeIndex] ?? presentations.at(-1)
  const title = selectedPresentation?.title
  const selectPrevious = () => setActiveIndex((index) => Math.max(0, index - 1))
  const selectNext = () => setActiveIndex((index) => Math.min(count - 1, index + 1))
  return (
    <div
      className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border/35 bg-muted/[0.18]"
      data-testid="thinking-block"
      onKeyDown={(event) => {
        if (count <= 1) return
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          selectPrevious()
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          selectNext()
        }
      }}
    >
      <div className="flex min-w-0 items-center px-2 py-1.5 text-meta text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
        >
          <Sparkles className="h-3 w-3 flex-none" />
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="flex-none font-medium">
              {count > 1
                ? t(active ? 'chat.transcript.thinkingUpdatesInProgress' : 'chat.transcript.thinkingUpdates', { count })
                : t(active ? 'chat.transcript.thinkingInProgress' : 'chat.transcript.thinking')}
            </span>
            {title ? (
              <span className="hidden min-w-0 truncate text-foreground/80 sm:block" data-testid="thinking-title">
                <span className="mr-1.5 text-muted-foreground/70" aria-hidden="true">·</span>
                {title}
              </span>
            ) : null}
          </span>
        </button>
        {count > 1 ? (
          <div className="ml-1 flex flex-none items-center gap-0.5" data-testid="thinking-navigation">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-35"
              onClick={selectPrevious}
              disabled={activeIndex === 0}
              aria-label={t('chat.transcript.previousThinking')}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-9 text-center tabular-nums" aria-live="polite">
              {activeIndex + 1} / {count}
            </span>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-35"
              onClick={selectNext}
              disabled={activeIndex >= count - 1}
              aria-label={t('chat.transcript.nextThinking')}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="ml-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-md hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? t('chat.transcript.collapseThinking') : t('chat.transcript.expandThinking')}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      </div>
      {open ? (
        <div
          className="ak-expand-in border-t border-border/25 px-3 py-2 text-muted-foreground"
          onTouchStart={(event) => {
            const touch = event.changedTouches[0]
            if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY }
          }}
          onTouchEnd={(event) => {
            const start = touchStartRef.current
            const touch = event.changedTouches[0]
            touchStartRef.current = null
            if (!start || !touch) return
            const deltaX = touch.clientX - start.x
            const deltaY = touch.clientY - start.y
            if (Math.abs(deltaX) < 40 || Math.abs(deltaX) <= Math.abs(deltaY)) return
            if (deltaX > 0) selectPrevious()
            else selectNext()
          }}
        >
          {selectedUpdate ? (
            <div
              data-testid="thinking-update"
            >
              <AssistantMarkdown text={selectedPresentation?.body ?? normalizeThinkingDisplayText(selectedUpdate.text)} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function thinkingPresentation(text: string): { title?: string; body: string } {
  const trimmed = text.trim()
  const [firstLine = '', ...remainingLines] = trimmed.split('\n')
  const body = remainingLines.join('\n').trim()
  if (!body) return { body: text }

  const markdownHeading = firstLine.match(/^#{1,6}\s+(.+?)\s*#*$/)
  const boldHeading = firstLine.match(/^\*\*(.+?)\*\*\s*:?\s*$/)
  const plainHeading = remainingLines[0]?.trim() === ''
    && firstLine.length <= 96
    && !/[.!?。！？]$/.test(firstLine)
      ? firstLine.replace(/:\s*$/, '')
      : undefined
  const title = (markdownHeading?.[1] ?? boldHeading?.[1] ?? plainHeading)?.trim()
  return title ? { title, body } : { body: text }
}

export function isLocalMarkdownImageSource(value: string): boolean {
  return !/^(?:https?:|data:|blob:|artifact:)/i.test(value) && !value.startsWith('#')
}

function localImageFileName(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.split('/').at(-1) || 'image'
}

export const AssistantMarkdown = memo(function AssistantMarkdown({ text, streaming = false, trailingAction }: { text: string; streaming?: boolean; trailingAction?: React.ReactNode }): JSX.Element {
  const [smoothFade] = useBooleanPref(PREF_SMOOTH_STREAMING_TEXT, true)
  // Markdown constructs can span blank lines (continued lists, reference links,
  // and fences), so semantic content must always be parsed as one document.
  return <MarkdownBlock text={text} streaming={streaming} smoothFade={smoothFade} trailingAction={trailingAction} />
})

// Memoization avoids reparsing unchanged completed messages. Streaming Markdown
// intentionally reparses the whole document for cross-block semantic correctness.
const MarkdownBlock = memo(function MarkdownBlock({ text, streaming, smoothFade, trailingAction }: { text: string; streaming: boolean; smoothFade: boolean; trailingAction?: React.ReactNode }): JSX.Element {
  if (streaming && smoothFade && canFadeRevealTail(text)) return <RevealTail text={text} />
  return <MarkdownBody text={text} streaming={streaming} trailingAction={trailingAction} />
})

const MarkdownBody = memo(function MarkdownBody({ text, streaming = false, trailingAction }: { text: string; streaming?: boolean; trailingAction?: React.ReactNode }): JSX.Element {
  const onOpenWorkspaceFile = useContext(WorkspaceFileLinkContext)
  const artifactSessionId = useContext(ArtifactSessionContext)
  const markdownText = normalizeMarkdownEmphasisAdjacency(text)
  const cursorTarget = streaming ? findStreamingCursorTarget(markdownText) : null
  const cursorEndOffset = markdownText.trimEnd().length
  const cursor = <RevealCursor />
  // The streaming cursor is placed at the active leaf. Per-character fade is NOT
  // done here: spans nested inside ReactMarkdown remount on every token (the AST
  // is re-parsed), which restarts their CSS animation every frame — so the fade
  // was invisible and already-shown text flashed. The fade now lives in
  // <RevealTail>, a persistent sibling that ReactMarkdown never re-parses.
  const placeTextCursor = (children: React.ReactNode): React.ReactNode =>
    appendCursor(children, cursor)
  return (
    <div
      className={cn(
        'ak-markdown-body ak-chat-text min-w-0 max-w-full break-words text-foreground [overflow-wrap:anywhere]',
        streaming && 'ak-streaming-markdown',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_img]:h-auto [&_img]:max-h-64 [&_img]:max-w-full [&_img]:rounded-lg sm:[&_img]:max-w-xs',
        '[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:bg-transparent [&_pre]:p-0',
        '[&_pre_code]:block [&_pre_code]:min-w-max [&_pre_code]:bg-transparent [&_pre_code]:p-3 [&_pre_code]:text-foreground',
      )}
    >
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [remarkMath, { singleDollarTextMath: false }],
          remarkStripEmphasisAdjacencyMarker,
        ]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={(url, key) => key === 'src' && url.startsWith('artifact://') ? url : defaultUrlTransform(url)}
        components={{
          table({ children }) {
            return <MarkdownTable label="Message table">{children}</MarkdownTable>
          },
          img({ src, alt }) {
            const artifact = typeof src === 'string' ? parseArtifactMarkdownSource(src) : null
            if (artifact && artifactSessionId) {
              const resolved = `/session-artifacts/${encodeURIComponent(artifact.artifactId)}?sessionId=${encodeURIComponent(artifactSessionId)}`
              return <ArtifactMarkdownImage src={resolved} alt={alt ?? 'artifact image'} mediaType={artifact.mediaType} />
            }
            if (typeof src === 'string' && isLocalMarkdownImageSource(src)) {
              return <span className="inline-flex rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-muted-foreground" data-testid="local-image-unavailable">Image unavailable: {alt || localImageFileName(src)}</span>
            }
            return <img src={src} alt={alt ?? ''} />
          },
          pre({ children, node: _node }) {
            const trailingSlot = shouldPlaceStreamingCursor(cursorTarget, 'code', _node, cursorEndOffset) ? cursor : undefined
            return <MarkdownPre trailingSlot={trailingSlot}>{children}</MarkdownPre>
          },
          code({ inline, className, children, node: _node, ...rest }: {
            inline?: boolean
            className?: string
            children?: React.ReactNode
            node?: MarkdownNodeWithPosition
          }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'code', _node, cursorEndOffset) ? appendCursor(children, cursor) : children
            return (
              <code className={className} {...rest}>
                {withCursor}
              </code>
            )
          },
          p({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'p', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <p {...rest}>{withCursor}{trailingAction ? <>{' '}{trailingAction}</> : null}</p>
          },
          li({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'li', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <li {...rest}>{withCursor}</li>
          },
          h1({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h1', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h1 {...rest}>{withCursor}</h1>
          },
          h2({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h2', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h2 {...rest}>{withCursor}</h2>
          },
          h3({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h3', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h3 {...rest}>{withCursor}</h3>
          },
          h4({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h4', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h4 {...rest}>{withCursor}</h4>
          },
          td({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'td', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <td {...rest}>{withCursor}</td>
          },
          th({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'th', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <th scope="col" {...rest}>{withCursor}</th>
          },
          a({ href, children, ...rest }) {
            const fileTarget = href ? workspaceFileTargetFromHref(href) : null
            if (!fileTarget || !onOpenWorkspaceFile) {
              return <a href={href} {...rest}>{children}</a>
            }
            const label = reactNodeText(children).trim() || fileTarget.path
            const Icon = workspaceFileIcon(fileTarget.path)
            const title = fileTarget.line !== undefined
              ? `View file: ${fileTarget.path}:${fileTarget.line}${fileTarget.column !== undefined ? `:${fileTarget.column}` : ''}`
              : `View file: ${fileTarget.path}`
            return (
              <a
                href={href}
                {...rest}
                className="not-prose inline-flex max-w-full items-center gap-1 rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 align-baseline font-mono text-[0.85em] leading-snug text-foreground no-underline shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
                aria-label={title}
                data-testid="workspace-file-link"
                onClick={(event) => {
                  event.preventDefault()
                  onOpenWorkspaceFile(fileTarget)
                }}
              >
                <Icon className="h-3 w-3 flex-none text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 truncate">{label}</span>
              </a>
            )
          },
        }}
      >
        {markdownText}
      </ReactMarkdown>
    </div>
  )
})

function parseArtifactMarkdownSource(src: string): { artifactId: string; mediaType?: string } | null {
  const match = src.match(/^artifact:\/\/([^/?#]+)(?:\?([^#]*))?$/)
  if (!match) return null
  const mediaType = new URLSearchParams(match[2] ?? '').get('mediaType') ?? undefined
  return { artifactId: match[1]!, ...(mediaType ? { mediaType } : {}) }
}

function ArtifactMarkdownImage({ src, alt, mediaType }: { src: string; alt: string; mediaType?: string }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [svgApproved, setSvgApproved] = useState(false)
  const isSvg = mediaType === 'image/svg+xml'
  const displaySrc = isSvg && svgApproved ? `${src}&allowSvg=1` : src
  if (failed) return <span className="text-sm text-destructive" role="alert">Image unavailable: {alt}</span>
  if (isSvg && !svgApproved) {
    return (
      <span className="my-2 flex max-w-sm items-center gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-left" data-testid="svg-image-warning">
        <AlertTriangle className="h-5 w-5 flex-none text-amber-500" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{t('chatCommon.svgImage')}</span>
          <span className="block text-xs text-muted-foreground">{t('chatCommon.svgPreviewWarning')}</span>
        </span>
        <Button type="button" variant="outline" size="sm" className="flex-none" onClick={() => setSvgApproved(true)}>{t('chatCommon.previewSvg')}</Button>
      </span>
    )
  }
  return (
    <>
      <button type="button" className="block max-w-full cursor-zoom-in" onClick={() => setOpen(true)} aria-label={`Open image preview: ${alt}`} data-testid="artifact-markdown-image">
        <img src={displaySrc} alt={alt} onError={() => setFailed(true)} loading="lazy" />
      </button>
      <ReadonlyImagePreviewDialog
        open={open}
        onOpenChange={setOpen}
        src={displaySrc}
        alt={alt}
        title={alt}
        dialogTestId="artifact-image-preview-dialog"
        closeTestId="artifact-image-preview-close"
        imageTestId="artifact-image-preview-full"
      />
    </>
  )
}

type StreamingCursorTarget = 'p' | 'li' | 'code' | 'h1' | 'h2' | 'h3' | 'h4' | 'td' | 'th'

function appendCursor(children: React.ReactNode, cursor: JSX.Element): React.ReactNode {
  return <>{children}{cursor}</>
}

type MarkdownNodeWithPosition = {
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

function shouldPlaceStreamingCursor(
  target: StreamingCursorTarget | null,
  tag: StreamingCursorTarget,
  node: MarkdownNodeWithPosition | undefined,
  cursorEndOffset: number,
): boolean {
  if (target !== tag) return false
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number') return false
  return start <= cursorEndOffset && cursorEndOffset <= end
}

function findStreamingCursorTarget(text: string): StreamingCursorTarget {
  const trimmed = text.trimEnd()
  const lastLine = trimmed.split('\n').at(-1)?.trimEnd() ?? ''
  const tableLine = findLastMeaningfulLine(trimmed)

  if (isInsideTrailingFence(trimmed)) return 'code'
  if (/^####\s+\S/.test(lastLine)) return 'h4'
  if (/^###\s+\S/.test(lastLine)) return 'h3'
  if (/^##\s+\S/.test(lastLine)) return 'h2'
  if (/^#\s+\S/.test(lastLine)) return 'h1'
  if (/^(?:[-+*]|\d+[.)])\s+\S/.test(lastLine)) return 'li'
  if (/^\|.*\|\s*$/.test(tableLine) && !/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableLine)) {
    return 'td'
  }
  return 'p'
}

function findLastMeaningfulLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trimEnd() ?? ''
    if (line.trim().length > 0) return line
  }
  return ''
}

function isInsideTrailingFence(text: string): boolean {
  const fenceCount = text
    .split('\n')
    .filter((line) => /^\s*```/.test(line) || /^\s*~~~/.test(line))
    .length
  return fenceCount % 2 === 1
}

function workspaceFileTargetFromHref(href: string): WorkspaceFileTarget | null {
  const trimmed = safeDecodeUri(href).trim()
  if (trimmed.length === 0) return null
  if (/^(?:https?|mailto|data|blob|tel):/i.test(trimmed) || trimmed.startsWith('#')) return null
  const fileHref = /^file:\/\//i.test(trimmed) ? trimmed.replace(/^file:\/\//i, '') : trimmed
  const parsed = splitFileTarget(fileHref)
  if (!parsed.path) return null
  if (parsed.path.startsWith('/') || parsed.path.startsWith('./') || parsed.path.startsWith('../')) return parsed
  if (!parsed.path.includes('/')) return null
  if (/\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(parsed.path)) return parsed
  return null
}

function splitFileTarget(value: string): WorkspaceFileTarget {
  const match = value.match(/^(.*?)(?::(\d+))(?::(\d+))?$/)
  if (!match) return { path: value }
  const path = match[1] ?? value
  if (!/\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(path)) return { path: value }
  const line = Number(match[2])
  const column = match[3] !== undefined ? Number(match[3]) : undefined
  return {
    path,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    ...(column !== undefined && Number.isInteger(column) && column > 0 ? { column } : {}),
  }
}

function workspaceFileIcon(path: string): typeof FileText {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return Image
  if (ext && ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'html', 'py', 'rs', 'go', 'java', 'sh', 'bash'].includes(ext)) return Code2
  return FileText
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function MarkdownPre({ children, trailingSlot }: { children?: React.ReactNode; trailingSlot?: React.ReactNode }): JSX.Element {
  const code = Children.toArray(children).find((child) => isValidElement(child))
  if (code && isValidElement<{ className?: string; children?: React.ReactNode }>(code)) {
    const className = code.props.className
    const match = /language-(\w+)/.exec(className ?? '')
    const raw = reactNodeText(code.props.children).replace(/\n$/, '')
    const lang = match?.[1]?.toLowerCase()
    if (lang === 'mermaid') return <MermaidBlock code={raw} deferRender={Boolean(trailingSlot)} />
    return <CodeBlock code={raw} lang={lang} trailingSlot={trailingSlot} deferEnhancement={Boolean(trailingSlot)} />
  }
  return <CodeBlock code={reactNodeText(children).replace(/\n$/, '')} trailingSlot={trailingSlot} deferEnhancement={Boolean(trailingSlot)} />
}

function reactNodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(node)) return reactNodeText(node.props.children)
  return ''
}

function ToolCallBlock({
  call,
  approval,
  onApprovalDecision,
}: {
  call: ToolCallContent
  approval: ApprovalRequiredEvent | null
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
}): JSX.Element {
  const { t } = useTranslation()
  const isPendingApproval = approval !== null && typeof onApprovalDecision === 'function'
  const hasDiffPreview = isPendingApproval && hasDiffPreviewForTool(call.name)
  const [open, setOpen] = useState(false)
  return (
    <div
      className={cn(
        'min-w-0 max-w-full overflow-hidden rounded-lg transition-colors',
        isPendingApproval
          ? 'bg-amber-50/60 ring-1 ring-amber-400/60 dark:bg-amber-950/20 dark:ring-amber-500/40'
          : 'bg-muted/40',
      )}
      data-testid={
        isPendingApproval ? `tool-call-pending-${call.callId}` : undefined
      }
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'group/tool flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground transition-colors',
          isPendingApproval
            ? 'hover:bg-amber-100/40 dark:hover:bg-amber-950/30'
            : 'hover:bg-muted',
        )}
        data-testid={`tool-call-toggle-${call.callId}`}
      >
        <Wrench
          className={cn(
            'h-4 w-4 flex-none',
            isPendingApproval
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground',
          )}
        />
        <span
          className={cn(
            'font-medium',
            isPendingApproval
              ? 'text-amber-800 dark:text-amber-200'
              : 'text-muted-foreground',
          )}
        >
          {isPendingApproval ? t('chat.transcript.approvalNeeded') : t('chat.transcript.assistantRequestedTool')}
        </span>
        <span className="min-w-0 max-w-[45%] truncate rounded bg-background/80 px-1.5 py-0.5 font-mono text-meta">
          {call.name}
        </span>
        <span className="flex-1" />
        <span className="hidden max-w-[35%] truncate font-mono text-meta text-muted-foreground sm:inline">
          {call.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="ak-expand-in flex min-w-0 flex-col gap-2 px-3 pb-2">
          {isPendingApproval && hasDiffPreview ? (
            <DiffPreview toolName={call.name} input={approval.input} />
          ) : (
            <div className="overflow-hidden rounded-md bg-background/60">
              <ScrollArea className="max-h-[min(24rem,50vh)]" viewportClassName="max-h-[min(24rem,50vh)]">
                <pre className="ak-tool-detail-code min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-muted-foreground [overflow-wrap:anywhere]">
                  {JSON.stringify(call.input, null, 2)}
                </pre>
              </ScrollArea>
            </div>
          )}
          {isPendingApproval ? (
            <p className="pt-1 text-meta italic text-amber-700 dark:text-amber-300">
              {t('chat.transcript.approveRejectBelow')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ToolResultBlock({
  result,
  toolName,
  defaultOpen = false,
}: {
  result: ToolResultContent
  toolName?: string
  defaultOpen?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const overflowReader = useContext(OverflowReaderContext)
  const isOverflowed = detectOverflowMarker(result.content)
  const [fullOutput, setFullOutput] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'loaded'; content: string } | { state: 'error'; error: string }
  >({ state: 'idle' })
  const Icon = result.ok ? CheckCircle2 : XCircle
  const statusTone = result.ok
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400'
  const statusBadge = result.ok
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'

  const handleViewFull = async (): Promise<void> => {
    if (!overflowReader || fullOutput.state === 'loading') return
    setFullOutput({ state: 'loading' })
    const res = await overflowReader(result.callId)
    if (res.error) setFullOutput({ state: 'error', error: res.error })
    else setFullOutput({ state: 'loaded', content: res.content ?? '' })
  }

  const displayContent =
    fullOutput.state === 'loaded' ? fullOutput.content : result.content
  const displayOutput = parseToolResultDisplay(displayContent)

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/tool flex w-full min-w-0 items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
        data-testid={`tool-result-toggle-${result.callId}`}
      >
        <Icon className={cn('h-3.5 w-3.5 flex-none', statusTone)} />
        <span className="font-medium text-muted-foreground">{t('chat.transcript.toolResult')}</span>
        {toolName ? (
          <span className="min-w-0 max-w-[45%] truncate rounded bg-background/80 px-1.5 py-0.5 font-mono text-meta">
            {toolName}
          </span>
        ) : null}
        <span
          className={cn(
            'flex-none rounded px-1.5 py-0.5 text-[0.75rem] font-medium uppercase tracking-wider',
            statusBadge,
          )}
        >
          {result.ok ? t('chat.transcript.succeeded') : t('chat.transcript.failed')}
        </span>
        {isOverflowed ? (
          <span className="flex-none rounded bg-amber-50 px-1.5 py-0.5 text-[0.75rem] font-medium uppercase tracking-wider text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {t('chat.transcript.truncated')}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="hidden max-w-[35%] truncate font-mono text-meta text-muted-foreground sm:inline">
          {result.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="ak-expand-in mt-2 overflow-hidden rounded-lg bg-muted/60">
          {isOverflowed && fullOutput.state !== 'loaded' && overflowReader ? (
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-meta">
              <span className="text-muted-foreground">
                Output truncated inline; full text lives on the executor's disk.
              </span>
              <button
                type="button"
                onClick={() => {
                  void handleViewFull()
                }}
                disabled={fullOutput.state === 'loading'}
                className="rounded bg-primary/10 px-2 py-0.5 font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
              >
                {fullOutput.state === 'loading' ? 'Loading…' : 'View full output'}
              </button>
            </div>
          ) : null}
          {fullOutput.state === 'error' ? (
            <div className="border-b border-border/40 bg-rose-50/60 px-3 py-1.5 text-meta text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              Failed to read full output: {fullOutput.error}
            </div>
          ) : null}
          <ToolResultContentView
            content={displayOutput.content}
            rawClassName="px-3 py-2"
          />
          {displayOutput.metadata ? (
            <ToolResultMetadataFields metadata={displayOutput.metadata} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

type ToolResultDisplayMetadata = {
  exitCode: string
  duration: string
}

type ToolResultDisplay = {
  content: string
  metadata: ToolResultDisplayMetadata | null
}

const TOOL_RESULT_METADATA_RE = /(?:^|\n)--- exit code: ([^,\n]+), duration: ([^\n]+)\s*$/

function parseToolResultDisplay(content: string): ToolResultDisplay {
  const match = TOOL_RESULT_METADATA_RE.exec(content)
  if (!match) return { content, metadata: null }
  return {
    content: content.slice(0, match.index).replace(/\n$/, ''),
    metadata: { exitCode: match[1]!.trim(), duration: match[2]!.trim() },
  }
}

function parseToolError(content: string): { code?: string; message: string } | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  const withoutPrefix = trimmed.replace(/^ERROR:\s*/i, '')
  const parts = withoutPrefix.split(':').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const first = parts[0]
  const second = parts[1]
  const code = first && /^[A-Z][A-Z0-9_]+$/.test(first) ? first : undefined
  if (!code) return { message: withoutPrefix }
  const messageParts = second === code ? parts.slice(2) : parts.slice(1)
  const message = messageParts.join(': ') || withoutPrefix.replace(new RegExp(`^${code}:\\s*`), '')
  return { code, message: message || withoutPrefix }
}

type StructuredToolResultFile = {
  path?: string
  operation?: string
  additions?: number
  deletions?: number
  diff?: string
  bytes_before?: number
  bytes_after?: number
  replacements?: Array<{ index?: number; count?: number }>
}

type StructuredToolResult = {
  ok?: boolean
  summary?: string
  files?: StructuredToolResultFile[]
}

function parseStructuredToolResult(content: string): StructuredToolResult | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const files = Array.isArray(record.files)
      ? record.files.map(normalizeStructuredToolResultFile).filter((file): file is StructuredToolResultFile => file !== null)
      : []
    const hasRenderableFields =
      typeof record.summary === 'string' ||
      files.length > 0
    if (!hasRenderableFields) return null
    return {
      ...(typeof record.ok === 'boolean' ? { ok: record.ok } : {}),
      ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
      ...(files.length > 0 ? { files } : {}),
    }
  } catch {
    return null
  }
}

function normalizeStructuredToolResultFile(value: unknown): StructuredToolResultFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const replacements = Array.isArray(record.replacements)
    ? record.replacements.map(normalizeReplacement).filter((item): item is { index?: number; count?: number } => item !== null)
    : undefined
  const file: StructuredToolResultFile = {
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    ...(typeof record.operation === 'string' ? { operation: record.operation } : {}),
    ...(isFiniteNumber(record.additions) ? { additions: record.additions } : {}),
    ...(isFiniteNumber(record.deletions) ? { deletions: record.deletions } : {}),
    ...(typeof record.diff === 'string' ? { diff: record.diff } : {}),
    ...(isFiniteNumber(record.bytes_before) ? { bytes_before: record.bytes_before } : {}),
    ...(isFiniteNumber(record.bytes_after) ? { bytes_after: record.bytes_after } : {}),
    ...(replacements && replacements.length > 0 ? { replacements } : {}),
  }
  return Object.keys(file).length > 0 ? file : null
}

function normalizeReplacement(value: unknown): { index?: number; count?: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const replacement = {
    ...(isFiniteNumber(record.index) ? { index: record.index } : {}),
    ...(isFiniteNumber(record.count) ? { count: record.count } : {}),
  }
  return Object.keys(replacement).length > 0 ? replacement : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function ToolResultContentView({
  content,
  fallback,
  rawClassName,
}: {
  content: string
  fallback?: string
  rawClassName?: string
}): JSX.Element {
  const { t } = useTranslation()
  const [raw, setRaw] = useState(false)
  const structuredResult = parseStructuredToolResult(content)
  if (!structuredResult) {
    return (
      <ScrollArea className="max-h-[min(24rem,50vh)]" viewportClassName="max-h-[min(24rem,50vh)]">
        <pre className={cn('ak-tool-detail-code min-w-0 whitespace-pre-wrap break-words font-mono text-foreground [overflow-wrap:anywhere]', rawClassName ?? 'px-2.5 py-2')}>
          {fallback || content || t('chatCommon.noOutput')}
        </pre>
      </ScrollArea>
    )
  }
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 border-b border-border/30 px-2.5 py-1.5 text-meta">
        <span className="text-muted-foreground">{t('chatCommon.result')}</span>
        <button
          type="button"
          onClick={() => setRaw((value) => !value)}
          className="rounded bg-muted px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
        >
          {t(raw ? 'chatCommon.renderedResult' : 'chatCommon.rawResult')}
        </button>
      </div>
      {raw ? (
        <ScrollArea className="max-h-[min(24rem,50vh)]" viewportClassName="max-h-[min(24rem,50vh)]">
          <pre className={cn('ak-tool-detail-code min-w-0 whitespace-pre-wrap break-words font-mono text-foreground [overflow-wrap:anywhere]', rawClassName ?? 'px-2.5 py-2')}>
            {content || t('chatCommon.noOutput')}
          </pre>
        </ScrollArea>
      ) : (
        <StructuredToolResultView result={structuredResult} />
      )}
    </div>
  )
}

function StructuredToolResultView({ result }: { result: StructuredToolResult }): JSX.Element {
  const files = result.files ?? []
  return (
    <div className="space-y-2 px-2.5 py-2 text-meta">
      {result.summary ? <div className="leading-relaxed text-foreground">{result.summary}</div> : null}
      {files.length > 0 ? (
        <div className="space-y-2">
          {files.map((file, index) => (
            <StructuredToolResultFileView key={`${file.path ?? 'file'}-${index}`} file={file} />
          ))}
        </div>
      ) : null}
      {!result.summary && files.length === 0 ? <div className="text-muted-foreground">(no output)</div> : null}
    </div>
  )
}

function StructuredToolResultFileView({ file }: { file: StructuredToolResultFile }): JSX.Element {
  const metric = typeof file.additions === 'number' || typeof file.deletions === 'number'
    ? { kind: 'delta' as const, additions: file.additions ?? 0, deletions: file.deletions ?? 0 }
    : null
  const replacementCount = file.replacements?.reduce((sum, item) => sum + (item.count ?? 0), 0)
  return (
    <div className="overflow-hidden rounded border border-border/40 bg-background/50">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/30 px-2 py-1.5">
        {file.operation ? <ToolTextBadge tone={operationTone(file.operation)}>{file.operation}</ToolTextBadge> : null}
        {metric ? <ToolDeltaBadges metric={metric} /> : null}
        {typeof replacementCount === 'number' && replacementCount > 0 ? <ToolTextBadge>{replacementCount} replacement{replacementCount === 1 ? '' : 's'}</ToolTextBadge> : null}
        {typeof file.bytes_before === 'number' && typeof file.bytes_after === 'number' ? (
          <ToolTextBadge>{formatBytes(file.bytes_before)} to {formatBytes(file.bytes_after)}</ToolTextBadge>
        ) : null}
        <span className="min-w-[8rem] flex-1 truncate font-mono text-foreground" title={file.path}>{file.path ?? '(no path)'}</span>
      </div>
      {file.diff ? <ToolResultDiffView diff={file.diff} /> : null}
    </div>
  )
}

function operationTone(operation: string): 'neutral' | 'success' | 'danger' | 'warning' | 'primary' {
  if (operation === 'created' || operation === 'added') return 'success'
  if (operation === 'deleted' || operation === 'removed') return 'danger'
  if (operation === 'modified' || operation === 'updated') return 'warning'
  return 'neutral'
}

function ToolResultDiffView({ diff }: { diff: string }): JSX.Element {
  const lines = diff.split('\n')
  return (
    <ScrollArea className="max-h-96 max-w-full">
      <pre className="ak-tool-detail-code min-w-max whitespace-pre py-1 pr-2 font-mono">
        {lines.map((line, index) => (
          <span key={index} className={cn('block px-2', resultDiffLineClass(line))}>{line || ' '}</span>
        ))}
      </pre>
    </ScrollArea>
  )
}

function resultDiffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
  if (line.startsWith('@@')) return 'bg-muted text-muted-foreground'
  if (line.startsWith('---') || line.startsWith('+++')) return 'bg-muted/50 text-muted-foreground'
  return 'text-foreground dark:text-muted-foreground'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function ToolResultMetadataFields({
  metadata,
  compact = false,
}: {
  metadata: ToolResultDisplayMetadata
  compact?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground',
        compact ? '' : 'border-t border-border/40 px-3 py-1.5',
      )}
    >
      <span className="inline-flex h-5 items-center gap-1 rounded bg-background/70 px-1.5 leading-none">
        <span className="uppercase tracking-wider text-muted-foreground/70">exit</span>
        <span className="font-mono text-foreground">{metadata.exitCode}</span>
      </span>
      <span className="inline-flex h-5 items-center gap-1 rounded bg-background/70 px-1.5 leading-none">
        <span className="uppercase tracking-wider text-muted-foreground/70">duration</span>
        <span className="font-mono text-foreground">{metadata.duration}</span>
      </span>
    </div>
  )
}

function ToolTextBadge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'primary'
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-6 flex-none items-center rounded px-2 text-meta font-medium uppercase leading-none tracking-wider',
        tone === 'success' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
        tone === 'danger' && 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
        tone === 'warning' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
        tone === 'primary' && 'bg-primary text-primary-foreground',
        tone === 'neutral' && 'bg-background/80 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

function ToolDeltaBadges({ metric }: { metric: SummaryDelta | null }): JSX.Element | null {
  if (!metric) return null
  return (
    <span className="inline-flex h-5 flex-none items-center overflow-hidden rounded border border-border/50 bg-background/70 text-meta leading-none shadow-sm" aria-label={`${metric.additions} additions, ${metric.deletions} deletions`}>
      <span className="inline-flex h-5 items-center gap-1 border-r border-border/50 px-1.5 font-mono font-semibold text-emerald-700 dark:text-emerald-300">
        <span className="text-[0.75rem] text-emerald-600/80 dark:text-emerald-300/80">+</span>
        {metric.additions}
      </span>
      <span className="inline-flex h-5 items-center gap-1 px-1.5 font-mono font-semibold text-rose-700 dark:text-rose-300">
        <span className="text-[0.75rem] text-rose-600/80 dark:text-rose-300/80">-</span>
        {metric.deletions}
      </span>
    </span>
  )
}

function toolDisplayName(name: string): string {
  if (name === 'bash') return 'Shell'
  if (name === 'bash_output') return 'Shell output'
  if (name === 'kill_shell') return 'Stop shell'
  return name
}

function ToolNameChip({ name }: { name: string }): JSX.Element {
  const displayName = toolDisplayName(name)
  return (
    <span className="inline-flex h-6 min-w-0 max-w-full items-center rounded bg-background/85 px-2 font-mono text-[0.9375rem] leading-none text-foreground ring-1 ring-border/50" title={displayName} data-tool-name={name} data-testid="tool-name-chip">
      <span className="truncate">{displayName}</span>
    </span>
  )
}

function ToolCallInlineDetail({
  call,
  approval,
  onApprovalDecision,
  compactNarrative = false,
}: {
  call: ToolCallContent
  approval: ApprovalRequiredEvent | null
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  compactNarrative?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const isPendingApproval = approval !== null && typeof onApprovalDecision === 'function'
  const hasDiffPreview = isPendingApproval && hasDiffPreviewForTool(call.name)
  const summary = summarizeToolCallInput(call)
  const headingId = `tool-call-heading-${call.callId}`
  const intentId = `tool-call-intent-heading-${call.callId}`
  return (
    <section
      className="min-w-0 overflow-hidden rounded-md border border-border/50 bg-background/55"
      aria-labelledby={headingId}
      data-testid={isPendingApproval ? `tool-call-pending-${call.callId}` : `tool-call-detail-${call.callId}`}
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border/40 px-2 py-2 sm:px-2.5">
        <h4 id={headingId} className="flex min-w-0 items-center gap-2">
          <span className="flex-none text-caption font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('chatCommon.tool')}</span>
          <ToolNameChip name={call.name} />
        </h4>
        {isPendingApproval ? (
          <ToolTextBadge tone="warning">{t('chatCommon.approvalNeeded')}</ToolTextBadge>
        ) : null}
      </header>
      {call.intent ? (
        <div className="border-b border-border/40 bg-primary/[0.035] px-2 py-2.5 sm:px-2.5" aria-labelledby={intentId}>
          <h5 id={intentId} className="mb-1 text-caption font-semibold uppercase tracking-[0.12em] text-primary/80">
            {t('chatCommon.intention')}
          </h5>
          <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-foreground [overflow-wrap:anywhere]" data-testid={`tool-call-detail-intent-${call.callId}`}>
            {call.intent}
          </p>
        </div>
      ) : null}
      <details open className="border-b border-border/40 text-meta" data-testid={`tool-call-technical-details-${call.callId}`}>
        <summary className="cursor-pointer select-none px-2 py-2 font-semibold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground sm:px-2.5">{t('chatCommon.inputs')}</summary>
        <div className="min-w-0 border-t border-border/30 bg-muted/15">
          {summary ? <div className="flex min-w-0 flex-wrap gap-1.5 px-2 py-2 sm:px-2.5"><ToolCallInputFieldBadges fields={summary.fields} /></div> : null}
          {isPendingApproval && hasDiffPreview ? (
            <div className="min-w-0 p-2">
              <DiffPreview toolName={call.name} input={approval.input} />
            </div>
          ) : summary?.rows?.length ? (
            <ToolCallInputSummaryRows rows={summary.rows} />
          ) : (
            <ScrollArea className="max-h-[min(24rem,50vh)] max-w-full" viewportClassName="max-h-[min(24rem,50vh)]">
              <pre className="ak-tool-detail-code min-w-0 max-w-full whitespace-pre-wrap break-words px-2 py-2 font-mono text-muted-foreground [overflow-wrap:anywhere] sm:px-2.5">
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </ScrollArea>
          )}
        </div>
      </details>
      {isPendingApproval ? (
        <p className="border-t border-border/30 px-2 py-1.5 text-meta italic text-amber-700 dark:text-amber-300 sm:px-2.5">
          Approve or reject below.
        </p>
      ) : null}
    </section>
  )
}

type ToolCallInputSummary = {
  fields: Array<{ label: string; value: string }>
  rows?: string[]
}

function summarizeToolCallInput(call: ToolCallContent): ToolCallInputSummary | null {
  const path = inputString(call.input.path ?? call.input.file_path)
  if (call.name === 'replace_many_in_file') {
    const edits = Array.isArray(call.input.edits) ? call.input.edits : []
    return {
      fields: [
        ...(path ? [{ label: 'path', value: path }] : []),
        { label: 'edits', value: String(edits.length) },
      ],
      rows: edits.slice(0, 3).map((edit, index) => {
        const record = edit && typeof edit === 'object' && !Array.isArray(edit) ? edit as Record<string, unknown> : {}
        const oldText = truncate(firstLine(inputString(record.old_string)), 56)
        const newText = truncate(firstLine(inputString(record.new_string)), 56)
        const suffix = record.replace_all === true ? ' · all' : ''
        return `${index + 1}. ${oldText || '(empty)'} -> ${newText || '(empty)'}${suffix}`
      }),
    }
  }
  if (call.name === 'replace_in_file') {
    return {
      fields: [
        ...(path ? [{ label: 'path', value: path }] : []),
        ...(call.input.replace_all === true ? [{ label: 'mode', value: 'replace all' }] : []),
      ],
      rows: [`${truncate(firstLine(inputString(call.input.old_string)), 72) || '(empty)'} -> ${truncate(firstLine(inputString(call.input.new_string)), 72) || '(empty)'}`],
    }
  }
  if (call.name === 'write_file') {
    const content = inputString(call.input.content)
    return {
      fields: [
        ...(path ? [{ label: 'path', value: path }] : []),
        { label: 'lines', value: String(content ? countDisplayLines(content) : 0) },
      ],
    }
  }
  return null
}

function ToolCallInputFieldBadges({ fields }: { fields: ToolCallInputSummary['fields'] }): JSX.Element | null {
  if (fields.length === 0) return null
  return (
    <>
      {fields.map((field) => (
        <span key={field.label} className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded bg-muted/70 px-1.5 leading-none">
          <span className="flex-none uppercase tracking-wider text-muted-foreground/70">{field.label}</span>
          <span className="min-w-0 truncate font-mono text-foreground">{field.value}</span>
        </span>
      ))}
    </>
  )
}

function ToolCallInputSummaryRows({ rows }: { rows: string[] }): JSX.Element {
  return (
    <div className="px-2.5 py-2 text-meta">
      <div className="min-w-0 rounded bg-muted/40 px-2 py-1 font-mono text-meta leading-relaxed text-muted-foreground">
        {rows.map((row) => (
          <div key={row} className="truncate">{row}</div>
        ))}
      </div>
    </div>
  )
}

function inputString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function countDisplayLines(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}

function ToolResultInlineDetail({
  result,
  compactNarrative = false,
}: {
  result: ToolResultContent
  compactNarrative?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const overflowReader = useContext(OverflowReaderContext)
  const isOverflowed = detectOverflowMarker(result.content)
  const [fullOutput, setFullOutput] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'loaded'; content: string } | { state: 'error'; error: string }
  >({ state: 'idle' })
  const displayContent = fullOutput.state === 'loaded' ? fullOutput.content : result.content
  const displayOutput = parseToolResultDisplay(displayContent)
  const parsedError = result.ok ? null : parseToolError(displayOutput.content)

  const handleViewFull = async (): Promise<void> => {
    if (!overflowReader || fullOutput.state === 'loading') return
    setFullOutput({ state: 'loading' })
    const res = await overflowReader(result.callId)
    if (res.error) setFullOutput({ state: 'error', error: res.error })
    else setFullOutput({ state: 'loaded', content: res.content ?? '' })
  }

  const headingId = `tool-result-heading-${result.callId}`
  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border/50 bg-background/55" aria-labelledby={headingId} data-testid={`tool-result-detail-${result.callId}`}>
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-2 py-2 text-meta sm:px-2.5">
        <h4 id={headingId} className="mr-0.5 text-caption font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('chatCommon.result')}</h4>
        {!compactNarrative ? <ToolTextBadge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'succeeded' : 'failed'}</ToolTextBadge> : null}
        {parsedError?.code ? <ToolTextBadge tone="danger">{parsedError.code}</ToolTextBadge> : null}
        {displayOutput.metadata ? <ToolResultMetadataFields metadata={displayOutput.metadata} compact /> : null}
        {isOverflowed ? (
          <ToolTextBadge tone="warning">truncated</ToolTextBadge>
        ) : null}
      </header>
      {isOverflowed && fullOutput.state !== 'loaded' && overflowReader ? (
        <div className="flex items-center justify-between border-b border-border/30 px-2.5 py-1.5 text-meta">
          <span className="text-muted-foreground">Output truncated inline.</span>
          <button
            type="button"
            onClick={() => {
              void handleViewFull()
            }}
            disabled={fullOutput.state === 'loading'}
            className="rounded bg-primary/10 px-2 py-0.5 font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            {fullOutput.state === 'loading' ? 'Loading…' : 'View full output'}
          </button>
        </div>
      ) : null}
      {fullOutput.state === 'error' ? (
        <div className="border-b border-border/30 bg-rose-50/60 px-2.5 py-1.5 text-meta text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          Failed to read full output: {fullOutput.error}
        </div>
      ) : null}
      <ToolResultContentView
        content={displayOutput.content}
        fallback={parsedError?.message}
      />
    </section>
  )
}

function summarizeToolResultInline(content: string): string {
  const parsed = parseToolResultDisplay(content)
  const text = parsed.content.trim()
  if (text) return summarizeStructuredToolResult(text) ?? truncate(firstLine(text), 72)
  if (parsed.metadata) return `exit ${parsed.metadata.exitCode} · ${parsed.metadata.duration}`
  return '(no output)'
}

type ToolHeaderResultSummary =
  | { kind: 'none' }
  | { kind: 'delta'; metric: SummaryDelta }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'error'; code?: string; message: string }

function summarizeToolResultForHeader(
  call: ToolCallContent,
  row: SummaryRow | null,
  result: ToolResultContent,
): ToolHeaderResultSummary {
  if (!result.ok) {
    const parsed = parseToolError(parseToolResultDisplay(result.content).content)
    return parsed
      ? { kind: 'error', ...(parsed.code ? { code: parsed.code } : {}), message: parsed.message }
      : { kind: 'error', message: summarizeToolResultInline(result.content) }
  }

  if (typeof row?.secondary === 'object' && row.secondary.kind === 'delta') return { kind: 'delta', metric: row.secondary }
  if (typeof row?.secondary === 'string' && shouldPreferRowSecondary(call.name, row.secondary)) return { kind: 'text', text: row.secondary }
  const text = summarizeToolResultInline(result.content)
  return text ? { kind: 'text', text, title: result.content } : { kind: 'none' }
}

function shouldPreferRowSecondary(toolName: string, secondary: string): boolean {
  if (secondary === 'ok' || secondary === 'failed') return false
  return toolName === 'read' || toolName === 'read_file' || toolName === 'read_files' || toolName === 'ls' || toolName === 'glob' || toolName === 'grep'
}

function shouldShowCompactHeaderText(toolName: string, text: string): boolean {
  if (!text || text === '(no output)') return false
  return shouldPreferRowSecondary(toolName, text)
}

function ToolHeaderResultSummaryView({
  summary,
  hideDelta = false,
}: {
  summary: ToolHeaderResultSummary
  hideDelta?: boolean
}): JSX.Element | null {
  if (summary.kind === 'none') return null
  if (summary.kind === 'delta' && hideDelta) return null
  if (summary.kind === 'delta') return <ToolDeltaBadges metric={summary.metric} />
  if (summary.kind === 'error') {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {summary.code ? <ToolTextBadge tone="danger">{summary.code}</ToolTextBadge> : null}
        <span className="min-w-0 truncate text-meta leading-5 text-rose-700 dark:text-rose-300" title={summary.message}>
          {summary.message}
        </span>
      </span>
    )
  }
  return (
    <span className="min-w-0 truncate text-meta leading-5 text-muted-foreground" title={summary.title ?? summary.text}>
      {summary.text}
    </span>
  )
}

function summarizeStructuredToolResult(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const summary = typeof record.summary === 'string' ? record.summary : ''
    const files = Array.isArray(record.files) ? record.files : []
    const firstFile = files.find((file): file is Record<string, unknown> => !!file && typeof file === 'object' && !Array.isArray(file))
    const replacements = Array.isArray(firstFile?.replacements)
      ? firstFile.replacements.reduce((sum, item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return sum
          const count = (item as Record<string, unknown>).count
          return sum + (typeof count === 'number' && Number.isFinite(count) ? count : 0)
        }, 0)
      : null
    const pieces: string[] = []
    if (replacements !== null) pieces.push(`${replacements} replacement${replacements === 1 ? '' : 's'}`)
    if (pieces.length > 0) return pieces.join(' · ')
    if (summary) return truncate(summary, 72)
    return null
  } catch {
    return null
  }
}

const OVERFLOW_MARKER_PREFIX = '--- output truncated:'

function detectOverflowMarker(content: string): boolean {
  if (content.length < OVERFLOW_MARKER_PREFIX.length) return false
  const tail = content.slice(Math.max(0, content.length - 512))
  return tail.includes(OVERFLOW_MARKER_PREFIX)
}

function ToolCallGroupBlock({
  group,
  messageIndex,
  timestamp,
  approvalByCallId,
  onApprovalDecision,
  liveToolActivityTailCount = DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  toolExecutionStartedAt,
  toolCardMode = 'dots',
  activeToolCallIds,
  badgeIntentionCallId,
}: {
  group: ToolCallGroup
  messageIndex: number
  timestamp?: string
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  liveToolActivityTailCount?: number
  toolExecutionStartedAt?: number | null
  toolCardMode?: ToolCardMode
  activeToolCallIds: ReadonlySet<string> | null
  badgeIntentionCallId?: string
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null)
  const [hoveredCallId, setHoveredCallId] = useState<string | null>(null)
  const [pinnedCallId, setPinnedCallId] = useState<string | null>(null)
  const [showAllMobileRows, setShowAllMobileRows] = useState(false)
  const isMobile = useIsMobile()
  const rows = summarizeToolActivityRows(group)
  const mobileRows = useMemo(() => {
    if (!isMobile || showAllMobileRows || rows.length <= 8) return rows
    const critical = rows.filter((row) => approvalByCallId.has(row.callId) || isActiveToolCall(row.callId, activeToolCallIds) || group.results.get(row.callId)?.ok === false)
    const recent = rows.slice(-8)
    const visible = new Set([...critical, ...recent].map((row) => row.callId))
    return rows.filter((row) => visible.has(row.callId))
  }, [activeToolCallIds, approvalByCallId, group.results, isMobile, rows, showAllMobileRows])
  const anyPending = group.calls.some((c) => approvalByCallId.has(c.callId))
  const singleCall = group.calls.length === 1 ? group.calls[0]! : null
  const singleRow = singleCall ? rows.find((r) => r.callId === singleCall.callId) : null
  const singleResult = singleCall ? group.results.get(singleCall.callId) ?? null : null
  const singleHeaderResult = singleCall && singleResult
    ? summarizeToolResultForHeader(singleCall, singleRow ?? null, singleResult)
    : { kind: 'none' as const }
  const singlePending = singleCall ? approvalByCallId.get(singleCall.callId) ?? null : null
  const singleStatus = singlePending
    ? toolLifecycleBadge('approval')
    : singleResult
      ? singleResult.ok
        ? toolLifecycleBadge('succeeded')
        : toolLifecycleBadge('failed')
      : singleCall
        ? toolLifecycleBadge(isActiveToolCall(singleCall.callId, activeToolCallIds) ? 'running' : 'orphaned')
        : null
  const groupLifecycle = summarizeToolGroupLifecycle(group, approvalByCallId, activeToolCallIds)
  const toolMix = summarizeToolMix(group.calls)
  const fallbackIntent = [...group.calls].reverse().find((call) => call.intent?.trim())?.intent?.trim() ?? ''
  const primaryTargets = summarizePrimaryTargets(rows, group.mixed ? 2 : 1)
  const groupTitle = group.mixed ? 'Tool activity' : group.toolName
  const liveTailCount = Math.max(0, Math.round(liveToolActivityTailCount))
  const unresolvedTailCallIds = liveTailCount > 0
    ? group.calls
        .slice(-liveTailCount)
        .filter((call) => !group.results.has(call.callId) && !approvalByCallId.has(call.callId) && isActiveToolCall(call.callId, activeToolCallIds))
        .map((call) => call.callId)
    : []
  const autoRevealTail = group.mixed && unresolvedTailCallIds.length > 0
  const visibleTailCallIds = autoRevealTail ? new Set(unresolvedTailCallIds) : null
  const dots = toolActivityDots(group, rows, approvalByCallId, activeToolCallIds)
  const [iconScale] = useNumberPref(PREF_TOOL_ACTIVITY_ICON_SCALE, DEFAULT_TOOL_ACTIVITY_ICON_SCALE, { min: 100, max: 300 })
  const interfaceScale = useInterfaceScale()
  const iconPixels = Math.round(18 * iconScale / 100 * interfaceScale)
  const nodePixels = iconPixels + Math.round(12 * interfaceScale)
  const [dotBoundary, setDotBoundary] = useState<HTMLDivElement | null>(null)
  const groupRootRef = useRef<HTMLDivElement | null>(null)
  const [dotBoundaryWidth, setDotBoundaryWidth] = useState(0)
  useEffect(() => {
    if (!dotBoundary) return
    const update = (): void => setDotBoundaryWidth(dotBoundary.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(dotBoundary)
    return () => observer.disconnect()
  }, [dotBoundary])
  const railBudget = toolDotRailBudget(dotBoundaryWidth)
  const gapWidth = Math.round(10 * interfaceScale)
  const omissionWidth = Math.round(48 * interfaceScale)
  const dotGroups = groupConsecutiveToolDots(dots)
  const widestDotGroup = Math.max(nodePixels, ...dotGroups.map((dotGroup) => toolDotNodeWidth(nodePixels, dotGroup.dots.length)))
  const limitWithoutOmission = railBudget > 0 ? Math.max(2, Math.floor((railBudget + gapWidth) / (widestDotGroup + gapWidth))) : 8
  const visibleDotLimit = dotGroups.length > limitWithoutOmission
    ? Math.max(2, Math.floor((railBudget - omissionWidth + gapWidth) / (widestDotGroup + gapWidth)))
    : limitWithoutOmission
  const preferredDotIds = [pinnedCallId, ...dots.filter((dot) => dot.status === 'running').map((dot) => dot.callId)].filter((id): id is string => Boolean(id))
  const preferredGroupIds = preferredDotIds.flatMap((callId) => {
    const dotGroup = dotGroups.find((candidate) => candidate.dots.some((dot) => dot.callId === callId))
    return dotGroup ? [dotGroup.callId] : []
  })
  const visibleDotGroups = visibleToolDots(dotGroups, visibleDotLimit, preferredGroupIds)
  const visibleDotCallCount = visibleDotGroups.reduce((total, dotGroup) => total + dotGroup.dots.length, 0)
  const omittedDotCount = Math.max(0, dots.length - visibleDotCallCount)
  const collapsedDots = toolCardMode === 'dots' && !open
  const showRows = open || anyPending || (!collapsedDots && autoRevealTail)

  // Live running state for this group: any dispatched call without a result and
  // not waiting on approval. When running, this card itself carries the dynamic
  // affordances that used to live in a second, redundant inline status card
  // (spinning wrench, elapsed timer, pulsing badge, breathing beam).
  const isRunning = dots.some((dot) => dot.status === 'running')
  const runningElapsed = useElapsedSeconds(isRunning, toolExecutionStartedAt)
  // A running call keeps its animated dot, but must not open the hover preview
  // until the user explicitly hovers, focuses, or pins that dot. Auto-opening
  // the fixed layer obscures transcript content while long-running tools execute.
  const previewCallId = pinnedCallId ?? hoveredCallId
  const previewCall = previewCallId
    ? group.calls.find((call) => call.callId === previewCallId) ?? null
    : null
  const previewRow = previewCallId
    ? rows.find((row) => row.callId === previewCallId) ?? null
    : null
  const previewStatus = previewCallId
    ? dots.find((dot) => dot.callId === previewCallId)?.status ?? null
    : null
  const previewResult = previewCallId ? group.results.get(previewCallId) ?? null : null
  const inspectedIntent = previewCallId !== badgeIntentionCallId ? previewCall?.intent?.trim() : ''
  // The persistent activity badge is transient and may be outside the visible
  // transcript. Keep the contextual Intention on the Dot Line; badge ownership
  // only prevents hover from replacing it with the same text.
  const displayedIntent = inspectedIntent || fallbackIntent
  const [previewPosition, setPreviewPosition] = useState<ToolPreviewGeometry | null>(null)
  const [previewElement, setPreviewElement] = useState<HTMLDivElement | null>(null)
  const [previewHeight, setPreviewHeight] = useState<number | undefined>()
  useLayoutEffect(() => {
    if (!previewElement) { setPreviewHeight(undefined); return }
    const update = (): void => setPreviewHeight(previewElement.getBoundingClientRect().height)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(previewElement)
    return () => observer.disconnect()
  }, [previewElement, previewCallId])
  useEffect(() => {
    if (!collapsedDots || !previewCallId || !previewRow || !previewStatus || typeof document === 'undefined') {
      setPreviewPosition(null)
      return
    }
    const anchor = document.getElementById(`tool-card-dot-anchor-${previewCallId}`)
    if (!anchor) {
      setPreviewPosition(null)
      return
    }
    const update = (): void => {
      const rect = anchor.getBoundingClientRect()
      setPreviewPosition(toolPreviewGeometry({
        anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        ...(previewHeight !== undefined ? { contentHeight: previewHeight } : {}),
      }))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [collapsedDots, previewCallId, previewStatus, previewHeight])

  const toggleOpen = (): void => {
    setHoveredCallId(null)
    setPinnedCallId(null)
    setOpen((v) => {
      const next = !v
      if (singleCall) setExpandedCallId(next ? singleCall.callId : null)
      return next
    })
  }

  const collapseFromBottom = (): void => {
    setHoveredCallId(null)
    setPinnedCallId(null)
    setExpandedCallId(null)
    setOpen(false)
    requestAnimationFrame(() => {
      const element = groupRootRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (rect.top < 0 || rect.bottom > window.innerHeight) element.scrollIntoView({ block: 'nearest' })
    })
  }

  return (
    <div
      id={`msg-${messageIndex}-group-${group.firstCallId}`}
      ref={(element) => {
        groupRootRef.current = element
        setDotBoundary(element)
      }}
      className={cn(
        'w-full min-w-0 max-w-full transition-colors',
        collapsedDots
          ? 'overflow-visible'
          : 'overflow-hidden rounded-lg',
        !collapsedDots && (anyPending
          ? 'bg-amber-50/60 ring-1 ring-amber-400/60 dark:bg-amber-950/20 dark:ring-amber-500/40'
          : isRunning
            ? 'ak-tool-running bg-violet-50/50 ring-1 ring-violet-300/70 dark:bg-violet-950/20 dark:ring-violet-800/70'
            : 'bg-muted/40'),
      )}
      data-running={isRunning ? 'true' : undefined}
      data-testid={`tool-call-group-${group.firstCallId}`}
    >
      {collapsedDots ? (
        <div
          className="grid min-h-10 w-full min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 overflow-visible max-sm:grid-cols-[minmax(0,1fr)_auto]"
          data-testid={`tool-card-dots-${group.firstCallId}`}
          aria-label={`${group.calls.length} tool calls`}
        >
          <div className="w-fit min-w-0 flex-none overflow-hidden" style={{ maxWidth: railBudget || '100%' }} data-testid="tool-activity-rail">
            <div className="relative flex w-max min-w-0 items-center gap-2.5 py-1.5">
              {visibleDotGroups.length > 1 ? (
                <span className="pointer-events-none absolute top-1/2 z-0 h-[3px] -translate-y-1/2 rounded-full bg-muted-foreground/60 shadow-[0_0_4px_hsl(var(--muted-foreground)/0.28)]" style={{ left: nodePixels / 2, right: nodePixels / 2 }} data-testid="tool-activity-connector" aria-hidden="true" />
              ) : null}
              {visibleDotGroups.map((dotGroup, index) => {
                const dot = aggregateToolDotGroup(dotGroup.dots)
                const repeated = dotGroup.dots.length > 1
                return (
              <div key={dotGroup.callId} className="relative z-10 flex flex-none items-center">
                <button
                  type="button"
                  id={`tool-card-dot-anchor-${dot.callId}`}
                  title={repeated ? `${dotGroup.toolName} ×${dotGroup.dots.length}` : dot.title}
                  aria-label={repeated ? `${dotGroup.toolName}, ${dotGroup.dots.length} consecutive calls` : dot.title}
                  aria-pressed={!repeated && pinnedCallId === dot.callId}
                  data-testid={repeated ? `tool-card-dot-group-${dot.callId}` : `tool-card-dot-${dot.callId}`}
                  onMouseEnter={() => { if (!repeated) setHoveredCallId(dot.callId) }}
                  onMouseLeave={() => setHoveredCallId(null)}
                  onFocus={() => { if (!repeated) setHoveredCallId(dot.callId) }}
                  onBlur={() => setHoveredCallId(null)}
                  onClick={() => {
                    setHoveredCallId(null)
                    if (repeated) toggleOpen()
                    else setPinnedCallId((current) => current === dot.callId ? null : dot.callId)
                  }}
                  className={cn('group/dot flex h-full flex-none items-center justify-center bg-background ring-offset-1 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', repeated ? 'gap-1.5 rounded-full px-2' : 'rounded-full')}
                  style={repeated ? { height: nodePixels, minWidth: nodePixels } : { width: nodePixels, height: nodePixels }}
                >
                  <ToolActivityGlyph dot={dot} size={iconPixels} />
                  {repeated ? <span className="font-mono text-ui font-bold tabular-nums text-foreground" data-testid={`tool-card-dot-count-${dot.callId}`}>×{dotGroup.dots.length}</span> : null}
                </button>
                {omittedDotCount > 0 && index === Math.ceil(visibleDotGroups.length / 2) - 1 ? (
                  <button type="button" onClick={toggleOpen} className="relative z-20 ml-2.5 flex h-8 min-w-12 flex-none items-center justify-center rounded-full bg-background px-2 font-mono text-[0.9375rem] font-bold tabular-nums text-foreground shadow-[0_0_0_4px_hsl(var(--background))] ring-1 ring-inset ring-foreground/30 hover:bg-muted" title={t('chatCommon.omittedTools', { count: omittedDotCount })} aria-label={t('chatCommon.omittedToolsExpand', { count: omittedDotCount })} data-testid="tool-activity-omission">+{omittedDotCount}</button>
                ) : null}
              </div>
                )
              })}
            </div>
          </div>
          <div className="col-start-3 row-start-1 flex min-w-0 items-center justify-end gap-1 max-sm:col-start-2" data-testid="tool-activity-actions">
            <InlineTimestamp ts={timestamp} className="flex-none opacity-65" />
            <button
              type="button"
              onClick={toggleOpen}
              className="flex h-8 w-8 flex-none items-center justify-center rounded text-muted-foreground/65 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={t('chatCommon.expandToolActivity')}
              data-testid="tool-activity-direction"
            >
              <ArrowRight className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
            </button>
          </div>
          {displayedIntent ? (
            <p
              className="col-start-2 row-start-1 min-w-0 whitespace-normal break-words text-[0.9375rem] leading-6 text-foreground/85 max-sm:col-span-2 max-sm:col-start-1 max-sm:row-start-2 max-sm:pr-1"
              data-testid={`tool-card-dots-intent-${group.firstCallId}`}
            >
              {displayedIntent}
            </p>
          ) : null}
          {previewCallId && previewCall && previewRow && previewStatus && previewPosition && typeof document !== 'undefined'
            ? createPortal(
                <div
                  ref={setPreviewElement}
                  className={cn(
                    'fixed z-[100] flex min-h-0 flex-col overflow-hidden border border-border/80 bg-popover p-2 text-popover-foreground shadow-2xl',
                    previewPosition.mobile ? 'rounded-t-2xl rounded-b-xl' : 'rounded-xl',
                    pinnedCallId === previewCallId ? 'pointer-events-auto' : 'pointer-events-none',
                  )}
                  style={{ left: previewPosition.left, top: previewPosition.top, width: previewPosition.width, maxHeight: previewPosition.maxHeight }}
                  data-placement={`${previewPosition.horizontal}-${previewPosition.vertical}`}
                  data-mobile={previewPosition.mobile ? 'true' : 'false'}
                  data-testid={`tool-card-preview-layer-${previewCallId}`}
                  role={pinnedCallId === previewCallId ? 'dialog' : 'tooltip'}
                  onWheel={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <div className="mb-2 flex min-w-0 items-center justify-between gap-3 px-1 py-0.5">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <ToolNameChip name={previewCall.name} />
                    </div>
                    <span className="flex flex-none items-center gap-1">
                      <ToolTextBadge tone={previewStatus === 'failed' ? 'danger' : previewStatus === 'succeeded' ? 'success' : previewStatus === 'approval' ? 'warning' : 'neutral'}>
                        {previewStatus}
                      </ToolTextBadge>
                      {pinnedCallId === previewCallId ? (
                        <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setPinnedCallId(null)} aria-label={t('chatCommon.closeToolDetails')} data-testid="tool-card-preview-close">
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <div className="grid min-h-0 min-w-0 flex-1 touch-pan-y gap-2 overflow-y-auto overscroll-contain pr-1" data-testid={`tool-card-preview-scroll-${previewCallId}`}>
                    <ToolCallInlineDetail
                      call={previewCall}
                      approval={approvalByCallId.get(previewCallId) ?? null}
                      compactNarrative
                    />
                    {previewResult ? <ToolResultInlineDetail result={previewResult} compactNarrative /> : (
                      <GroupSummaryPreview row={previewRow} status={previewStatus === 'partial' ? 'failed' : previewStatus} />
                    )}
                  </div>
                </div>,
                document.body,
              )
            : null}
        </div>
      ) : (
      <button
        type="button"
        onClick={toggleOpen}
        className={cn(
          'grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-foreground transition-colors max-sm:grid-cols-[auto_minmax(0,1fr)]',
          anyPending
            ? 'hover:bg-amber-100/40 dark:hover:bg-amber-950/30'
            : 'hover:bg-muted',
        )}
        data-testid={
          singleCall
            ? `grouped-tool-row-${singleCall.callId}`
            : `tool-call-group-toggle-${group.firstCallId}`
        }
      >
        <Wrench
          className={cn(
            'h-4 w-4 flex-none',
            anyPending
              ? 'text-amber-600 dark:text-amber-400'
              : isRunning
                ? 'text-violet-600 animate-[spin_2s_linear_infinite] dark:text-violet-300'
                : 'text-muted-foreground',
          )}
        />
        <span className="flex min-w-0 items-center gap-1.5">
          <ToolNameChip name={groupTitle} />
          {toolCardMode !== 'dots' && singleCall?.intent ? (
            <span className="min-w-0 truncate text-meta text-muted-foreground" title={singleCall.intent} data-testid={`tool-call-intent-${singleCall.callId}`}>
              {singleCall.intent}
            </span>
          ) : toolCardMode !== 'dots' && fallbackIntent ? (
            <span className="min-w-0 whitespace-normal break-words text-meta text-muted-foreground" data-testid={`tool-call-intent-summary-${group.firstCallId}`}>
              {fallbackIntent}
            </span>
          ) : toolCardMode !== 'dots' && singleRow?.primary ? (
            <span className="min-w-0 truncate font-mono text-meta text-foreground [overflow-wrap:anywhere]" title={singleRow.primary}>
              {singleRow.primary}
            </span>
          ) : group.mixed ? (
            <span className="min-w-0 truncate text-ui text-muted-foreground" title={toolMix}>
              {toolMix}
            </span>
          ) : toolCardMode !== 'dots' && primaryTargets ? (
            <span className="min-w-0 truncate font-mono text-meta text-foreground [overflow-wrap:anywhere]" title={primaryTargets}>
              {primaryTargets}
            </span>
          ) : null}
          {singleHeaderResult.kind === 'error' ? (
            <span className="hidden min-w-0 items-center gap-1.5 sm:flex">
              <ToolHeaderResultSummaryView summary={singleHeaderResult} hideDelta />
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-none flex-wrap items-center justify-end gap-1.5 max-sm:col-span-2 max-sm:justify-start max-sm:pl-5">
          {singleHeaderResult.kind === 'delta' ? <ToolDeltaBadges metric={singleHeaderResult.metric} /> : null}
          {singleHeaderResult.kind === 'text' && shouldShowCompactHeaderText(singleCall?.name ?? '', singleHeaderResult.text) ? (
            <span className="hidden h-5 max-w-32 items-center truncate rounded bg-background/70 px-1.5 text-meta leading-none text-muted-foreground lg:inline-flex" title={singleHeaderResult.title ?? singleHeaderResult.text}>
              {singleHeaderResult.text}
            </span>
          ) : null}
          {group.calls.length > 1 ? (
            <span
              className={cn(
                'inline-flex h-6 flex-none items-center rounded px-2 font-mono text-ui leading-none',
                group.mixed
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background/80 text-muted-foreground',
              )}
            >
              {group.mixed ? `${group.calls.length} ops` : `× ${group.calls.length}`}
            </span>
          ) : null}
          {!singleCall ? <ToolLifecycleSummaryBadges summary={groupLifecycle} /> : null}
          {isRunning && runningElapsed !== undefined ? (
            <span className="flex-none whitespace-nowrap font-mono text-[0.75rem] tabular-nums text-violet-700/80 dark:text-violet-300/80" data-testid="tool-running-elapsed">
              ↳ {runningElapsed.toFixed(1)}s
            </span>
          ) : null}
          {singleStatus ? (
            <span
              className={cn(
                'inline-flex h-6 flex-none items-center rounded px-2 text-meta font-medium uppercase leading-none tracking-wider',
                singleStatus.className,
                isRunning && 'motion-safe:animate-pulse',
              )}
            >
              {singleStatus.label}
            </span>
          ) : null}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          )}
        </span>
      </button>
      )}
      {showRows ? (
        <div
          className="ak-expand-in flex min-w-0 max-w-full flex-col gap-1 overflow-hidden border-t border-border/40 px-3 pb-2.5 pt-1.5"
          data-testid={`tool-call-group-details-${group.firstCallId}`}
        >
          {isMobile && rows.length > 8 ? (
            <button type="button" className="mb-1 flex min-h-12 w-full items-center justify-center rounded-lg border border-border/60 bg-background/70 px-3 text-xs font-medium text-foreground" onClick={() => setShowAllMobileRows((value) => !value)} data-testid="tool-mobile-row-limit-toggle">
              {showAllMobileRows ? 'Show recent activity' : `Show all ${rows.length} operations`}
            </button>
          ) : null}
          {mobileRows.map((row) => {
            const call = group.calls.find((c) => c.callId === row.callId)!
            const result = group.results.get(row.callId)
            const expanded = expandedCallId === row.callId
            const pending = approvalByCallId.get(row.callId) ?? null
            if (singleCall && row.callId === singleCall.callId) {
              if (!expanded && !pending) return null
              return (
                <div
                  key={row.callId}
                  id={`msg-${messageIndex}-call-${row.callId}`}
                  className="mt-1 flex min-w-0 max-w-full flex-col gap-2 overflow-hidden pl-1"
                >
                  <ToolCallInlineDetail
                    call={call}
                    approval={pending}
                    onApprovalDecision={onApprovalDecision}
                  />
                  {result ? (
                  <ToolResultInlineDetail
                    result={result}
                  />
                ) : null}
                </div>
              )
            }
            const tailVisible = visibleTailCallIds?.has(row.callId) ?? false
            if (!open && !pending && !tailVisible) return null
            const rowStatus = approvalByCallId.has(row.callId)
              ? 'approval' as const
              : group.results.has(row.callId)
                ? group.results.get(row.callId)!.ok ? 'succeeded' as const : 'failed' as const
                : 'running' as const
            return (
              <div
                key={row.callId}
                id={`msg-${messageIndex}-call-${row.callId}`}
                className="min-w-0 max-w-full overflow-hidden"
              >
                <GroupSummaryRow
                  row={row}
                  toolName={call.name}
                  intent={call.intent}
                  status={rowStatus}
                  onClick={() =>
                    setExpandedCallId((cur) => (cur === row.callId ? null : row.callId))
                  }
                />
                {expanded || pending ? (
                  <div className="ak-expand-in mt-1 flex min-w-0 max-w-full flex-col gap-2 overflow-hidden pl-5">
                    <ToolCallInlineDetail
                      call={call}
                      approval={pending}
                      onApprovalDecision={onApprovalDecision}
                    />
                    {result ? (
                      <ToolResultInlineDetail result={result} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          {open ? (
            <button
              type="button"
              onClick={collapseFromBottom}
              className="mt-2 flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-background/70 px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t('chatCommon.collapseToolActivity')}
              data-testid="tool-activity-collapse-bottom"
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('chatCommon.collapse')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

type ToolActivityDot = {
  callId: string
  toolName: string
  status: 'succeeded' | 'failed' | 'partial' | 'approval' | 'running' | 'orphaned'
  kind: 'read' | 'search' | 'write' | 'shell' | 'web' | 'todo' | 'memory' | 'agent' | 'other'
  title: string
}

function toolActivityDots(
  group: ToolCallGroup,
  rows: readonly SummaryRow[],
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>,
  activeToolCallIds: ReadonlySet<string> | null,
): ToolActivityDot[] {
  return group.calls.map((call) => {
    const result = group.results.get(call.callId)
    const row = rows.find((candidate) => candidate.callId === call.callId)
    const status: ToolActivityDot['status'] = approvalByCallId.has(call.callId)
      ? 'approval'
      : result
        ? result.ok ? 'succeeded' : 'failed'
        : isActiveToolCall(call.callId, activeToolCallIds) ? 'running' : 'orphaned'
    return {
      callId: call.callId,
      toolName: call.name,
      status,
      kind: toolActivityKind(call.name),
      title: call.intent?.trim() || `${call.name} · ${status}`,
    }
  })
}


function aggregateToolDotGroup(dots: readonly ToolActivityDot[]): ToolActivityDot {
  const first = dots[0]!
  const terminalStatuses = new Set(dots.map((dot) => dot.status))
  if (terminalStatuses.has('failed') && terminalStatuses.has('succeeded')) {
    const failed = dots.filter((dot) => dot.status === 'failed').length
    return { ...first, status: 'partial', title: `${dots.length} calls · ${failed} failed` }
  }
  const statusPriority: Record<ToolActivityDot['status'], number> = { succeeded: 0, orphaned: 1, partial: 2, running: 3, approval: 4, failed: 5 }
  const status = dots.reduce<ToolActivityDot['status']>((current, dot) => statusPriority[dot.status] > statusPriority[current] ? dot.status : current, first.status)
  return { ...first, status }
}

const READ_TOOLS = new Set(['read', 'read_file', 'read_files', 'ls', 'glob'])
const FILE_MUTATION_TOOLS = new Set(['write', 'write_file', 'edit', 'replace_in_file', 'replace_many_in_file', 'apply_file_patch'])
const SHELL_TOOLS = new Set(['bash', 'bash_output', 'kill_shell'])

function toolActivityKind(toolName: string): ToolActivityDot['kind'] {
  if (toolName === 'grep' || toolName === 'multi_grep') return 'search'
  if (READ_TOOLS.has(toolName)) return 'read'
  if (FILE_MUTATION_TOOLS.has(toolName)) return 'write'
  if (SHELL_TOOLS.has(toolName)) return 'shell'
  if (toolName === 'websearch' || toolName === 'webfetch') return 'web'
  // todowrite is retained here only for legacy/history transcript rendering.
  if (toolName === 'todowrite' || toolName === 'todo_graph') return 'todo'
  if (toolName === 'memory') return 'memory'
  if (toolName === 'agent') return 'agent'
  return 'other'
}

function ToolActivityGlyph({ dot, size }: { dot: ToolActivityDot; size: number }): JSX.Element {
  const Icon = dot.kind === 'read' ? Eye : dot.kind === 'search' ? FileSearch : dot.kind === 'write' ? PenLine : dot.kind === 'shell' ? Terminal : dot.kind === 'web' ? Globe : dot.kind === 'todo' ? ListChecks : dot.kind === 'memory' ? Brain : dot.kind === 'agent' ? Bot : Wrench
  return (
    <span data-shape={dot.kind} className={cn('relative flex items-center justify-center rounded-full transition-transform group-hover/dot:scale-110', dot.status === 'succeeded' && 'text-emerald-600 dark:text-emerald-400', dot.status === 'failed' && 'text-rose-600 dark:text-rose-400', dot.status === 'partial' && 'text-amber-600 dark:text-amber-400', dot.status === 'approval' && 'text-amber-500', dot.status === 'running' && 'text-violet-600 dark:text-violet-300', dot.status === 'orphaned' && 'text-muted-foreground/70')} style={{ width: size, height: size }}>
      {dot.status === 'running' ? <span className="ak-tool-activity-running absolute inset-[-4px] rounded-full" aria-hidden="true" /> : null}
      <Icon className="relative stroke-[2.2]" style={{ width: size, height: size }} aria-hidden="true" />
      {dot.status === 'failed' ? <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-rose-500 ring-1 ring-background" aria-hidden="true" /> : null}
      {dot.status === 'partial' ? <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-amber-500 ring-1 ring-background" aria-hidden="true" /> : null}
      {dot.status === 'approval' ? <span className="absolute -right-1 -top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 ring-1 ring-background" aria-hidden="true" /> : null}
    </span>
  )
}

function middleTruncatedToolActivityDots(dots: readonly ToolActivityDot[], limit: number): ToolActivityDot[] {
  if (dots.length <= limit) return [...dots]
  const headCount = Math.ceil(limit / 2)
  const tailCount = Math.floor(limit / 2)
  return [...dots.slice(0, headCount), ...dots.slice(-tailCount)]
}

function summarizeToolActivityRows(group: ToolCallGroup): SummaryRow[] {
  if (!group.mixed) {
    return pickRenderer(group.toolName)({ calls: group.calls, results: group.results })
  }

  const rowsByCallId = new Map<string, SummaryRow>()
  for (const call of group.calls) {
    const renderer = pickRenderer(call.name)
    const row = renderer({ calls: [call], results: group.results })[0]
    if (!row) continue
    rowsByCallId.set(call.callId, {
      ...row,
      primary: `${call.name} · ${row.primary}`,
    })
  }
  return group.calls.map((call) => rowsByCallId.get(call.callId)).filter((row): row is SummaryRow => !!row)
}

function summarizeToolMix(calls: readonly ToolCallContent[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(', ')
}

function summarizeToolIntents(calls: readonly ToolCallContent[], limit: number): string {
  const intents: string[] = []
  for (const call of calls) {
    const intent = call.intent?.trim()
    if (!intent || intents.includes(intent)) continue
    intents.push(intent)
  }
  if (intents.length === 0) return ''
  const visible = intents.slice(0, limit)
  const remainder = intents.length - visible.length
  return `${visible.join(' · ')}${remainder > 0 ? ` · +${remainder} more` : ''}`
}

function summarizePrimaryTargets(rows: readonly SummaryRow[], limit: number): string {
  const targets: string[] = []
  for (const row of rows) {
    if (!row.primary || targets.includes(row.primary)) continue
    targets.push(row.primary)
    if (targets.length >= limit) break
  }
  return targets.join(', ')
}

type ToolLifecycleKind = 'approval' | 'running' | 'succeeded' | 'failed' | 'orphaned'

function toolLifecycleBadge(kind: ToolLifecycleKind): { label: string; className: string } {
  if (kind === 'approval') {
    return { label: 'Needs approval', className: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' }
  }
  if (kind === 'running') {
    return { label: 'Running', className: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300' }
  }
  if (kind === 'failed') {
    return { label: 'Failed', className: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' }
  }
  if (kind === 'orphaned') {
    return { label: 'Orphaned', className: 'bg-background/80 text-muted-foreground' }
  }
  return { label: 'Succeeded', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' }
}

function isActiveToolCall(callId: string, activeToolCallIds: ReadonlySet<string> | null): boolean {
  return activeToolCallIds === null || activeToolCallIds.has(callId)
}

function summarizeToolGroupLifecycle(
  group: ToolCallGroup,
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>,
  activeToolCallIds: ReadonlySet<string> | null,
): Partial<Record<ToolLifecycleKind, number>> {
  const summary: Partial<Record<ToolLifecycleKind, number>> = {}
  for (const call of group.calls) {
    const result = group.results.get(call.callId)
    const kind: ToolLifecycleKind = approvalByCallId.has(call.callId)
      ? 'approval'
      : result
        ? result.ok
          ? 'succeeded'
          : 'failed'
        : isActiveToolCall(call.callId, activeToolCallIds) ? 'running' : 'orphaned'
    summary[kind] = (summary[kind] ?? 0) + 1
  }
  return summary
}

function ToolLifecycleSummaryBadges({ summary }: { summary: Partial<Record<ToolLifecycleKind, number>> }): JSX.Element {
  const kinds: readonly ToolLifecycleKind[] = ['approval', 'running', 'failed', 'succeeded', 'orphaned']
  return (
    <span className="flex min-w-0 flex-none items-center gap-1 leading-none">
      {kinds.map((kind) => {
        const count = summary[kind] ?? 0
        if (count === 0) return null
        const badge = toolLifecycleBadge(kind)
        return (
          <span key={kind} className={cn('inline-flex h-5 items-center rounded px-1.5 text-[0.75rem] font-medium uppercase leading-none tracking-wider', badge.className)}>
            {count} {badge.label}
          </span>
        )
      })}
    </span>
  )
}
