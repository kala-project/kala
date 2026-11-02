import { describe, expect, it, vi } from 'vitest'

import { TenantRuntimeUnitRegistry, parseTenantRuntimeUnitId, type TenantRuntimeUnit } from './unit.js'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function unit(id: string): TenantRuntimeUnit {
  return { id: parseTenantRuntimeUnitId(id), state: 'ready', origin: `http://${id}`, drain: vi.fn(async () => {}), close: vi.fn(async () => {}) }
}

describe('TenantRuntimeUnitRegistry', () => {
  it('rejects path-like and malformed ids', () => {
    for (const id of ['', '..', '../a', 'a/b', 'a b']) expect(() => parseTenantRuntimeUnitId(id)).toThrow()
    expect(parseTenantRuntimeUnitId('tenant_01-A')).toBe('tenant_01-A')
  })

  it('deduplicates concurrent first load', async () => {
    const waiting = deferred<TenantRuntimeUnit>()
    const factory = vi.fn(() => waiting.promise)
    const registry = new TenantRuntimeUnitRegistry(factory)
    const id = parseTenantRuntimeUnitId('a')
    const first = registry.getOrLoad(id)
    const second = registry.getOrLoad(id)
    expect(factory).toHaveBeenCalledTimes(1)
    waiting.resolve(unit('a'))
    expect(await first).toBe(await second)
    expect(registry.list()).toHaveLength(1)
  })

  it('cleans failed load so it can retry', async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce(unit('a'))
    const registry = new TenantRuntimeUnitRegistry(factory)
    const id = parseTenantRuntimeUnitId('a')
    await expect(registry.getOrLoad(id)).rejects.toThrow('failed')
    await expect(registry.getOrLoad(id)).resolves.toMatchObject({ id })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('enforces the loaded Unit capacity without breaking duplicate load sharing', async () => {
    const registry = new TenantRuntimeUnitRegistry(async (id) => unit(id), 1)
    await registry.getOrLoad(parseTenantRuntimeUnitId('a'))
    await expect(registry.getOrLoad(parseTenantRuntimeUnitId('b'))).rejects.toThrow('capacity')
    await expect(registry.getOrLoad(parseTenantRuntimeUnitId('a'))).resolves.toMatchObject({ id: 'a' })
  })

  it('drains loaded units and rejects later loads', async () => {
    const a = unit('a')
    const registry = new TenantRuntimeUnitRegistry(async () => a)
    await registry.getOrLoad(a.id)
    await registry.drainAll()
    expect(a.drain).toHaveBeenCalledOnce()
    await expect(registry.getOrLoad(parseTenantRuntimeUnitId('b'))).rejects.toThrow('draining')
  })

  it('serializes close during load and blocks reload until teardown completes', async () => {
    const id = parseTenantRuntimeUnitId('a')
    const firstLoad = deferred<TenantRuntimeUnit>()
    const firstClose = deferred<void>()
    const first = unit('a')
    first.close = vi.fn(() => firstClose.promise)
    const fresh = unit('a')
    const factory = vi.fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(fresh)
    const registry = new TenantRuntimeUnitRegistry(factory)

    const loading = registry.getOrLoad(id)
    const closing = registry.close(id)
    const concurrentClose = registry.close(id)
    firstLoad.resolve(first)
    await expect(loading).resolves.toBe(first)
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce())

    const reload = registry.getOrLoad(id)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(registry.get(id)).toBe(first)

    firstClose.resolve(undefined)
    await Promise.all([closing, concurrentClose])
    await expect(reload).resolves.toBe(fresh)
    expect(first.close).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(registry.get(id)).toBe(fresh)
  })
})
