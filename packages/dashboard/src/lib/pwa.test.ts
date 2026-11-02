import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSW } from 'virtual:pwa-register'

vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }))

import { activatePwaUpdate, activateWaitingWorker, forcePwaRefresh, initPwa, isStandalone } from './pwa.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function serviceWorkerHarness(): {
  serviceWorker: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>
  dispatchControllerChange(): void
  add: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  let controllerChange: EventListener | null = null
  const add = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'controllerchange') controllerChange = listener as EventListener
  })
  const remove = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'controllerchange' && controllerChange === listener) controllerChange = null
  })
  return {
    serviceWorker: { addEventListener: add, removeEventListener: remove } as unknown as Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>,
    dispatchControllerChange: () => controllerChange?.(new Event('controllerchange')),
    add,
    remove,
  }
}

describe('PWA standalone detection', () => {
  it('does not register or check service workers in the desktop webview', async () => {
    Object.defineProperty(window, '__KALA_DESKTOP__', { value: true, configurable: true })
    try {
      const handlers = { onNeedRefresh: vi.fn(), onOfflineReady: vi.fn(), onRegistered: vi.fn() }
      const controller = initPwa(handlers)
      await controller.checkForUpdate()
      await controller.applyUpdate()
      await controller.forceRefresh()
      expect(handlers.onRegistered).not.toHaveBeenCalled()
    } finally {
      delete (window as Window & { __KALA_DESKTOP__?: boolean }).__KALA_DESKTOP__
    }
  })

  describe('forcePwaRefresh', () => {
    it('unregisters the worker, clears only dashboard caches, and cache-busts the current URL', async () => {
      const unregister = vi.fn(async () => true)
      const deleteCache = vi.fn(async () => true)
      const replace = vi.fn()
      const serviceWorker = {
        getRegistration: vi.fn(async () => ({ unregister })),
      } as unknown as ServiceWorkerContainer
      const cacheStorage = {
        keys: vi.fn(async () => ['workbox-precache-v2-origin', 'ak-icons-v1', 'unrelated-cache']),
        delete: deleteCache,
      }

      await forcePwaRefresh({
        serviceWorker,
        cacheStorage,
        location: { href: 'https://kala.example/session/one?tab=chat#latest', replace } as Pick<Location, 'href' | 'replace'>,
        nonce: 'test',
      })

      expect(unregister).toHaveBeenCalledOnce()
      expect(deleteCache).toHaveBeenCalledTimes(2)
      expect(deleteCache).toHaveBeenCalledWith('workbox-precache-v2-origin')
      expect(deleteCache).toHaveBeenCalledWith('ak-icons-v1')
      expect(replace).toHaveBeenCalledWith('https://kala.example/session/one?tab=chat&__kala_refresh=test#latest')
    })
  })
  it('enables PWA-only behavior for standard and legacy iOS standalone modes', () => {
    expect(isStandalone({ matches: true })).toBe(true)
    expect(isStandalone({ navigatorStandalone: true })).toBe(true)
    expect(isStandalone({ matches: false, navigatorStandalone: false })).toBe(false)
  })
})

describe('activatePwaUpdate', () => {
  it('reloads immediately after the new worker takes control', async () => {
    const harness = serviceWorkerHarness()
    const reload = vi.fn()
    const sendSkipWaiting = vi.fn(async () => {})

    const applying = activatePwaUpdate({
      sendSkipWaiting,
      serviceWorker: harness.serviceWorker,
      reload,
      timeoutMs: 10_000,
    })

    await Promise.resolve()
    expect(sendSkipWaiting).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()

    harness.dispatchControllerChange()
    await applying

    expect(reload).toHaveBeenCalledTimes(1)
    expect(harness.remove).toHaveBeenCalledTimes(1)
  })

  it('falls back to a bounded reload when controllerchange never arrives', async () => {
    vi.useFakeTimers()
    try {
      const harness = serviceWorkerHarness()
      const reload = vi.fn()
      const applying = activatePwaUpdate({
        sendSkipWaiting: async () => {},
        serviceWorker: harness.serviceWorker,
        reload,
        timeoutMs: 100,
      })
      await vi.advanceTimersByTimeAsync(99)
      expect(reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await applying

      expect(reload).toHaveBeenCalledTimes(1)
      expect(harness.remove).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reload when sending SKIP_WAITING fails', async () => {
    const harness = serviceWorkerHarness()
    const reload = vi.fn()

    await expect(activatePwaUpdate({
      sendSkipWaiting: async () => { throw new Error('message failed') },
      serviceWorker: harness.serviceWorker,
      reload,
      timeoutMs: 100,
    })).rejects.toThrow('message failed')

    expect(reload).not.toHaveBeenCalled()
    expect(harness.remove).toHaveBeenCalledTimes(1)
  })
})

describe('registered worker lifecycle', () => {
  async function register(waiting: object | null, forced = false) {
    const harness = serviceWorkerHarness()
    const reload = vi.fn()
    vi.stubEnv('PROD', true)
    vi.stubGlobal('window', {
      location: { href: 'https://kala.example/' + (forced ? '?__kala_refresh=test' : ''), reload },
      history: { replaceState: vi.fn() },
      addEventListener: vi.fn(),
    })
    const getRegistration = vi.fn(async () => ({ waiting }))
    vi.stubGlobal('navigator', { serviceWorker: { ...harness.serviceWorker, getRegistration } })
    const sendSkipWaiting = vi.fn(async () => {})
    vi.mocked(registerSW).mockReset().mockReturnValue(sendSkipWaiting)
    const handlers = { onNeedRefresh: vi.fn(), onOfflineReady: vi.fn(), onRegisterError: vi.fn() }
    const controller = initPwa(handlers)
    await vi.waitFor(() => expect(registerSW).toHaveBeenCalledOnce())
    const options = vi.mocked(registerSW).mock.calls[0][0]!
    return { harness, reload, getRegistration, sendSkipWaiting, handlers, controller, options }
  }

  it('does not advertise a new version for an external installation with no waiting worker', async () => {
    const state = await register(null)
    state.options.onNeedRefresh?.()
    await vi.waitFor(() => expect(state.getRegistration).toHaveBeenCalledOnce())
    expect(state.handlers.onNeedRefresh).not.toHaveBeenCalled()
  })

  it('keeps the update prompt for an actual waiting worker', async () => {
    const state = await register({ state: 'installed' })
    state.options.onNeedRefresh?.()
    await vi.waitFor(() => expect(state.handlers.onNeedRefresh).toHaveBeenCalledOnce())
  })

  it('finishes an older page forced refresh instead of presenting the same waiting update again', async () => {
    const waiting = Object.assign(new EventTarget(), {
      state: 'installed',
      postMessage: vi.fn(() => {
        waiting.state = 'activated'
        waiting.dispatchEvent(new Event('statechange'))
      }),
    })
    const state = await register(waiting, true)
    state.options.onNeedRefresh?.()
    await vi.waitFor(() => expect(state.reload).toHaveBeenCalledOnce())
    expect(state.handlers.onNeedRefresh).not.toHaveBeenCalled()
  })

  it('reloads other tabs on activation and deduplicates the explicit activation reload', async () => {
    const state = await register({ state: 'installed' })
    const applying = state.controller.applyUpdate()
    await vi.waitFor(() => expect(state.sendSkipWaiting).toHaveBeenCalledOnce())
    state.options.onNeedReload?.()
    state.harness.dispatchControllerChange()
    await applying
    state.options.onNeedReload?.()
    expect(state.reload).toHaveBeenCalledOnce()
  })
})

describe('forced refresh activation', () => {
  class WaitingWorker extends EventTarget {
    state: ServiceWorkerState = 'installed'
    postMessage = vi.fn(() => {
      this.state = 'activated'
      this.dispatchEvent(new Event('statechange'))
    })
  }

  it('activates the waiting update before unregistering so another tab cannot retain the old active worker', async () => {
    const waiting = new WaitingWorker()
    const unregister = vi.fn(async () => {
      expect(waiting.state).toBe('activated')
      return true
    })
    const replace = vi.fn()
    await forcePwaRefresh({
      serviceWorker: { getRegistration: async () => ({ waiting, unregister }) } as unknown as ServiceWorkerContainer,
      cacheStorage: { keys: async () => [], delete: async () => true },
      location: { href: 'https://kala.example/', replace },
    })
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(unregister).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledOnce()
  })

  it('reports an activation deadline rather than pretending a blocked update succeeded', async () => {
    vi.useFakeTimers()
    try {
      const worker = new WaitingWorker()
      worker.postMessage.mockImplementation(() => {})
      const activation = expect(activateWaitingWorker(worker, 100)).rejects.toThrow('activation timed out')
      await vi.advanceTimersByTimeAsync(100)
      await activation
    } finally {
      vi.useRealTimers()
    }
  })
})
