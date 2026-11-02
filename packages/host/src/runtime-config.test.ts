/**
 * runtime-config.ts tests.
 *
 * We construct temporary settings files rather than reading the real
 * `~/.claude/settings.json` — the point is to pin the loader's shape, not
 * the operator's current key.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultAgentRuntimeSettings, loadAgentRuntimeSettings, loadAnthropicCliDefaults, loadEnvFile, loadRuntimeConfig, organizationAgentSettingsPath, parseCodexToml, parseHookConfigToml, loadHookConfigs, requireAnthropicBaseUrl, writeAgentRuntimeSettings } from './runtime-config.js'
import { DEFAULT_KALA_SYSTEM_PROMPT } from './builtin-tools.js'

describe('parseCodexToml', () => {
  it('extracts top-level model + provider block fields', () => {
    const input = [
      'model = "gpt-5.5"',
      'model_provider = "newapi"',
      'model_context_window = 353346',
      'unrelated = 42',
      '',
      '[model_providers.newapi]',
      'name = "newapi"',
      'base_url = "https://api.example.test/v1"',
      'env_key = "TK_API_KEY"',
      'wire_api = "responses"',
      '',
      '[model_providers.direct]',
      'name = "Self Hosted"',
      'base_url = "http://gc.example.com/api/openai/v1"',
      'env_key = "GC_API_KEY"',
      '',
      '[projects."/some/path"]',
      'trust_level = "trusted"',
    ].join('\n')
    const out = parseCodexToml(input)
    expect(out.model).toBe('gpt-5.5')
    expect(out.defaultProviderId).toBe('newapi')
    expect(out.modelContextWindow).toBe(353346)
    expect(out.providers).toHaveLength(2)
    const [newapi, direct] = out.providers
    expect(newapi!.id).toBe('newapi')
    expect(newapi!.baseUrl).toBe('https://api.example.test/v1')
    expect(newapi!.envKey).toBe('TK_API_KEY')
    expect(direct!.id).toBe('direct')
    expect(direct!.envKey).toBe('GC_API_KEY')
  })

  it('ignores inline comments', () => {
    const out = parseCodexToml('model = "gpt-5.5" # default\n')
    expect(out.model).toBe('gpt-5.5')
  })
})

describe('loadRuntimeConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-runtime-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses claude settings + codex config into a model list, no keys leaked', () => {
    const claudePath = join(dir, 'claude.json')
    const codexPath = join(dir, 'codex.toml')
    writeFileSync(
      claudePath,
      JSON.stringify({
        apiKeyHelper: 'echo test-anthropic-key',
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:33333',
          ANTHROPIC_MODEL: 'claude-opus-4.7-1m-internal',
          ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
        },
      }),
    )
    writeFileSync(
      codexPath,
      [
        'model = "gpt-5.5"',
        'model_provider = "newapi"',
        'model_context_window = 353346',
        '[model_providers.newapi]',
        'name = "newapi"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "KALA_TEST_TK_KEY"',
      ].join('\n'),
    )
    process.env.KALA_TEST_TK_KEY = 'test-openai-key'
    try {
      const cfg = loadRuntimeConfig({
        claudeSettingsPath: claudePath,
        codexConfigPath: codexPath,
        codexAuthPath: join(dir, 'missing-auth.json'),
        manualModelsPath: join(dir, 'missing-manual-models.json'),
      })
      expect(cfg.defaultModel).toBe('newapi:gpt-5.5')
      expect(cfg.models.map((m) => m.id)).toEqual([
        'claude-opus-4.7-1m-internal',
        'claude-haiku-4-5',
        'gpt-5.5',
      ])
      expect(cfg.models.at(-1)?.ref).toBe('newapi:gpt-5.5')
      expect(cfg.models.map((m) => m.contextWindow)).toEqual([
        1_000_000,
        200_000,
        353_346,
      ])
      expect(cfg.models.map((m) => m.source)).toEqual([
        'claude-settings',
        'claude-settings',
        'codex-config',
      ])
      // Model list is the sanitized DTO — no `apiKey` field on ModelInfo.
      for (const m of cfg.models) {
        expect(m).not.toHaveProperty('apiKey')
      }
      // No gpt-4o slipped through anywhere.
      expect(cfg.models.some((m) => m.id.includes('gpt-4o'))).toBe(false)
      // Providers carry the resolved apiKey in-memory (not exposed to
      // dashboards) — this is what adapter constructors need.
      const anthropic = cfg.providers.find((p) => p.wire === 'anthropic')
      expect(anthropic?.apiKey).toBe('test-anthropic-key')
      expect(anthropic?.baseUrl).toBe('http://127.0.0.1:33333')
      const openai = cfg.providers.find((p) => p.wire === 'openai')
      expect(openai?.apiKey).toBe('test-openai-key')
      expect(openai?.baseUrl).toBe('https://api.example.test/v1')
    } finally {
      delete process.env.KALA_TEST_TK_KEY
    }
  })

  it('loads benchmark env files without overwriting existing env values', () => {
    const envPath = join(dir, '.env.local')
    writeFileSync(envPath, [
      'ANTHROPIC_BASE_URL=https://api.example.test/anthropic',
      'ANTHROPIC_API_KEY=test-key-from-file',
      'ANTHROPIC_MODEL=claude-sonnet-4-6',
      '',
    ].join('\n'))
    process.env.ANTHROPIC_API_KEY = 'test-key-from-env'
    try {
      const loaded = loadEnvFile(envPath, { sourceName: 'env-file' })
      expect(loaded.ANTHROPIC_BASE_URL).toBe('https://api.example.test/anthropic')
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.example.test/anthropic')
      expect(process.env.KALA_ENV_SOURCE_ANTHROPIC_BASE_URL).toBe('env-file')
      expect(process.env.ANTHROPIC_API_KEY).toBe('test-key-from-env')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_BASE_URL
      delete process.env.ANTHROPIC_MODEL
      delete process.env.KALA_ENV_SOURCE_ANTHROPIC_BASE_URL
    }
  })

  it('resolves Anthropic CLI defaults from env first, then Claude settings', () => {
    const claudePath = join(dir, 'claude.json')
    writeFileSync(claudePath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://settings.example.test/anthropic',
        ANTHROPIC_MODEL: 'claude-opus-4.7-1m-internal',
      },
    }))

    expect(loadAnthropicCliDefaults(claudePath)).toMatchObject({
      baseUrl: 'https://settings.example.test/anthropic',
      baseUrlSource: 'claude-settings',
      model: 'claude-opus-4.7-1m-internal',
    })

    process.env.ANTHROPIC_BASE_URL = 'https://env.example.test/anthropic'
    try {
      expect(requireAnthropicBaseUrl({ defaults: loadAnthropicCliDefaults(claudePath) })).toEqual({
        baseUrl: 'https://env.example.test/anthropic',
        source: 'env',
      })
    } finally {
      delete process.env.ANTHROPIC_BASE_URL
      delete process.env.KALA_ENV_SOURCE_ANTHROPIC_BASE_URL
    }
  })

  it('requires an Anthropic base URL instead of falling back to localhost', () => {
    expect(() => requireAnthropicBaseUrl({ defaults: {} })).toThrow(/missing Anthropic base URL/)
  })

  it('does not let manual models override auto-discovered model sources', () => {
    const claudePath = join(dir, 'claude.json')
    const manualPath = join(dir, 'models.json')
    writeFileSync(
      claudePath,
      JSON.stringify({
        apiKeyHelper: 'echo test-anthropic-key',
        env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
      }),
    )
    writeFileSync(
      manualPath,
      JSON.stringify({
        models: [
          { providerId: 'anthropic', id: 'claude-sonnet-4-6' },
          { providerId: 'anthropic', id: 'claude-haiku-4-6' },
        ],
      }),
    )

    const cfg = loadRuntimeConfig({
      claudeSettingsPath: claudePath,
      codexConfigPath: join(dir, 'missing-codex.toml'),
      manualModelsPath: manualPath,
    })

    expect(cfg.models.map((m) => [m.id, m.source])).toEqual([
      ['claude-sonnet-4-6', 'claude-settings'],
      ['claude-haiku-4-6', 'manual'],
    ])
    expect(cfg.manualModels).toEqual([{ providerId: 'anthropic', id: 'claude-haiku-4-6' }])
  })

  it('loads manual providers and binds manual models without exposing keys in ModelInfo', () => {
    const manualPath = join(dir, 'models.json')
    writeFileSync(
      manualPath,
      JSON.stringify({
        defaultModel: 'local-openai:gpt-local',
        providers: [
          {
            id: 'local-openai',
            label: 'Local OpenAI',
            wire: 'openai',
            baseUrl: 'http://localhost:8000/v1',
            apiKey: 'test-redacted-api-key',
          },
        ],
        models: [
          { providerId: 'local-openai', id: 'gpt-local', label: 'GPT Local', contextWindow: 123456 },
        ],
      }),
    )

    const cfg = loadRuntimeConfig({
      claudeSettingsPath: join(dir, 'missing-claude.json'),
      codexConfigPath: join(dir, 'missing-codex.toml'),
      manualModelsPath: manualPath,
    })

    expect(cfg.providers).toEqual([
      expect.objectContaining({
        id: 'local-openai',
        label: 'Local OpenAI',
        wire: 'openai',
        source: 'manual',
        baseUrl: 'http://localhost:8000/v1',
        apiKey: 'test-redacted-api-key',
      }),
    ])
    expect(cfg.models).toEqual([
      expect.objectContaining({
        id: 'gpt-local',
        ref: 'local-openai:gpt-local',
        label: 'GPT Local',
        provider: 'Local OpenAI',
        providerId: 'local-openai',
        source: 'manual',
        contextWindow: 123456,
      }),
    ])
    expect(cfg.defaultModel).toBe('local-openai:gpt-local')
    expect(cfg.manualDefaultModel).toBe('local-openai:gpt-local')
    expect(JSON.stringify(cfg.models)).not.toContain('test-redacted-api-key')
  })

  it('drops providers whose env key is unset (so nothing loud fails when TK_API_KEY is missing)', () => {
    const codexPath = join(dir, 'codex.toml')
    writeFileSync(
      codexPath,
      [
        'model = "gpt-5.5"',
        'model_provider = "newapi"',
        '[model_providers.newapi]',
        'name = "newapi"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "KALA_TEST_UNSET_KEY"',
      ].join('\n'),
    )
    // Isolate every local config source so the test cannot read operator credentials.
    const cfg = loadRuntimeConfig({
      claudeSettingsPath: join(dir, 'missing.json'),
      codexConfigPath: codexPath,
      codexAuthPath: join(dir, 'missing-auth.json'),
      manualModelsPath: join(dir, 'missing-manual-models.json'),
    })
    expect(cfg.providers).toEqual([])
    expect(cfg.models).toEqual([])
  })

  it('resolves codex provider keys from auth.json when the env key is not exported', () => {
    const codexPath = join(dir, 'codex.toml')
    const authPath = join(dir, 'auth.json')
    writeFileSync(
      codexPath,
      [
        'model = "gpt-5.5"',
        'model_provider = "newapi"',
        '[model_providers.newapi]',
        'name = "napi"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "KALA_TEST_AUTH_ONLY_KEY"',
      ].join('\n'),
    )
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'auth-openai-key' }))

    const cfg = loadRuntimeConfig({
      claudeSettingsPath: join(dir, 'missing.json'),
      codexConfigPath: codexPath,
      codexAuthPath: authPath,
      manualModelsPath: join(dir, 'missing-manual-models.json'),
    })

    expect(cfg.models.map((m) => m.id)).toEqual(['gpt-5.5'])
    expect(cfg.providers[0]?.apiKey).toBe('auth-openai-key')
  })

  it('returns empty when both files are missing', () => {
    const cfg = loadRuntimeConfig({
      claudeSettingsPath: join(dir, 'nope1'),
      codexConfigPath: join(dir, 'nope2'),
      codexAuthPath: join(dir, 'missing-auth.json'),
      manualModelsPath: join(dir, 'missing-manual-models.json'),
    })
    expect(cfg.providers).toEqual([])
    expect(cfg.models).toEqual([])
    expect(cfg.defaultModel).toBe('')
  })
})

describe('parseHookConfigToml', () => {
  it('extracts multiple [[hooks]] blocks with optional match', () => {
    const input = [
      '[[hooks]]',
      'event = "pre_tool_use"',
      'match = "bash"',
      'command = "/usr/local/bin/lint-shell.sh"',
      '',
      '[[hooks]]',
      'event = "post_tool_use"',
      'command = "echo done"',
    ].join('\n')
    const out = parseHookConfigToml(input)
    expect(out).toEqual([
      {
        event: 'pre_tool_use',
        command: '/usr/local/bin/lint-shell.sh',
        match: 'bash',
      },
      { event: 'post_tool_use', command: 'echo done' },
    ])
  })

  it('drops blocks with unknown event or missing command', () => {
    const input = [
      '[[hooks]]',
      'event = "not_a_real_event"',
      'command = "true"',
      '',
      '[[hooks]]',
      'event = "session_start"',
      '# no command here',
      '',
      '[[hooks]]',
      'event = "session_end"',
      'command = "notify.sh"',
    ].join('\n')
    const out = parseHookConfigToml(input)
    expect(out).toEqual([{ event: 'session_end', command: 'notify.sh' }])
  })

  it('ignores blocks belonging to other sections', () => {
    const input = [
      '[unrelated]',
      'foo = "bar"',
      '',
      '[[hooks]]',
      'event = "pre_tool_use"',
      'command = "echo hi"',
    ].join('\n')
    const out = parseHookConfigToml(input)
    expect(out).toEqual([{ event: 'pre_tool_use', command: 'echo hi' }])
  })
})

describe('loadHookConfigs', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-hooks-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns [] when file is missing', () => {
    expect(loadHookConfigs(join(dir, 'nope.toml'))).toEqual([])
  })

  it('reads hooks from an explicit path', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(
      path,
      ['[[hooks]]', 'event = "pre_tool_use"', 'command = "echo ok"'].join('\n'),
    )
    const out = loadHookConfigs(path)
    expect(out).toEqual([{ event: 'pre_tool_use', command: 'echo ok' }])
  })
})

describe('agent prompt slots', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-agent-settings-'))
    path = join(dir, 'agent.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('uses three named copies of the Kala template for a new installation', () => {
    expect(loadAgentRuntimeSettings(path)).toEqual({
      desktopManualAuthorizationRequired: false,
      computerUseEnabled: false,
      desktopPreviewEnabled: false,
      selectedSlotId: 'slot-1',
      slots: [
        { id: 'slot-1', name: '默认', prompt: DEFAULT_KALA_SYSTEM_PROMPT },
        { id: 'slot-2', name: '方案 2', prompt: DEFAULT_KALA_SYSTEM_PROMPT },
        { id: 'slot-3', name: '方案 3', prompt: DEFAULT_KALA_SYSTEM_PROMPT },
      ],
    })
  })

  it.each([
    ['codex', 'slot-1'],
    ['claude-code', 'slot-2'],
    ['custom', 'slot-3'],
  ] as const)('migrates legacy %s settings to %s and replaces every old prompt', (preset, selectedSlotId) => {
    writeFileSync(path, JSON.stringify({ systemPromptPreset: preset, customSystemPrompt: 'delete this legacy text' }))

    const settings = loadAgentRuntimeSettings(path)

    expect(settings.selectedSlotId).toBe(selectedSlotId)
    expect(settings.slots.map((slot) => slot.prompt)).toEqual(Array(3).fill(DEFAULT_KALA_SYSTEM_PROMPT))
    expect(readFileSync(path, 'utf8')).not.toContain('delete this legacy text')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(settings)
  })

  it('persists and reloads custom names, prompts, and selection atomically', () => {
    const settings = {
      selectedSlotId: 'slot-2' as const,
      desktopManualAuthorizationRequired: true,
      computerUseEnabled: true,
      desktopPreviewEnabled: false,
      slots: [
        { id: 'slot-1' as const, name: 'Build', prompt: 'Implement carefully.' },
        { id: 'slot-2' as const, name: 'Plan', prompt: 'Discuss the design.' },
        { id: 'slot-3' as const, name: 'Review', prompt: 'Review only.' },
      ],
    }

    writeAgentRuntimeSettings(path, settings)

    expect(loadAgentRuntimeSettings(path)).toEqual(settings)
    expect(readdirSync(dir)).toEqual(['agent.json'])
  })

  it('reports invalid stored Slot data without replacing it with defaults', () => {
    const defaults = defaultAgentRuntimeSettings()
    const invalid = { ...defaults, slots: [defaults.slots[1]!, defaults.slots[0]!, defaults.slots[2]!] }
    const damaged = JSON.stringify(invalid)
    writeFileSync(path, damaged)

    expect(() => loadAgentRuntimeSettings(path)).toThrow(`invalid agent prompt settings file: ${path}`)
    expect(readFileSync(path, 'utf8')).toBe(damaged)

    writeAgentRuntimeSettings(path, defaults)
    const beforeFailure = readFileSync(path, 'utf8')
    expect(() => writeAgentRuntimeSettings(path, invalid)).toThrow('invalid agent prompt settings')
    expect(readFileSync(path, 'utf8')).toBe(beforeFailure)
  })

  it('defaults existing prompt settings to no extra desktop authorization without altering their slots', () => {
    const { desktopManualAuthorizationRequired: _policy, ...legacy } = defaultAgentRuntimeSettings()
    writeFileSync(path, JSON.stringify(legacy))
    expect(loadAgentRuntimeSettings(path)).toEqual({ ...legacy, desktopManualAuthorizationRequired: false })
    writeFileSync(path, JSON.stringify({ ...legacy, desktopManualAuthorizationRequired: 'false' }))
    expect(() => loadAgentRuntimeSettings(path)).toThrow('invalid agent prompt settings file')
  })

  it('migrates missing desktop feature options to off without changing old prompts', () => {
    const { computerUseEnabled: _computer, desktopPreviewEnabled: _preview, ...legacy } = defaultAgentRuntimeSettings()
    writeFileSync(path, JSON.stringify(legacy))
    expect(loadAgentRuntimeSettings(path)).toEqual({ ...legacy, computerUseEnabled: false, desktopPreviewEnabled: false })
    writeFileSync(path, JSON.stringify({ ...legacy, desktopPreviewEnabled: 'false' }))
    expect(() => loadAgentRuntimeSettings(path)).toThrow('invalid agent prompt settings file')
  })

  it('reports malformed JSON without silently selecting defaults', () => {
    writeFileSync(path, '{"selectedSlotId":')

    expect(() => loadAgentRuntimeSettings(path)).toThrow(`invalid agent prompt settings file: ${path}`)
    expect(readFileSync(path, 'utf8')).toBe('{"selectedSlotId":')
  })

  it('uses stable, non-overlapping hashed paths for organization settings', () => {
    const globalPath = join(dir, 'agent.json')
    const first = organizationAgentSettingsPath(globalPath, 'org/a')
    const again = organizationAgentSettingsPath(globalPath, 'org/a')
    const second = organizationAgentSettingsPath(globalPath, 'org/b')

    expect(first).toBe(again)
    expect(first).not.toBe(second)
    expect(first).not.toContain('org/a')
    expect(second).not.toContain('org/b')
  })
})
