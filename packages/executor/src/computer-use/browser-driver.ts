import { randomUUID } from 'node:crypto'
import puppeteer, { type Browser, type Page, type SerializedAXNode } from 'puppeteer-core'
import { ComputerObservationSchema, type ComputerObservation, type ComputerSemanticRequest } from '@agent-kernel/shared'

/** Attaches only to an explicitly configured local browser; never launches a profile. */
export function createBrowserDriver(endpoint: string | undefined, checkDesktop?: (signal?: AbortSignal) => Promise<void>) {
  let browser: Browser | undefined
  let snapshot: { id: string; page: Page; expiresAt: number; refs: Map<string, SerializedAXNode> } | undefined
  const pages = new Map<string, Page>()
  const ids = new WeakMap<Page, string>()
  let generation = 0
  const invalidate = () => { snapshot = undefined }
  const disconnect = () => {
    invalidate()
    generation++
    pages.clear()
    browser?.disconnect()
    browser = undefined
  }
  const endpointURL = (value: string, allowHTTP: boolean) => {
    const url = new URL(value)
    if (url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash
        || !(allowHTTP && url.protocol === 'http:' && url.pathname === '/' || url.protocol === 'ws:' && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname))) {
      throw new Error('Browser endpoint must be an explicit IPv4 loopback HTTP root or browser CDP WebSocket; remote endpoints and new profiles are not allowed')
    }
    return url
  }
  const connect = async (signal: AbortSignal) => {
    if (!endpoint) throw new Error('Browser semantics are not configured. The machine owner must explicitly attach a local browser using KALA_COMPUTER_BROWSER_ENDPOINT; use desktop observation or screenshot instead.')
    let url = endpointURL(endpoint, true)
    if (!browser?.connected) {
      if (url.protocol === 'http:') {
        const response = await fetch(new URL('/json/version', url), { signal, redirect: 'error' })
        if (!response.ok) throw new Error(`Local browser discovery failed (${response.status})`)
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Local browser discovery returned no body')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.length
            if (size > 16_384) throw new Error('Local browser discovery exceeded bounds')
            chunks.push(part.value)
          }
        } finally { await reader.cancel() }
        const info: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!info || typeof info !== 'object' || !('webSocketDebuggerUrl' in info) || typeof info.webSocketDebuggerUrl !== 'string') throw new Error('Local browser discovery returned no browser endpoint')
        const discovered = endpointURL(info.webSocketDebuggerUrl, false)
        if (discovered.port !== url.port) throw new Error('Local browser discovery must return the same configured loopback port')
        url = discovered
      }
      signal.throwIfAborted()
      const ownGeneration = generation
      const connection = puppeteer.connect({ browserWSEndpoint: url.href, defaultViewport: null, protocolTimeout: 5_000 }).then(async (attached) => {
        // Connection handshakes are not abortable upstream. A late connection
        // may only detach, never restore authority or perform page actions.
        if (signal.aborted || ownGeneration !== generation) {
          await attached.disconnect()
          throw new DOMException('Browser attachment cancelled', 'AbortError')
        }
        return attached
      })
      let onAbort = () => {}
      try {
        browser = await Promise.race([connection, new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new DOMException('Browser attachment cancelled', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })])
      } finally { signal.removeEventListener('abort', onAbort) }
    }
    signal.throwIfAborted()
    const current = await browser.pages()
    pages.clear()
    for (const page of current) {
      let id = ids.get(page)
      if (!id) {
        id = randomUUID()
        ids.set(page, id)
        page.on('framenavigated', invalidate)
        page.on('close', invalidate)
        page.setDefaultTimeout(5_000)
      }
      pages.set(id, page)
    }
  }
  const observe = async (signal: AbortSignal, tabId?: string, query?: string): Promise<ComputerObservation> => {
    await connect(signal)
    invalidate()
    const tabs = await Promise.all([...pages].slice(0, 32).map(async ([id, page]) => ({ id, title: (await page.title()).slice(0, 160) })))
    if (!tabId) return {
      backend: 'browser', snapshotId: randomUUID(), targetId: '', title: 'Choose a tabId from tabs, then observe it',
      elements: [], tabs, truncated: pages.size > tabs.length,
    }
    const page = pages.get(tabId)
    if (!page) throw new Error('Browser tab is no longer attached. Observe browser tabs again.')
    const tree = await page.accessibility.snapshot({ includeIframes: true })
    if (!tree) throw new Error('Browser accessibility tree is unavailable; use a desktop screenshot for this page')
    const refs = new Map<string, SerializedAXNode>()
    const elements: ComputerObservation['elements'] = []
    const queue = [tree]
    while (queue.length && elements.length < 64) {
      const node = queue.shift()!
      if (node.children) for (const child of node.children) queue.push(child)
      if (!node.name && node.value === undefined) continue
      if (query && !node.name?.toLowerCase().includes(query.toLowerCase())) continue
      const actions: ComputerObservation['elements'][number]['actions'] = []
      if (['button', 'link', 'menuitem', 'tab'].includes(node.role)) actions.push('invoke')
      if (['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(node.role) && !node.readonly) actions.push('setValue')
      if (['checkbox', 'switch'].includes(node.role)) actions.push('toggle')
      if (['option', 'radio'].includes(node.role)) actions.push('select')
      const ref = `e${elements.length + 1}`
      refs.set(ref, node)
      // Never return form values: even an ordinary textbox may contain a secret.
      elements.push({ ref, role: node.role.slice(0, 80), name: (node.name ?? '').slice(0, 160), enabled: !node.disabled, actions })
    }
    const id = randomUUID()
    snapshot = { id, page, expiresAt: Date.now() + 30_000, refs }
    return ComputerObservationSchema.parse({
      backend: 'browser', snapshotId: id, targetId: tabId, title: (await page.title()).slice(0, 160),
      elements, truncated: queue.length > 0,
    })
  }
  return {
    invalidate,
    disconnect,
    async semantic(request: ComputerSemanticRequest, signal?: AbortSignal): Promise<ComputerObservation> {
      if (signal?.aborted) throw new DOMException('Browser operation cancelled', 'AbortError')
      const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)])
      // Disconnecting aborts protocol waits without closing the user's browser.
      bounded.addEventListener('abort', disconnect, { once: true })
      try {
        if (request.operation === 'observe') return await observe(bounded, request.tabId, request.query)
        const current = snapshot
        if (!current || current.id !== request.snapshotId || current.expiresAt <= Date.now()) throw new Error('Stale browser refs. Observe the tab again before acting.')
        const tabId = ids.get(current.page)!
        for (let i = 0; i < request.actions.length; i++) {
          try {
            await checkDesktop?.(bounded)
            if (bounded.aborted || snapshot !== current || current.expiresAt <= Date.now()) throw new Error('Browser document changed, refs expired or control was revoked')
            const action = request.actions[i]!
            const node = current.refs.get(action.ref)
            if (!node || node.disabled) throw new Error('Unknown or disabled browser ref')
            const handle = await node.elementHandle()
            if (!handle) throw new Error('Browser ref has no DOM element; use a screenshot')
            try {
              if (!(await handle.isVisible())) throw new Error('Browser ref is no longer visible')
              const fresh = await current.page.accessibility.snapshot({ root: handle })
              if (!fresh || fresh.role !== node.role || fresh.name !== node.name || fresh.disabled) throw new Error('Browser ref changed; observe again')
              if (bounded.aborted || snapshot !== current) throw new Error('Browser document changed or control was revoked')
              const locator = handle.asLocator().setTimeout(5_000)
              if (action.action === 'setValue' && ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(node.role) && !node.readonly) {
                if (await handle.evaluate((element) => element instanceof HTMLInputElement && element.type === 'password')) throw new Error('Protected password control; ask the user to enter it locally')
                await locator.fill(action.value!, { signal: bounded, typingThreshold: 0 })
              } else if (action.action === 'invoke' && ['button', 'link', 'menuitem', 'tab'].includes(node.role)
                  || action.action === 'toggle' && ['checkbox', 'switch'].includes(node.role)
                  || action.action === 'select' && ['option', 'radio'].includes(node.role)) {
                // Do not wrap a consequential click in Locator's automatic retry loop.
                await handle.click()
              } else throw new Error('This ref does not support that semantic action')
            } finally { await handle.dispose() }
          } catch (error) {
            invalidate()
            throw new Error(`Browser batch stopped at action ${i + 1}; ${request.actions.length - i - 1} later actions skipped. ${error instanceof Error ? error.message : 'Browser action failed'}`)
          }
        }
        // Act and observe in one round trip. New refs replace all previous refs.
        return await observe(bounded, tabId)
      } finally {
        bounded.removeEventListener('abort', disconnect)
        if (bounded.aborted) disconnect()
      }
    },
  }
}
