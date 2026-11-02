import { useEffect, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { JsonBlock } from '../../components/ui/json-block.js'
import { ProductState } from '../../components/ui/product-state.js'
import { cn } from '../../lib/utils.js'
import { arrayField, arrayLength, asRecord, booleanField, formatBytes, formatBytesMetric, formatConfidence, formatDurationMetric, formatInteger, numberField, stringField } from './artifact-model.js'
import { artifactRequest, downloadArtifact } from './artifact-client.js'
import { CodeBlock } from '../chat/CodeBlock.js'

export type ArtifactManifestEntry = {
  path: string
  kind: string
  mediaType: string
  bytes: number
  mtime: string
  sha256?: string
  hashSkippedReason?: string
}

export type ArtifactManifest = {
  schemaVersion: 1
  generatedAt: string
  rootDir: string
  entries: ArtifactManifestEntry[]
  summary: {
    entryCount: number
    totalBytes: number
    hashedCount: number
    hashSkippedCount: number
    kinds: Record<string, number>
  }
  page?: {
    limit: number
    returnedEntries: number
    totalEntries: number
    hasMore: boolean
    nextCursor?: string
    snapshotId: string
  }
}

type ArtifactContentResponse = {
  path: string
  mediaType: string
  body: unknown
}


type EnhancementActionResponse = Record<string, unknown> & { action?: string; error?: string }

type TextEnhancementActionField = {
  kind?: 'text'
  key: string
  label: string
  placeholder?: string
  required?: boolean
  defaultValue?: string
  numeric?: boolean
  boolean?: boolean
  list?: boolean
}

type UploadEnhancementActionField = {
  kind: 'upload'
  key: string
  label: string
  contentKey: string
  accept?: string
  maxBytes?: number
  placeholder?: string
  required?: boolean
}

type SessionEnhancementActionField = {
  kind: 'session'
  key: string
  label: string
  contentKey?: string
  required?: boolean
  placeholder?: string
}

type EnhancementActionField =
  | TextEnhancementActionField
  | UploadEnhancementActionField
  | SessionEnhancementActionField

type EnhancementActionConfig = {
  action: string
  label: string
  fields: readonly EnhancementActionField[]
}

export type SessionProfile = {
  sessionId?: string
  llmCalls?: number
  toolCalls?: number
  failedToolResults?: number
  llmTraceMissingCalls?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  models?: readonly string[]
  wallTimeMs?: number
  llmLatencyCalls?: number
  averageLlmDurationMs?: number
  p95LlmDurationMs?: number
  averageTimeToFirstChunkMs?: number
  p95TimeToFirstChunkMs?: number
}

export type ProfileRow = {
  path: string
  profile: SessionProfile
}

type MemoryIndexEntry = {
  scope?: 'workspace' | 'global'
  key?: string
  path?: string
  bytes?: number
  status?: 'active' | 'tombstoned'
  name?: string
  description?: string
  type?: string
  source?: string
  confidence?: number
  generatedAt?: string
  sessionId?: string
  deletedAt?: string
  archivedPath?: string
}

type MemoryStaleWarning = {
  scope?: 'workspace' | 'global'
  key?: string
  path?: string
  generatedAt?: string
  ageDays?: number
  reasonCode?: string
}

type MemoryConflictWarning = {
  reasonCode?: string
  key?: string
  name?: string
  entries?: readonly { scope?: string; key?: string; path?: string }[]
}

export type MemoryIndex = {
  generatedAt?: string
  entries?: readonly MemoryIndexEntry[]
  warnings?: readonly string[]
  staleWarnings?: readonly MemoryStaleWarning[]
  conflictWarnings?: readonly MemoryConflictWarning[]
}

export type MemoryIndexRow = {
  path: string
  index: MemoryIndex
}

export type OpsArtifactKind =
  | 'reliability_audit'
  | 'reliability_chaos'
  | 'rl_rollout_sidecar'
  | 'rl_token_segments'
  | 'rl_adapter'
  | 'subagent_graph'
  | 'trace'
  | 'message_assembly'
  | 'router_decision'
  | 'tool_catalog'

export type OpsArtifactRow = {
  path: string
  kind: OpsArtifactKind
  body: Record<string, unknown>
}

export type ArtifactDetailRequest = {
  path: string
  label: string
}


export function ArtifactInventory({
  manifest,
  kindRows,
  error,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onOpenArtifact,
}: {
  manifest: ArtifactManifest | null
  kindRows: readonly [string, number][]
  error: string | null
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore(): void
  onOpenArtifact(request: ArtifactDetailRequest): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
          <aside className="flex-none border-b border-border/30 bg-muted/10 p-3 sm:p-4">
            {manifest ? (
              <div className="ak-metric-strip text-xs">
                <Stat label={t('artifacts.inventory.files')} value={String(manifest.summary.entryCount)} />
                <Stat label={t('artifacts.inventory.bytes')} value={formatBytes(manifest.summary.totalBytes)} />
                <Stat label={t('artifacts.inventory.hashed')} value={`${manifest.summary.hashedCount}/${manifest.summary.entryCount}`} />
                <details className="rounded-xl bg-card/70 px-3 py-2 ring-1 ring-border/35">
                  <summary className="cursor-pointer text-caption font-medium text-muted-foreground">{t('artifacts.inventory.kinds')}</summary>
                  <div className="mt-2 grid gap-1">
                    {kindRows.map(([kind, count]) => (
                      <div key={kind} className="flex items-center justify-between gap-2 font-mono text-caption">
                        <span className="truncate">{kind}</span>
                        <span className="text-muted-foreground">{count}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ) : !loading ? (
              <div className="text-xs text-muted-foreground">{t('artifacts.inventory.noManifest')}</div>
            ) : null}
          </aside>
          <div className="min-h-0 flex-1 p-3 sm:p-4">
            {error && !manifest ? <ProductState compact kind="error" title={t('artifacts.state.errorTitle')} description={error} /> : null}
            {error && manifest ? <InlineDataNotice kind="error">{error}</InlineDataNotice> : null}
            {loading && !manifest ? <ProductState compact kind="loading" title={t('artifacts.state.loadingTitle')} description={t('artifacts.inventory.loadingManifest')} /> : null}
            {manifest ? (
              <>
              <ArtifactGallery entries={manifest.entries} onOpenArtifact={onOpenArtifact} />
              <div className="divide-y divide-border/35 overflow-hidden rounded-xl bg-card/70 ring-1 ring-border/40 md:hidden" data-testid="artifact-inventory-mobile-list">
                {manifest.entries.map((entry) => (
                  <button key={entry.path} type="button" onClick={() => onOpenArtifact({ path: entry.path, label: artifactDisplayName(entry.path) })} className="block w-full min-w-0 px-3 py-2 text-left hover:bg-muted/40">
                    <div className="truncate text-xs font-medium" title={entry.path}>{artifactDisplayName(entry.path)}</div>
                    <div className="mt-1 flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
                      <span className="truncate">{humanizeArtifactKind(entry.kind)}</span><span className="ml-auto flex-none">{formatBytes(entry.bytes)}</span>
                    </div>
                  </button>
                ))}
              </div>
              <ScrollArea className="hidden h-full overflow-hidden rounded-xl bg-card/55 ring-1 ring-border/40 md:block">
                <div className="min-w-[620px] divide-y divide-border text-xs">
                  <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(120px,0.7fr)_100px] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                    <div>{t('artifacts.inventory.path')}</div>
                    <div>{t('artifacts.inventory.kind')}</div>
                    <div>{t('artifacts.inventory.size')}</div>
                  </div>
                  {manifest.entries.map((entry) => (
                    <button key={entry.path} type="button" onClick={() => onOpenArtifact({ path: entry.path, label: artifactDisplayName(entry.path) })} className="grid w-full grid-cols-[minmax(0,1.6fr)_minmax(120px,0.7fr)_100px] gap-3 px-3 py-2 text-left hover:bg-muted/40">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium" title={entry.path}>{artifactDisplayName(entry.path)}</div>
                        <div className="mt-0.5 truncate font-mono text-caption text-muted-foreground">{artifactParentPath(entry.path)}</div>
                      </div>
                      <div className="text-caption text-muted-foreground">{humanizeArtifactKind(entry.kind)}</div>
                      <div className="font-mono text-caption">{formatBytes(entry.bytes)}</div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
              <PaginationFooter manifest={manifest} loadingMore={loadingMore} hasMore={hasMore} onLoadMore={onLoadMore} />
              </>
            ) : null}
          </div>
        </div>
  )
}

function ArtifactGallery({ entries, onOpenArtifact }: { entries: readonly ArtifactManifestEntry[]; onOpenArtifact(request: ArtifactDetailRequest): void }): JSX.Element | null {
  const featured = entries
    .filter((entry) => entry.mediaType.startsWith('text/') || entry.mediaType.includes('json') || entry.mediaType.startsWith('image/') || entry.kind.includes('report') || entry.kind.includes('profile'))
    .slice(0, 6)
  if (featured.length === 0) return null
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="artifact-gallery">
      {featured.map((entry) => (
        <button
          key={`gallery:${entry.path}`}
          type="button"
          onClick={() => onOpenArtifact({ path: entry.path, label: entry.path })}
          className="group relative overflow-hidden rounded-2xl border border-border/30 bg-card/60 p-4 text-left transition-colors hover:border-primary/25 hover:bg-card/78 motion-reduce:transform-none"
          data-testid="artifact-gallery-card"
        >
          <span className="absolute inset-x-0 top-0 h-px bg-primary/20 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
          <div className="flex items-start justify-between gap-3">
            <span className="rounded-full bg-primary/10 px-2 py-1 text-caption font-semibold uppercase tracking-wide text-primary">{artifactGalleryKind(entry)}</span>
            <span className="font-mono text-caption text-muted-foreground">{formatBytes(entry.bytes)}</span>
          </div>
          <div className="mt-3 line-clamp-2 break-words text-sm font-medium text-foreground">{artifactDisplayName(entry.path)}</div>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
            <span className="truncate font-mono">{artifactParentPath(entry.path)}</span>
            <span className="ml-auto flex-none">{formatBytes(entry.bytes)}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

function artifactGalleryKind(entry: ArtifactManifestEntry): string {
  if (entry.mediaType.startsWith('image/')) return 'image'
  if (entry.kind.includes('profile')) return 'profile'
  if (entry.kind.includes('report')) return 'report'
  if (entry.mediaType.includes('json')) return 'json'
  return humanizeArtifactKind(entry.kind || 'artifact')
}

function artifactDisplayName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

function artifactParentPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'Output'
}

function humanizeArtifactKind(kind: string): string {
  return kind.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function PaginationFooter({ manifest, loadingMore, hasMore, onLoadMore }: { manifest: ArtifactManifest; loadingMore: boolean; hasMore: boolean; onLoadMore(): void }): JSX.Element {
  const { t } = useTranslation()
  const total = manifest.page?.totalEntries ?? manifest.entries.length
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground" data-testid="artifact-pagination">
      <span>{t('artifacts.inventory.loaded', { loaded: manifest.entries.length, total })}</span>
      {hasMore ? <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? t('artifacts.inventory.loadingMore') : t('artifacts.inventory.loadMore')}</Button> : null}
    </div>
  )
}

function LabeledInput({ label, value, onChange, ...props }: { label: string; value: string; onChange(value: string): void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): JSX.Element {
  return (
    <label className="grid gap-1">
      <span className="text-caption font-medium text-muted-foreground">{label}</span>
      <Input value={value} onChange={(event) => onChange(event.currentTarget.value)} {...props} />
    </label>
  )
}

const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

type UploadFieldValue = {
  mode: 'paste' | 'upload'
  content: string
  filename?: string
  path?: string
}

const EMPTY_UPLOAD: UploadFieldValue = { mode: 'paste', content: '' }

function EnhancementActionPanel({ title, actions, onComplete }: { title: string; actions: readonly EnhancementActionConfig[]; onComplete(): void }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [selectedAction, setSelectedAction] = useState(actions[0]?.action ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<Record<string, UploadFieldValue>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EnhancementActionResponse | null>(null)
  const config = actions.find((action) => action.action === selectedAction) ?? actions[0]
  const configAction = config?.action
  const testIdPrefix = `enhancement-action-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

  useEffect(() => {
    if (!config) return
    const next: Record<string, string> = {}
    const nextUploads: Record<string, UploadFieldValue> = {}
    for (const field of config.fields) {
      if (isUploadField(field)) nextUploads[field.key] = { ...EMPTY_UPLOAD }
      else if (isTextField(field)) next[field.key] = field.defaultValue ?? ''
      else next[field.key] = ''
    }
    setValues(next)
    setUploads(nextUploads)
    setError(null)
    setResult(null)
  }, [configAction])

  if (!config) return <></>

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const activeConfig = config
    if (!activeConfig) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    const payload: Record<string, unknown> = { action: activeConfig.action }
    for (const field of activeConfig.fields) {
      if (isUploadField(field)) {
        const upload = uploads[field.key] ?? EMPTY_UPLOAD
        if (upload.path && upload.path.trim()) {
          payload[field.key] = upload.path.trim()
        } else if (upload.content && upload.content.length > 0) {
          const max = field.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES
          const bytes = new Blob([upload.content]).size
          if (bytes > max) {
            setError(t('artifacts.actionPanel.uploadTooLarge', { field: enhancementFieldLabel(t, field), max: formatBytes(max) }))
            setSubmitting(false)
            return
          }
          payload[field.contentKey] = upload.content
        } else if (field.required) {
          setError(t('artifacts.actionPanel.uploadRequired', { field: enhancementFieldLabel(t, field) }))
          setSubmitting(false)
          return
        }
        continue
      }
      const raw = values[field.key]?.trim() ?? ''
      if (!raw) continue
      if (isTextField(field) && field.boolean) payload[field.key] = raw === 'true'
      else if (isTextField(field) && field.numeric) payload[field.key] = Number(raw)
      else if (isTextField(field) && field.list) payload[field.key] = raw.split(',').map((item) => item.trim()).filter(Boolean)
      else payload[field.key] = raw
    }
    try {
      const res = await artifactRequest('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null) as EnhancementActionResponse | null
      if (!res.ok) throw new Error(body?.error ?? `enhancement action failed: ${res.status}`)
      setResult(body ?? {})
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-3 rounded-md border border-border/50 bg-background/70" data-testid={`enhancement-action-panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/30" onClick={() => setOpen((value) => !value)} data-testid={`${testIdPrefix}-toggle`}>
        <span className="font-medium">{title}</span>
        <span className="font-mono text-caption text-muted-foreground">{open ? t('artifacts.actionPanel.hide') : t('artifacts.actionPanel.show')}</span>
      </button>
      {open ? (
        <form onSubmit={(event) => void submit(event)} className="grid gap-3 border-t border-border/50 p-3 text-xs" data-testid={`${testIdPrefix}-form`}>
          <label className="grid gap-1">
            <span className="text-caption font-medium text-muted-foreground">{t('artifacts.actionPanel.action')}</span>
            <select className="h-8 rounded border border-input bg-background px-2 text-sm" value={selectedAction} onChange={(event) => setSelectedAction(event.currentTarget.value)} data-testid={`${testIdPrefix}-select`}>
              {actions.map((action) => <option key={action.action} value={action.action}>{enhancementActionLabel(t, action)}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
            {config.fields.map((field) => {
              if (isUploadField(field)) {
                return (
                  <UploadFieldControl
                    key={`${config.action}:${field.key}`}
                    field={field}
                    value={uploads[field.key] ?? EMPTY_UPLOAD}
                    onChange={(next) => setUploads((current) => ({ ...current, [field.key]: next }))}
                    testId={`${testIdPrefix}-upload-${field.key}`}
                  />
                )
              }
              const textField = field as TextEnhancementActionField
              return (
                <LabeledInput
                  key={`${config.action}:${field.key}`}
                  label={enhancementFieldLabel(t, textField)}
                  value={values[textField.key] ?? textField.defaultValue ?? ''}
                  onChange={(value) => setValues((current) => ({ ...current, [textField.key]: value }))}
                  required={textField.required}
                  placeholder={enhancementFieldPlaceholder(t, textField)}
                  inputMode={textField.numeric ? 'numeric' : undefined}
                  data-testid={`${testIdPrefix}-field-${textField.key}`}
                />
              )
            })}
          </div>
          {error ? <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300" data-testid={`${testIdPrefix}-error`}>{error}</div> : null}
          {result ? <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" data-testid={`${testIdPrefix}-result`}>{typeof result.shellCommand === 'string' ? t('artifacts.actionPanel.generated') : t('artifacts.actionPanel.created')}</div> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={submitting} data-testid={`${testIdPrefix}-submit`}>{submitting ? t('artifacts.actionPanel.running') : t('artifacts.actionPanel.runAction')}</Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

function isUploadField(field: EnhancementActionField): field is UploadEnhancementActionField {
  return (field as { kind?: string }).kind === 'upload'
}

function isTextField(field: EnhancementActionField): field is TextEnhancementActionField {
  const kind = (field as { kind?: string }).kind
  return kind === undefined || kind === 'text'
}

function enhancementActionLabel(t: TFunction, action: EnhancementActionConfig): string {
  return t(`artifacts.actionPanel.actions.${action.action}`, { defaultValue: action.label })
}

function enhancementFieldLabel(t: TFunction, field: EnhancementActionField): string {
  return t(`artifacts.actionPanel.fields.${field.key}.label`, { defaultValue: field.label })
}

function enhancementFieldPlaceholder(t: TFunction, field: EnhancementActionField): string | undefined {
  const fallback = isTextField(field) || isUploadField(field) ? field.placeholder : undefined
  if (!fallback) return undefined
  return t(`artifacts.actionPanel.fields.${field.key}.placeholder`, { defaultValue: fallback })
}

function UploadFieldControl({ field, value, onChange, testId }: { field: UploadEnhancementActionField; value: UploadFieldValue; onChange(next: UploadFieldValue): void; testId: string }): JSX.Element {
  const { t } = useTranslation()
  const label = enhancementFieldLabel(t, field)
  return (
    <div className="grid gap-1 rounded border border-border/50 bg-background/50 p-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-medium text-muted-foreground">{label}{field.required ? ' *' : ''}</span>
        <div className="flex gap-1">
          <button
            type="button"
            className={`h-6 rounded px-2 text-caption ${value.mode === 'paste' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            aria-pressed={value.mode === 'paste'}
            onClick={() => onChange({ mode: 'paste', content: value.content, filename: undefined, path: value.path })}
            data-testid={`${testId}-mode-paste`}
          >
            {t('artifacts.actionPanel.uploadPasteTab')}
          </button>
          <button
            type="button"
            className={`h-6 rounded px-2 text-caption ${value.mode === 'upload' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            aria-pressed={value.mode === 'upload'}
            onClick={() => onChange({ mode: 'upload', content: value.mode === 'upload' ? value.content : '', filename: value.filename, path: value.path })}
            data-testid={`${testId}-mode-upload`}
          >
            {t('artifacts.actionPanel.uploadFileTab')}
          </button>
        </div>
      </div>
      {value.mode === 'paste' ? (
        <textarea
          className="min-h-[60px] w-full rounded border border-input bg-background px-2 py-1 font-mono text-caption"
          rows={3}
          placeholder={enhancementFieldPlaceholder(t, field) ?? t('artifacts.actionPanel.uploadPastePlaceholder')}
          value={value.content}
          onChange={(event) => onChange({ mode: 'paste', content: event.currentTarget.value })}
          data-testid={`${testId}-textarea`}
        />
      ) : (
        <div className="grid gap-1">
          <input
            type="file"
            accept={field.accept}
            className="text-caption"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (!file) {
                onChange({ mode: 'upload', content: '', filename: undefined })
                return
              }
              const reader = new FileReader()
              reader.onload = () => {
                const text = typeof reader.result === 'string' ? reader.result : ''
                onChange({ mode: 'upload', content: text, filename: file.name })
              }
              reader.readAsText(file)
            }}
            data-testid={`${testId}-file`}
          />
          {value.filename ? <span className="font-mono text-caption text-muted-foreground" data-testid={`${testId}-filename`}>{value.filename} ({formatBytes(new Blob([value.content]).size)})</span> : null}
        </div>
      )}
    </div>
  )
}

const sessionFields: readonly EnhancementActionField[] = [
  { key: 'sessionId', label: 'Session ID', placeholder: 'current or target session id' },
  { kind: 'upload', key: 'sessionLogPath', contentKey: 'sessionLogContent', label: 'Session Log', accept: '.jsonl,.json,.txt', placeholder: 'paste JSONL or upload file (optional if Session ID set)' },
]

const profileActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'profile-session', label: 'Profile session', fields: sessionFields },
]

const memoryActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'memory-index', label: 'Build memory index', fields: [{ key: 'includeGlobal', label: 'Include Global', placeholder: 'true or false', boolean: true }] },
  { action: 'memory-retrieve', label: 'Retrieve memory (lexical)', fields: [
    { key: 'query', label: 'Query', required: true },
    { key: 'includeGlobal', label: 'Include Global', placeholder: 'true or false', boolean: true },
    { key: 'maxTokens', label: 'Max Tokens', placeholder: '2048', numeric: true },
    { key: 'maxHits', label: 'Max Hits', placeholder: '8', numeric: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
]

const opsActionConfigs: readonly EnhancementActionConfig[] = [
  { action: 'reliability-audit-session', label: 'Audit session reliability', fields: sessionFields },
  { action: 'reliability-chaos-replay', label: 'Replay reliability chaos', fields: [{ key: 'sessionLogPaths', label: 'Session Log Paths', required: true, placeholder: 'comma separated paths', list: true }] },
  { action: 'reliability-gate', label: 'Reliability gate', fields: [
    { kind: 'upload', key: 'chaosReportPath', contentKey: 'chaosReportContent', label: 'Chaos Report', accept: '.json' },
    { key: 'sessionLogPaths', label: 'Session Log Paths', placeholder: 'comma separated (if no chaos report)', list: true },
    { key: 'maxDanglingCount', label: 'Max Dangling Count', numeric: true },
    { key: 'minRecoverableRatio', label: 'Min Recoverable Ratio', numeric: true },
    { key: 'maxRecoveryEventCount', label: 'Max Recovery Event Count', numeric: true },
    { key: 'requireStatusIn', label: 'Require Status In', placeholder: 'comma separated (e.g. idle,done)', list: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'reliability-classify', label: 'Crash-kill classify', fields: [
    ...sessionFields,
    { kind: 'upload', key: 'heartbeatPath', contentKey: 'heartbeatContent', label: 'Heartbeat', accept: '.jsonl', required: true },
    { key: 'wedgedThresholdMs', label: 'Wedged Threshold (ms)', numeric: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'tool-catalog-diff', label: 'Tool catalog diff', fields: [
    { kind: 'upload', key: 'baselineCatalogPath', contentKey: 'baselineCatalogContent', label: 'Baseline Catalog', accept: '.json,.jsonl', required: true },
    { kind: 'upload', key: 'candidateCatalogPath', contentKey: 'candidateCatalogContent', label: 'Candidate Catalog', accept: '.json,.jsonl', required: true },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'executor-capabilities-snapshot', label: 'Executor capabilities snapshot', fields: [
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'trace-export-session', label: 'Export trace', fields: [...sessionFields, { key: 'runId', label: 'Run ID' }] },
  { action: 'rollout-export-segments', label: 'Export rollout segments', fields: [...sessionFields, { key: 'runId', label: 'Run ID' }] },
  { action: 'rollout-export-session', label: 'Export rollout sidecar', fields: [...sessionFields, { key: 'taskId', label: 'Task ID', required: true }, { key: 'frameworkTarget', label: 'Framework', required: true, placeholder: 'slime, verl, trl, openrlhf, unknown' }, { key: 'model', label: 'Model' }, { key: 'weightVersion', label: 'Weight Version' }, { kind: 'upload', key: 'rewardPath', contentKey: 'rewardContent', label: 'Reward', accept: '.json' }, { kind: 'upload', key: 'tokenSegmentsPath', contentKey: 'tokenSegmentsContent', label: 'Token Segments', accept: '.jsonl,.json' }] },
  { action: 'rollout-export-adapter', label: 'Export rollout adapter', fields: [{ kind: 'upload', key: 'sidecarPath', contentKey: 'sidecarContent', label: 'Sidecar', accept: '.json', required: true }, { key: 'frameworkTarget', label: 'Framework', placeholder: 'slime, verl, trl, openrlhf, unknown' }] },
  { action: 'subagents-graph', label: 'Export subagent graph', fields: [] },
  { action: 'trace-export-otlp', label: 'Export OTLP trace', fields: [
    ...sessionFields,
    { key: 'runId', label: 'Run ID' },
    { key: 'endpoint', label: 'OTLP Endpoint', placeholder: 'https://collector.example.com/v1/traces (blank writes bundle only)' },
    { key: 'headers', label: 'Headers', placeholder: 'e.g. authorization=Bearer xyz, X-Team=ml (comma separated key=value)' },
    { kind: 'upload', key: 'headersFilePath', contentKey: 'headersFileContent', label: 'Headers File', accept: '.json' },
    { key: 'retries', label: 'Retries', numeric: true },
    { key: 'retryDelayMs', label: 'Retry Delay (ms)', numeric: true },
    { key: 'timeoutMs', label: 'Timeout (ms)', numeric: true },
    { key: 'serviceName', label: 'Service Name' },
    { key: 'hostVersion', label: 'Host Version' },
    { key: 'outputFilename', label: 'Output Filename' },
  ] },
  { action: 'artifacts-manifest', label: 'Rebuild artifact manifest', fields: [
    { key: 'maxHashBytes', label: 'Max Hash Bytes', numeric: true, placeholder: 'default 25 MiB' },
  ] },
  { action: 'artifacts-prune', label: 'Prune artifact retention', fields: [
    { key: 'olderThanDays', label: 'Older Than (days)', numeric: true },
    { key: 'maxTotalBytes', label: 'Max Total Bytes', numeric: true, placeholder: 'oldest-first eviction' },
    { key: 'kinds', label: 'Kinds', placeholder: 'comma separated (e.g. profile,trace,memory_index)', list: true },
    { key: 'dryRun', label: 'Dry Run', placeholder: 'true or false', boolean: true },
  ] },
]

export function ArtifactContentDialog({
  request,
  onOpenChange,
  onOpenSession,
}: {
  request: ArtifactDetailRequest | null
  onOpenChange(open: boolean): void
  onOpenSession?(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const [content, setContent] = useState<ArtifactContentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!request) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)
    void fetchArtifactContent(request.path)
      .then((next) => {
        if (!cancelled) setContent(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [request])

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(720px,86dvh)] w-[min(980px,94vw)] max-w-none flex-col overflow-hidden p-0 gap-0">
        <DialogHeader className="border-b border-border/50 bg-muted/20 px-4 py-3">
          <DialogTitle>{t('artifacts.detail.title')}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{request?.label ?? ''}</DialogDescription>
        </DialogHeader>
        <div className="ak-reader-surface flex min-h-0 flex-1 flex-col p-3">
          {loading ? <div className="text-xs text-muted-foreground">{t('artifacts.detail.loading')}</div> : null}
          {error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
          {content ? <ArtifactBody content={content} /> : null}
          {request ? <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={() => void downloadArtifact(request.path)}>{t('artifacts.detail.download')}</Button>{onOpenSession && sessionIdFromArtifact(content?.body, request.path) ? <Button variant="outline" onClick={() => onOpenSession(sessionIdFromArtifact(content?.body, request.path)!)}>{t('artifacts.detail.openSession')}</Button> : null}</div> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ArtifactBody({ content }: { content: ArtifactContentResponse }): JSX.Element {
  if (content.mediaType.startsWith('application/json')) {
    return <JsonBlock label={content.path} value={content.body} collapsed={2} className="h-full [&>div:last-child]:max-h-[calc(86dvh-150px)] [&_[data-radix-scroll-area-viewport]]:max-h-[calc(86dvh-150px)]" />
  }
  return (
    <ScrollArea className="h-full rounded-xl border border-border/55 bg-background/65 p-3">
      <CodeBlock code={String(content.body)} lang={artifactLanguage(content.path, content.mediaType)} className="my-0" />
    </ScrollArea>
  )
}

function artifactLanguage(path: string, mediaType: string): string | undefined {
  if (mediaType.includes('yaml')) return 'yaml'
  if (mediaType.includes('xml')) return 'xml'
  if (mediaType.includes('markdown')) return 'markdown'
  if (mediaType.includes('javascript')) return 'javascript'
  if (mediaType.includes('typescript')) return 'typescript'
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    cjs: 'javascript',
    css: 'css',
    diff: 'diff',
    html: 'html',
    js: 'javascript',
    jsonl: 'json',
    jsx: 'jsx',
    log: 'log',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    rs: 'rust',
    sh: 'shell',
    ts: 'typescript',
    tsx: 'tsx',
    txt: 'text',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return map[ext]
}

export function ProfilesView({
  manifest,
  rows,
  error,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onArtifactActionComplete,
  onOpenSession,
}: {
  manifest: ArtifactManifest | null
  rows: readonly ProfileRow[]
  error: string | null
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore(): void
  onArtifactActionComplete(): void
  onOpenSession?(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const totals = rows.reduce((acc, row) => {
    acc.llmCalls += row.profile.llmCalls ?? 0
    acc.toolCalls += row.profile.toolCalls ?? 0
    acc.inputTokens += row.profile.totalInputTokens ?? 0
    acc.outputTokens += row.profile.totalOutputTokens ?? 0
    acc.latencyCalls += row.profile.llmLatencyCalls ?? 0
    return acc
  }, { llmCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, latencyCalls: 0 })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <aside className="flex-none border-b border-border/30 bg-muted/10 p-3 sm:p-4">
        <div className="ak-metric-strip text-xs">
          <Stat label={t('artifacts.profiles.profiles')} value={String(rows.length)} />
          <Stat label={t('artifacts.stats.llmCalls')} value={String(totals.llmCalls)} />
          <Stat label={t('artifacts.stats.toolCalls')} value={String(totals.toolCalls)} />
          <Stat label={t('artifacts.stats.inputTokens')} value={formatInteger(totals.inputTokens)} />
          <Stat label={t('artifacts.stats.outputTokens')} value={formatInteger(totals.outputTokens)} />
          <Stat label={t('artifacts.stats.latencyCalls')} value={String(totals.latencyCalls)} />
          <Stat label={t('artifacts.stats.artifacts')} value={String(manifest?.summary?.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 flex-1 p-3 sm:p-4">
        {error ? <InlineDataNotice kind="error">{error}</InlineDataNotice> : null}
        {loading ? <InlineDataNotice kind="loading">{manifest ? t('artifacts.inventory.loadingContent') : t('artifacts.inventory.loadingManifest')}</InlineDataNotice> : null}
        <EnhancementActionPanel title={t('artifacts.profiles.actions')} actions={profileActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error && !loading ? <ProductState compact kind="empty" title={t('artifacts.state.emptyTitle')} description={t('artifacts.profiles.none')} /> : null}
        {rows.length > 0 ? (
          <>
          <div className="divide-y divide-border/35 overflow-hidden rounded-xl bg-card/70 ring-1 ring-border/40 md:hidden" data-testid="profiles-mobile-list">
            {rows.map((row) => (
              <div key={row.path} className="min-w-0 px-3 py-2" role={row.profile.sessionId && onOpenSession ? 'button' : undefined} tabIndex={row.profile.sessionId && onOpenSession ? 0 : undefined} onClick={() => row.profile.sessionId && onOpenSession?.(row.profile.sessionId)} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && row.profile.sessionId) onOpenSession?.(row.profile.sessionId) }}>
                <div className="truncate font-mono text-xs">{row.profile.sessionId ?? row.path}</div>
                <div className="mt-1 truncate text-caption text-muted-foreground">{(row.profile.models ?? []).join(', ') || t('artifacts.fallback.unknown')}</div>
                <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-caption"><span>LLM {row.profile.llmCalls ?? 0}</span><span>Tools {row.profile.toolCalls ?? 0}</span><span className="text-right">{formatInteger((row.profile.totalInputTokens ?? 0) + (row.profile.totalOutputTokens ?? 0))} tok</span></div>
              </div>
            ))}
          </div>
          <ScrollArea className="hidden h-full overflow-hidden rounded-xl bg-card/55 ring-1 ring-border/40 md:block">
            <div className="min-w-[980px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[1.25fr_70px_70px_95px_95px_85px_85px_85px_85px] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>{t('artifacts.profiles.columns.profile')}</div>
                <div>{t('artifacts.profiles.columns.llm')}</div>
                <div>{t('artifacts.profiles.columns.tools')}</div>
                <div>{t('artifacts.profiles.columns.input')}</div>
                <div>{t('artifacts.profiles.columns.output')}</div>
                <div>{t('artifacts.profiles.columns.avgDur')}</div>
                <div>{t('artifacts.profiles.columns.p95Dur')}</div>
                <div>{t('artifacts.profiles.columns.avgTtft')}</div>
                <div>{t('artifacts.profiles.columns.p95Ttft')}</div>
              </div>
              {rows.map((row) => (
                <div key={row.path} className="grid grid-cols-[1.25fr_70px_70px_95px_95px_85px_85px_85px_85px] gap-3 px-3 py-2" role={row.profile.sessionId && onOpenSession ? 'button' : undefined} tabIndex={row.profile.sessionId && onOpenSession ? 0 : undefined} onClick={() => row.profile.sessionId && onOpenSession?.(row.profile.sessionId)} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && row.profile.sessionId) onOpenSession?.(row.profile.sessionId) }}>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-caption">{row.profile.sessionId ?? row.path}</div>
                    <div className="mt-0.5 truncate text-caption text-muted-foreground">{row.path} · {(row.profile.models ?? []).join(', ') || t('artifacts.fallback.unknown')} · {t('artifacts.fallback.missing')} {row.profile.llmTraceMissingCalls ?? 0}</div>
                  </div>
                  <div className="font-mono text-caption">{row.profile.llmCalls ?? 0}</div>
                  <div className="font-mono text-caption">{row.profile.toolCalls ?? 0}</div>
                  <div className="font-mono text-caption">{formatInteger(row.profile.totalInputTokens)}</div>
                  <div className="font-mono text-caption">{formatInteger(row.profile.totalOutputTokens)}</div>
                  <div className="font-mono text-caption">{formatDurationMetric(row.profile.averageLlmDurationMs)}</div>
                  <div className="font-mono text-caption">{formatDurationMetric(row.profile.p95LlmDurationMs)}</div>
                  <div className="font-mono text-caption">{formatDurationMetric(row.profile.averageTimeToFirstChunkMs)}</div>
                  <div className="font-mono text-caption">{formatDurationMetric(row.profile.p95TimeToFirstChunkMs)}</div>
                </div>
              ))}
            </div>
          </ScrollArea>
          </>
        ) : null}
        {manifest ? <PaginationFooter manifest={manifest} loadingMore={loadingMore} hasMore={hasMore} onLoadMore={onLoadMore} /> : null}
      </div>
    </div>
  )
}

export function MemoryView({
  manifest,
  rows,
  error,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onArtifactActionComplete,
  onOpenSession,
}: {
  manifest: ArtifactManifest | null
  rows: readonly MemoryIndexRow[]
  error: string | null
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore(): void
  onArtifactActionComplete(): void
  onOpenSession?(sessionId: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const entries = rows.flatMap((row) => (row.index.entries ?? []).map((entry) => ({ row, entry })))
  const totals = entries.reduce((acc, item) => {
    if (item.entry.scope === 'global') acc.global += 1
    else acc.workspace += 1
    if (item.entry.status === 'tombstoned') acc.tombstoned += 1
    else acc.active += 1
    return acc
  }, { active: 0, tombstoned: 0, workspace: 0, global: 0 })
  const warningCount = rows.reduce((sum, row) => sum + (row.index.warnings?.length ?? 0), 0)
  const staleCount = rows.reduce((sum, row) => sum + (row.index.staleWarnings?.length ?? 0), 0)
  const conflictCount = rows.reduce((sum, row) => sum + (row.index.conflictWarnings?.length ?? 0), 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <aside className="flex-none border-b border-border/30 bg-muted/10 p-3 sm:p-4">
        <div className="ak-metric-strip text-xs">
          <Stat label={t('artifacts.stats.indexes')} value={String(rows.length)} />
          <Stat label={t('artifacts.stats.active')} value={String(totals.active)} />
          <Stat label={t('artifacts.stats.tombstoned')} value={String(totals.tombstoned)} />
          <Stat label={t('artifacts.stats.workspace')} value={String(totals.workspace)} />
          <Stat label={t('artifacts.stats.global')} value={String(totals.global)} />
          <Stat label={t('artifacts.stats.warnings')} value={String(warningCount)} />
          <Stat label={t('artifacts.stats.stale')} value={String(staleCount)} />
          <Stat label={t('artifacts.stats.conflicts')} value={String(conflictCount)} />
          <Stat label={t('artifacts.stats.artifacts')} value={String(manifest?.summary?.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 flex-1 p-3 sm:p-4">
        {error ? <InlineDataNotice kind="error">{error}</InlineDataNotice> : null}
        {loading ? <InlineDataNotice kind="loading">{manifest ? t('artifacts.inventory.loadingContent') : t('artifacts.inventory.loadingManifest')}</InlineDataNotice> : null}
        <EnhancementActionPanel title={t('artifacts.memory.actions')} actions={memoryActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error && !loading ? <ProductState compact kind="empty" title={t('artifacts.state.emptyTitle')} description={t('artifacts.memory.none')} /> : null}
        {entries.length > 0 ? (
          <>
          <div className="divide-y divide-border/35 overflow-hidden rounded-xl bg-card/70 ring-1 ring-border/40 md:hidden" data-testid="memory-mobile-list">
            {entries.map(({ row, entry }, index) => (
              <div key={`${row.path}:${entry.scope ?? 'unknown'}:${entry.key ?? index}`} className="min-w-0 px-3 py-2" role={entry.sessionId && onOpenSession ? 'button' : undefined} tabIndex={entry.sessionId && onOpenSession ? 0 : undefined} onClick={() => entry.sessionId && onOpenSession?.(entry.sessionId)} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && entry.sessionId) onOpenSession?.(entry.sessionId) }}>
                <div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.key ?? t('artifacts.fallback.unknown')}</span><MemoryStatus status={entry.status} /></div>
                <div className="mt-1 line-clamp-2 text-caption text-muted-foreground">{entry.description ?? entry.name ?? '-'}</div>
                <div className="mt-1 flex min-w-0 gap-2 font-mono text-caption text-muted-foreground"><span>{entry.scope ?? t('artifacts.fallback.unknown')}</span><span>{formatConfidence(entry.confidence)}</span><span className="ml-auto max-w-[50%] truncate" title={entry.source ?? entry.path}>{entry.source ?? entry.path ?? '-'}</span></div>
              </div>
            ))}
          </div>
          <ScrollArea className="hidden h-full overflow-hidden rounded-xl bg-card/55 ring-1 ring-border/40 md:block">
            <div className="min-w-[980px] divide-y divide-border text-xs">
              <div className="grid grid-cols-[110px_110px_1fr_1.4fr_90px_130px_1fr] gap-3 bg-muted/40 px-3 py-2 font-medium text-muted-foreground">
                <div>{t('artifacts.memory.columns.scope')}</div>
                <div>{t('artifacts.memory.columns.status')}</div>
                <div>{t('artifacts.memory.columns.key')}</div>
                <div>{t('artifacts.memory.columns.description')}</div>
                <div>{t('artifacts.memory.columns.confidence')}</div>
                <div>{t('artifacts.memory.columns.session')}</div>
                <div>{t('artifacts.memory.columns.provenance')}</div>
              </div>
              {entries.map(({ row, entry }, index) => (
                <div key={`${row.path}:${entry.scope ?? 'unknown'}:${entry.key ?? index}`} className="grid grid-cols-[110px_110px_1fr_1.4fr_90px_130px_1fr] gap-3 px-3 py-2" role={entry.sessionId && onOpenSession ? 'button' : undefined} tabIndex={entry.sessionId && onOpenSession ? 0 : undefined} onClick={() => entry.sessionId && onOpenSession?.(entry.sessionId)} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && entry.sessionId) onOpenSession?.(entry.sessionId) }}>
                  <div className="font-mono text-caption">{entry.scope ?? t('artifacts.fallback.unknown')}</div>
                  <MemoryStatus status={entry.status} />
                  <div className="min-w-0">
                    <div className="truncate font-mono text-caption" title={entry.key}>{entry.key ?? t('artifacts.fallback.unknown')}</div>
                    <div className="mt-0.5 truncate text-caption text-muted-foreground" title={row.path}>{row.path}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate" title={entry.description ?? entry.name}>{entry.description ?? entry.name ?? '-'}</div>
                    <div className="mt-0.5 truncate font-mono text-caption text-muted-foreground">{entry.type ?? t('artifacts.fallback.memory')}</div>
                  </div>
                  <div className="font-mono text-caption">{formatConfidence(entry.confidence)}</div>
                  <div className="truncate font-mono text-caption text-muted-foreground" title={entry.sessionId}>{entry.sessionId ?? '-'}</div>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-caption" title={entry.path}>{entry.status === 'tombstoned' ? entry.deletedAt ?? t('artifacts.fallback.deleted') : entry.source ?? t('artifacts.fallback.unknown')}</div>
                    <div className="mt-0.5 truncate text-caption text-muted-foreground" title={entry.archivedPath ?? entry.path}>{entry.archivedPath ?? entry.path ?? '-'}</div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          </>
        ) : null}
        {manifest ? <PaginationFooter manifest={manifest} loadingMore={loadingMore} hasMore={hasMore} onLoadMore={onLoadMore} /> : null}
      </div>
    </div>
  )
}

function MemoryStatus({ status }: { status: MemoryIndexEntry['status'] | undefined }): JSX.Element {
  const { t } = useTranslation()
  if (status === 'tombstoned') return <div className="font-mono text-caption text-amber-700 dark:text-amber-300">{t('artifacts.memory.status.tombstoned')}</div>
  if (status === 'active') return <div className="font-mono text-caption text-emerald-700 dark:text-emerald-300">{t('artifacts.memory.status.active')}</div>
  return <div className="font-mono text-caption text-muted-foreground">{t('artifacts.memory.status.unknown')}</div>
}

export function OpsView({
  manifest,
  rows,
  error,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onOpenArtifact,
  onArtifactActionComplete,
}: {
  manifest: ArtifactManifest | null
  rows: readonly OpsArtifactRow[]
  error: string | null
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore(): void
  onOpenArtifact(request: ArtifactDetailRequest): void
  onArtifactActionComplete(): void
}): JSX.Element {
  const { t } = useTranslation()
  const groups = groupOpsRows(rows, t)
  const reliabilityIssues = rows.reduce((sum, row) => sum + opsIssueCount(row), 0)
  const rolloutReady = rows.filter((row) => row.kind === 'rl_adapter' && stringField(row.body, 'status') === 'ready').length
  const rolloutBlocked = rows.filter((row) => row.kind === 'rl_adapter' && stringField(row.body, 'status') === 'blocked').length
  const traceCount = rows.filter((row) => row.kind === 'trace' || row.kind === 'message_assembly').length
  const routerCount = rows.filter((row) => row.kind === 'router_decision' || row.kind === 'tool_catalog').length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <aside className="flex-none border-b border-border/30 bg-muted/10 p-3 sm:p-4">
        <div className="ak-metric-strip text-xs">
          <Stat label={t('artifacts.ops.artifacts')} value={String(rows.length)} />
          <Stat label={t('artifacts.ops.stats.reliabilityIssues')} value={String(reliabilityIssues)} />
          <Stat label={t('artifacts.ops.stats.rolloutReady')} value={String(rolloutReady)} />
          <Stat label={t('artifacts.ops.stats.rolloutBlocked')} value={String(rolloutBlocked)} />
          <Stat label={t('artifacts.ops.stats.traceContext')} value={String(traceCount)} />
          <Stat label={t('artifacts.ops.stats.routerTool')} value={String(routerCount)} />
          <Stat label={t('artifacts.ops.stats.artifacts')} value={String(manifest?.summary?.entryCount ?? 0)} />
        </div>
      </aside>
      <div className="min-h-0 flex-1 p-3 sm:p-4">
        {error ? <InlineDataNotice kind="error">{error}</InlineDataNotice> : null}
        {loading ? <InlineDataNotice kind="loading">{manifest ? t('artifacts.inventory.loadingContent') : t('artifacts.inventory.loadingManifest')}</InlineDataNotice> : null}
        <EnhancementActionPanel title={t('artifacts.ops.actions')} actions={opsActionConfigs} onComplete={onArtifactActionComplete} />
        {manifest && rows.length === 0 && !error && !loading ? <ProductState compact kind="empty" title={t('artifacts.state.emptyTitle')} description={t('artifacts.ops.none')} /> : null}
        {rows.length > 0 ? (
          <ScrollArea className="h-full overflow-hidden rounded-xl bg-card/55 ring-1 ring-border/40">
            <div className="divide-y divide-border/50 text-xs">
              {groups.map((group) => (
                <div key={group.label} className="grid gap-2 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{group.label}</div>
                    <div className="font-mono text-caption text-muted-foreground">{group.rows.length}</div>
                  </div>
                  <div className="grid gap-1.5">
                    {group.rows.map((row) => (
                      <button
                        key={row.path}
                        type="button"
                        onClick={() => onOpenArtifact({ path: row.path, label: row.path })}
                        className="grid min-w-0 gap-1 rounded-xl bg-background/55 px-3 py-2.5 text-left ring-1 ring-border/35 transition-all hover:bg-muted/40 hover:ring-border/60 md:grid-cols-[170px_minmax(0,1fr)_minmax(220px,0.8fr)] md:gap-3"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-caption font-medium">{opsKindLabel(row.kind)}</div>
                          <div className="mt-0.5 truncate text-caption text-muted-foreground" title={row.path}>{artifactDisplayName(row.path)}</div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{opsPrimary(row, t)}</div>
                          <div className="mt-0.5 truncate font-mono text-caption text-muted-foreground">{opsSecondary(row, t)}</div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-caption">{opsMetricLine(row, t)}</div>
                          <div className="mt-0.5 truncate text-caption text-muted-foreground">{opsStatusLine(row, t)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : null}
        {manifest ? <PaginationFooter manifest={manifest} loadingMore={loadingMore} hasMore={hasMore} onLoadMore={onLoadMore} /> : null}
      </div>
    </div>
  )
}

function groupOpsRows(rows: readonly OpsArtifactRow[], t: TFunction): Array<{ label: string; rows: OpsArtifactRow[] }> {
  const groups = new Map<string, OpsArtifactRow[]>()
  for (const row of rows) {
    const label = opsGroupLabel(row.kind, t)
    const existing = groups.get(label) ?? []
    existing.push(row)
    groups.set(label, existing)
  }
  return [...groups.entries()].map(([label, groupRows]) => ({ label, rows: groupRows }))
}

function InlineDataNotice({ kind, children }: { kind: 'loading' | 'error'; children: React.ReactNode }): JSX.Element {
  return <div className={cn('mb-3 rounded-lg px-3 py-2 text-xs', kind === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted/60 text-muted-foreground')} role={kind === 'error' ? 'alert' : 'status'} aria-live={kind === 'loading' ? 'polite' : undefined}>{children}</div>
}



function opsGroupLabel(kind: OpsArtifactKind, t: TFunction): string {
  if (kind === 'reliability_audit' || kind === 'reliability_chaos') return t('artifacts.ops.groups.reliability')
  if (kind === 'rl_rollout_sidecar' || kind === 'rl_token_segments' || kind === 'rl_adapter') return t('artifacts.ops.groups.agenticRl')
  if (kind === 'subagent_graph') return t('artifacts.ops.groups.subagents')
  if (kind === 'trace' || kind === 'message_assembly') return t('artifacts.ops.groups.traceContext')
  return t('artifacts.ops.groups.routerTools')
}

function opsKindLabel(kind: OpsArtifactKind): string {
  return kind.replace(/_/g, ' ')
}

function opsPrimary(row: OpsArtifactRow, t: TFunction): string {
  if (row.kind === 'reliability_audit') return stringField(row.body, 'sessionId') ?? t('artifacts.ops.labels.sessionAudit')
  if (row.kind === 'reliability_chaos') return t('artifacts.ops.labels.sessions', { count: numberField(row.body, 'sessionCount') ?? 0 })
  if (row.kind === 'rl_rollout_sidecar') return stringField(row.body, 'rollout_id') ?? t('artifacts.ops.labels.rolloutSidecar')
  if (row.kind === 'rl_token_segments') return stringField(row.body, 'sessionId') ?? t('artifacts.ops.labels.tokenSegments')
  if (row.kind === 'rl_adapter') return `${stringField(row.body, 'frameworkTarget') ?? stringField(row.body, 'framework_target') ?? t('artifacts.ops.labels.adapter')} ${stringField(row.body, 'status') ?? ''}`.trim()
  if (row.kind === 'subagent_graph') return t('artifacts.ops.labels.nodesEdges', { nodes: arrayLength(row.body.nodes), edges: arrayLength(row.body.edges) })
  if (row.kind === 'message_assembly') return stringField(row.body, 'sessionId') ?? t('artifacts.ops.labels.messageAssembly')
  if (row.kind === 'router_decision') return stringField(row.body, 'selectedModel') ?? t('artifacts.ops.labels.routerDecision')
  if (row.kind === 'tool_catalog') return t('artifacts.ops.labels.tools', { count: numberField(row.body, 'toolCount') ?? arrayLength(row.body.tools) })
  return stringField(row.body, 'sessionId') ?? 'trace'
}

function opsSecondary(row: OpsArtifactRow, t: TFunction): string {
  if (row.kind === 'reliability_audit') {
    const dangling = booleanField(row.body, 'dangling') ? stringField(row.body, 'danglingKind') ?? t('artifacts.ops.labels.yes') : t('artifacts.ops.labels.no')
    return t('artifacts.ops.labels.statusDangling', { status: stringField(row.body, 'status') ?? t('artifacts.ops.labels.unknown'), dangling })
  }
  if (row.kind === 'reliability_chaos') return t('artifacts.ops.labels.danglingRecovery', { dangling: numberField(row.body, 'danglingCount') ?? 0, recovery: numberField(row.body, 'recoveryEventCount') ?? 0 })
  if (row.kind === 'rl_rollout_sidecar') return t('artifacts.ops.labels.taskFramework', { task: stringField(row.body, 'task_id') ?? t('artifacts.ops.labels.task'), framework: stringField(row.body, 'framework_target') ?? t('artifacts.ops.labels.framework') })
  if (row.kind === 'rl_token_segments') return t('artifacts.ops.labels.segmentsTokenIds', { segments: arrayLength(row.body.segments), captureStatus: booleanField(row.body, 'tokenIdsCaptured') ? t('artifacts.ops.labels.captured') : t('artifacts.ops.labels.notCaptured') })
  if (row.kind === 'rl_adapter') return stringField(row.body, 'reason') ?? stringField(row.body, 'entrypoint') ?? t('artifacts.ops.labels.adapterArtifact')
  if (row.kind === 'subagent_graph') return t('artifacts.ops.labels.warnings', { count: arrayLength(row.body.warnings) })
  if (row.kind === 'message_assembly') return t('artifacts.ops.labels.messagesTools', { messages: numberField(row.body, 'messageCount') ?? 0, tools: numberField(row.body, 'toolCount') ?? 0 })
  if (row.kind === 'router_decision') return `${stringField(row.body, 'selectedProvider') ?? t('artifacts.ops.labels.providerUnknown')} / ${(arrayField(row.body, 'reasonCodes') ?? []).join(', ')}`
  if (row.kind === 'tool_catalog') return t('artifacts.ops.labels.registeredTools', { count: arrayLength(row.body.tools) })
  return t('artifacts.ops.labels.spans', { count: arrayLength(row.body.spans) })
}

function opsMetricLine(row: OpsArtifactRow, t: TFunction): string {
  if (row.kind === 'reliability_audit') return t('artifacts.ops.labels.integrityIssues', { count: opsIssueCount(row) })
  if (row.kind === 'rl_token_segments') return t('artifacts.ops.labels.compactionsSubagents', { compactions: numberField(asRecord(row.body.topology), 'compactionCount') ?? 0, subagents: numberField(asRecord(row.body.topology), 'subAgentCallCount') ?? 0 })
  if (row.kind === 'router_decision') {
    const policy = asRecord(row.body.toolPolicy)
    return t('artifacts.ops.labels.toolsSkillBacked', { tools: numberField(policy, 'toolCount') ?? 0, skillBacked: numberField(policy, 'skillBackedCount') ?? 0 })
  }
  if (row.kind === 'message_assembly') return t('artifacts.ops.labels.estimatedTokens', { count: numberField(row.body, 'estimatedTokens') ?? 0 })
  if (row.kind === 'tool_catalog') return t('artifacts.ops.labels.skillBacked', { count: arrayField(row.body, 'tools')?.filter((tool) => asRecord(tool).skillBacked === true).length ?? 0 })
  return `${formatBytesMetric(numberField(row.body, 'bytes'))}`
}

function opsStatusLine(row: OpsArtifactRow, t: TFunction): string {
  if (row.kind === 'rl_adapter') return stringField(row.body, 'status') ?? t('artifacts.ops.labels.unknown')
  if (row.kind === 'reliability_audit') return arrayLength(row.body.recoveryEventDetails) > 0 ? t('artifacts.ops.labels.recovered') : t('artifacts.ops.labels.noRecoveryEvents')
  if (row.kind === 'subagent_graph') return t('artifacts.ops.labels.derivedGraph')
  if (row.kind === 'trace') return t('artifacts.ops.labels.openInferenceTrace')
  return row.path
}

function opsIssueCount(row: OpsArtifactRow): number {
  if (row.kind === 'reliability_chaos') return numberField(row.body, 'danglingCount') ?? 0
  if (row.kind !== 'reliability_audit') return 0
  const integrity = asRecord(row.body.integrity)
  return arrayLength(integrity.duplicateToolCallIds) + arrayLength(integrity.duplicateToolResultIds) + arrayLength(integrity.toolResultsWithoutCall) + arrayLength(integrity.toolCallsWithoutResult)
}







function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-h-14 flex-col justify-center rounded-xl bg-card/70 px-3 py-2 ring-1 ring-border/35">
      <span className="text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
      <span className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}



















export async function fetchArtifactContent(path: string): Promise<ArtifactContentResponse> {
  const res = await artifactRequest(`/artifacts/content?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
  if (res.ok) return (await res.json()) as ArtifactContentResponse
  const body = await res.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error ?? `artifact content request failed: ${res.status}`)
}

export function sessionIdFromArtifact(body: unknown, path: string): string | undefined {
  const record = asRecord(body)
  for (const key of ['sessionId', 'session_id']) {
    const value = stringField(record, key)
    if (value) return value
  }
  const match = path.match(/(?:^|\/)sessions\/([^/]+)(?:\/|$)/u)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}
