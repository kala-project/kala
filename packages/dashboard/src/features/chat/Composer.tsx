import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArrowRight, AtSign, Bot, Check, ChevronDown, ChevronUp, Cloud, CornerDownRight, Eraser, FileText, GripVertical, ListChecks, LoaderCircle, LockKeyhole, Maximize2, Mic, Navigation, PanelTopClose, PanelTopOpen, Paperclip, Pencil, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, Square, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import {
  MAX_MESSAGE_IMAGES,
  MAX_MESSAGE_FILES,
  MAX_FILE_DECODED_BYTES,
  MAX_MESSAGE_FILE_BYTES,
  validateClientMessagePayload,
  validateInlineMessageImages,
  type ContextUsageSnapshot,
  type CompactStatusEvent,
  type FileListEntry,
  type HumanAttentionTimeline,
  type ModelInfo,
  type QueuedMessagePreview,
  type RuntimeCompactionPolicy,
} from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentState,
  ApprovalMode,
  FileContent,
  ImageContent,
  MessageContent,
  ReferencedFileContent,
  TextContent,
} from '@agent-kernel/kernel'

import { Button } from '../../components/ui/button.js'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js'
import { Textarea } from '../../components/ui/textarea.js'
import { cn } from '../../lib/utils.js'
import { PREF_COMPOSER_DRAFT_PREFIX, PREF_COMPOSER_SEND_MODE_PREFIX } from '../../lib/prefs.js'
import { getDesktopBridge } from '../../lib/desktop-bridge.js'
import { RuntimeMetrics } from './RuntimeMetrics.js'
import { HumanAttentionIndicator, shouldShowLowAttentionHint } from './HumanAttentionIndicator.js'
import type { TimelineEntry } from '../../session.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { SimpleComposerInput } from './composer/SimpleComposerInput.js'
import { useComposerMode } from './composer/useComposerMode.js'
import { chatDisplayStyle, type ChatDisplayPrefs } from './chatDisplayPrefs.js'
import { prepareComposerImage } from './image-compression.js'
import { joinTranscriptChunks, mergeTranscriptAtCaret, useVoiceRecorder, type VoiceRecorderError } from '../voice/useVoiceRecorder.js'
import { speechMaxMinutes } from '../voice/speech-api.js'
import { VoiceWorkbench, VoiceCompactAnchor } from './VoiceWorkbench.js'
import { VoiceLevelTrace } from './VoiceLevelTrace.js'

type Props = {
  disabled?: boolean
  serviceUnavailable?: boolean
  workspaceUnavailable?: boolean
  onReconnectService?(): void
  onSubmit(text: string, mode: SendMode, attachments: readonly (ImageContent | FileContent)[] | undefined, extraBlocks: readonly TextContent[] | undefined, intent: MessageIntent): void | Promise<void>
  onExecuteShell?(command: string): Promise<string>
  onUploadFiles?(files: readonly File[]): Promise<readonly ReferencedFileContent[]>
  onReleaseFiles?(files: readonly ReferencedFileContent[]): Promise<void>
  onCompact?(): void
  onCancel?(): void
  onClearTranscript?(): void
  onNewSession?(): void | Promise<void>
  onConsolidateMemory?(): void
  onRenameSession?(label: string | null): void
  onDeleteSession?(): void
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  approvalMode: ApprovalMode
  onApprovalModeChange(mode: ApprovalMode): void
  allowModelSelection?: boolean
  allowApprovalMode?: boolean
  allowQueue?: boolean
  allowAttachments?: boolean
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  runtimeCompactionPolicy?: RuntimeCompactionPolicy
  runtimeCompactStatus?: CompactStatusEvent | null
  humanAttention: HumanAttentionTimeline
  queuedMessages: readonly QueuedMessagePreview[]
  timeline?: readonly TimelineEntry[]
  displayPrefs?: ChatDisplayPrefs
  onQueuedReorder?(id: string, beforeId?: string | null): Promise<void>
  onQueuedUpdate?(id: string, text: string, content?: readonly MessageContent[]): Promise<void>
  onQueuedDelete?(id: string): Promise<void>
  workspaceOnline?: boolean
  onListFiles?(query: string): Promise<readonly FileListEntry[]>
  onReadFile?(path: string): Promise<{ content?: string; error?: string }>
  awaitingAck?: boolean
  lockWhileSubmitting?: boolean
  /**
   * Extra controls rendered inline in the footer, immediately after the
   * approval-mode picker. Used e.g. by the background-shells trigger.
   */
  footerExtras?: ReactNode
  /** Compact controls shown beside Attach in simple mode. */
  simpleFooterExtras?: ReactNode
  /** Controls rendered in the side space immediately left of the Composer surface. */
  leftAccessory?: ReactNode
  onOpenVoiceSettings?(): void
}

export type SendMode = 'steer' | 'queue'
export type MessageIntent = 'text' | 'shell'
const SEND_MODE_STORAGE_PREFIX = PREF_COMPOSER_SEND_MODE_PREFIX
const QUEUED_MESSAGES_VISIBLE_LIMIT = 3

type PastedImage = {
  id: string
  dataUrl: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  base64: string
}

type AttachedFile = {
  id: string
  name: string
  mediaType: string
  size: number
  file: File
}

export const APPROVAL_MODES: ReadonlyArray<{
  value: ApprovalMode
  label: string
  hint: string
}> = [
  { value: 'auto', label: 'Auto', hint: 'ask only for tools marked unsafe' },
  { value: 'ask', label: 'Ask everything', hint: 'confirm every tool call' },
  { value: 'deny', label: 'Deny unsafe', hint: 'auto-reject anything unsafe' },
  { value: 'allow_all', label: 'Allow all', hint: 'Danger: bypass all approval prompts' },
]

const APPROVAL_MODE_BY_VALUE = new Map(APPROVAL_MODES.map((mode) => [mode.value, mode]))

function approvalModeDisplay(mode: ApprovalMode, t: TFunction): { label: string; hint: string } {
  if (mode === 'auto') return { label: t('composer.approvalModes.auto.label'), hint: t('composer.approvalModes.auto.hint') }
  if (mode === 'ask') return { label: t('composer.approvalModes.ask.label'), hint: t('composer.approvalModes.ask.hint') }
  if (mode === 'deny') return { label: t('composer.approvalModes.deny.label'), hint: t('composer.approvalModes.deny.hint') }
  if (mode === 'allow_all') return { label: t('composer.approvalModes.allowAll.label'), hint: t('composer.approvalModes.allowAll.hint') }
  const fallback = APPROVAL_MODE_BY_VALUE.get(mode)
  return { label: fallback?.label ?? mode, hint: fallback?.hint ?? '' }
}

function readStoredSendMode(sessionId: string | null): SendMode {
  if (!sessionId || typeof window === 'undefined') return 'steer'
  try {
    const value = window.localStorage.getItem(`${SEND_MODE_STORAGE_PREFIX}${sessionId}`)
    return value === 'queue' ? 'queue' : 'steer'
  } catch {
    return 'steer'
  }
}

function writeStoredSendMode(sessionId: string | null, mode: SendMode): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${SEND_MODE_STORAGE_PREFIX}${sessionId}`, mode)
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

const DRAFT_STORAGE_PREFIX = PREF_COMPOSER_DRAFT_PREFIX
const DRAFT_INTENT_STORAGE_PREFIX = 'ak-composer-draft-intent:'
const VOICE_LAYOUT_STORAGE_PREFIX = 'ak-composer-voice-layout:'
type VoiceLayout = 'expanded' | 'compact'

function readStoredVoiceLayout(sessionId: string | null): VoiceLayout {
  if (!sessionId || typeof window === 'undefined') return 'expanded'
  try { return window.localStorage.getItem(`${VOICE_LAYOUT_STORAGE_PREFIX}${sessionId}`) === 'compact' ? 'compact' : 'expanded' }
  catch { return 'expanded' }
}

function writeStoredVoiceLayout(sessionId: string | null, layout: VoiceLayout): void {
  if (!sessionId || typeof window === 'undefined') return
  try { window.localStorage.setItem(`${VOICE_LAYOUT_STORAGE_PREFIX}${sessionId}`, layout) }
  catch { /* Storage is best effort, as for drafts. */ }
}

/** Read the saved, unsent composer draft for a session (empty when none). */
function readStoredDraft(sessionId: string | null): string {
  if (!sessionId || typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${sessionId}`) ?? ''
  } catch {
    return ''
  }
}

/** Persist (or, on empty, clear) the composer draft for a session. */
function writeStoredDraft(sessionId: string | null, text: string): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    if (text.length > 0) window.localStorage.setItem(`${DRAFT_STORAGE_PREFIX}${sessionId}`, text)
    else window.localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${sessionId}`)
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

function readStoredDraftIntent(sessionId: string | null, text: string): MessageIntent {
  if (!sessionId || typeof window === 'undefined') return text.startsWith('!') ? 'shell' : 'text'
  try {
    const stored = window.localStorage.getItem(`${DRAFT_INTENT_STORAGE_PREFIX}${sessionId}`)
    if (stored === 'shell') return 'shell'
    if (stored === 'text') return 'text'
    return text.startsWith('!') ? 'shell' : 'text'
  } catch {
    return text.startsWith('!') ? 'shell' : 'text'
  }
}

function writeStoredDraftIntent(sessionId: string | null, text: string, intent: MessageIntent): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    const key = `${DRAFT_INTENT_STORAGE_PREFIX}${sessionId}`
    if (intent === 'shell') window.localStorage.setItem(key, 'shell')
    else if (text.startsWith('!')) window.localStorage.setItem(key, 'text')
    else window.localStorage.removeItem(key)
  } catch {
    // Draft mode persistence is best effort, matching draft text persistence.
  }
}

function isActiveTurnStatus(status: AgentState['status'] | undefined): boolean {
  return status === 'thinking' || status === 'executing_tools' || status === 'awaiting_approval'
}

function useIsNarrow(): boolean {
  const query = '(max-width: 639px)'
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia(query)
    const onChange = (): void => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return matches
}

export function Composer({
  disabled,
  serviceUnavailable = false,
  workspaceUnavailable = false,
  onReconnectService,
  onSubmit,
  onExecuteShell,
  onUploadFiles,
  onReleaseFiles,
  onCompact,
  onCancel,
  onClearTranscript,
  onNewSession,
  onConsolidateMemory,
  onRenameSession,
  onDeleteSession,
  model,
  models,
  onModelChange,
  approvalMode,
  onApprovalModeChange,
  allowModelSelection = true,
  allowApprovalMode = true,
  allowQueue = true,
  allowAttachments = true,
  state,
  config,
  contextSnapshot,
  runtimeCompactionPolicy,
  runtimeCompactStatus,
  humanAttention,
  queuedMessages,
  timeline,
  displayPrefs,
  onQueuedReorder,
  onQueuedUpdate,
  onQueuedDelete,
  workspaceOnline,
  onListFiles,
  onReadFile,
  awaitingAck = false,
  lockWhileSubmitting = false,
  footerExtras,
  simpleFooterExtras,
  leftAccessory,
  onOpenVoiceSettings,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const isNarrow = useIsNarrow()
  const lowAttentionHint = shouldShowLowAttentionHint(humanAttention)
  const placeholderText = disabled
    ? workspaceUnavailable
      ? t('composer.waitingForWorkspace')
      : t('composer.waitingForService')
    : lowAttentionHint
      ? isNarrow
        ? t('composer.placeholderLowAttentionShort')
        : t('composer.placeholderLowAttention')
    : isNarrow
      ? t('composer.placeholderShort')
      : t('composer.placeholder')
  const { mode, toggle: toggleMode } = useComposerMode()
  const displayStyle = chatDisplayStyle(displayPrefs)
  const sessionId = state?.sessionId ?? null
  const [voiceLayoutPreference, setVoiceLayoutPreference] = useState(() => ({ sessionId, layout: readStoredVoiceLayout(sessionId) }))
  const voiceLayout = voiceLayoutPreference.sessionId === sessionId ? voiceLayoutPreference.layout : readStoredVoiceLayout(sessionId)
  const updateVoiceLayout = (layout: VoiceLayout): void => {
    setVoiceLayoutPreference({ sessionId, layout })
    writeStoredVoiceLayout(sessionId, layout)
  }
  const [text, setText] = useState<string>(() => readStoredDraft(sessionId))
  const [messageIntent, setMessageIntent] = useState<MessageIntent>(() => {
    const draft = readStoredDraft(sessionId)
    return readStoredDraftIntent(sessionId, draft)
  })
  // Per-session draft persistence. Switching sessions must show that session's
  // own unsent draft, not whatever was typed in the previous one. We reload the
  // draft when the session changes and persist edits under the session they were
  // made in. `loadedDraftSession` guards the persist effect so it never writes
  // the outgoing session's text into the newly-selected session between the
  // session change and the reload.
  const loadedDraftSession = useRef<string | null>(sessionId)
  useEffect(() => {
    loadedDraftSession.current = sessionId
    const draft = readStoredDraft(sessionId)
    setText(draft)
    setMessageIntent(readStoredDraftIntent(sessionId, draft))
  }, [sessionId])
  const draftWriteTimer = useRef<number | null>(null)
  const latestDraft = useRef({ sessionId, text })
  useEffect(() => {
    if (loadedDraftSession.current !== sessionId) return
    latestDraft.current = { sessionId, text }
    if (draftWriteTimer.current !== null) window.clearTimeout(draftWriteTimer.current)
    draftWriteTimer.current = window.setTimeout(() => {
      writeStoredDraft(sessionId, text)
      writeStoredDraftIntent(sessionId, text, messageIntent)
      draftWriteTimer.current = null
    }, 300)
    return () => {
      if (draftWriteTimer.current !== null) window.clearTimeout(draftWriteTimer.current)
      draftWriteTimer.current = null
    }
  }, [text, messageIntent, sessionId])
  useEffect(() => () => {
    const pending = latestDraft.current
    if (pending.sessionId === sessionId) {
      writeStoredDraft(pending.sessionId, pending.text)
      writeStoredDraftIntent(pending.sessionId, pending.text, messageIntent)
    }
  }, [sessionId, messageIntent])
  const [sendMode, setSendMode] = useState<SendMode>(() => readStoredSendMode(sessionId))
  useEffect(() => {
    setSendMode(readStoredSendMode(sessionId))
  }, [sessionId])
  useEffect(() => {
    if (!allowQueue && sendMode !== 'steer') setSendMode('steer')
  }, [allowQueue, sendMode])
  const updateSendMode = useCallback((next: SendMode): void => {
    setSendMode(next)
    writeStoredSendMode(sessionId, next)
  }, [sessionId])
  const [pastedImages, setPastedImages] = useState<readonly PastedImage[]>([])
  const [attachedFiles, setAttachedFiles] = useState<readonly AttachedFile[]>([])
  const [submitting, setSubmitting] = useState(false)
  const submitInFlight = useRef(false)
  useEffect(() => {
    setPastedImages([])
    setAttachedFiles([])
  }, [sessionId])
  const [mentionState, setMentionState] = useState<MentionState | null>(null)
  const [mentionFiles, setMentionFiles] = useState<readonly FileListEntry[]>([])
  const [mentionActive, setMentionActive] = useState(0)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [pendingToast, setPendingToast] = useState<string | null>(null)
  const shellMode = messageIntent === 'shell'
  const inputPlaceholder = shellMode && !disabled && workspaceOnline !== false
    ? 'Enter a shell command…'
    : placeholderText
  const exitShellMode = (): void => {
    setMessageIntent('text')
    const literalText = `!${text}`
    setText(literalText)
    writeStoredDraftIntent(sessionId, literalText, 'text')
  }
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const simpleCaretRef = useRef(0)
  const voiceDraftRef = useRef({ text: '', caret: 0 })
  const voiceRequestRef = useRef<{ sessionId: string | null } | null>(null)
  const previousVoiceSessionRef = useRef(sessionId)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mentionRequestId = useRef(0)
  const approvalModeLabel = approvalModeDisplay(approvalMode, t).label
  const voice = useVoiceRecorder({
    onTranscript: (transcript) => {
      // A late result must never write speech from the previous session into this one.
      if (!voiceRequestRef.current || voiceRequestRef.current.sessionId !== sessionId) return
      const draft = voiceDraftRef.current
      const next = mergeTranscriptAtCaret(draft.text, draft.caret, transcript)
      setText(next)
      window.requestAnimationFrame(() => {
        const input = textareaRef.current
        if (!input) return
        const position = draft.text.trim()
          ? next.length - (draft.text.length - draft.caret)
          : next.length
        input.focus()
        input.setSelectionRange(position, position)
      })
    },
    onConfigure: onOpenVoiceSettings,
  })
  const beginVoiceInput = useCallback((): void => {
    const caret = mode === 'full'
      ? textareaRef.current?.selectionStart ?? text.length
      : simpleCaretRef.current || text.length
    voiceDraftRef.current = { text, caret }
    voiceRequestRef.current = { sessionId }
    void voice.start()
  }, [mode, text, voice, sessionId])
  const voiceActive = voice.phase !== 'idle' && voiceRequestRef.current?.sessionId === sessionId

  useEffect(() => {
    if (!voiceActive || voiceLayout === 'expanded') return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (voice.phase === 'error') voice.dismissError()
      else void voice.cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [voice, voiceActive, voiceLayout])

  useEffect(() => {
    if (previousVoiceSessionRef.current === sessionId) return
    previousVoiceSessionRef.current = sessionId
    // Also invalidate a pending settings/microphone request before it reaches listening.
    if (voiceRequestRef.current && voiceRequestRef.current.sessionId !== sessionId) void voice.cancel()
  // A recording belongs to the session where it began.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  const slashQuery = text.trimStart().startsWith('/') ? text.trimStart() : ''
  const slashCommands = useMemo(
    () => {
      const commands: SlashCommand[] = []
      if (onCompact) {
        commands.push({
          command: '/compact',
          icon: Archive,
          label: t('composer.slash.compact'),
          description: t('composer.slash.compactDesc'),
          run: onCompact,
        })
      }
      if (onCancel) {
        commands.push({
          command: '/stop',
          icon: Square,
          label: t('composer.slash.stop'),
          description: t('composer.slash.stopDesc'),
          run: onCancel,
        })
        commands.push({
          command: '/cancel',
          icon: Square,
          label: t('composer.slash.cancel'),
          description: t('composer.slash.cancelDesc'),
          run: onCancel,
        })
      }
      if (onClearTranscript) {
        commands.push({
          command: '/clear',
          icon: Eraser,
          label: t('composer.slash.clear'),
          description: t('composer.slash.clearDesc'),
          run: onClearTranscript,
        })
      }
      if (onNewSession) {
        commands.push({
          command: '/new',
          icon: Plus,
          label: t('composer.slash.new'),
          description: t('composer.slash.newDesc'),
          run: () => { void onNewSession() },
        })
      }
      if (onRenameSession) {
        commands.push({
          command: '/rename',
          icon: Pencil,
          label: t('composer.slash.rename'),
          description: t('composer.slash.renameDesc'),
          acceptsArgs: true,
          run: ({ args }) => {
            const label = args.trim()
            if (label === '--clear') {
              onRenameSession('')
              return
            }
            onRenameSession(label.length > 0 ? label : null)
          },
        })
      }
      if (onDeleteSession) {
        commands.push({
          command: '/delete',
          icon: Trash2,
          label: t('composer.slash.delete'),
          description: t('composer.slash.deleteDesc'),
          run: ({ args }) => {
            if (args.trim().length > 0) {
              setPendingToast(t('composer.slash.noArgs', { command: '/delete' }))
              return
            }
            onDeleteSession()
          },
        })
      }
      if (onConsolidateMemory) {
        commands.push({
          command: '/consolidate-memory',
          icon: ListChecks,
          label: t('composer.slash.consolidateMemory'),
          description: t('composer.slash.consolidateMemoryDesc'),
          run: onConsolidateMemory,
        })
      }
      return commands
    },
    [onCompact, onCancel, onClearTranscript, onNewSession, onRenameSession, onDeleteSession, onConsolidateMemory, t],
  )
  const matchingCommands = slashQuery
    ? slashCommands.filter((c) => c.command.startsWith(slashQuery))
    : []

  useEffect(() => {
    if (!mentionState || !onListFiles) {
      if (mentionFiles.length > 0) setMentionFiles([])
      return
    }
    const rid = ++mentionRequestId.current
    setMentionLoading(true)
    let cancelled = false
    const handle = setTimeout(() => {
      onListFiles(mentionState.query)
        .then((files) => {
          if (cancelled || rid !== mentionRequestId.current) return
          setMentionFiles(files)
          setMentionActive(0)
          setMentionLoading(false)
        })
        .catch(() => {
          if (cancelled || rid !== mentionRequestId.current) return
          setMentionFiles([])
          setMentionLoading(false)
        })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [mentionState, onListFiles])

  useEffect(() => {
    if (!pendingToast) return
    const t = setTimeout(() => setPendingToast(null), 3500)
    return () => clearTimeout(t)
  }, [pendingToast])

  const updateText = (next: string, caret: number): void => {
    if (messageIntent !== 'shell' && text.length === 0 && next.startsWith('!')) {
      const command = next.slice(1)
      setMessageIntent('shell')
      setText(command)
      setMentionState(null)
      mentionRequestId.current += 1
      return
    }
    setMessageIntent((current) => {
      return current === 'shell' ? 'shell' : 'text'
    })
    setText(next)
    const found = detectMention(next, caret)
    setMentionState(found)
    if (!found) mentionRequestId.current += 1
  }

  const applyMention = (file: FileListEntry): void => {
    if (!mentionState) return
    const before = text.slice(0, mentionState.start)
    const after = text.slice(mentionState.end)
    const inserted = `@${file.path}`
    const next = `${before}${inserted} ${after}`
    setText(next)
    setMentionState(null)
    setMentionFiles([])
    setMentionActive(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const pos = before.length + inserted.length + 1
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const submit = async (textOverride?: string): Promise<void> => {
    if (disabled || workspaceOnline === false || submitting || submitInFlight.current) return
    const sourceText = textOverride ?? text
    const trimmed = sourceText.trim()
    const isBangShell = messageIntent === 'shell'
    if (isBangShell && sourceText.trim().length === 0) {
      setPendingToast('Shell command is empty. Usage: !command')
      return
    }
    if (isBangShell && new TextEncoder().encode(sourceText).byteLength > 16 * 1024) {
      setPendingToast('Shell command exceeds 16384 bytes')
      return
    }
    if (trimmed.length === 0 && pastedImages.length === 0 && attachedFiles.length === 0) return
    if (isBangShell && (pastedImages.length > 0 || attachedFiles.length > 0)) {
      setPendingToast('Shell commands cannot include attachments')
      return
    }
    if (isBangShell) {
      if (!onExecuteShell) {
        setPendingToast('Shell execution is unavailable')
        return
      }
      submitInFlight.current = true
      setSubmitting(true)
      try {
        const draft = await onExecuteShell(sourceText)
        setText(draft)
        setMessageIntent('text')
        setMentionState(null)
        setMentionFiles([])
      } catch (error) {
        setPendingToast(error instanceof Error ? error.message : String(error))
      } finally {
        submitInFlight.current = false
        setSubmitting(false)
      }
      return
    }
    const submittedMessageText = sourceText.trimStart().startsWith('!') ? sourceText : trimmed
    const parsedCommand = parseSlashCommand(trimmed)
    const command = parsedCommand
      ? slashCommands.find((c) => c.command === parsedCommand.name)
      : undefined
    if (command && pastedImages.length === 0 && attachedFiles.length === 0) {
      if (!command.acceptsArgs && parsedCommand!.args.trim().length > 0) {
        setPendingToast(t('composer.slash.noArgs', { command: command.command }))
        return
      }
      command.run({ args: parsedCommand!.args })
      setText('')
      return
    }
    const images: ImageContent[] = pastedImages.map((img) => ({
      type: 'image',
      source: { kind: 'base64', mediaType: img.mediaType, data: img.base64 },
    }))
    const imageValidation = validateInlineMessageImages(images)
    if (!imageValidation.ok) {
      setPendingToast(imageValidation.error.message)
      return
    }
    const extraBlocks: TextContent[] = []
    if (onReadFile && !isBangShell) {
      const mentions = collectMentionPaths(trimmed)
      const seen = new Set<string>()
      for (const path of mentions) {
        if (seen.has(path)) continue
        seen.add(path)
        try {
          const result = await onReadFile(path)
          if (result.error) {
            setPendingToast(`@${path}: ${result.error}`)
            continue
          }
          if (typeof result.content === 'string') {
            extraBlocks.push({
              type: 'text',
              text: `--- ${path} ---\n${result.content}\n---`,
            })
          }
        } catch (err) {
          setPendingToast(`@${path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    const submittedText = sourceText
    const submittedIntent = 'text' as const
    const submittedImages = pastedImages
    const submittedFiles = attachedFiles
    // Clear optimistically while raw File objects remain only in this
    // in-memory snapshot. Upload still completes before message admission.
    setText('')
    setMessageIntent('text')
    setPastedImages([])
    setAttachedFiles([])
    setMentionState(null)
    setMentionFiles([])
    const uploadImages = submittedImages.length > 0 && Boolean(onUploadFiles)
    const uploadingFiles = submittedFiles.length > 0 || uploadImages
    if (uploadingFiles || lockWhileSubmitting) {
      submitInFlight.current = true
      setSubmitting(true)
    }
    let files: readonly ReferencedFileContent[] = []
    let admissionStarted = false
    try {
      const imageFiles = uploadImages
        ? submittedImages.map((image, index) => pastedImageAsFile(image, index))
        : []
      const filesToUpload = [...imageFiles, ...submittedFiles.map((file) => file.file)]
      const uploadedFiles = filesToUpload.length > 0 ? await onUploadFiles?.(filesToUpload) : []
      if (!uploadedFiles) throw new Error('File attachment upload is unavailable')
      files = uploadedFiles
      // Host references keep screenshots durable without copying base64 into
      // every external-runtime snapshot. Demos without an upload endpoint keep
      // the legacy inline representation. Do not add any synthetic text here:
      // it would be rendered as user-authored transcript content and would also
      // break optimistic/admitted message reconciliation keys.
      const attachments = [...(uploadImages ? [] : images), ...files]
      const payloadError = validateClientMessagePayload({ text: submittedMessageText, mode: sendMode, content: [...(submittedMessageText ? [{ type: 'text', text: submittedMessageText }] : []), ...extraBlocks, ...attachments] })
      if (payloadError) throw new Error(payloadError.message)
      admissionStarted = true
      await onSubmit(
        submittedMessageText,
        sendMode,
        attachments.length > 0 ? attachments : undefined,
        extraBlocks.length > 0 ? extraBlocks : undefined,
        submittedIntent,
      )
    } catch (error) {
      // Restore only into an untouched composer. Never overwrite text or images
      // the operator added while the acknowledgement was pending.
      // A platform delivery timeout is different from an acceptance failure:
      // the durable ledger already owns the operationId, so restoring the
      // draft would invite a second send with a different identity.
      const durablyAccepted = typeof error === 'object' && error !== null && 'durablyAccepted' in error && error.durablyAccepted === true
      const safeToRelease = !admissionStarted
        || (typeof error === 'object' && error !== null && 'safeToReleaseAttachments' in error && error.safeToReleaseAttachments === true)
      if (!durablyAccepted && safeToRelease && files.length > 0 && onReleaseFiles) {
        try {
          await onReleaseFiles(files)
        } catch (releaseError) {
          console.error('Unable to release pending message attachments', releaseError)
        }
      }
      if (!durablyAccepted) {
        setText((current) => {
          if (current.length === 0) {
            setMessageIntent(submittedIntent)
            return submittedText
          }
          return current
        })
        setPastedImages((current) => current.length === 0 ? submittedImages : current)
        setAttachedFiles((current) => current.length === 0 ? submittedFiles : current)
      }
      setPendingToast(error instanceof Error ? error.message : String(error))
    } finally {
      if (uploadingFiles || lockWhileSubmitting) {
        submitInFlight.current = false
        setSubmitting(false)
      }
    }
  }
  const stopVoiceAndSend = async (): Promise<void> => {
    await commitVoiceAndSend({
      stop: voice.stop,
      draft: voiceDraftRef.current,
      setText,
      submit,
    })
  }
  const expandedVoice = voiceActive && voiceLayout === 'expanded'

  async function extractImagesFromClipboardData(data: DataTransfer | null): Promise<PastedImage[]> {
    if (!allowAttachments) return []
    const items = Array.from(data?.items ?? [])
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    const added: PastedImage[] = []
    if (pastedImages.length + imageItems.length > MAX_MESSAGE_IMAGES) {
      setPendingToast(`A message can contain at most ${MAX_MESSAGE_IMAGES} images.`)
      return []
    }

    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const prepared = await prepareComposerImage(file)
      added.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl: prepared.dataUrl,
        mediaType: prepared.mediaType,
        base64: prepared.base64,
      })
    }
    return added
  }

  async function addFiles(files: readonly File[]): Promise<boolean> {
    if (!allowAttachments || shellMode || files.length === 0) return false
    try {
      const imageFiles = files.filter((file) => file.type.startsWith('image/'))
      const genericFiles = files.filter((file) => !file.type.startsWith('image/'))
      if (pastedImages.length + imageFiles.length > MAX_MESSAGE_IMAGES) {
        setPendingToast(`A message can contain at most ${MAX_MESSAGE_IMAGES} images.`)
        return false
      }
      if (attachedFiles.length + genericFiles.length > MAX_MESSAGE_FILES) {
        setPendingToast(`A message can contain at most ${MAX_MESSAGE_FILES} files.`)
        return false
      }
      const nextImages: PastedImage[] = []
      for (const file of imageFiles) {
        const prepared = await prepareComposerImage(file)
        nextImages.push({
          id: attachmentId('img'),
          dataUrl: prepared.dataUrl,
          mediaType: prepared.mediaType,
          base64: prepared.base64,
        })
      }
      const nextFiles: AttachedFile[] = []
      for (const file of genericFiles) {
        nextFiles.push({
          id: attachmentId('file'),
          name: file.name || 'attachment',
          mediaType: file.type || 'application/octet-stream',
          size: file.size,
          file,
        })
      }
      const fileError = validateSelectedFiles([...attachedFiles, ...nextFiles])
      if (fileError) {
        setPendingToast(fileError)
        return false
      }
      if (nextImages.length > 0) setPastedImages((current) => [...current, ...nextImages])
      if (nextFiles.length > 0) setAttachedFiles((current) => [...current, ...nextFiles])
      return true
    } catch (error) {
      setPendingToast(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  async function addNativeClipboardImage(): Promise<boolean> {
    const readClipboardImage = getDesktopBridge()?.readClipboardImage
    if (!readClipboardImage) return false
    try {
      const dataUrl = await readClipboardImage()
      if (!dataUrl) return false
      const response = await fetch(dataUrl)
      const blob = await response.blob()
      if (blob.type !== 'image/png') throw new Error('Desktop clipboard returned an unsupported image format.')
      return addFiles([new File([blob], 'pasted-image.png', { type: 'image/png' })])
    } catch (error) {
      setPendingToast(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  async function pasteAttachments(data: DataTransfer | null): Promise<boolean> {
    if (shellMode) return false
    const clipboardFiles = Array.from(data?.files ?? [])
    if (clipboardFiles.length > 0) return addFiles(clipboardFiles)
    const added = await extractImagesFromClipboardData(data)
    if (added.length > 0) {
      setPastedImages((prev) => [...prev, ...added])
      return true
    }
    return addNativeClipboardImage()
  }

  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const hasFileRepresentation = Array.from(e.clipboardData?.items ?? []).some((item) => item.kind === 'file')
      || (e.clipboardData?.files?.length ?? 0) > 0
    if (hasFileRepresentation) {
      e.preventDefault()
      await pasteAttachments(e.clipboardData)
      return
    }
    // Native clipboard inspection is asynchronous, while preventDefault only
    // works during this event. Intercept synchronously and restore plain text
    // ourselves when the native clipboard contains no image.
    if (!getDesktopBridge()?.readClipboardImage) return
    e.preventDefault()
    const target = e.currentTarget
    const plainText = e.clipboardData?.getData('text/plain') ?? ''
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? start
    if (await addNativeClipboardImage() || !plainText) return
    const next = `${target.value.slice(0, start)}${plainText}${target.value.slice(end)}`
    updateText(next, start + plainText.length)
    window.requestAnimationFrame(() => target.setSelectionRange(start + plainText.length, start + plainText.length))
  }

  async function handleSimplePaste(e: ClipboardEvent<HTMLDivElement>): Promise<boolean> {
    return pasteAttachments(e.clipboardData)
  }

  function removeImage(id: string): void {
    setPastedImages((prev) => prev.filter((img) => img.id !== id))
  }

  function removeFile(id: string): void {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== id))
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    void submit()
  }

  const shellModeIndicator = shellMode ? (
    <div className="flex min-w-0 items-center gap-1.5 px-3 pt-1.5 text-[11px] text-amber-700 dark:text-amber-300" data-testid="composer-shell-mode">
      <span className="font-medium">Shell · workspace</span>
      <span className="truncate text-muted-foreground">Runs in this Session workspace</span>
      <button
        type="button"
        className="ml-auto inline-flex h-5 w-5 flex-none items-center justify-center rounded-full hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-label="Exit shell mode and keep as text"
        onClick={exitShellMode}
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  ) : null

  const canSubmit = !disabled && !submitting && workspaceOnline !== false && (text.trim().length > 0 || pastedImages.length > 0 || attachedFiles.length > 0)
  const canStop = typeof onCancel === 'function' && (awaitingAck || isActiveTurnStatus(state?.status))
  const showStopButton = !canSubmit && canStop
  const simpleTools = (
    <SimpleComposerToolsMenu
      disabled={Boolean(disabled)}
      allowAttachments={allowAttachments && !shellMode}
      onAttach={() => fileInputRef.current?.click()}
      onToggleMode={toggleMode}
      config={<ComposerConfigButton
        model={model}
        models={models}
        onModelChange={onModelChange}
        approvalMode={approvalMode}
        approvalModeLabel={approvalModeLabel}
        onApprovalModeChange={onApprovalModeChange}
        composerMode={mode}
        onComposerModeChange={toggleMode}
        sendMode={sendMode}
        onSendModeChange={updateSendMode}
        allowModelSelection={allowModelSelection}
        allowApprovalMode={allowApprovalMode}
        allowQueue={allowQueue}
        appearance="menu"
      />}
      extras={simpleFooterExtras}
    />
  )
  const contextUsageBar = (frameShape: 'compact' | 'full'): JSX.Element => (
    <RuntimeMetrics
      state={state}
      config={config}
      contextSnapshot={contextSnapshot}
      runtimeCompactionPolicy={runtimeCompactionPolicy}
      compactStatus={runtimeCompactStatus}
      modelInfo={modelInfoFor(models, model)}
      queuedMessages={queuedMessages.length}
      timeline={timeline}
      density="simple"
      frameShape={frameShape}
      onCompact={onCompact}
      compactDisabled={disabled}
    />
  )

  if (serviceUnavailable) {
    return (
      <div
        className="ak-composer-container ak-composer-surface mx-auto flex h-14 w-full items-center gap-3 rounded-2xl px-4"
        style={displayStyle}
        data-testid="service-connection-state"
        role="status"
      >
        <span className="relative flex h-7 w-7 flex-none items-center justify-center" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-primary/15 motion-safe:animate-ping" />
          <Cloud className="relative h-4 w-4 text-primary" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t('composer.connectingToService')}…</span>
        {onReconnectService ? (
          <Button type="button" variant="ghost" size="sm" className="h-9 flex-none gap-1.5 rounded-xl px-3 text-muted-foreground hover:text-foreground" onClick={onReconnectService} data-testid="service-reconnect">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('composer.reconnectService')}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <>
    <form
      onSubmit={handleSubmit}
      className={cn(
        'bg-transparent',
        // Keep a small baseline gap while retaining only half the iOS safe-area
        // shelf, so the compact composer does not sit against the viewport edge.
        mode === 'simple'
          ? 'pt-0.5 pb-[calc(env(safe-area-inset-bottom)/2+0.125rem)] sm:pt-1 sm:pb-1.5'
          : 'pt-1 pb-[calc(env(safe-area-inset-bottom)/2+0.25rem)] sm:pt-1 sm:pb-2.5',
      )}
      style={displayStyle}
      data-testid="composer"
      data-composer-mode={mode}
      onDragOver={(event) => {
        if (!allowAttachments || shellMode || disabled || !event.dataTransfer?.types?.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (!allowAttachments || shellMode || disabled) return
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length === 0) return
        event.preventDefault()
        void addFiles(files)
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={disabled || !allowAttachments || shellMode}
        className="hidden"
        data-testid="composer-file-input"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void addFiles(files)
        }}
      />
      <div className="ak-composer-container relative mx-auto w-full">
        <QueuedMessagesDock
          items={queuedMessages}
          onReorder={onQueuedReorder}
          onUpdate={onQueuedUpdate}
          onDelete={onQueuedDelete}
        />
        {mode === 'simple' ? (
          <div className="flex min-w-0 flex-col gap-1" data-testid="composer-simple-frame">
            <div className="flex min-w-0 items-end gap-2 sm:-ml-8" data-testid="composer-simple-row">
              <ComposerLeftAccessory>{leftAccessory}</ComposerLeftAccessory>
              <div
                className={cn(
                  'ak-composer-surface relative flex min-h-12 min-w-0 flex-1 flex-col overflow-visible rounded-[20px] transition-[border-color,background-color,box-shadow]',
                  shellMode && 'border-amber-400/80 bg-amber-50/30 ring-1 ring-amber-400/20 dark:bg-amber-950/10',
                )}
                data-testid="composer-simple-shell"
                data-layout="single-row"
              >
                {voiceActive ? (
                  expandedVoice
                    ? <VoiceCompactAnchor voice={voice} />
                    : <VoiceRecorderSurface voice={voice} draftText={voiceDraftRef.current.text} onStopAndSend={stopVoiceAndSend} compact onExpand={() => updateVoiceLayout('expanded')} />
                ) : (
                <>
                  {shellModeIndicator}
                  {contextUsageBar('compact')}
                  <AttachmentTray images={pastedImages} files={attachedFiles} onRemoveImage={removeImage} onRemoveFile={removeFile} bordered />
                  <div className="flex min-h-12 min-w-0 flex-nowrap items-center gap-1 px-1 py-0.5" data-testid="composer-simple-controls">
                  <SlashCommandMenu
                    commands={matchingCommands}
                    disabled={disabled}
                    onRun={(cmd) => {
                      cmd.run({ args: '' })
                      setText('')
                    }}
                    className="absolute inset-x-0 bottom-full z-20 mb-2"
                  />
                  {simpleTools}
                  <div className="min-w-0 flex-1">
                    <SimpleComposerInput
                      text={text}
                      images={[]}
                      disabled={disabled || (shellMode && submitting)}
                      placeholder={inputPlaceholder}
                      ariaLabel={t('composer.placeholder')}
                      onTextChange={(next) => updateText(next, next.length)}
                      onSelectionChange={(caret) => { simpleCaretRef.current = caret }}
                      onRemoveImage={(id) => removeImage(id)}
                      onPaste={handleSimplePaste}
                      onEnterSubmit={() => { void submit() }}
                      className="border-0 bg-transparent shadow-none focus-within:border-0 focus-within:bg-transparent focus-within:ring-0"
                    />
                  </div>
                  <div className="flex flex-none items-center justify-center gap-0.5" data-testid="composer-simple-send-column">
                    <VoiceInputButton disabled={Boolean(disabled || submitting)} secureContext={voice.secureContext} onPrepare={voice.prepare} onClick={beginVoiceInput} />
                    <SendButton
                      disabled={!canSubmit}
                      sendMode={sendMode}
                      onSendModeChange={updateSendMode}
                      density="simple"
                      allowQueue={allowQueue}
                      stop={showStopButton ? { onClick: onCancel } : undefined}
                    />
                  </div>
                </div>
                </>
                )}
              </div>
            </div>
          </div>
        ) : (
        <div className="flex min-w-0 items-stretch gap-2 sm:-ml-8" data-testid="composer-full-shell">
        <ComposerLeftAccessory>{leftAccessory}</ComposerLeftAccessory>
        <div
          className={cn(
            'ak-composer-surface relative min-w-0 flex-1 rounded-2xl transition-[border-color,background-color,box-shadow]',
            shellMode && 'border-amber-400/80 bg-amber-50/30 ring-1 ring-amber-400/20 dark:bg-amber-950/10',
          )}
        >
          {voiceActive ? (
            expandedVoice
              ? <VoiceCompactAnchor voice={voice} />
              : <VoiceRecorderSurface voice={voice} draftText={voiceDraftRef.current.text} onStopAndSend={stopVoiceAndSend} onExpand={() => updateVoiceLayout('expanded')} />
          ) : (
          <>
          {contextUsageBar('full')}
          {shellModeIndicator}
          <AttachmentTray images={pastedImages} files={attachedFiles} onRemoveImage={removeImage} onRemoveFile={removeFile} bordered />
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onSelect={(e) => {
                const el = e.currentTarget
                if (mentionState !== null || el.value.includes('@')) {
                  const found = detectMention(el.value, el.selectionStart ?? el.value.length)
                  setMentionState(found)
                  if (!found) mentionRequestId.current += 1
                }
              }}
              rows={1}
              disabled={disabled || (shellMode && submitting)}
              placeholder={inputPlaceholder}
              className="max-h-[min(240px,35vh)] min-h-12 w-full resize-none overflow-y-auto overscroll-contain border-0 bg-transparent px-4 py-2.5 text-[1.125rem] leading-7 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              data-testid="composer-input"
              onPaste={(e) => {
                void handlePaste(e)
              }}
              onKeyDown={(e) => {
                if (mentionState && mentionFiles.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMentionActive((i) => Math.min(mentionFiles.length - 1, i + 1))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionActive((i) => Math.max(0, i - 1))
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    const file = mentionFiles[mentionActive]
                    if (file) {
                      e.preventDefault()
                      applyMention(file)
                      return
                    }
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setMentionState(null)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            <SlashCommandMenu
              commands={matchingCommands}
              disabled={disabled}
              onRun={(cmd) => {
                cmd.run({ args: '' })
                setText('')
              }}
              className="absolute inset-x-2 bottom-2 z-10"
            />
            {mentionState && !disabled && onListFiles ? (
              <div
                className="absolute inset-x-2 bottom-2 z-10 max-h-[min(16rem,40vh)] overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg"
                data-testid="mention-menu"
              >
                <div className="flex items-center gap-2 border-b px-3 py-1.5 text-caption uppercase tracking-wider text-muted-foreground">
                  <AtSign className="h-3 w-3" aria-hidden="true" />
                  <span>{t('composer.files')}</span>
                  {mentionState.query ? (
                    <span className="font-mono text-foreground">{mentionState.query}</span>
                  ) : null}
                  {mentionLoading ? <span className="ml-auto">…</span> : null}
                </div>
                <ScrollArea className="max-h-56" data-testid="mention-list">
                  {mentionFiles.length === 0 && !mentionLoading ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {workspaceOnline === false ? t('composer.workspaceOffline') : t('composer.noMatches')}
                    </div>
                  ) : null}
                  {mentionFiles.map((file, idx) => (
                    <button
                      key={file.path}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                        idx === mentionActive
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-accent hover:text-accent-foreground',
                      )}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setMentionActive(idx)}
                      onClick={() => applyMention(file)}
                      data-testid={`mention-option-${idx}`}
                    >
                      <span className="font-mono truncate"><HighlightText text={file.path} query={mentionState.query} /></span>
                    </button>
                  ))}
                </ScrollArea>
              </div>
            ) : null}
          </div>
          <div
            className="flex min-h-10 min-w-0 flex-col items-stretch gap-0.5 border-t border-border/25 px-2 py-1 sm:flex-row sm:flex-nowrap sm:items-center sm:overflow-hidden"
            data-testid="composer-footer"
          >
            <div
              className="flex min-w-0 flex-1 flex-wrap items-center gap-1 pr-1 sm:flex-nowrap sm:overflow-x-auto sm:overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-testid="composer-footer-rail"
            >
              <ComposerModeToggle mode={mode} onToggle={toggleMode} />
              {allowAttachments ? <AttachmentButton disabled={disabled || shellMode} onClick={() => fileInputRef.current?.click()} /> : null}
              <ComposerConfigButton
                model={model}
                models={models}
                onModelChange={onModelChange}
                approvalMode={approvalMode}
                approvalModeLabel={approvalModeLabel}
                onApprovalModeChange={onApprovalModeChange}
                composerMode={mode}
                onComposerModeChange={toggleMode}
                sendMode={sendMode}
                onSendModeChange={updateSendMode}
                allowModelSelection={allowModelSelection}
                allowApprovalMode={allowApprovalMode}
                allowQueue={allowQueue}
                className="flex sm:hidden"
              />
              <div className="hidden min-w-0 flex-none items-center gap-1.5 sm:flex" data-testid="composer-footer-config">
              {allowModelSelection ? <Select
                value={modelInfoFor(models, model ?? '') ? model : ''}
                onValueChange={onModelChange}
                disabled={models.length === 0}
              >
                <SelectTrigger
                  className="h-9 w-10 flex-none gap-1 rounded-md border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-accent/55 md:w-24 xl:w-36"
                  data-testid="model-picker"
                  aria-label={t('common.model')}
                >
                  <Bot className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
                  <span className="hidden min-w-0 truncate md:inline">
                    <SelectValue
                      placeholder={models.length === 0 ? t('common.noModels') : t('common.model')}
                    />
                  </span>
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]">
                  {models.map((m) => {
                    const key = modelKey(m)
                    return (
                    <SelectItem key={key} value={key} data-testid={`model-option-${key}`}>
                      {m.label}{m.providerId ? <span className="ml-1 text-caption text-muted-foreground">{m.providerId}</span> : null}
                    </SelectItem>
                  )})}
                </SelectContent>
              </Select> : null}
              {allowApprovalMode ? <Select
                value={approvalMode}
                onValueChange={(v) => onApprovalModeChange(v as ApprovalMode)}
              >
                <SelectTrigger
                  className={cn(
                    'h-9 w-10 flex-none rounded-md border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-accent/55 md:w-16 xl:w-28',
                    approvalMode === 'allow_all'
                      ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40'
                      : approvalMode === 'ask'
                        ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40'
                        : '',
                  )}
                  data-testid="approval-mode-picker"
                  aria-label={t('composer.approvalMode')}
                >
                  <ShieldCheck className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                  <span className="hidden min-w-0 truncate md:inline">{approvalModeLabel}</span>
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]">
                  {APPROVAL_MODES.map((m) => {
                    const display = approvalModeDisplay(m.value, t)
                    return (
                    <SelectItem
                      key={m.value}
                      value={m.value}
                      textValue={display.label}
                      data-testid={`approval-mode-option-${m.value}`}
                    >
                      <div className="flex flex-col">
                        <span>{display.label}</span>
                        <span className="text-caption text-muted-foreground">
                          {display.hint}
                        </span>
                      </div>
                    </SelectItem>
                  )})}
                </SelectContent>
              </Select> : null}
              </div>
              {footerExtras}
            </div>
            <div className="flex flex-none items-center justify-end gap-0.5" data-testid="composer-footer-actions">
              <HumanAttentionIndicator timeline={humanAttention} />
              <VoiceInputButton disabled={Boolean(disabled || submitting)} secureContext={voice.secureContext} onPrepare={voice.prepare} onClick={beginVoiceInput} />
              <SendButton
                disabled={!canSubmit}
                sendMode={sendMode}
                onSendModeChange={updateSendMode}
                allowQueue={allowQueue}
                stop={showStopButton ? { onClick: onCancel } : undefined}
              />
            </div>
          </div>
          </>
          )}
        </div>
        </div>
        )}
        {pendingToast ? (
          <div
            className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-caption text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            data-testid="composer-toast"
          >
            {pendingToast}
          </div>
        ) : null}
      </div>
    </form>
    {expandedVoice ? <VoiceWorkbench voice={voice} draft={voiceDraftRef.current} onCompact={() => updateVoiceLayout('compact')} onStopAndSend={stopVoiceAndSend} /> : null}
    </>
  )
}

function ComposerLeftAccessory({ children }: { children?: ReactNode }): JSX.Element | null {
  if (!children) return null
  return (
    <div
      className={cn(
        'hidden flex-none items-center justify-center self-center sm:flex [&_[data-testid=user-message-navigation]]:flex-col [&_[data-testid=user-message-navigation]]:gap-0 [&_[data-testid=user-message-navigation]_button]:h-6 [&_[data-testid=user-message-navigation]_button]:w-6',
      )}
      data-testid="composer-left-accessory"
    >
      {children}
    </div>
  )
}

type VoiceRecorderControls = ReturnType<typeof useVoiceRecorder>

function VoiceInputButton({
  disabled,
  secureContext,
  onPrepare,
  onClick,
}: {
  disabled: boolean
  secureContext: boolean
  onPrepare?(): Promise<void>
  onClick(): void
}): JSX.Element {
  const { t } = useTranslation()
  const [secureContextHelp, setSecureContextHelp] = useState<{ left: number; top: number } | null>(null)
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onPointerEnter={() => { if (!disabled && secureContext) void onPrepare?.().catch(() => undefined) }}
        onFocus={() => { if (!disabled && secureContext) void onPrepare?.().catch(() => undefined) }}
        onPointerDown={() => { if (!disabled && secureContext) void onPrepare?.().catch(() => undefined) }}
        onClick={(event) => {
          if (!secureContext) {
            const rect = event.currentTarget.getBoundingClientRect()
            setSecureContextHelp((current) => current
              ? null
              : {
                  left: Math.max(12, Math.min(rect.right - 256, window.innerWidth - 268)),
                  top: Math.max(12, rect.top - 78),
                })
            return
          }
          onClick()
        }}
        aria-label={secureContext ? t('composer.voice.start') : t('composer.voice.httpsRequired')}
        title={secureContext ? t('composer.voice.start') : t('composer.voice.httpsRequired')}
        aria-expanded={!secureContext ? Boolean(secureContextHelp) : undefined}
        data-testid="composer-voice-start"
        data-secure-context={secureContext ? 'true' : 'false'}
        className="relative z-[1] flex h-11 w-10 flex-none items-center justify-center rounded-xl border-0 bg-transparent text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground active:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:h-10 sm:w-10"
      >
        <Mic className="h-[18px] w-[18px]" aria-hidden="true" />
        {!secureContext ? <LockKeyhole className="absolute bottom-1 right-1 h-2.5 w-2.5" aria-hidden="true" /> : null}
      </button>
      {secureContextHelp && !secureContext && typeof document !== 'undefined' ? createPortal((
        <div
          className="fixed z-[100] w-64 rounded-lg border border-border bg-popover p-3 text-left shadow-lg"
          style={secureContextHelp}
          role="alert"
          data-testid="composer-voice-https-help"
        >
          <div className="text-xs font-medium text-popover-foreground">{t('composer.voice.httpsRequired')}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{t('composer.voice.httpsRequiredDetail')}</div>
        </div>
      ), document.body) : null}
    </>
  )
}

function VoiceRecorderSurface({
  voice,
  draftText,
  onStopAndSend,
  onExpand,
  compact = false,
}: {
  voice: VoiceRecorderControls
  draftText: string
  onStopAndSend(): Promise<void>
  onExpand(): void
  compact?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef<HTMLDivElement | null>(null)
  const followTranscriptRef = useRef(true)
  const listening = voice.phase === 'listening'
  const error = voice.phase === 'error' ? voiceErrorLabel(voice.error, t) : null
  const liveMode = voice.configuration?.mode !== 'after_recording'
  const transcript = joinTranscriptChunks(voice.finalTranscript, voice.interimTranscript)
  const interimDisplay = transcript.slice(voice.finalTranscript.length)
  useEffect(() => {
    const element = transcriptRef.current
    if (element && followTranscriptRef.current) element.scrollTop = element.scrollHeight
  }, [transcript])
  useEffect(() => {
    if (draftRef.current) draftRef.current.scrollTop = draftRef.current.scrollHeight
  }, [draftText])
  const maxMinutes = voice.configuration?.mode === 'after_recording'
    ? voice.configuration.afterRecordingMaxMinutes : voice.configuration?.realtimeMaxMinutes
  const maxSeconds = speechMaxMinutes(maxMinutes) * 60
  const status = voice.phase === 'requesting'
    ? t('composer.voice.requesting')
    : voice.phase === 'processing'
      ? t('composer.voice.processing')
      : error ?? (voice.elapsedSeconds >= maxSeconds - 30
        ? t('composer.voice.finishingSoon')
        : liveMode ? t('composer.voice.listening') : t('composer.voice.recording'))
  return (
    <div
      className={cn(
        'ak-voice-recorder flex min-w-0 items-center gap-2 rounded-[inherit] px-2.5 py-2',
        compact ? 'min-h-12' : 'min-h-[5.625rem] px-3.5',
        listening && 'ak-voice-recorder-listening',
      )}
      data-testid="composer-voice-recorder"
      data-voice-phase={voice.phase}
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</span>
      {voice.phase === 'error' ? (
        <button
          type="button"
          onClick={voice.dismissError}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t('composer.voice.dismiss')}
          data-testid="composer-voice-dismiss"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : voice.phase !== 'processing' ? (
        <button
          type="button"
          onClick={() => { void voice.cancel() }}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t('composer.voice.cancel')}
          data-testid="composer-voice-cancel"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : <span className="h-9 w-9 flex-none" aria-hidden="true" />}

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex h-7 w-7 flex-none items-center justify-center" aria-hidden="true">
          {listening ? <span className="absolute inset-0 rounded-full bg-sky-500/15 motion-safe:animate-ping" /> : null}
          <span className={cn('relative h-2.5 w-2.5 rounded-full', voice.phase === 'error' ? 'bg-destructive' : listening ? 'bg-rose-500' : 'bg-primary')} />
        </span>
        <div className="min-w-0 flex-1">
          {draftText.trim() ? (
            <div ref={draftRef} className={cn('mb-1 max-h-16 overflow-y-auto whitespace-pre-wrap break-words border-b border-border/50 pb-1 text-sm text-foreground [scrollbar-width:thin]', compact && 'max-h-10')} data-testid="composer-voice-draft" aria-live="off">
              <span className="mr-2 text-xs text-muted-foreground">{t('composer.voice.existingDraft')}</span>{draftText}
            </div>
          ) : null}
          {listening && liveMode && transcript ? (
            <div
              ref={transcriptRef}
              className={cn('whitespace-pre-wrap break-words overflow-y-auto overscroll-contain text-sm leading-5 [scrollbar-width:thin]', compact ? 'max-h-10' : 'max-h-20')}
              onScroll={(event) => {
                const element = event.currentTarget
                followTranscriptRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 12
              }}
              data-testid="composer-voice-transcript"
            >
              <span className="text-foreground">{voice.finalTranscript}</span>
              <span className="text-muted-foreground">{interimDisplay}</span>
            </div>
          ) : (
            <div className={cn('text-sm font-medium', voice.phase === 'error' ? 'text-destructive' : 'text-foreground')} data-testid="composer-voice-status">
              {status}
            </div>
          )}
        </div>
        {voice.phase !== 'error' ? (
          <VoiceLevelTrace
            levels={voice.levels}
            className={cn('w-20 flex-none sm:w-28 md:w-36', !compact && 'sm:w-36 md:w-44', listening && liveMode && Boolean(transcript) && 'hidden sm:block')}
          />
        ) : null}
        {voice.phase !== 'error' ? (
          <span className="hidden w-10 flex-none text-right font-mono text-xs tabular-nums text-muted-foreground sm:block" data-testid="composer-voice-timer">
            {formatVoiceDuration(voice.elapsedSeconds)}
          </span>
        ) : null}
      </div>

      <button type="button" className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-accent" onClick={onExpand} aria-label={t('composer.voice.expand')} title={t('composer.voice.expand')} data-testid="composer-voice-expand"><Maximize2 className="h-4 w-4" aria-hidden="true" /></button>
      {listening ? (
        <VoiceStopControl
          compact={compact}
          onStop={() => voice.stop()}
          onStopAndSend={onStopAndSend}
        />
      ) : voice.phase === 'error' ? (
        <button
          type="button"
          onClick={() => { void voice.retry() }}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
          aria-label={t('composer.voice.retry')}
          data-testid="composer-voice-retry"
        >
          <Mic className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <span className="flex h-9 w-9 flex-none items-center justify-center text-muted-foreground" aria-hidden="true">
          <LoaderCircle className="h-4 w-4 animate-spin" />
        </span>
      )}
    </div>
  )
}

const VOICE_SEND_DRAG_PX = 58
const VOICE_SEND_MAX_PX = 66
const VOICE_TAP_SLOP_PX = 5

export async function commitVoiceAndSend({
  stop,
  draft,
  setText,
  submit,
}: {
  stop(): Promise<string | undefined>
  draft: { text: string; caret: number }
  setText(text: string): void
  submit(text: string): Promise<void>
}): Promise<boolean> {
  const transcript = await stop()
  if (!transcript) return false
  const next = mergeTranscriptAtCaret(draft.text, draft.caret, transcript)
  if (!next.trim()) return false
  setText(next)
  await submit(next)
  return true
}

export function VoiceStopControl({
  compact,
  onStop,
  onStopAndSend,
}: {
  compact: boolean
  onStop(): void | Promise<unknown>
  onStopAndSend(): void | Promise<unknown>
}): JSX.Element {
  const { t } = useTranslation()
  const dragRef = useRef<{ pointerId: number; startX: number } | null>(null)
  const suppressClickRef = useRef(false)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const armed = offset >= VOICE_SEND_DRAG_PX
  const reset = (): void => {
    dragRef.current = null
    setDragging(false)
    setOffset(0)
  }
  return (
    <div
      className={cn(
        'relative h-10 flex-none overflow-hidden rounded-full border border-primary/15 bg-primary/[0.055] select-none touch-none',
        compact ? 'w-[6.5rem]' : 'w-[7.25rem]',
      )}
      data-testid="composer-voice-send-track"
      data-armed={armed ? 'true' : 'false'}
      title={t('composer.voice.slideToSend')}
    >
      <span
        className="pointer-events-none absolute inset-y-0 left-0 bg-primary/10"
        style={{ width: `${36 + offset}px` }}
        aria-hidden="true"
      />
      <span className={cn(
        'pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1 text-caption font-medium text-primary/65 transition-opacity',
        dragging && 'text-primary',
      )}>
        <span className="hidden md:inline">{armed ? t('composer.voice.releaseToSend') : t('composer.voice.send')}</span>
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <button
        type="button"
        className={cn(
          'absolute left-0.5 top-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm',
          !dragging && 'transition-transform hover:scale-[1.03] active:scale-95',
          armed && 'bg-emerald-600',
        )}
        style={{ transform: `translateX(${offset}px)` }}
        aria-label={t('composer.voice.stop')}
        aria-description={t('composer.voice.slideToSend')}
        data-testid="composer-voice-stop"
        onPointerDown={(event) => {
          if (event.button !== 0 || dragRef.current) return
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX }
          event.currentTarget.setPointerCapture?.(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          setOffset(Math.max(0, Math.min(VOICE_SEND_MAX_PX, event.clientX - drag.startX)))
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const distance = Math.max(0, Math.min(VOICE_SEND_MAX_PX, event.clientX - drag.startX))
          suppressClickRef.current = true
          reset()
          if (distance >= VOICE_SEND_DRAG_PX) void onStopAndSend()
          else if (distance <= VOICE_TAP_SLOP_PX) void onStop()
        }}
        onPointerCancel={reset}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            event.preventDefault()
            return
          }
          void onStop()
        }}
      >
        {armed
          ? <Navigation className="h-4 w-4 fill-current" aria-hidden="true" />
          : <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />}
      </button>
    </div>
  )
}

function voiceErrorLabel(error: VoiceRecorderError | undefined, t: TFunction): string {
  if (error === 'not_configured') return t('composer.voice.errors.notConfigured')
  if (error === 'permission_denied') return t('composer.voice.errors.permissionDenied')
  if (error === 'microphone_unavailable') return t('composer.voice.errors.unavailable')
  if (error === 'secure_context_required') return t('composer.voice.errors.secureContext')
  if (error === 'no_speech') return t('composer.voice.errors.noSpeech')
  return t('composer.voice.errors.service')
}

function formatVoiceDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function AttachmentButton({ disabled, onClick, appearance = 'icon' }: { disabled?: boolean; onClick(): void; appearance?: 'icon' | 'menu' }): JSX.Element {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={t('composer.attachFile')}
      title={t('composer.attachFile')}
      data-testid="composer-attach-file"
      className={cn(
        'relative z-[1] flex flex-none border-0 bg-transparent text-muted-foreground transition-colors active:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
        appearance === 'menu'
          ? 'h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-accent hover:text-foreground'
          : 'h-11 w-10 items-center justify-center sm:h-10 sm:w-10 sm:rounded-xl sm:hover:bg-accent/70 sm:hover:text-foreground',
      )}
    >
      <Paperclip className="h-[18px] w-[18px]" aria-hidden="true" />
      {appearance === 'menu' ? <span>{t('composer.attachFile')}</span> : null}
    </button>
  )
}

function AttachmentTray({
  images,
  files,
  onRemoveImage,
  onRemoveFile,
  bordered = false,
}: {
  images: readonly PastedImage[]
  files: readonly AttachedFile[]
  onRemoveImage(id: string): void
  onRemoveFile(id: string): void
  bordered?: boolean
}): JSX.Element | null {
  const { t } = useTranslation()
  if (images.length === 0 && files.length === 0) return null
  return (
    <div
      className={cn('flex flex-wrap gap-2 px-3 py-2', bordered ? 'border-b border-border/50' : 'rounded-xl border border-border/60 bg-card/90')}
      data-testid={images.length > 0 ? 'pasted-image-tray' : 'attachment-tray'}
    >
      {images.map((image) => (
        <div
          key={image.id}
          className="group relative h-16 w-16 overflow-hidden rounded-lg border border-border/50 bg-background"
          data-testid={`pasted-image-${image.id}`}
        >
          <img src={image.dataUrl} alt={t('composer.pastedImage')} className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => onRemoveImage(image.id)}
            className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100 focus:opacity-100"
            aria-label={t('composer.removeImage')}
            data-testid={`pasted-image-remove-${image.id}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {files.map((file) => (
        <div
          key={file.id}
          className="group flex h-16 min-w-0 max-w-64 items-center gap-2 rounded-lg border border-border/50 bg-background px-3"
          data-testid={`attached-file-${file.id}`}
        >
          <FileText className="h-5 w-5 flex-none text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{file.name}</span>
            <span className="block truncate text-caption text-muted-foreground">{formatAttachmentBytes(file.size)} · {file.mediaType}</span>
          </span>
          <button
            type="button"
            onClick={() => onRemoveFile(file.id)}
            className="rounded-full p-1 text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground group-hover:opacity-100"
            aria-label={t('composer.removeFile', { name: file.name })}
            data-testid={`attached-file-remove-${file.id}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function attachmentId(prefix: 'img' | 'file'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function pastedImageAsFile(image: PastedImage, index: number): File {
  const binary = window.atob(image.base64)
  const bytes = new Uint8Array(binary.length)
  for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset)
  const extension = image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.slice('image/'.length)
  return new File([bytes], `pasted-image-${index + 1}.${extension}`, { type: image.mediaType })
}

function validateSelectedFiles(files: readonly AttachedFile[]): string | undefined {
  const oversized = files.find((file) => file.size > MAX_FILE_DECODED_BYTES)
  if (oversized) return `Each attached file must be at most ${formatAttachmentBytes(MAX_FILE_DECODED_BYTES)}.`
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_MESSAGE_FILE_BYTES) return `Files in one message must total at most ${formatAttachmentBytes(MAX_MESSAGE_FILE_BYTES)}.`
  return undefined
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ComposerModeToggle({ mode, onToggle, appearance = 'icon' }: { mode: 'simple' | 'full'; onToggle(): void; appearance?: 'icon' | 'menu' }): JSX.Element {
  const { t } = useTranslation()
  const label = mode === 'simple' ? t('composer.mode.toFull') : t('composer.mode.toSimple')
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={mode === 'full'}
      aria-label={label}
      title={label}
      data-testid="composer-mode-toggle"
      data-composer-mode={mode}
      className={cn(
        'relative z-[1] flex flex-none border-0 bg-transparent text-muted-foreground transition-colors',
        appearance === 'menu'
          ? 'h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-accent hover:text-foreground'
          : 'h-11 w-10 items-center justify-center sm:h-10 sm:w-10 sm:rounded-xl active:text-foreground sm:hover:bg-accent/70 sm:hover:text-foreground',
        'focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      {mode === 'simple'
        ? <PanelTopClose className="h-[18px] w-[18px]" aria-hidden="true" />
        : <PanelTopOpen className="h-[18px] w-[18px]" aria-hidden="true" />}
      {appearance === 'menu' ? <span>{label}</span> : null}
    </button>
  )
}

function SimpleComposerToolsMenu({
  disabled,
  allowAttachments,
  onAttach,
  onToggleMode,
  config,
  extras,
}: {
  disabled: boolean
  allowAttachments: boolean
  onAttach(): void
  onToggleMode(): void
  config: ReactNode
  extras?: ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (root.current?.contains(target) || target?.closest('[data-composer-tools-portal], [data-composer-config-select]')) return
      setOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div className="relative flex-none" ref={root} data-testid="composer-simple-tools">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t('composer.tools.open')}
        title={t('composer.tools.open')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="composer-tools-trigger"
        className={cn(
          'relative z-[1] flex h-11 w-10 flex-none items-center justify-center rounded-xl border-0 bg-transparent text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground',
          open && 'bg-accent/70 text-foreground',
        )}
      >
        <Plus className={cn('h-[19px] w-[19px] transition-transform', open && 'rotate-45')} aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t('composer.tools.title')}
          className="absolute bottom-full left-0 z-30 mb-2 w-[min(19rem,calc(100vw-1rem))] rounded-xl border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-xl"
          data-testid="composer-tools-menu"
        >
          {allowAttachments ? <AttachmentButton disabled={disabled} onClick={() => { onAttach(); setOpen(false) }} appearance="menu" /> : null}
          {config}
          {extras}
          <ComposerModeToggle mode="simple" onToggle={() => { onToggleMode(); setOpen(false) }} appearance="menu" />
        </div>
      ) : null}
    </div>
  )
}

function modelKey(model: ModelInfo): string {
  return model.ref ?? model.id
}

function modelInfoFor(models: readonly ModelInfo[], key: string): ModelInfo | null {
  const exact = models.find((m) => modelKey(m) === key)
  if (exact) return exact
  const byId = models.filter((m) => m.id === key)
  return byId.length === 1 ? byId[0]! : null
}

function SendButton({
  disabled,
  sendMode,
  onSendModeChange,
  allowQueue = true,
  density = 'default',
  stop,
}: {
  disabled: boolean
  sendMode: SendMode
  onSendModeChange(value: SendMode): void
  allowQueue?: boolean
  density?: 'default' | 'simple'
  stop?: { onClick?: () => void }
}): JSX.Element {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const showingStop = Boolean(stop)
  useLayoutEffect(() => {
    if (!menuOpen) return
    if (showingStop || !allowQueue) {
      setMenuOpen(false)
      return
    }
    const menu = menuRef.current
    const anchor = containerRef.current
    if (!menu || !anchor) return
    // Match HelpHint's native top layer: escape flip transforms and panel
    // clipping without moving the menu out of its face's inert/focus scope.
    menu.setAttribute('popover', 'manual')
    menu.showPopover?.()
    const rect = anchor.getBoundingClientRect()
    const width = Math.min(288, window.innerWidth - 16)
    const above = Math.max(0, rect.top - 16)
    const below = Math.max(0, window.innerHeight - rect.bottom - 16)
    menu.style.width = `${width}px`
    const useAbove = above >= Math.min(menu.getBoundingClientRect().height, below)
    menu.style.maxHeight = `${useAbove ? above : below}px`
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`
    menu.style.top = `${useAbove ? Math.max(8, rect.top - menu.getBoundingClientRect().height - 8) : rect.bottom + 8}px`
    return () => { if (menu.isConnected) menu.hidePopover?.() }
  }, [menuOpen, showingStop, allowQueue])
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: Event): void => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const close = (): void => setMenuOpen(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (menuRef.current?.contains(document.activeElement)) {
        containerRef.current?.querySelector<HTMLButtonElement>('[data-testid="send-mode-toggle"]')?.focus()
      }
      close()
    }
    const onScroll = (event: Event): void => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('focusin', onDocClick)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('focusin', onDocClick)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [menuOpen])

  const ModeIcon = sendMode === 'steer' ? Navigation : ListChecks
  const modeLabel = sendMode === 'steer' ? t('composer.steerActiveTurn') : t('composer.queueFollowUp')
  const modeHint =
    sendMode === 'steer'
      ? t('composer.steerHint')
      : t('composer.queueHint')
  const isSimple = density === 'simple'

  if (stop) {
    return (
      <Button
        type="button"
        onClick={stop.onClick}
        disabled={!stop.onClick}
        data-testid="composer-stop"
        className={cn(
          'flex-none rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90',
          isSimple ? 'h-10 w-10 p-0 shadow-[0_2px_8px_hsl(var(--destructive)/0.2)]' : 'h-10 px-4 text-sm font-medium',
        )}
        aria-label={t('chatStatus.stopTitle')}
        title={t('chatStatus.stopTitle')}
      >
        <Square className={cn('h-3.5 w-3.5', !isSimple && 'sm:mr-0')} aria-hidden="true" />
        <span className={isSimple ? 'sr-only' : 'hidden sm:inline'}>{t('chatStatus.stop')}</span>
      </Button>
    )
  }

  return (
    <div
      className="relative flex flex-none"
      ref={containerRef}
      data-testid="send-mode-control"
    >
      <Button
        type="submit"
        disabled={disabled}
        data-testid="composer-send"
        className={cn(
          !allowQueue
            ? 'h-10 min-w-10 rounded-xl p-0 text-sm font-medium shadow-sm'
            : 'h-10 min-w-10 rounded-r-none rounded-l-xl p-0 text-sm font-medium',
          disabled ? 'opacity-50' : '',
        )}
        aria-label={t('composer.sendMessage', { mode: modeLabel })}
        title={modeHint}
      >
        <ModeIcon className={cn('h-[18px] w-[18px]', 'sm:mr-1.5')} aria-hidden="true" />
        <span className="sr-only">{t('composer.send')}</span>
      </Button>
      {allowQueue ? <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className={cn(
          'flex flex-none items-center justify-center rounded-r-xl border-l border-primary-foreground/30 bg-primary text-primary-foreground transition-colors hover:bg-primary/90',
          isSimple ? 'h-10 w-7 px-0 shadow-sm' : 'h-10 w-7 px-0',
        )}
        data-testid="send-mode-toggle"
        aria-label={t('chat.transcript.sendMode')}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
      >
        {menuOpen ? (
          <ChevronUp className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        )}
      </button> : null}
      {menuOpen ? (
        <div
          ref={menuRef}
          className="fixed z-50 m-0 max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden rounded-lg border border-border/60 bg-popover text-xs shadow-lg"
          style={{ inset: 'auto', margin: 0 }}
          role="listbox"
          data-testid="send-mode-menu"
        >
          {(['steer', 'queue'] as const).map((mode) => {
            const Icon = mode === 'steer' ? Navigation : ListChecks
            const selected = sendMode === mode
            const label = mode === 'steer' ? t('composer.steerActiveTurn') : t('composer.queueFollowUp')
            const hint =
              mode === 'steer'
                ? t('composer.steerHint')
                : t('composer.queueHint')
            const longHint =
              mode === 'steer'
                ? t('composer.steerHint')
                : t('composer.queueHint')
            return (
              <button
                key={mode}
                type="button"
                role="option"
                aria-selected={selected}
                title={longHint}
                onPointerDown={(event) => {
                  event.preventDefault()
                  onSendModeChange(mode)
                  setMenuOpen(false)
                }}
                onClick={(event) => {
                  event.preventDefault()
                  if (event.detail === 0) {
                    onSendModeChange(mode)
                    setMenuOpen(false)
                  }
                }}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground',
                  selected ? 'bg-accent/60 text-accent-foreground' : 'text-foreground',
                )}
                data-testid={`send-mode-${mode}`}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{label}</span>
                  <span className="mt-0.5 block text-caption text-muted-foreground">
                    {hint}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function ComposerConfigButton({
  model,
  models,
  onModelChange,
  approvalMode,
  approvalModeLabel,
  onApprovalModeChange,
  composerMode,
  onComposerModeChange,
  sendMode,
  onSendModeChange,
  allowModelSelection,
  allowApprovalMode,
  allowQueue,
  className,
  appearance = 'icon',
}: {
  model: string
  models: readonly ModelInfo[]
  onModelChange(next: string): void
  approvalMode: ApprovalMode
  approvalModeLabel: string
  onApprovalModeChange(next: ApprovalMode): void
  composerMode: 'simple' | 'full'
  onComposerModeChange(): void
  sendMode: SendMode
  onSendModeChange(value: SendMode): void
  allowModelSelection: boolean
  allowApprovalMode: boolean
  allowQueue: boolean
  className?: string
  appearance?: 'icon' | 'menu'
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent): void => {
      if (!containerRef.current) return
      const target = event.target as Element | null
      if (containerRef.current.contains(target) || target?.closest('[data-composer-config-select]')) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const activeModel = modelInfoFor(models, model ?? '')
  const modelSummary = activeModel?.label ?? t('common.model')
  const approvalTone =
    approvalMode === 'allow_all'
      ? 'text-rose-600 dark:text-rose-300'
      : approvalMode === 'ask'
        ? 'text-amber-600 dark:text-amber-300'
        : 'text-muted-foreground'

  return (
    <div className={cn('relative flex-none', className)} ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('composer.config.open')}
        title={t('composer.config.open')}
        aria-expanded={open}
        data-testid="composer-config-trigger"
        className={cn(
          'relative inline-flex flex-none border-0 bg-transparent text-muted-foreground transition-colors active:text-foreground',
          appearance === 'menu'
            ? 'h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-accent hover:text-foreground'
            : 'h-11 w-10 items-center justify-center sm:h-10 sm:w-10 sm:rounded-xl sm:hover:bg-accent/70 sm:hover:text-foreground',
          open && 'text-foreground sm:bg-accent/70',
          appearance === 'icon' && approvalTone,
        )}
      >
        <SlidersHorizontal className="h-[18px] w-[18px] stroke-[1.75]" aria-hidden="true" />
        {appearance === 'menu' ? <span>{t('composer.config.title')}</span> : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('composer.config.title')}
          className="fixed inset-x-2 bottom-[5.5rem] z-30 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border/60 bg-popover p-3 text-xs shadow-lg sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-2 sm:w-[min(20rem,calc(100vw-1rem))]"
          data-testid="composer-config-popover"
        >
          <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            {t('composer.config.title')}
          </div>
          <div className="flex flex-col gap-3">
            {allowModelSelection ? <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-caption font-medium text-foreground">
                <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {t('common.model')}
                <span className="ml-auto truncate text-caption text-muted-foreground">{modelSummary}</span>
              </span>
              <Select
                value={activeModel ? model : ''}
                onValueChange={onModelChange}
                disabled={models.length === 0}
              >
                <SelectTrigger className="h-9 w-full" aria-label={t('common.model')}>
                  <SelectValue placeholder={models.length === 0 ? t('common.noModels') : t('common.model')} />
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]" data-composer-config-select="model">
                  {models.map((m) => {
                    const key = modelKey(m)
                    return (
                      <SelectItem key={key} value={key}>
                        {m.label}
                        {m.providerId ? <span className="ml-1 text-caption text-muted-foreground">{m.providerId}</span> : null}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </label> : null}

            {allowApprovalMode ? <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-caption font-medium text-foreground">
                <ShieldCheck className={cn('h-3.5 w-3.5', approvalTone)} aria-hidden="true" />
                {t('composer.approvalMode')}
                <span className={cn('ml-auto truncate text-caption', approvalTone)}>{approvalModeLabel}</span>
              </span>
              <select
                value={approvalMode}
                onChange={(event) => onApprovalModeChange(event.currentTarget.value as ApprovalMode)}
                aria-label={t('composer.approvalMode')}
                data-testid="composer-config-approval-native"
                className="h-9 w-full rounded border border-input bg-background px-2 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring sm:hidden"
              >
                {APPROVAL_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{approvalModeDisplay(m.value, t).label}</option>
                ))}
              </select>
              <div className="hidden sm:block">
                <Select
                  value={approvalMode}
                  onValueChange={(v) => onApprovalModeChange(v as ApprovalMode)}
                >
                  <SelectTrigger className="h-9 w-full" aria-label={t('composer.approvalMode')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]" data-composer-config-select="approval">
                    {APPROVAL_MODES.map((m) => {
                      const display = approvalModeDisplay(m.value, t)
                      return (
                        <SelectItem key={m.value} value={m.value} textValue={display.label}>
                          <div className="flex flex-col">
                            <span>{display.label}</span>
                            <span className="text-caption text-muted-foreground">{display.hint}</span>
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>
            </label> : null}

            {allowQueue ? <fieldset className="flex flex-col gap-1" data-testid="composer-config-send-mode">
              <legend className="flex w-full items-center gap-1.5 text-caption font-medium text-foreground">
                <Navigation className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {t('chat.transcript.sendMode')}
              </legend>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1">
                {(['steer', 'queue'] as const).map((value) => (
                  <button key={value} type="button" onPointerDown={(event) => { event.preventDefault(); onSendModeChange(value) }} onClick={(event) => { event.preventDefault(); if (event.detail === 0) onSendModeChange(value) }} className={cn('min-h-9 rounded-md px-2 text-xs font-medium', sendMode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')} aria-pressed={sendMode === value} data-testid={`composer-config-send-${value}`}>
                    {value === 'steer' ? t('composer.steerActiveTurn') : t('composer.queueFollowUp')}
                  </button>
                ))}
              </div>
            </fieldset> : null}

            <label className="flex flex-col gap-1" data-testid="composer-config-mode">
              <span className="flex items-center gap-1.5 text-caption font-medium text-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span>Composer layout</span>
                <span className="ml-auto truncate text-caption text-muted-foreground">
                  {composerMode === 'simple' ? t('composer.mode.toFull').replace(/[（(].*[)）]/, '').trim() : t('composer.mode.toSimple').replace(/[（(].*[)）]/, '').trim()}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  onComposerModeChange()
                  setOpen(false)
                }}
                data-testid="composer-config-mode-toggle"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background px-3 text-caption font-medium text-foreground hover:bg-accent"
              >
                {composerMode === 'simple' ? (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('composer.mode.toFull')}</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('composer.mode.toSimple')}</span>
                  </>
                )}
              </button>
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function queuedMessageSummary(item: QueuedMessagePreview, translate?: TFunction): string {
  const text = item.text.trim()
  const imageCount = item.content?.filter((part) => part.type === 'image').length ?? 0
  const files = item.content?.filter((part): part is FileContent => part.type === 'file') ?? []
  const imageTokens = Array.from({ length: imageCount }, (_, index) => translate
    ? translate('composer.queued.imageToken', { index: index + 1 })
    : `[Image #${index + 1}]`)
  const fileTokens = files.map((file) => translate
    ? translate('composer.queued.fileToken', { name: file.name })
    : `[File: ${file.name}]`)
  return [text, ...imageTokens, ...fileTokens].filter(Boolean).join(' ') || (translate ? translate('composer.queued.empty') : '(empty queued message)')
}

function QueuedMessagesDock({
  items,
  onReorder,
  onUpdate,
  onDelete,
}: {
  items: readonly QueuedMessagePreview[]
  onReorder?(id: string, beforeId?: string | null): Promise<void>
  onUpdate?(id: string, text: string, content?: readonly MessageContent[]): Promise<void>
  onDelete?(id: string): Promise<void>
}): JSX.Element | null {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<{ id: string; message: string; retry(): Promise<void> } | null>(null)
  if (items.length === 0) return null
  const beginEdit = (item: QueuedMessagePreview): void => {
    setEditingId(item.id)
    setDraft(item.text)
  }
  const runMutation = async (id: string, operation: () => Promise<void>): Promise<void> => {
    setPendingId(id)
    setOperationError(null)
    try {
      await operation()
    } catch (error) {
      setOperationError({ id, message: error instanceof Error ? error.message : String(error), retry: operation })
      throw error
    } finally {
      setPendingId(null)
    }
  }
  const commitEdit = (): void => {
    if (!editingId) return
    const trimmed = draft.trim()
    const item = items.find((candidate) => candidate.id === editingId)
    const hasAttachments = item?.content?.some((part) => part.type === 'image' || part.type === 'file') ?? false
    if ((trimmed.length > 0 || hasAttachments) && onUpdate) {
      const id = editingId
      void runMutation(id, () => onUpdate(id, trimmed, item?.content)).then(() => {
        setEditingId(null)
        setDraft('')
      }).catch(() => undefined)
    }
  }
  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }
  const move = (index: number, direction: -1 | 1): void => {
    const item = items[index]
    if (!item) return
    if (direction < 0) {
      const before = items[index - 1]
      if (before && onReorder) void runMutation(item.id, () => onReorder(item.id, before.id)).catch(() => undefined)
    } else {
      const afterNext = items[index + 2]
      if (onReorder) void runMutation(item.id, () => onReorder(item.id, afterNext?.id ?? null)).catch(() => undefined)
    }
  }
  return (
    <div
      className="mb-2 rounded-xl bg-muted/55 px-3 py-2 text-xs"
      data-testid="queued-messages-dock"
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
          <ListChecks className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          <span>
            {t('composer.queued.pending', { count: items.length })}
          </span>
        </div>
        <span className="flex-none text-caption text-muted-foreground">
          {t('composer.queued.sendsAfterActiveTurn')}
        </span>
      </div>
      <ScrollArea
        className={cn(items.length > QUEUED_MESSAGES_VISIBLE_LIMIT && 'h-40 max-h-40')}
        data-testid="queued-messages-scrollarea"
      >
        <div className="space-y-1 pr-3">
          {items.map((item, index) => (
            <div
              key={item.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-lg bg-background/85 px-2 py-1.5 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.35)]"
              data-testid="queued-message-row"
              title={queuedMessageSummary(item, t)}
              draggable={Boolean(onReorder)}
              onDragStart={(e) => {
                setDraggingId(item.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', item.id)
              }}
              onDragOver={(e) => {
                if (!onReorder) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                if (!onReorder) return
                e.preventDefault()
                const id = e.dataTransfer.getData('text/plain') || draggingId
                if (id && id !== item.id) void runMutation(id, () => onReorder(id, item.id)).catch(() => undefined)
                setDraggingId(null)
              }}
              onDragEnd={() => setDraggingId(null)}
            >
              <span className="mt-0.5 flex h-4 min-w-7 items-center justify-center gap-px rounded bg-muted font-mono text-caption text-muted-foreground">
                {onReorder ? <GripVertical className="h-2.5 w-2.5" aria-hidden="true" /> : null}
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="mb-0.5 flex items-center gap-1 text-caption text-muted-foreground">
                  <CornerDownRight className="h-3 w-3" aria-hidden="true" />
                  {item.mode === 'steer' ? t('composer.queued.steerLabel') : t('composer.queued.queueLabel')}
                </span>
                {editingId === item.id ? (
                  <span className="flex min-w-0 flex-col gap-1">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit()
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    className="h-6 w-full rounded border border-border/50 bg-background px-2 text-xs outline-none focus:border-ring"
                    data-testid="queued-message-edit-input"
                    placeholder={item.content?.some((part) => part.type === 'image' || part.type === 'file') ? 'Optional message text' : undefined}
                    autoFocus
                  />
                  {item.content?.some((part) => part.type === 'image' || part.type === 'file') ? (
                    <span className="truncate font-mono text-caption text-muted-foreground" data-testid="queued-message-edit-attachments">
                      {queuedMessageSummary({ ...item, text: '' }, t)}
                    </span>
                  ) : null}
                  </span>
                ) : (
                  <span className="block truncate text-foreground">
                    {queuedMessageSummary(item, t)}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-0.5" aria-busy={pendingId === item.id}>
                {editingId === item.id ? (
                  <>
                    <QueueAction label="save queued message" onClick={commitEdit} testId="queued-message-save">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="cancel edit" onClick={cancelEdit} testId="queued-message-cancel">
                      <X className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                  </>
                ) : (
                  <>
                    <QueueAction label="move queued message up" onClick={() => move(index, -1)} disabled={!onReorder || index === 0} testId="queued-message-up">
                      <ChevronUp className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="move queued message down" onClick={() => move(index, 1)} disabled={!onReorder || index === items.length - 1} testId="queued-message-down">
                      <ChevronDown className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="edit queued message" onClick={() => beginEdit(item)} disabled={!onUpdate} testId="queued-message-edit">
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="delete queued message" onClick={() => { if (onDelete) void runMutation(item.id, () => onDelete(item.id)).catch(() => undefined) }} disabled={!onDelete || pendingId === item.id} testId="queued-message-delete">
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                  </>
                )}
              </span>
            </div>
          ))}
          {operationError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive" role="alert" data-testid="queued-message-error">
              <span>{operationError.message}</span>{' '}
              <button type="button" className="font-medium underline" onClick={() => { void runMutation(operationError.id, operationError.retry).catch(() => undefined) }}>{t('common.retry')}</button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

function QueueAction({
  children,
  label,
  onClick,
  disabled,
  testId,
}: {
  children: React.ReactNode
  label: string
  onClick(): void
  disabled?: boolean
  testId: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  )
}

type MentionState = {
  start: number
  end: number
  query: string
}

type SlashCommand = {
  command: string
  icon: LucideIcon
  label: string
  description: string
  acceptsArgs?: boolean
  run(input: { args: string }): void
}

function parseSlashCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith('/')) return null
  const match = text.match(/^(\/\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { name: match[1]!, args: match[2] ?? '' }
}

function SlashCommandMenu({
  commands,
  disabled,
  className,
  onRun,
}: {
  commands: readonly SlashCommand[]
  disabled?: boolean
  className?: string
  onRun(cmd: SlashCommand): void
}): JSX.Element | null {
  if (disabled || commands.length === 0) return null
  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg', className)}
      data-testid="slash-command-menu"
    >
      {commands.map((cmd, index) => {
        const Icon = cmd.icon
        return (
          <button
            key={cmd.command}
            type="button"
            className="flex w-full items-start gap-3 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onRun(cmd)}
            data-testid={`slash-command-option-${index}`}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-primary">{cmd.command}</span>
                <span className="truncate text-foreground">{cmd.label}</span>
              </span>
              <span className="mt-0.5 block truncate text-caption text-muted-foreground">{cmd.description}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function HighlightText({ text, query }: { text: string; query: string }): JSX.Element {
  const needle = query.trim()
  if (!needle) return <>{text}</>
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (index === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-500/30" data-testid="mention-match-highlight">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  )
}

const MENTION_CHAR = /[A-Za-z0-9._\-\/@]/
const MENTION_PATH = /[A-Za-z0-9._\-\/]/

function detectMention(text: string, caret: number): MentionState | null {
  const clamped = Math.min(caret, text.length)
  let start = clamped
  while (start > 0 && MENTION_CHAR.test(text[start - 1] ?? '')) start -= 1
  const at = text[start]
  if (at !== '@') return null
  if (start > 0) {
    const prev = text[start - 1] ?? ''
    if (prev !== '' && !/\s/.test(prev)) return null
  }
  let end = clamped
  while (end < text.length && MENTION_CHAR.test(text[end] ?? '')) end += 1
  const raw = text.slice(start + 1, end)
  if (/[\s@]/.test(raw)) return null
  return { start, end, query: raw }
}

function collectMentionPaths(text: string): readonly string[] {
  const out: string[] = []
  const re = /(^|\s)@([A-Za-z0-9._\-\/]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const path = m[2]
    if (path && path.length > 0 && !path.startsWith('/')) out.push(path)
  }
  return out
}

export const __TESTABLE__ = {
  detectMention,
  collectMentionPaths,
  MENTION_PATH,
}
