import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { ConfigurationRead, ServerSettingsPayload, SettingsSectionValue } from '@agent-kernel/shared'
import { agentSettingsSnapshot, defaultAgentRuntimeSettings, updateAgentRuntimeSettings } from '../runtime-config.js'
import { KalaStateStore } from '../store/state-store.js'
import { LocalWebSearchCredentialStore } from '../web-search/credential-store.js'
import { LocalAzureSpeechCredentialStore } from '../speech/credential-store.js'
import type { SettingsWriteProtocol } from '../settings-concurrency.js'
import { attachJsonRoutes } from './routes.js'
import { configurationEtag, settingsWriteProtocolFromEnvironment } from './settings-preconditions.js'

async function fixture(protocol: SettingsWriteProtocol = 'legacy-compatible') {
  const root = mkdtempSync(join(tmpdir(), 'kala-settings-http-'))
  const state = new KalaStateStore(join(root, 'state'))
  const agentPath = join(root, 'agent.json')
  writeFileSync(agentPath, JSON.stringify(defaultAgentRuntimeSettings()), { mode: 0o600 })
  const search = new LocalWebSearchCredentialStore(state)
  const speech = new LocalAzureSpeechCredentialStore(state)
  let race = false
  const value = (): ServerSettingsPayload => {
    const snapshot = agentSettingsSnapshot(agentPath, state)
    return { providers: [], defaultModel: '', hooks: [],
      agentSettingsResourceId: 'fixture-agent',
      agentPrompt: { configPath: 'fixture-agent', selectedSlotId: snapshot.value!.selectedSlotId, slots: snapshot.value!.slots },
      desktopAccess: { manualAuthorizationRequired: snapshot.value!.desktopManualAuthorizationRequired },
    } as ServerSettingsPayload
  }
  const server = createServer()
  attachJsonRoutes(server, {
    models: [], defaultModel: '', settings: value,
    auth: { sharedToken: 'local-fixture-token' }, settingsWriteProtocol: protocol,
    webSearchCredentials: search, speechCredentials: speech,
    settingsConfiguration: section => {
      if (section !== 'agent' && section !== 'execution') return undefined
      const snapshot = agentSettingsSnapshot(agentPath, state)
      const configuration: ConfigurationRead<SettingsSectionValue> = {
        resource: { kind: 'agent', id: 'runtime' }, revision: snapshot.revision, capabilities: [],
        value: section === 'agent' ? { agentPrompt: value().agentPrompt }
          : { agentSettingsResourceId: 'fixture-agent', desktopAccess: value().desktopAccess },
        application: { state: 'unknown', desiredRevision: snapshot.revision, effectiveRevision: null,
          applyMode: 'next-turn', scope: 'device' },
      }
      return configuration
    },
    settingsRevision: resource => {
      if (resource !== 'agent') return undefined
      const revision = agentSettingsSnapshot(agentPath, state).revision
      if (race) {
        race = false
        updateAgentRuntimeSettings(agentPath, current => ({ ...current, selectedSlotId: 'slot-3' }), state)
      }
      return revision
    },
    updateAgentPrompt: (input, _actor, options) => {
      updateAgentRuntimeSettings(agentPath, current => ({ ...current, ...input }), state, options)
      return value()
    },
    updateDesktopAccess: (input, _actor, options) => {
      updateAgentRuntimeSettings(agentPath, current => ({
        ...current, desktopManualAuthorizationRequired: input.manualAuthorizationRequired,
      }), state, options)
      return value()
    },
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  const headers = { authorization: 'Bearer local-fixture-token', 'content-type': 'application/json' }
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { ...headers, ...init?.headers } })
  return {
    request, state, search, speech, agentPath, race: () => { race = true },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      state.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('configuration HTTP preconditions against real Portable authorities', () => {
  it('shares prompt/desktop versions, preserves strict legacy DTOs and rejects stale edits without losing fields', async () => {
    const f = await fixture('conditional-required')
    try {
      const read = await f.request('/settings/sections/agent')
      expect(read.status).toBe(200)
      const tag = read.headers.get('etag')!
      expect(tag).toMatch(/^"[\w-]{43}"$/u)
      expect(await read.json()).toMatchObject({ resource: { kind: 'agent' }, revision: '1', application: { state: 'unknown' } })
      const execution = await f.request('/settings/sections/execution')
      expect(execution.headers.get('etag')).toBe(tag)
      expect((await f.request('/settings/agent-prompt', {
        method: 'POST', headers: { 'if-match': tag },
        body: JSON.stringify({ selectedSlotId: 'slot-2', slots: defaultAgentRuntimeSettings().slots }),
      })).status).toBe(200)
      const rejected = await f.request('/settings/desktop-access', {
        method: 'POST', headers: { 'if-match': tag }, body: '{"manualAuthorizationRequired":true}',
      })
      expect(rejected.status).toBe(412)
      expect(await rejected.json()).toMatchObject({ error: 'configuration_conflict' })
      const fresh = await f.request('/settings/sections/execution')
      const saved = await f.request('/settings/desktop-access', {
        method: 'POST', headers: { 'if-match': fresh.headers.get('etag')! }, body: '{"manualAuthorizationRequired":true}',
      })
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({ agentPrompt: { selectedSlotId: 'slot-2' }, desktopAccess: { manualAuthorizationRequired: true } })
      expect(agentSettingsSnapshot(f.agentPath, f.state)).toMatchObject({ revision: '3', value: { selectedSlotId: 'slot-2', desktopManualAuthorizationRequired: true } })
    } finally { await f.close() }
  })

  it('keeps the explicit legacy-write window revision-aware, then rejects missing conditions under the required protocol', async () => {
    for (const protocol of ['legacy-compatible', 'conditional-required'] as const) {
      const f = await fixture(protocol)
      try {
        const before = await f.request('/settings/web-search')
        expect(await before.json()).toEqual({ configured: false, provider: 'serper' })
        const response = await f.request('/settings/web-search', {
          method: 'PUT', body: '{"provider":"serper","apiKey":"fixture-key-only"}',
        })
        expect(response.status).toBe(protocol === 'legacy-compatible' ? 200 : 428)
        const current = await f.search.configuration()
        expect(current.revision).toBe(protocol === 'legacy-compatible' ? '2' : '1')
        if (protocol === 'conditional-required') expect(await response.json()).toEqual({ error: 'client_upgrade_required' })
        expect(current.value.configured).toBe(protocol === 'legacy-compatible')
        const latest = await f.request('/settings/web-search')
        const conditional = await f.request('/settings/web-search', {
          method: 'PUT', headers: { 'if-match': latest.headers.get('etag')! },
          body: '{"provider":"serper","apiKey":"replacement-fixture-only"}',
        })
        expect(conditional.status).toBe(200)
        expect(await conditional.text()).not.toContain('replacement-fixture-only')
      } finally { await f.close() }
    }
  })

  it('rejects weak, wildcard, list and cross-resource tags; preserves Speech credentials on keyless edits', async () => {
    const f = await fixture('conditional-required')
    try {
      const search = await f.request('/settings/web-search')
      const speech = await f.request('/settings/speech')
      expect(search.headers.get('etag')).not.toBe(speech.headers.get('etag'))
      const body = JSON.stringify({ endpoint: 'https://japaneast.api.cognitive.microsoft.com/', apiKey: 'fixture-speech-key', enabled: true, mode: 'realtime' })
      for (const tag of [search.headers.get('etag')!, `W/${speech.headers.get('etag')!}`, '*', `${speech.headers.get('etag')!}, "another"`]) {
        expect((await f.request('/settings/speech', { method: 'PUT', headers: { 'if-match': tag }, body })).status).toBe(412)
      }
      expect((await f.request('/settings/speech', { method: 'PUT', headers: { 'if-match': speech.headers.get('etag')! }, body })).status).toBe(200)
      const fresh = await f.request('/settings/speech')
      const edit = await f.request('/settings/speech', { method: 'PUT', headers: { 'if-match': fresh.headers.get('etag')! },
        body: JSON.stringify({ endpoint: 'https://japaneast.api.cognitive.microsoft.com/', enabled: false, mode: 'after_recording' }) })
      expect(edit.status).toBe(200)
      expect(await edit.text()).not.toContain('fixture-speech-key')
      expect(await f.speech.get()).toMatchObject({ apiKey: 'fixture-speech-key', enabled: false, mode: 'after_recording' })
    } finally { await f.close() }
  })

  it('rechecks the precondition under the real resource lock after the HTTP header comparison', async () => {
    const f = await fixture('conditional-required')
    try {
      const before = await f.request('/settings/sections/agent')
      f.race()
      const response = await f.request('/settings/agent-prompt', {
        method: 'POST', headers: { 'if-match': before.headers.get('etag')! },
        body: JSON.stringify({ selectedSlotId: 'slot-2', slots: defaultAgentRuntimeSettings().slots }),
      })
      expect(response.status).toBe(412)
      expect(agentSettingsSnapshot(f.agentPath, f.state)).toMatchObject({ revision: '2', value: { selectedSlotId: 'slot-3' } })
    } finally { await f.close() }
  })

  it('binds tags to organization, authority and resource, and rejects invalid protocol settings', () => {
    const request = { headers: { host: 'unit-a.kala.test' } } as IncomingMessage
    const actor = { kind: 'ingress', principal: 'fixture', organizationId: 'a', role: 'owner' } as const
    const tag = configurationEtag(request, 'agent', actor, '1')
    expect(configurationEtag(request, 'agent', { ...actor, organizationId: 'b' }, '1')).not.toBe(tag)
    expect(configurationEtag({ headers: { host: 'unit-b.kala.test' } } as IncomingMessage, 'agent', actor, '1')).not.toBe(tag)
    expect(configurationEtag(request, 'models', actor, '1')).not.toBe(tag)
    expect(() => settingsWriteProtocolFromEnvironment('automatic')).toThrow('invalid settingsWriteProtocol')
  })
})
