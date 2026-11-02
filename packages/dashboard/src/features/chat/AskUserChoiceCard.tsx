import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Check, CheckSquare2, HelpCircle, Loader2, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AskUserChoiceRequest } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { Textarea } from '../../components/ui/textarea.js'
import { cn } from '../../lib/utils.js'

export type AskUserChoiceDraft =
  | { kind: 'choice'; value: string }
  | { kind: 'choices'; values: readonly string[] }
  | { kind: 'custom'; text: string }

type Props = {
  sessionScope: string
  requests: readonly AskUserChoiceRequest[]
  onSubmit(callId: string, draft: AskUserChoiceDraft): Promise<void>
  onReject(callId: string): Promise<void>
}

type SubmissionPhase =
  | { kind: 'idle' }
  | { kind: 'submitting'; action: 'submit' | 'reject' }
  | { kind: 'accepted'; action: 'submit' | 'reject' }
  | { kind: 'error'; message: string }

export function AskUserChoiceCard({ sessionScope, requests, onSubmit, onReject }: Props): JSX.Element | null {
  const [current, setCurrent] = useState(0)
  const request = requests[current] ?? null

  useEffect(() => {
    if (requests.length === 0) {
      setCurrent(0)
      return
    }
    if (current >= requests.length) setCurrent(requests.length - 1)
  }, [current, requests.length])

  useEffect(() => {
    setCurrent(0)
  }, [sessionScope])

  if (!request) return null

  return (
    <AskUserChoiceRequestCard
      key={requestIdentity(sessionScope, request)}
      request={request}
      requestIdentity={requestIdentity(sessionScope, request)}
      current={current}
      total={requests.length}
      onSubmit={onSubmit}
      onReject={onReject}
    />
  )
}

function AskUserChoiceRequestCard({
  request,
  requestIdentity,
  current,
  total,
  onSubmit,
  onReject,
}: {
  request: AskUserChoiceRequest
  requestIdentity: string
  current: number
  total: number
  onSubmit: Props['onSubmit']
  onReject: Props['onReject']
}): JSX.Element {
  const { t } = useTranslation()
  const initialValues = useMemo(() => initialSelectedValues(request), [request])
  const [selectedValues, setSelectedValues] = useState<readonly string[]>(initialValues)
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const [phase, setPhase] = useState<SubmissionPhase>({ kind: 'idle' })
  const customInputRef = useRef<HTMLTextAreaElement>(null)
  const submissionLock = useRef(false)
  const generation = useRef(0)
  const disabled = phase.kind === 'submitting' || phase.kind === 'accepted'
  const trimmedCustomText = customText.trim()
  const canSubmit = customOpen ? trimmedCustomText.length > 0 : selectedValues.length > 0
  const selectedLabel = useMemo(() => {
    if (customOpen && trimmedCustomText.length > 0) return t('chat.askUser.customSelection')
    const labels = selectedValues.map((value) => (
      request.choices.find((choice) => choice.value === value)?.label ?? value
    ))
    return labels.join(', ')
  }, [customOpen, request.choices, selectedValues, t, trimmedCustomText])

  useEffect(() => {
    generation.current += 1
    submissionLock.current = false
    setSelectedValues(initialValues)
    setCustomOpen(false)
    setCustomText('')
    setPhase({ kind: 'idle' })
    return () => { generation.current += 1 }
  }, [initialValues, requestIdentity])

  useEffect(() => {
    if (customOpen) customInputRef.current?.focus()
  }, [customOpen])

  const clearError = (): void => {
    if (phase.kind === 'error') setPhase({ kind: 'idle' })
  }

  const selectChoice = (value: string): void => {
    if (request.multiple) {
      setSelectedValues((currentValues) => (
        currentValues.includes(value)
          ? currentValues.filter((candidate) => candidate !== value)
          : [...currentValues, value]
      ))
    } else {
      setSelectedValues([value])
    }
    setCustomOpen(false)
    clearError()
  }

  const runAction = async (action: 'submit' | 'reject'): Promise<void> => {
    if (submissionLock.current || disabled || (action === 'submit' && !canSubmit)) return
    submissionLock.current = true
    const actionGeneration = generation.current
    setPhase({ kind: 'submitting', action })
    try {
      if (action === 'reject') {
        await onReject(request.callId)
      } else if (customOpen) {
        await onSubmit(request.callId, { kind: 'custom', text: trimmedCustomText })
      } else if (request.multiple) {
        await onSubmit(request.callId, { kind: 'choices', values: selectedValues })
      } else {
        await onSubmit(request.callId, { kind: 'choice', value: selectedValues[0] ?? '' })
      }
      if (generation.current === actionGeneration) setPhase({ kind: 'accepted', action })
    } catch (error) {
      if (generation.current !== actionGeneration) return
      submissionLock.current = false
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div
      className={cn(
        'flex w-full max-w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card text-card-foreground shadow-sm',
        'supports-[backdrop-filter]:bg-card/95',
      )}
      data-testid="ask-user-choice-card"
      role="dialog"
      aria-label={t('chat.askUser.requiredAria')}
      aria-busy={phase.kind === 'submitting'}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.defaultPrevented) return
        const target = event.target as HTMLElement
        if (target.closest('textarea, button, input, label')) return
        void runAction('submit')
      }}
    >
      <div
        className="flex min-w-0 items-center gap-1.5 border-b border-border/55 bg-muted/20 px-2.5 py-1"
        data-testid="ask-user-choice-meta"
      >
        <HelpCircle className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground" data-testid="ask-user-choice-required">
          {t('chat.askUser.required')}
        </span>
        {request.multiple ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <span aria-hidden="true">·</span>
            <CheckSquare2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('chat.askUser.multiple')}
          </span>
        ) : null}
        {total > 1 ? (
          <span className="ml-auto flex-none text-xs font-medium tabular-nums text-muted-foreground" data-testid="ask-user-choice-index">
            {t('chat.askUser.index', { current: current + 1, total })}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1.5 p-2" data-testid="ask-user-choice-body">
        <div className="min-w-0" data-testid="ask-user-choice-prompt">
          <p
            className="break-words text-[15px] font-semibold leading-[1.5] text-foreground"
            data-testid="ask-user-choice-message"
          >
            {request.message}
          </p>
        </div>

        <fieldset className="grid min-w-0 gap-0.5" aria-label={request.message} data-testid="ask-user-choice-list">
          <legend className="sr-only">{request.message}</legend>
          {request.choices.map((choice, index) => {
            const active = !customOpen && selectedValues.includes(choice.value)
            const descriptionId = choice.description
              ? `ask-user-choice-${request.callId}-${index}-description`
              : undefined
            return (
              <label
                key={choice.value}
                className={cn(
                  'group flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border/50 px-2 py-1.5 text-left transition-colors',
                  'focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-primary/25',
                  disabled && 'cursor-not-allowed opacity-60',
                  active
                    ? 'border-primary/45 bg-primary/[0.07] ring-1 ring-primary/15'
                    : 'border-border/65 bg-background/35 hover:border-border/50 hover:bg-muted/45',
                )}
                data-testid={`ask-user-choice-row-${choice.value}`}
                data-selected={active ? 'true' : 'false'}
              >
                <span className="relative flex h-5 w-5 flex-none items-center justify-center">
                  <input
                    type={request.multiple ? 'checkbox' : 'radio'}
                    name={`ask-user-choice-${encodeURIComponent(requestIdentity)}`}
                    value={choice.value}
                    checked={active}
                    aria-checked={active}
                    aria-describedby={descriptionId}
                    disabled={disabled}
                    data-testid={`ask-user-choice-option-${choice.value}`}
                    onChange={() => { selectChoice(choice.value) }}
                    className={cn(
                      'peer h-4 w-4 cursor-pointer appearance-none border border-border/50 bg-background outline-none transition',
                      'focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
                      request.multiple ? 'rounded' : 'rounded-full',
                      active && 'border-primary bg-primary',
                    )}
                  />
                  {request.multiple ? (
                    <Check
                      className="pointer-events-none absolute h-3 w-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
                      strokeWidth={3}
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="pointer-events-none absolute h-1.5 w-1.5 rounded-full bg-primary-foreground opacity-0 peer-checked:opacity-100"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span
                  className="flex min-w-0 flex-1 items-start gap-1.5"
                  data-testid={`ask-user-choice-content-${choice.value}`}
                >
                  <span
                    className="max-w-[42%] flex-none truncate text-[0.9375rem] font-semibold leading-5 text-foreground"
                    data-testid={`ask-user-choice-title-${choice.value}`}
                    title={choice.label ?? choice.value}
                  >
                    {choice.label ?? choice.value}
                  </span>
                  {choice.description ? (
                    <span
                      id={descriptionId}
                      className="line-clamp-2 min-w-0 flex-1 whitespace-pre-line break-words text-[0.9375rem] font-normal leading-5 text-muted-foreground"
                      data-testid={`ask-user-choice-description-${choice.value}`}
                      title={choice.description}
                    >
                      {choice.description}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </fieldset>

        {customOpen ? (
          <div
            className="ak-expand-in min-w-0 rounded-md border border-primary/35 bg-primary/[0.05] p-1.5 ring-1 ring-primary/10"
            data-testid="ask-user-choice-custom"
            data-selected="true"
          >
            <label
              className="sr-only"
              htmlFor={`ask-user-choice-custom-${request.callId}`}
            >
              {t('chat.askUser.customSelection')}
            </label>
            <Textarea
              ref={customInputRef}
              id={`ask-user-choice-custom-${request.callId}`}
              aria-label={t('chat.askUser.customSelection')}
              value={customText}
              onChange={(event) => {
                setCustomText(event.target.value)
                clearError()
              }}
              disabled={disabled}
              maxLength={4000}
              rows={1}
              placeholder={t('chat.askUser.customPlaceholder')}
              data-testid="ask-user-choice-custom-input"
              className="min-h-10 resize-y border-border/70 bg-background text-sm leading-5 placeholder:text-muted-foreground focus-visible:ring-primary/35"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setCustomOpen(false)
                  clearError()
                  return
                }
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void runAction('submit')
                }
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCustomOpen(true)
              clearError()
            }}
            disabled={disabled}
            data-testid="ask-user-choice-custom-option"
            className="inline-flex h-7 w-fit max-w-full items-center gap-1 rounded-md px-1.5 text-sm font-medium text-muted-foreground outline-none transition hover:bg-muted/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4 flex-none" aria-hidden="true" />
            <span className="break-words text-left">{t('chat.askUser.customLabel')}</span>
          </button>
        )}

        {phase.kind === 'error' ? (
          <p className="text-sm leading-5 text-destructive" role="alert" data-testid="ask-user-choice-error">
            {t('chat.askUser.submitError', { error: phase.message })}
          </p>
        ) : null}
        {phase.kind === 'submitting' ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid="ask-user-choice-status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {phase.action === 'submit' ? t('chat.askUser.submitting') : t('chat.askUser.rejecting')}
          </p>
        ) : null}
        {phase.kind === 'accepted' ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid="ask-user-choice-status">
            <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            {phase.action === 'submit' ? t('chat.askUser.submitted') : t('chat.askUser.rejected')}
          </p>
        ) : null}

        <div className="flex min-w-0 items-center justify-end gap-1.5 border-t border-border/50 pt-1.5" data-testid="ask-user-choice-footer">
          <span className="sr-only" aria-live="polite">
            {selectedLabel ? t('chat.askUser.selected', { value: selectedLabel }) : t('chat.askUser.nothingSelected')}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => { void runAction('reject') }}
              disabled={disabled}
              data-testid="ask-user-choice-reject-all"
              className="h-7 flex-none border-border/70 px-2.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="mr-1 h-4 w-4" aria-hidden="true" />
              {t('chat.askUser.rejectAll')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => { void runAction('submit') }}
              disabled={disabled || !canSubmit}
              data-testid="ask-user-choice-submit"
              className="h-7 flex-none bg-primary px-3 text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              {phase.kind === 'submitting' && phase.action === 'submit' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="mr-1 h-4 w-4" aria-hidden="true" />
              )}
              {t('chat.askUser.confirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function initialSelectedValues(request: AskUserChoiceRequest): readonly string[] {
  const available = new Set(request.choices.map((choice) => choice.value))
  if (request.multiple) {
    const defaults = request.defaultValues?.filter((value) => available.has(value)) ?? []
    if (defaults.length > 0) return defaults
  }
  const initial = request.defaultValue ?? request.choices[0]?.value
  return initial && available.has(initial) ? [initial] : []
}

function requestIdentity(sessionScope: string, request: AskUserChoiceRequest): string {
  return JSON.stringify([
    sessionScope,
    request.sessionId,
    request.callId,
    request.message,
    request.intent ?? null,
    request.multiple ?? false,
    request.defaultValue ?? null,
    request.defaultValues ?? null,
    request.choices.map((choice) => [choice.value, choice.label ?? null, choice.description ?? null]),
  ])
}
