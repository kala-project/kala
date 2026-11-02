import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useRef, useState } from 'react'
import { Check, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentRuntimeDescriptor, AgentRuntimeId, ModelInfo } from '@agent-kernel/shared'
import { HelpHint } from '../../components/ui/help-hint.js'
import type { MessageContent, ReferencedFileContent } from '@agent-kernel/kernel'
import { releaseMessageAttachments, uploadMessageAttachment } from '../../admission-client.js'
import { createSessionWithAck, type DashboardSocket } from '../../session.js'
import { randomId } from '../../lib/random-id.js'
import { PREF_AGENT_RUNTIME, readStringPref, writeStringPref } from '../../lib/prefs.js'
import { Button } from '../../components/ui/button.js'
import { isRecommendedRuntime, runtimeDisplayDescription, runtimeDisplayLabel } from '../../app-logic/agent-runtime-display.js'
import { Composer } from './Composer.js'
import type { ChatDisplayPrefs } from './chatDisplayPrefs.js'

const SIMPLE_CHAT_TOOLS = ['todo_graph', 'agent', 'websearch', 'memory'] as const
const EMPTY_ATTENTION = { sessionId: '', points: [], latest: null } as const

export type SimpleChatSubmission = {
  operationId: string
  text: string
  content?: readonly MessageContent[]
}

export function SimpleChatDraft({
  socket, host, token, agentRuntimes, models, preferredModel, displayPrefs, onCreated, onOpenVoiceSettings,
}: {
  socket: DashboardSocket | null
  host: string
  token?: string
  agentRuntimes: readonly AgentRuntimeDescriptor[]
  models: readonly ModelInfo[]
  preferredModel: string
  displayPrefs: ChatDisplayPrefs
  onCreated(sessionId: string, submission: SimpleChatSubmission): void
  onOpenVoiceSettings?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const [runtime, setRuntime] = useState(() => initialSimpleChatRuntime(agentRuntimes))
  const descriptor = agentRuntimes.find((item) => item.id === runtime && item.available)
    ?? agentRuntimes.find((item) => item.available)
  const [model, setModel] = useState<string | undefined>()
  const availableModels = descriptor?.models ?? (descriptor?.id === 'kernel' ? models : [])
  const selectedModel = model ?? (descriptor?.id === 'kernel' ? preferredModel : '')
  const [sessionId] = useState(randomId)
  const creationInput = useRef<Parameters<typeof createSessionWithAck>[1] | null>(null)
  const creating = useRef<Promise<void> | null>(null)
  const created = useRef(false)
  const mounted = useRef(true)
  const inFlight = useRef<Promise<void> | null>(null)
  const [started, setStarted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const address = { host, ...(token ? { token } : {}), sessionId }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (started) return
    const stored = readStringPref(PREF_AGENT_RUNTIME, '')
    if ((stored === 'kernel' || stored === 'copilot') && agentRuntimes.some((item) => item.id === stored && item.available)) return
    const next = initialSimpleChatRuntime(agentRuntimes)
    setRuntime((current) => current === next ? current : next)
  }, [agentRuntimes, started])

  const ensureSession = async (): Promise<void> => {
    if (created.current) return
    if (!socket?.connected) throw new Error(t('app.socketNotConnected'))
    if (!descriptor) throw new Error(t('dialogs.runtimeTemporarilyReadOnly'))
    // A lost acknowledgement must retry the same session and runtime, never
    // create a second conversation or silently change the first one's engine.
    if (!creationInput.current) {
      creationInput.current = {
        sessionId, agentRuntime: descriptor.id, tools: SIMPLE_CHAT_TOOLS,
        ...(selectedModel ? { selectedModel } : {}),
      }
      setStarted(true)
    }
    creating.current ??= createSessionWithAck(socket, creationInput.current)
    try {
      await creating.current
      created.current = true
    } finally {
      creating.current = null
    }
  }

  const deliver = (submission: SimpleChatSubmission): Promise<void> => {
    if (inFlight.current) return inFlight.current
    setBusy(true)
    setError(null)
    const operation = (async () => {
      try {
        await ensureSession()
        if (mounted.current) onCreated(sessionId, submission)
      } catch (cause) {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
        throw cause
      } finally {
        inFlight.current = null
        if (mounted.current) {
          setBusy(false)
        }
      }
    })()
    inFlight.current = operation
    return operation
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="simple-chat-draft">
      <ScrollArea className="min-h-0 flex-1 text-center" contentClassName="flex flex-col items-center justify-center px-6 py-8 min-h-full">
        <h1 className="flex items-center justify-center gap-1 text-2xl font-semibold tracking-tight sm:text-3xl">{t('chat.transcript.emptyTitle')}<HelpHint label={t('chat.transcript.emptyTitle')}>{t('chat.draft.description')}</HelpHint></h1>
        <div className="mt-6 flex max-w-full flex-wrap justify-center gap-2" role="radiogroup" aria-label={t('dialogs.chooseAgentRuntime')}>
          {agentRuntimes.map((item) => {
            const selected = descriptor?.id === item.id
            const label = runtimeDisplayLabel(t, item)
            const description = runtimeDisplayDescription(t, item)
            const recommended = isRecommendedRuntime(item)
            return <Button
              key={item.id}
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={selected}
              disabled={started || !item.available}
              title={item.available ? description : item.reason}
              data-testid={`draft-runtime-${item.id}`}
              onClick={() => {
                setRuntime(item.id)
                setModel(undefined)
                writeStringPref(PREF_AGENT_RUNTIME, item.id as AgentRuntimeId)
              }}
              className={selected
                ? 'h-auto min-h-10 gap-1.5 rounded-full border border-primary/65 bg-primary/15 px-3 py-1.5 text-primary shadow-sm ring-2 ring-primary/25 ring-offset-2 ring-offset-background hover:bg-primary/20 hover:text-primary'
                : 'h-auto min-h-10 rounded-full border border-transparent px-3 py-1.5 text-muted-foreground hover:border-border/50 hover:bg-accent hover:text-foreground'}
            >
              {selected ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
              <span className="flex min-w-0 flex-col items-start">
                <span className="flex items-center gap-1">
                  <span>{label}</span>
                  {recommended ? <span className="rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-caption font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">{t('dialogs.runtime.recommended')}</span> : null}
                  <HelpHint label={label} trigger={<span className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground" aria-label={description}><Info className="h-3.5 w-3.5" aria-hidden="true" /></span>}>{description}</HelpHint>
                </span>
              </span>
            </Button>
          })}
        </div>
      </ScrollArea>
      {error ? (
        <div role="alert" className="mx-4 mb-2 rounded-lg border border-border/50 bg-muted/50 p-3 text-sm" data-testid="draft-send-error">
          <p>{error}</p>
        </div>
      ) : null}
      <Composer
        disabled={!socket?.connected || !descriptor || busy}
        serviceUnavailable={!socket?.connected}
        onReconnectService={() => socket?.connect()}
        onOpenVoiceSettings={onOpenVoiceSettings}
        lockWhileSubmitting
        model={selectedModel}
        models={availableModels}
        onModelChange={setModel}
        allowModelSelection={!started && descriptor?.capabilities.modelSelection === true}
        approvalMode="auto"
        onApprovalModeChange={() => {}}
        allowApprovalMode={false}
        allowQueue={false}
        allowAttachments={descriptor?.capabilities.attachments === true}
        state={null}
        config={null}
        contextSnapshot={null}
        humanAttention={EMPTY_ATTENTION}
        queuedMessages={[]}
        displayPrefs={displayPrefs}
        onUploadFiles={async (files) => {
          await ensureSession()
          const uploaded: ReferencedFileContent[] = []
          try {
            for (const file of files) uploaded.push(await uploadMessageAttachment({ ...address, file }))
            return uploaded
          } catch (cause) {
            await releaseMessageAttachments({ ...address, files: uploaded }).catch(() => {})
            throw cause
          }
        }}
        onReleaseFiles={(files) => releaseMessageAttachments({ ...address, files })}
        onSubmit={(text, _mode, attachments = [], extras = []) => {
          const content = [...(text ? [{ type: 'text' as const, text }] : []), ...extras, ...attachments]
          return deliver({ operationId: randomId(), text, ...(attachments.length || extras.length ? { content } : {}) })
        }}
      />
    </div>
  )
}

function initialSimpleChatRuntime(agentRuntimes: readonly AgentRuntimeDescriptor[]): AgentRuntimeId {
  const stored = readStringPref(PREF_AGENT_RUNTIME, '')
  if (stored === 'kernel' || stored === 'copilot') {
    if (agentRuntimes.some((item) => item.id === stored && item.available)) return stored
  }
  const copilot = agentRuntimes.find((item) => item.id === 'copilot' && item.available)
  if (copilot) return copilot.id
  return agentRuntimes.find((item) => item.available)?.id ?? 'kernel'
}
