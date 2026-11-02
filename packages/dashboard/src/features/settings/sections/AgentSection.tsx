import type {
  AgentPromptSlotId,
  ClientUpdateAgentPromptSettings,
  ServerSettingsPayload,
  SettingsAgentPromptSlot,
} from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../../../lib/utils.js'
import { EmptyRow, SectionHeader } from '../controls.js'

type Feedback = { kind: 'success' | 'error' | 'pending'; message: string } | null

type PromptUpdateError = Error & { settingsSaved?: boolean }

function settingsSavedPending(error: unknown): error is PromptUpdateError {
  return error instanceof Error && 'settingsSaved' in error && error.settingsSaved === true
}

function replaceSlot(
  slots: readonly SettingsAgentPromptSlot[],
  nextSlot: SettingsAgentPromptSlot,
): readonly SettingsAgentPromptSlot[] {
  return slots.map((slot) => slot.id === nextSlot.id ? nextSlot : slot)
}

type AgentSectionProps = {
  payload: ServerSettingsPayload
  onPayloadChange(payload: ServerSettingsPayload): void
}

export function AgentSection({ payload, onPayloadChange }: AgentSectionProps): JSX.Element {
  const scope = payload.agentPrompt?.configPath ?? 'unavailable'
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  return (
    <AgentSectionForScope
      key={scope}
      payload={payload}
      onPayloadChange={(next) => {
        // A save started in a previous organization may finish after switching accounts.
        if (scopeRef.current === scope && next.agentPrompt?.configPath === scope) onPayloadChange(next)
      }}
    />
  )
}

function AgentSectionForScope({ payload, onPayloadChange }: AgentSectionProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const agentPrompt = payload.agentPrompt
  const [editingSlotId, setEditingSlotId] = useState<AgentPromptSlotId | null>(agentPrompt?.slots[0]?.id ?? null)
  const [drafts, setDrafts] = useState<Partial<Record<AgentPromptSlotId, SettingsAgentPromptSlot>>>(() =>
    Object.fromEntries((agentPrompt?.slots ?? []).map((slot) => [slot.id, { ...slot }])),
  )
  const [dirtySlotIds, setDirtySlotIds] = useState<ReadonlySet<AgentPromptSlotId>>(() => new Set())
  const [saveFeedback, setSaveFeedback] = useState<Feedback>(null)
  const [defaultFeedback, setDefaultFeedback] = useState<Feedback>(null)

  useEffect(() => {
    if (!agentPrompt) return
    setDrafts((current) => {
      const next = { ...current }
      for (const slot of agentPrompt.slots) {
        if (!dirtySlotIds.has(slot.id)) next[slot.id] = { ...slot }
      }
      return next
    })
    setEditingSlotId((current) => current ?? agentPrompt.slots[0]?.id ?? null)
  }, [agentPrompt, dirtySlotIds])

  const postSettings = async (next: ClientUpdateAgentPromptSettings): Promise<ServerSettingsPayload> => {
    const res = await fetch('/settings/agent-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    })
    const body = await res.json() as ServerSettingsPayload | { error?: string; settingsSaved?: boolean }
    if (!res.ok) {
      const error = new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`) as PromptUpdateError
      if (res.status === 503 && 'settingsSaved' in body && body.settingsSaved === true) error.settingsSaved = true
      throw error
    }
    return body as ServerSettingsPayload
  }

  const saveSlot = useMutation({
    mutationFn: ({ settings }: { slotId: AgentPromptSlotId; settings: ClientUpdateAgentPromptSettings }) => postSettings(settings),
    onSuccess: (next, variables) => {
      setDirtySlotIds((current) => {
        const updated = new Set(current)
        updated.delete(variables.slotId)
        return updated
      })
      setSaveFeedback({ kind: 'success', message: t('settings.agent.saveSuccess') })
      onPayloadChange(next)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err, variables) => {
      if (settingsSavedPending(err)) {
        setDirtySlotIds((current) => {
          const updated = new Set(current)
          updated.delete(variables.slotId)
          return updated
        })
        if (agentPrompt) onPayloadChange({ ...payload, agentPrompt: { ...agentPrompt, ...variables.settings } })
        setSaveFeedback({ kind: 'pending', message: t('settings.agent.savedPending') })
        void queryClient.invalidateQueries({ queryKey: ['settings'] })
      } else {
        setSaveFeedback({ kind: 'error', message: t('settings.agent.saveFailed', { error: err instanceof Error ? err.message : String(err) }) })
      }
    },
  })

  const selectDefault = useMutation({
    mutationFn: postSettings,
    onSuccess: (next) => {
      setDefaultFeedback({ kind: 'success', message: t('settings.agent.defaultSuccess') })
      onPayloadChange(next)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err, variables) => {
      if (settingsSavedPending(err)) {
        if (agentPrompt) onPayloadChange({ ...payload, agentPrompt: { ...agentPrompt, ...variables } })
        setDefaultFeedback({ kind: 'pending', message: t('settings.agent.savedPending') })
        void queryClient.invalidateQueries({ queryKey: ['settings'] })
      } else {
        setDefaultFeedback({ kind: 'error', message: t('settings.agent.defaultFailed', { error: err instanceof Error ? err.message : String(err) }) })
      }
    },
  })

  if (!agentPrompt) {
    return (
      <div>
        <SectionHeader title={t('settings.sections.agent.label')} subtitle={t('settings.agent.subtitle')} />
        <EmptyRow>{t('settings.agent.unavailable')}</EmptyRow>
      </div>
    )
  }

  const editingSlot = editingSlotId ? drafts[editingSlotId] : undefined
  const persistedEditingSlot = editingSlotId
    ? agentPrompt.slots.find((slot) => slot.id === editingSlotId)
    : undefined
  const editingDirty = editingSlotId ? dirtySlotIds.has(editingSlotId) : false
  const busy = saveSlot.isPending || selectDefault.isPending

  const updateDraft = (patch: Partial<Pick<SettingsAgentPromptSlot, 'name' | 'prompt'>>): void => {
    if (!editingSlotId) return
    setDrafts((current) => {
      const slot = current[editingSlotId]
      return slot ? { ...current, [editingSlotId]: { ...slot, ...patch } } : current
    })
    setDirtySlotIds((current) => new Set(current).add(editingSlotId))
    setSaveFeedback(null)
  }

  return (
    <div>
      <SectionHeader title={t('settings.sections.agent.label')} subtitle={t('settings.agent.subtitle')} />
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {agentPrompt.slots.map((slot) => {
            const selected = slot.id === agentPrompt.selectedSlotId
            const editing = slot.id === editingSlotId
            const draft = drafts[slot.id] ?? slot
            return (
              <div
                key={slot.id}
                className={cn(
                  'flex min-h-36 flex-col rounded-md border border-border/50 p-3 transition-colors',
                  editing ? 'border-primary/70 bg-primary/5 ring-1 ring-primary/30' : 'border-border/50 bg-card/60',
                )}
                data-testid={`settings-agent-slot-${slot.id}`}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="truncate text-sm font-semibold text-foreground">{draft.name}</div>
                  {selected ? (
                    <span className="inline-flex flex-none items-center gap-1 text-xs font-medium text-primary">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('settings.agent.defaultBadge')}
                    </span>
                  ) : null}
                </div>
                {dirtySlotIds.has(slot.id) ? <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('settings.agent.unsaved')}</div> : null}
                <div className="mt-auto grid gap-2 pt-4">
                  <button
                    type="button"
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    onClick={() => {
                      setEditingSlotId(slot.id)
                      setSaveFeedback(null)
                    }}
                    disabled={busy}
                    data-testid={`settings-agent-edit-${slot.id}`}
                    aria-pressed={editing}
                  >
                    {editing ? t('settings.agent.editing') : t('settings.agent.editSlot')}
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                    onClick={() => {
                      setDefaultFeedback(null)
                      selectDefault.mutate({ selectedSlotId: slot.id, slots: agentPrompt.slots })
                    }}
                    disabled={busy || selected}
                    data-testid={`settings-agent-default-${slot.id}`}
                  >
                    {selected ? t('settings.agent.currentDefault') : t('settings.agent.useForNewSessions')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {defaultFeedback ? (
          <div
            className={cn('text-xs', defaultFeedback.kind === 'error' ? 'text-destructive' : defaultFeedback.kind === 'pending' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}
            role="status"
            data-testid="settings-agent-default-feedback"
          >
            {defaultFeedback.message}
          </div>
        ) : null}

        {editingSlot && persistedEditingSlot ? (
          <div className="space-y-3 rounded-md border border-border/50 bg-card/40 p-3 sm:p-4" data-testid="settings-agent-editor">
            <div className="text-sm font-semibold text-foreground">{t('settings.agent.editorTitle')}</div>
            <div className="space-y-1.5">
              <label htmlFor="settings-agent-slot-name" className="text-sm font-medium text-foreground">{t('settings.agent.slotName')}</label>
              <input
                id="settings-agent-slot-name"
                data-testid="settings-agent-slot-name"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={editingSlot.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                disabled={busy}
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="settings-agent-slot-prompt" className="text-sm font-medium text-foreground">{t('settings.agent.systemPrompt')}</label>
              <textarea
                id="settings-agent-slot-prompt"
                data-testid="settings-agent-slot-prompt"
                className="min-h-72 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-relaxed text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={editingSlot.prompt}
                onChange={(event) => updateDraft({ prompt: event.target.value })}
                disabled={busy}
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div
                className={cn('min-h-5 text-xs', saveFeedback?.kind === 'error' ? 'text-destructive' : saveFeedback?.kind === 'pending' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}
                role="status"
                data-testid="settings-agent-save-feedback"
              >
                {saveFeedback?.message ?? (editingDirty ? t('settings.agent.unsavedHint') : '')}
              </div>
              <button
                type="button"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                disabled={busy || !editingDirty || !editingSlot.name.trim() || !editingSlot.prompt.trim()}
                onClick={() => {
                  setSaveFeedback(null)
                  const nextSlot = { ...editingSlot, name: editingSlot.name.trim() }
                  saveSlot.mutate({
                    slotId: editingSlot.id,
                    settings: {
                      selectedSlotId: agentPrompt.selectedSlotId,
                      slots: replaceSlot(agentPrompt.slots, nextSlot),
                    },
                  })
                }}
                data-testid="settings-agent-slot-save"
              >
                {saveSlot.isPending ? t('settings.agent.saving') : t('settings.agent.saveSlot')}
              </button>
            </div>
          </div>
        ) : null}

        <div className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground ring-1 ring-border/50">
          <div>{t('settings.agent.appliesToNewSessions')}</div>
          <div className="mt-1 break-all font-mono">{agentPrompt.configPath}</div>
        </div>
      </div>
    </div>
  )
}
