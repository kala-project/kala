import { expect, it } from 'vitest'
import { ServerSettingsPayloadSchema } from './schema/dashboard-outbound.js'

it('retains the actual Hook source load revision across the declared settings wire schema', () => {
  const hooksSummary = { sourceRef: 'mounted-unit-hooks-manifest', loadState: 'loaded',
    events: ['session_start', 'pre_tool_use', 'post_tool_use', 'session_end'],
    loadedAt: '2026-01-01T00:00:00.000Z', version: '7', applyMode: 'restart' }
  const payload = { providers: [], defaultModel: '', hooks: [], hooksSummary,
    paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
    mcp: { supported: false, note: '' } }
  expect(ServerSettingsPayloadSchema.parse(payload).hooksSummary).toEqual(hooksSummary)
  expect(ServerSettingsPayloadSchema.safeParse({ ...payload, hooksSummary: { ...hooksSummary, version: '0' } }).success).toBe(false)
  expect(ServerSettingsPayloadSchema.safeParse({ ...payload, hooksSummary: { ...hooksSummary, applyMode: 'immediate' } }).success).toBe(false)
})
