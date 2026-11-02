import { describe, expect, it } from 'vitest'
import { schema } from './index.js'

describe('dashboard channel contracts', () => {
  it('accepts bounded channel batches and rejects malformed channels', () => {
    expect(schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: 2, channels: ['global', 'workspace:w', 'session:s'], cursors: { 'session:s': 4 } }).channels).toHaveLength(3)
    expect(() => schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: 2, channels: ['bad:x'] })).toThrow()
    expect(() => schema.ClientSubscribeChannelsSchema.parse({ requestId: 'r', generation: -1, channels: [] })).toThrow()
  })

  it('defines deletion as one strict recursive operation', () => {
    expect(schema.ClientDeleteSessionSchema.safeParse({ operationId: 'delete-op', sessionId: 'root-session' }).success).toBe(true)
    expect(schema.ClientDeleteSessionSchema.safeParse({ operationId: 'delete-op', sessionId: 'root-session', cascade: false }).success).toBe(false)
  })

  it('validates incremental Session summary control updates', () => {
    const update = {
      kind: 'session_summary_changed',
      session: {
        sessionId: 'session-1',
        agentRuntime: 'copilot',
        executionMode: 'chat',
        createdAt: '2026-01-01T00:00:00.000Z',
        eventCount: 4,
        status: 'thinking',
      },
    }
    expect(schema.ControlUpdateSchema.parse(update)).toEqual(update)
    expect(schema.ControlUpdateSchema.safeParse({
      kind: 'session_summary_changed',
      session: { sessionId: 'session-1', eventCount: -1 },
    }).success).toBe(false)
  })

  it('preserves operator model guidance, measured storage and Owner-authenticated administration metadata', () => {
    const settings = {
      providers: [], defaultModel: '', hooks: [],
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
      mcp: { supported: false, note: 'Managed by Runtime' },
      modelConfiguration: { management: 'operator', providerCatalogPath: '/etc/kala/providers.json' },
      storage: {
        kind: 'postgres-s3', organizationId: 'org-test', objectBytes: 1024, objectLimitBytes: 4096,
        usage: {
          measuredAt: '2026-11-02T00:00:00Z', storedFiles: 1, storedBytes: 768, reservedFiles: 1, reservedBytes: 256,
          artifacts: { files: 1, bytes: 768 }, attachments: { files: 0, bytes: 0 },
        },
      },
      socketAdmin: {
        authentication: 'gateway-owner', active: false, initialized: true, path: '/admin/socket.io',
        username: '', runtimeMode: 'production', configuredMode: 'production', configPath: '',
        unavailableReason: 'Official assets are unavailable',
      },
    }
    const parsed = schema.ServerSettingsPayloadSchema.parse(settings)
    expect(parsed.modelConfiguration).toEqual(settings.modelConfiguration)
    expect(parsed.storage).toEqual(settings.storage)
    expect(parsed.socketAdmin).toEqual(settings.socketAdmin)
    expect(schema.ServerSettingsPayloadSchema.safeParse({
      ...settings, storage: { ...settings.storage, usage: { ...settings.storage.usage, storedFiles: -1 } },
    }).success).toBe(false)
  })
})
