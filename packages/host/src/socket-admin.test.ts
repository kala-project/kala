import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadGatewayOwnerSocketAdminConfig, loadSocketAdminConfig } from './socket-admin.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

const ORIGINAL_MODE = process.env.KALA_SOCKET_ADMIN_MODE

afterEach(() => {
  vi.mocked(existsSync).mockReset()
  if (ORIGINAL_MODE === undefined) delete process.env.KALA_SOCKET_ADMIN_MODE
  else process.env.KALA_SOCKET_ADMIN_MODE = ORIGINAL_MODE
})

it('reports missing installed Dedicated assets without enabling instrumentation or falling back to another UI', () => {
  vi.mocked(existsSync).mockReturnValue(false)
  const state = loadGatewayOwnerSocketAdminConfig({ currentModulePath: import.meta.url })
  expect(state.runtime).toBeUndefined()
  expect(state.indexHtml).toBeUndefined()
  expect(state.summary).toMatchObject({
    authentication: 'gateway-owner', active: false, initialized: false,
    unavailableReason: expect.stringContaining('missing'),
  })
})

describe('loadSocketAdminConfig', () => {
  it('defaults Socket.IO Admin UI mode to development before initialization', () => {
    delete process.env.KALA_SOCKET_ADMIN_MODE

    const state = loadSocketAdminConfig({
      currentModulePath: import.meta.url,
      configPath: '/tmp/socket-admin.json',
      record: null,
      embeddedAssets: [],
    })

    expect(state.summary.runtimeMode).toBe('development')
    expect(state.summary.configuredMode).toBe('development')
  })

  it('defaults old initialized records without mode to development', () => {
    delete process.env.KALA_SOCKET_ADMIN_MODE

    const state = loadSocketAdminConfig({
      currentModulePath: import.meta.url,
      configPath: '/tmp/socket-admin.json',
      record: {
        version: 1,
        username: 'admin',
        passwordHash: '$2b$10$012345678901234567890u7Z/08sx9Loa7TXHL62ojTkhUMYeOHpu',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      embeddedAssets: [{ path: 'index.html', contentBase64: '' }],
    })

    expect(state.runtime?.mode).toBe('development')
    expect(state.summary.runtimeMode).toBe('development')
  })

  it('allows explicit production mode from the environment', () => {
    process.env.KALA_SOCKET_ADMIN_MODE = 'production'

    const state = loadSocketAdminConfig({
      currentModulePath: import.meta.url,
      configPath: '/tmp/socket-admin.json',
      record: null,
      embeddedAssets: [],
    })

    expect(state.summary.runtimeMode).toBe('production')
  })
})
