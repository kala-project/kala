import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { attachJsonRoutes } from './routes.js'
import { DEDICATED_DEPLOYMENT, PRIVATE_CLOUD_DEPLOYMENT } from '@agent-kernel/shared'

describe('HTTP route ownership', () => {
  it('requires an owner or admin for Dedicated model writes before invoking callbacks', async () => {
    const server = createServer()
    const mutate = vi.fn(() => ({ providers: [] } as never))
    attachJsonRoutes(server, {
      models: [], defaultModel: '', deployment: DEDICATED_DEPLOYMENT,
      addManualModel: mutate, deleteManualModel: mutate, addManualProvider: mutate,
      updateManualModel: mutate,
      updateManualProvider: mutate, deleteManualProvider: mutate, setDefaultModel: mutate,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing address')
      for (const role of ['member', 'viewer']) {
        for (const [path, method] of [
          ['/settings/models', 'POST'], ['/settings/models', 'PATCH'], ['/settings/models', 'DELETE'],
          ['/settings/providers', 'POST'], ['/settings/providers', 'PATCH'], ['/settings/providers', 'DELETE'],
          ['/settings/default-model', 'POST'],
        ]) {
          const result = await fetch(`http://127.0.0.1:${address.port}${path}`, {
            method, headers: {
              'x-agent-runlab-principal': role!, 'x-agent-runlab-organization-id': 'org_settings',
              'x-agent-runlab-organization-role': role!,
            },
          })
          expect(result.status).toBe(403)
          expect(await result.json()).toEqual({ error: 'admin_required' })
        }
      }
      expect(mutate).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('awaits each model mutation and reports rejected writes without success auditing', async () => {
    const server = createServer()
    const actors: unknown[] = []
    let finish!: () => void
    let entered!: () => void
    let started: Promise<void>
    const audit = { log: vi.fn() }
    const mutate = async (_input: unknown, actor: unknown) => {
      actors.push(actor)
      entered()
      await new Promise<void>(resolve => { finish = resolve })
      throw Object.assign(new Error('durable write rejected'), { status: 409 })
    }
    attachJsonRoutes(server, {
      models: [], defaultModel: '', deployment: PRIVATE_CLOUD_DEPLOYMENT, audit: audit as never,
      addManualModel: mutate, deleteManualModel: mutate, addManualProvider: mutate,
      updateManualModel: mutate,
      updateManualProvider: mutate, deleteManualProvider: mutate, setDefaultModel: mutate,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing address')
      const headers = {
        'content-type': 'application/json', 'x-agent-runlab-principal': 'admin',
        'x-agent-runlab-organization-id': 'org_settings', 'x-agent-runlab-organization-role': 'admin',
      }
      const requests: Array<[string, string, unknown?]> = [
        ['/settings/models', 'POST', { providerId: 'custom', id: 'model' }],
        ['/settings/models', 'PATCH', { providerId: 'custom', id: 'model', label: '', contextWindow: 64000 }],
        ['/settings/models?providerId=custom&id=model', 'DELETE'],
        ['/settings/providers', 'POST', { id: 'custom', wire: 'openai', baseUrl: 'https://example.test', apiKey: 'secret' }],
        ['/settings/providers', 'PATCH', { providerId: 'custom', baseUrl: 'https://edited.test', apiKey: '' }],
        ['/settings/providers?providerId=custom', 'DELETE'],
        ['/settings/default-model', 'POST', { model: 'custom:model' }],
      ]
      for (const [path, method, body] of requests) {
        started = new Promise<void>(resolve => { entered = resolve })
        let replied = false
        const response = fetch(`http://127.0.0.1:${address.port}${path}`, {
          method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
        }).then(response => { replied = true; return response })
        await started
        expect(replied).toBe(false)
        expect(audit.log).not.toHaveBeenCalled()
        finish()
        const result = await response
        expect(result.status).toBe(409)
        expect(await result.json()).toEqual({ error: 'durable write rejected' })
      }
      expect(actors).toHaveLength(requests.length)
      for (const actor of actors) expect(actor).toMatchObject({ kind: 'ingress', organizationId: 'org_settings', role: 'admin' })
      expect(audit.log).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('marks only persisted agent prompt settings as pending when sessions cannot sync', async () => {
    const server = createServer()
    let saved = true
    attachJsonRoutes(server, {
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      updateAgentPrompt: () => {
        const error = new Error(saved ? 'Session retry pending' : 'Host not writable') as Error & { status: number; settingsSaved?: boolean }
        error.status = 503
        if (saved) error.settingsSaved = true
        throw error
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing address')
      const body = JSON.stringify({
        selectedSlotId: 'slot-1',
        slots: [
          { id: 'slot-1', name: 'Default', prompt: 'Updated prompt' },
          { id: 'slot-2', name: 'Second', prompt: 'Second prompt' },
          { id: 'slot-3', name: 'Third', prompt: 'Third prompt' },
        ],
      })
      for (saved of [true, false]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/settings/agent-prompt`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-agent-runlab-principal': 'admin@example.test',
            'x-agent-runlab-organization-id': 'org_settings',
            'x-agent-runlab-organization-role': 'admin',
          },
          body,
        })
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject(saved
          ? { error: 'Session retry pending', settingsSaved: true }
          : { error: 'Host not writable' })
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('does not touch Engine.IO response headers', () => {
    const server = createServer()
    attachJsonRoutes(server, {})
    const listener = server.listeners('request')[0]
    expect(listener).toBeTypeOf('function')
    const setHeader = vi.fn(() => { throw new Error('headers already sent') })
    expect(() => listener?.(
      { url: '/socket.io/?EIO=4&transport=polling', headers: { origin: 'https://browser.example.test' } },
      { setHeader } as unknown as ServerResponse,
    )).not.toThrow()
    expect(setHeader).not.toHaveBeenCalled()
  })

  it('requires tenant admins for multi-tenant settings write routes', async () => {
    const calls: string[] = []
    const server = createServer()
    attachJsonRoutes(server, {
      models: [],
      defaultModel: '',
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      addManualModel: () => { calls.push('model:add'); return { models: [], providers: [] } as never },
      updateManualModel: () => { calls.push('model:update'); return { models: [], providers: [] } as never },
      deleteManualModel: () => { calls.push('model:delete'); return { models: [], providers: [] } as never },
      addManualProvider: () => { calls.push('provider:add'); return { models: [], providers: [] } as never },
      updateManualProvider: () => { calls.push('provider:update'); return { models: [], providers: [] } as never },
      deleteManualProvider: () => { calls.push('provider:delete'); return { models: [], providers: [] } as never },
      setDefaultModel: () => { calls.push('default-model'); return { models: [], providers: [] } as never },
      updateAgentPrompt: () => { calls.push('agent-prompt'); return { models: [], providers: [] } as never },
      initializeSocketAdmin: () => { calls.push('socket-admin:init'); return { models: [], providers: [] } as never },
      updateSocketAdminMode: () => { calls.push('socket-admin:mode'); return { models: [], providers: [] } as never },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing address')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const memberHeaders = {
        'content-type': 'application/json',
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_settings',
        'x-agent-runlab-organization-role': 'member',
      }
      const adminHeaders = {
        'content-type': 'application/json',
        'x-agent-runlab-principal': 'admin@example.test',
        'x-agent-runlab-organization-id': 'org_settings',
        'x-agent-runlab-organization-role': 'admin',
      }
      const requests: Array<[string, RequestInit]> = [
        ['/settings/models', { method: 'POST', body: JSON.stringify({ providerId: 'custom', id: 'model', label: 'Model' }) }],
        ['/settings/models', { method: 'PATCH', body: JSON.stringify({ providerId: 'custom', id: 'model', label: 'Edited' }) }],
        ['/settings/models?providerId=custom&id=model', { method: 'DELETE' }],
        ['/settings/providers', { method: 'POST', body: JSON.stringify({ id: 'custom', label: 'Custom', baseUrl: 'https://example.test', apiKey: 'not-a-real-key' }) }],
        ['/settings/providers', { method: 'PATCH', body: JSON.stringify({ providerId: 'custom', baseUrl: 'https://edited.test' }) }],
        ['/settings/providers?providerId=custom', { method: 'DELETE' }],
        ['/settings/default-model', { method: 'POST', body: JSON.stringify({ model: 'custom:model' }) }],
        ['/settings/agent-prompt', { method: 'POST', body: JSON.stringify({ preset: 'custom', customPrompt: 'safe prompt' }) }],
        ['/settings/socket-admin/init', { method: 'POST', body: JSON.stringify({ password: 'password-1234' }) }],
        ['/settings/socket-admin/mode', { method: 'POST', body: JSON.stringify({ mode: 'production' }) }],
      ]
      for (const [path, init] of requests) {
        const blocked = await fetch(`${baseUrl}${path}`, { ...init, headers: memberHeaders })
        expect(blocked.status).toBe(403)
        await expect(blocked.json()).resolves.toMatchObject({ error: 'admin_required' })
      }
      expect(calls).toEqual([])

      const allowed = await fetch(`${baseUrl}/settings/socket-admin/mode`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ mode: 'production' }),
      })
      expect(allowed.status).toBe(200)
      expect(calls).toEqual(['socket-admin:mode'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
