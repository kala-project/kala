/**
 * Runtime config loader.
 *
 * Reads two local files, both belonging to the operator, and produces the
 * providers + models the host should advertise:
 *
 *   `~/.claude/settings.json` — Anthropic base URL, API key (via `apiKeyHelper`
 *     shell hook), primary + small model names.
 *   `~/.codex/config.toml`    — default model + a table of OpenAI-compatible
 *     providers (`[model_providers.<name>]` blocks each carrying `base_url`,
 *     `env_key`, `wire_api`).
 *
 * We accept partial config: either file missing is fine, we just skip that
 * side. The output is what the host CLI needs to build adapters, plus a
 * sanitized `ModelInfo[]` for the dashboard's picker. **No secrets ever
 * appear in the output** — API keys are held in-memory on the returned
 * provider objects, but the `models` list is safe to serialize over HTTP.
 */

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

import type { ManualModelInput, ManualProviderInput, ModelInfo, ModelSource, ProviderWire } from '@agent-kernel/shared'

import { DEFAULT_KALA_SYSTEM_PROMPT } from './builtin-tools.js'
import type { HookConfig, HookEvent } from './extensions/hooks.js'
import { knownContextWindow } from './model-capabilities.js'

export { knownContextWindow } from './model-capabilities.js'

export type ProviderSpec = {
  id: string
  label: string
  wire: 'anthropic' | 'openai'
  source: ModelSource
  baseUrl?: string
  apiKey: string
  models: readonly string[]
  contextWindows?: Readonly<Record<string, number>>
}

export type RuntimeConfig = {
  providers: readonly ProviderSpec[]
  models: readonly ModelInfo[]
  defaultModel: string
  manualProviders: readonly ManualProviderInput[]
  manualModels: readonly ManualModelInput[]
  manualDefaultModel?: string
}

export type AgentPromptSlotId = 'slot-1' | 'slot-2' | 'slot-3'

export type AgentPromptSlot = {
  id: AgentPromptSlotId
  name: string
  prompt: string
}

export type AgentRuntimeSettings = {
  selectedSlotId: AgentPromptSlotId
  slots: readonly AgentPromptSlot[]
}

export class InvalidAgentRuntimeSettingsError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`invalid agent prompt settings file: ${path}`, options)
    this.name = 'InvalidAgentRuntimeSettingsError'
  }
}

export type LoadRuntimeConfigOptions = {
  claudeSettingsPath?: string
  codexConfigPath?: string
  codexAuthPath?: string
  manualModelsPath?: string
}

export type AnthropicCliDefaults = {
  baseUrl?: string
  baseUrlSource?: 'env' | 'env-file' | 'claude-settings'
  model?: string
  smallFastModel?: string
}

export function loadRuntimeConfig(
  opts: LoadRuntimeConfigOptions = {},
): RuntimeConfig {
  const home = homedir()
  const claudePath =
    opts.claudeSettingsPath ?? join(home, '.claude', 'settings.json')
  const codexPath =
    opts.codexConfigPath ?? join(home, '.codex', 'config.toml')
  const codexAuthPath =
    opts.codexAuthPath ?? join(home, '.codex', 'auth.json')
  const manualPath =
    opts.manualModelsPath ?? join(home, '.config', 'kala', 'models.json')

  const providers: ProviderSpec[] = []
  const claude = loadClaudeSettings(claudePath)
  if (claude) providers.push(claude)
  const codex = loadCodexProviders(codexPath, codexAuthPath)
  providers.push(...codex.providers)
  const manualConfig = loadManualConfig(manualPath)
  const manualProviders = manualConfig.providers.filter((p) => !providers.some((existing) => existing.id === p.id))
  providers.push(...manualProviders.map(providerSpecFromManual))
  const discoveredModels = new Map(providers.map((p) => [p.id, new Set(p.models)]))
  const manualModels = manualConfig.models.filter((m) => {
    const discovered = discoveredModels.get(m.providerId)
    return !discovered?.has(m.id)
  })
  applyManualModels(providers, manualModels)

  const models: ModelInfo[] = providers.flatMap((p) =>
    p.models.map((m) => {
      const manual = manualModels.find((candidate) => candidate.providerId === p.id && candidate.id === m)
      return modelInfo(m, p.label, {
        providerId: p.id,
        source: modelSourceFor(p, m, manualModels, discoveredModels),
        ...(manual?.label ? { label: manual.label } : {}),
        ...(p.contextWindows?.[m] ?? manual?.contextWindow
          ? { contextWindow: p.contextWindows?.[m] ?? manual?.contextWindow }
          : {}),
      })
    }),
  )

  const defaultModel = normalizeDefaultModelRef(
    manualConfig.defaultModel ?? codex.defaultModel ?? claude?.models[0],
    models,
  ) ?? models[0]?.ref ?? models[0]?.id ?? ''

  return { providers, models, defaultModel, manualProviders, manualModels, ...(manualConfig.defaultModel ? { manualDefaultModel: manualConfig.defaultModel } : {}) }
}

export function modelInfo(
  model: string,
  provider: string,
  opts: { providerId: string; source?: ModelSource; label?: string; contextWindow?: number },
): ModelInfo {
  const contextWindow = opts.contextWindow ?? knownContextWindow(model)
  return {
    ref: modelRef(opts.providerId, model),
    id: model,
    label: opts.label ?? model,
    provider,
    providerId: opts.providerId,
    ...(opts.source ? { source: opts.source } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  }
}

export function modelRef(providerId: string | undefined, model: string): string {
  return providerId ? `${providerId}:${model}` : model
}

function normalizeDefaultModelRef(defaultModel: string | undefined, models: readonly ModelInfo[]): string | undefined {
  if (!defaultModel) return undefined
  const exact = models.find((model) => model.ref === defaultModel || model.id === defaultModel)
  return exact?.ref ?? exact?.id ?? defaultModel
}

// ============================================================================
// Claude settings
// ============================================================================

type ClaudeSettings = {
  apiKeyHelper?: string
  env?: {
    ANTHROPIC_API_KEY?: string
    ANTHROPIC_AUTH_TOKEN?: string
    ANTHROPIC_BASE_URL?: string
    ANTHROPIC_MODEL?: string
    ANTHROPIC_SMALL_FAST_MODEL?: string
  }
}

export function loadAnthropicCliDefaults(path = join(homedir(), '.claude', 'settings.json')): AnthropicCliDefaults {
  const raw = tryReadFile(path)
  let settingsEnv: NonNullable<ClaudeSettings['env']> = {}
  if (raw !== undefined) {
    try {
      settingsEnv = (JSON.parse(raw) as ClaudeSettings).env ?? {}
    } catch {
      settingsEnv = {}
    }
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? settingsEnv.ANTHROPIC_BASE_URL
  const envSource = process.env.KALA_ENV_SOURCE_ANTHROPIC_BASE_URL === 'env-file' ? 'env-file' : 'env'
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(baseUrl ? { baseUrlSource: process.env.ANTHROPIC_BASE_URL ? envSource : 'claude-settings' } : {}),
    ...(process.env.ANTHROPIC_MODEL ?? settingsEnv.ANTHROPIC_MODEL
      ? { model: process.env.ANTHROPIC_MODEL ?? settingsEnv.ANTHROPIC_MODEL }
      : {}),
    ...(process.env.ANTHROPIC_SMALL_FAST_MODEL ?? settingsEnv.ANTHROPIC_SMALL_FAST_MODEL
      ? { smallFastModel: process.env.ANTHROPIC_SMALL_FAST_MODEL ?? settingsEnv.ANTHROPIC_SMALL_FAST_MODEL }
      : {}),
  }
}

export function requireAnthropicBaseUrl(input: { explicit?: string; defaults?: AnthropicCliDefaults; flagName?: string } = {}): {
  baseUrl: string
  source: 'cli' | 'env' | 'env-file' | 'claude-settings'
} {
  if (input.explicit) return { baseUrl: input.explicit, source: 'cli' }
  const defaults = input.defaults ?? loadAnthropicCliDefaults()
  if (defaults.baseUrl) return { baseUrl: defaults.baseUrl, source: defaults.baseUrlSource ?? 'claude-settings' }
  throw new Error(`missing Anthropic base URL: pass ${input.flagName ?? '--base-url'}, set ANTHROPIC_BASE_URL, or set env.ANTHROPIC_BASE_URL in ~/.claude/settings.json`)
}

export function redactedUrlForArtifact(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return '<invalid-url>'
  }
}

export function loadEnvFile(path: string, opts: { override?: boolean; sourceName?: string } = {}): Record<string, string> {
  const raw = tryReadFile(path)
  if (raw === undefined) return {}
  const parsed: Record<string, string> = {}
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const value = parseEnvValue(line.slice(eq + 1).trim())
    parsed[key] = value
    if (opts.override || process.env[key] === undefined) {
      process.env[key] = value
      if (opts.sourceName) process.env[`KALA_ENV_SOURCE_${key}`] = opts.sourceName
    }
  }
  return parsed
}

function parseEnvValue(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

function loadClaudeSettings(path: string): ProviderSpec | undefined {
  const raw = tryReadFile(path)
  if (raw === undefined) return undefined
  let parsed: ClaudeSettings
  try {
    parsed = JSON.parse(raw) as ClaudeSettings
  } catch {
    return undefined
  }
  const env = parsed.env ?? {}
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    env.ANTHROPIC_API_KEY ??
    env.ANTHROPIC_AUTH_TOKEN ??
    (parsed.apiKeyHelper ? runApiKeyHelper(parsed.apiKeyHelper) : undefined)
  if (!apiKey) return undefined
  const primary = process.env.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL
  const small = process.env.ANTHROPIC_SMALL_FAST_MODEL ?? env.ANTHROPIC_SMALL_FAST_MODEL
  const models: string[] = []
  if (primary) models.push(primary)
  if (small && !models.includes(small)) models.push(small)
  if (models.length === 0) return undefined
  return {
    id: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic',
    source: 'claude-settings',
    ...(process.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL
      ? { baseUrl: process.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL }
      : {}),
    apiKey,
    models,
  }
}

function runApiKeyHelper(cmd: string): string | undefined {
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// Codex config.toml
// ============================================================================

type CodexParsed = {
  defaultModel?: string
  providers: readonly ProviderSpec[]
}

function loadCodexProviders(path: string, authPath: string): CodexParsed {
  const raw = tryReadFile(path)
  if (raw === undefined) return { providers: [] }
  const parsed = parseCodexToml(raw)
  const auth = loadCodexAuth(authPath)
  const providers: ProviderSpec[] = []
  const defaultModel = parsed.model
  for (const p of parsed.providers) {
    const apiKey = resolveCodexApiKey(p.envKey, auth)
    if (!apiKey) continue
    // Codex config declares providers but not per-provider model lists.
    // The user names one default model at the top; attach it to the
    // provider that owns the current default. Other providers become
    // available as endpoints even though the picker won't list them
    // until an explicit model → provider mapping is provided.
    const models: string[] = []
    if (defaultModel && p.id === parsed.defaultProviderId) {
      models.push(defaultModel)
    }
    providers.push({
      id: p.id,
      label: p.name ?? p.id,
      wire: 'openai',
      source: 'codex-config',
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      apiKey,
      models,
      ...(defaultModel && parsed.modelContextWindow ? { contextWindows: { [defaultModel]: parsed.modelContextWindow } } : {}),
    })
  }
  return {
    ...(defaultModel ? { defaultModel } : {}),
    providers,
  }
}

// ============================================================================
// Manual models (`~/.config/kala/models.json`)
// ============================================================================

export type ManualModelsFile = {
  defaultModel?: string
  providers?: readonly ManualProviderInput[]
  models: readonly ManualModelInput[]
}

export type ManualConfigFile = {
  defaultModel?: string
  providers: readonly ManualProviderInput[]
  models: readonly ManualModelInput[]
}

export function loadManualConfig(path: string): ManualConfigFile {
  const raw = tryReadFile(path)
  if (raw === undefined) return { providers: [], models: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<ManualModelsFile>
    const providers = Array.isArray(parsed.providers)
      ? parsed.providers.filter(isManualProviderInput)
      : []
    const models = Array.isArray(parsed.models)
      ? parsed.models.filter(isManualModelInput)
      : []
    return {
      ...(typeof parsed.defaultModel === 'string' && parsed.defaultModel.trim().length > 0 ? { defaultModel: parsed.defaultModel.trim() } : {}),
      providers,
      models,
    }
  } catch {
    return { providers: [], models: [] }
  }
}

export function loadManualModels(path: string): readonly ManualModelInput[] {
  return loadManualConfig(path).models
}

export function writeManualModels(path: string, models: readonly ManualModelInput[]): void {
  writeManualConfig(path, { providers: loadManualConfig(path).providers, models })
}

export function writeManualConfig(path: string, config: ManualConfigFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const normalizedProviders = config.providers.map((p) => ({
    id: p.id,
    ...(p.label ? { label: p.label } : {}),
    wire: p.wire,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
  }))
  const normalized = config.models.map((m) => ({
    providerId: m.providerId,
    id: m.id,
    ...(m.label ? { label: m.label } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  }))
  writeFileSync(path, `${JSON.stringify({
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    providers: normalizedProviders,
    models: normalized,
  }, null, 2)}\n`, 'utf8')
}

function providerSpecFromManual(input: ManualProviderInput): ProviderSpec {
  return {
    id: input.id,
    label: input.label?.trim() || input.id,
    wire: input.wire,
    source: 'manual',
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: [],
  }
}

export function defaultAgentSettingsPath(home = homedir()): string {
  return join(home, '.config', 'kala', 'agent.json')
}

/** Keep untrusted organization ids out of paths while retaining stable isolation. */
export function organizationAgentSettingsPath(globalPath: string, organizationId: string): string {
  const key = createHash('sha256').update(organizationId, 'utf8').digest('hex')
  return join(dirname(globalPath), 'agent-organizations', `${key}.json`)
}

export function defaultAgentRuntimeSettings(): AgentRuntimeSettings {
  return {
    selectedSlotId: 'slot-1',
    slots: [
      { id: 'slot-1', name: '默认', prompt: DEFAULT_KALA_SYSTEM_PROMPT },
      { id: 'slot-2', name: '方案 2', prompt: DEFAULT_KALA_SYSTEM_PROMPT },
      { id: 'slot-3', name: '方案 3', prompt: DEFAULT_KALA_SYSTEM_PROMPT },
    ],
  }
}

export function loadAgentRuntimeSettings(path = defaultAgentSettingsPath()): AgentRuntimeSettings {
  const raw = tryReadFile(path)
  if (raw === undefined) return defaultAgentRuntimeSettings()
  try {
    const parsed = JSON.parse(raw) as unknown
    const settings = parseAgentRuntimeSettings(parsed)
    if (settings) return settings
    if (isLegacyAgentRuntimeSettings(parsed)) {
      const migrated = defaultAgentRuntimeSettings()
      migrated.selectedSlotId = parsed.systemPromptPreset === 'claude-code'
        ? 'slot-2'
        : parsed.systemPromptPreset === 'custom'
          ? 'slot-3'
          : 'slot-1'
      writeAgentRuntimeSettings(path, migrated)
      return migrated
    }
  } catch (error) {
    if (error instanceof InvalidAgentRuntimeSettingsError) throw error
    throw new InvalidAgentRuntimeSettingsError(path, { cause: error })
  }
  throw new InvalidAgentRuntimeSettingsError(path)
}

export function writeAgentRuntimeSettings(path: string, settings: AgentRuntimeSettings): void {
  const normalized = parseAgentRuntimeSettings(settings)
  if (!normalized) throw new Error('invalid agent prompt settings')
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}

export function parseAgentRuntimeSettings(value: unknown): AgentRuntimeSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { selectedSlotId?: unknown; slots?: unknown }
  const selectedSlotId = candidate.selectedSlotId
  if (!isAgentPromptSlotId(selectedSlotId) || !Array.isArray(candidate.slots) || candidate.slots.length !== 3) return undefined
  const ids = ['slot-1', 'slot-2', 'slot-3'] as const
  const slots: AgentPromptSlot[] = []
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!
    const slot = candidate.slots[index]
    if (!slot || typeof slot !== 'object') return undefined
    const entry = slot as { id?: unknown; name?: unknown; prompt?: unknown }
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const prompt = typeof entry.prompt === 'string' ? entry.prompt : ''
    if (entry.id !== id || !name || name.length > 80 || !prompt.trim() || prompt.length > 100_000) return undefined
    slots.push({ id, name, prompt })
  }
  return { selectedSlotId, slots }
}

function isAgentPromptSlotId(value: unknown): value is AgentPromptSlotId {
  return value === 'slot-1' || value === 'slot-2' || value === 'slot-3'
}

function isLegacyAgentRuntimeSettings(value: unknown): value is { systemPromptPreset?: unknown } {
  return !!value && typeof value === 'object' && !('slots' in value)
}

function applyManualModels(
  providers: ProviderSpec[],
  manualModels: readonly ManualModelInput[],
): void {
  for (const manual of manualModels) {
    const provider = providers.find((p) => p.id === manual.providerId)
    if (!provider || provider.models.includes(manual.id)) continue
    provider.models = [...provider.models, manual.id]
  }
}

function modelSourceFor(
  provider: ProviderSpec,
  model: string,
  manualModels: readonly ManualModelInput[],
  discoveredModels: ReadonlyMap<string, ReadonlySet<string>>,
): ModelSource {
  const discovered = discoveredModels.get(provider.id)
  if (discovered?.has(model)) return provider.source
  return manualModels.some((m) => m.providerId === provider.id && m.id === model)
    ? 'manual'
    : provider.source
}

function isManualModelInput(value: unknown): value is ManualModelInput {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  if (typeof rec.providerId !== 'string' || rec.providerId.length === 0) return false
  if (typeof rec.id !== 'string' || rec.id.length === 0) return false
  if (rec.label !== undefined && typeof rec.label !== 'string') return false
  if (rec.contextWindow !== undefined && typeof rec.contextWindow !== 'number') return false
  return true
}

function isManualProviderInput(value: unknown): value is ManualProviderInput {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id.trim().length === 0) return false
  if (rec.label !== undefined && typeof rec.label !== 'string') return false
  if (!isProviderWire(rec.wire)) return false
  if (typeof rec.baseUrl !== 'string' || rec.baseUrl.trim().length === 0) return false
  if (typeof rec.apiKey !== 'string' || rec.apiKey.length === 0) return false
  return true
}

function isProviderWire(value: unknown): value is ProviderWire {
  return value === 'anthropic' || value === 'openai'
}

type CodexProviderBlock = {
  id: string
  name?: string
  baseUrl?: string
  envKey?: string
  wireApi?: string
}

type CodexTomlSubset = {
  model?: string
  defaultProviderId?: string
  modelContextWindow?: number
  providers: CodexProviderBlock[]
}

/**
 * Minimal TOML reader for the shape codex writes. Handles top-level
 * `key = "value"` and `[model_providers.<id>]` blocks with string fields.
 * Deliberately ignores everything else — the codex config file has many
 * unrelated sections we shouldn't parse or reject.
 */
export function parseCodexToml(text: string): CodexTomlSubset {
  const lines = text.split('\n')
  let currentBlock: CodexProviderBlock | undefined
  let inTopLevel = true
  const providers: CodexProviderBlock[] = []
  const top: Record<string, string> = {}

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim()
    if (line.length === 0) continue
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) {
      const path = header[1]!
      const providerMatch = path.match(/^model_providers\.(.+)$/)
      if (providerMatch) {
        currentBlock = { id: providerMatch[1]! }
        providers.push(currentBlock)
        inTopLevel = false
      } else {
        currentBlock = undefined
        inTopLevel = false
      }
      continue
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.+)$/)
    if (!kv) continue
    const key = kv[1]!
    const value = parseTomlValue(kv[2]!)
    if (value === undefined) continue
    if (inTopLevel) {
      top[key] = value
      continue
    }
    if (!currentBlock) continue
    if (key === 'name') currentBlock.name = value
    else if (key === 'base_url') currentBlock.baseUrl = value
    else if (key === 'env_key') currentBlock.envKey = value
    else if (key === 'wire_api') currentBlock.wireApi = value
  }

  const model = top.model
  const defaultProviderId = top.model_provider
  const modelContextWindow = parsePositiveInt(top.model_context_window)
  return {
    ...(model ? { model } : {}),
    ...(defaultProviderId ? { defaultProviderId } : {}),
    ...(modelContextWindow ? { modelContextWindow } : {}),
    providers,
  }
}

function stripComment(line: string): string {
  // Comments start with `#` when not inside a string. We only need to handle
  // simple cases: string literals are `"..."` on one line, so scan and drop
  // the tail at the first `#` not inside quotes.
  let inString = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '"') inString = !inString
    else if (c === '#' && !inString) return line.slice(0, i)
  }
  return line
}

function parseTomlValue(raw: string): string | undefined {
  const s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"')
  }
  if (/^\d+$/.test(s)) return s
  return undefined
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function loadCodexAuth(path: string): Record<string, string> {
  const raw = tryReadFile(path)
  if (raw === undefined) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0 && value !== 'env') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function resolveCodexApiKey(envKey: string | undefined, auth: Readonly<Record<string, string>>): string | undefined {
  if (envKey) {
    const fromEnv = process.env[envKey]
    if (fromEnv) return fromEnv
    const fromAuth = auth[envKey]
    if (fromAuth) return fromAuth
  }
  return auth.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
}

function tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

// ============================================================================
// Hooks config (`~/.config/kala/config.toml`)
// ============================================================================

const KNOWN_HOOK_EVENTS: readonly HookEvent[] = [
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'session_end',
]

export function loadHookConfigs(
  path?: string,
): readonly HookConfig[] {
  const home = homedir()
  const target = path ?? join(home, '.config', 'kala', 'config.toml')
  const raw = tryReadFile(target)
  if (raw === undefined) return []
  return parseHookConfigToml(raw)
}

/**
 * Extracts `[[hooks]]` array-of-tables blocks from a TOML file. Each block
 * must carry an `event` field and a `command` field; `match` is optional.
 * Malformed blocks (unknown event, missing command) are dropped silently so a
 * typo in one hook can't disable the rest.
 */
export function parseHookConfigToml(text: string): readonly HookConfig[] {
  const lines = text.split('\n')
  const hooks: HookConfig[] = []
  let current: Partial<HookConfig> | undefined
  const flush = (): void => {
    if (!current) return
    const event = current.event
    const command = current.command
    if (
      event !== undefined &&
      KNOWN_HOOK_EVENTS.includes(event) &&
      typeof command === 'string' &&
      command.length > 0
    ) {
      hooks.push({
        event,
        command,
        ...(current.match !== undefined && current.match.length > 0
          ? { match: current.match }
          : {}),
      })
    }
    current = undefined
  }
  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim()
    if (line.length === 0) continue
    if (line === '[[hooks]]') {
      flush()
      current = {}
      continue
    }
    const otherHeader = line.match(/^\[\[?[^\]]+\]?\]$/)
    if (otherHeader) {
      flush()
      continue
    }
    if (!current) continue
    const kv = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.+)$/)
    if (!kv) continue
    const key = kv[1]!
    const value = parseTomlValue(kv[2]!)
    if (value === undefined) continue
    if (key === 'event' && KNOWN_HOOK_EVENTS.includes(value as HookEvent)) {
      current.event = value as HookEvent
    } else if (key === 'command') {
      current.command = value
    } else if (key === 'match') {
      current.match = value
    }
  }
  flush()
  return hooks
}
