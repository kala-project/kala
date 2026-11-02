import { describe, expect, it, vi } from 'vitest'

import { resolveRuntimeIngressControlPlaneMode } from './control-plane.js'

describe('resolveRuntimeIngressControlPlaneMode', () => {
  it('requires Postgres in production and does not fall back to JSON stores', async () => {
    const readSecret = vi.fn(async () => '/tmp/runtime-units.json')

    await expect(resolveRuntimeIngressControlPlaneMode({ NODE_ENV: 'production' }, readSecret))
      .rejects.toThrow('KALA_INGRESS_DATABASE_URL is required in production')
    expect(readSecret).not.toHaveBeenCalledWith('KALA_INGRESS_UNIT_DIRECTORY')
  })

  it('uses direct, file-backed or external Postgres URLs without authority fallback', async () => {
    await expect(resolveRuntimeIngressControlPlaneMode({ KALA_INGRESS_DATABASE_URL: 'postgres://db/app' }, async () => 'unused'))
      .resolves.toEqual({ kind: 'postgres', databaseUrl: 'postgres://db/app' })
    await expect(resolveRuntimeIngressControlPlaneMode({ KALA_INGRESS_DATABASE_URL_FILE: '/run/db-url' }, async (name) => {
      expect(name).toBe('KALA_INGRESS_DATABASE_URL')
      return 'postgres://file/app'
    })).resolves.toEqual({ kind: 'postgres', databaseUrl: 'postgres://file/app' })
    await expect(resolveRuntimeIngressControlPlaneMode({ NODE_ENV: 'production', KALA_INGRESS_DATABASE_URL_REF: 'bao:control/database#url' }, async (name) => {
      expect(name).toBe('KALA_INGRESS_DATABASE_URL')
      return 'postgres://external/app'
    })).resolves.toEqual({ kind: 'postgres', databaseUrl: 'postgres://external/app' })
    await expect(resolveRuntimeIngressControlPlaneMode({ KALA_INGRESS_DATABASE_URL_REF: 'bao:control/database#url' }, async () => {
      throw new Error('Secret authority unavailable')
    })).rejects.toThrow('Secret authority unavailable')
  })

  it('allows JSON control stores only outside production', async () => {
    await expect(resolveRuntimeIngressControlPlaneMode({ NODE_ENV: 'development' }, async (name) => {
      expect(name).toBe('KALA_INGRESS_UNIT_DIRECTORY')
      return '/tmp/runtime-units.json'
    })).resolves.toEqual({ kind: 'json', directoryPath: '/tmp/runtime-units.json' })
  })
})
