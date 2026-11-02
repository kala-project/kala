Object.defineProperty(window, '__KALA_DESKTOP__', { value: true, writable: false, configurable: false })
;(() => {
  const listeners = new Set()
  let pendingSession = null
  const validSession = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  const deliver = (event) => {
    if (event.type === 'open-session' && listeners.size === 0) {
      pendingSession = event.sessionId
      return
    }
    for (const listener of listeners) listener(event)
  }
  const openSession = (sessionId) => {
    if (!validSession(sessionId)) return
    const url = new URL(location.href)
    if (url.searchParams.has('desktopSession')) {
      url.searchParams.delete('desktopSession')
      history.replaceState(history.state, '', url)
    }
    deliver({ type: 'open-session', sessionId })
  }
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
  const nativeIntegration = location.protocol === 'https:'
    || (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
  Object.defineProperty(window, '__KALA_DESKTOP_CONNECTION__', {
    value: Object.freeze({ confirmConnection: () => invoke('desktop_connection_ready') }),
    writable: false, configurable: false,
  })
  const installWindowControls = () => {
    const controlsWidth = nativeIntegration ? 204 : 168
    if (document.getElementById('kala-desktop-window-controls')) return
    const host = document.createElement('div')
    host.id = 'kala-desktop-window-controls'
    host.style.cssText = `position:fixed;top:2px;right:4px;width:${controlsWidth}px;height:32px;z-index:2147483647`
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = `<style>:host{font:13px system-ui;color:#cbd5e1;user-select:none}.controls{box-sizing:border-box;display:flex;width:100%;height:32px;overflow:hidden;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;background:color-mix(in srgb,#111827 88%,transparent);box-shadow:0 1px 4px #0004;backdrop-filter:blur(12px)}:host([data-docked="true"]){color:inherit}:host([data-docked="true"]) .controls{border-color:transparent;border-radius:6px;background:transparent;box-shadow:none;backdrop-filter:none}.drag{width:24px;flex:none;cursor:grab;background:radial-gradient(circle,currentColor 1px,transparent 1.5px) 6px 5px/6px 6px;opacity:.55}.drag:active{cursor:grabbing}button{width:36px;border:0;background:transparent;color:inherit;font:16px system-ui;cursor:pointer;border-radius:5px}button:hover{background:color-mix(in srgb,currentColor 14%,transparent)}.recover{font-size:18px}.recover[aria-busy="true"]{animation:spin .8s linear infinite}:host([data-recovery="true"]) .recover{background:#b45309;color:#fff}.close:hover{background:#dc2626;color:#fff}button:focus-visible{outline:2px solid #60a5fa;outline-offset:-3px}@keyframes spin{to{transform:rotate(360deg)}}</style><div class="controls" aria-label="Window controls"><div class="drag" aria-hidden="true"></div><button class="debug" aria-label="Application debugging" title="Application debugging — manual ports">↔</button><button class="recover" aria-label="Clear cached interface and reload" title="Force refresh (Ctrl+Shift+R)">↻</button><button data-action="minimize" aria-label="Minimize">−</button><button data-action="toggle-maximize" aria-label="Maximize or restore">□</button><button class="close" data-action="close" aria-label="Close">×</button></div>`
    root.querySelectorAll('button[data-action]').forEach((button) => button.addEventListener('click', () => void invoke('desktop_window', { action: button.dataset.action })))
    if (!nativeIntegration) root.querySelector('.debug').remove()
    root.querySelector('.debug')?.addEventListener('click', () => void invoke('application_debug', { request: { op: 'show' } }).catch(() => {}))
    const recover = root.querySelector('.recover')
    recover.addEventListener('click', () => {
      recover.setAttribute('aria-busy', 'true')
      void invoke('desktop_force_refresh').catch(() => recover.removeAttribute('aria-busy'))
    })
    const drag = root.querySelector('.drag')
    drag.addEventListener('mousedown', (event) => { if (event.button === 0) void invoke('desktop_window', { action: 'start-dragging' }) })
    drag.addEventListener('dblclick', () => void invoke('desktop_window', { action: 'toggle-maximize' }))
    document.body.appendChild(host)
    const dock = () => {
      const slots = [...document.querySelectorAll('[data-kala-desktop-window-controls-slot="true"]')]
      const slot = slots.find((candidate) => candidate.getClientRects().length > 0) ?? slots[0]
      if (slot) {
        slot.style.width = `${controlsWidth}px`
        host.dataset.docked = 'true'
        host.style.cssText = `position:relative;inset:auto;width:${controlsWidth}px;height:32px;display:block;flex:0 0 ${controlsWidth}px;z-index:10`
        if (host.parentNode !== slot) slot.appendChild(host)
      } else if (host.parentNode !== document.body) {
        delete host.dataset.docked
        host.style.cssText = `position:fixed;top:2px;right:4px;width:${controlsWidth}px;height:32px;z-index:2147483647`
        document.body.appendChild(host)
      }
    }
    dock()
    const dockSlotSelector = '[data-kala-desktop-window-controls-slot="true"]'
    const containsDockSlot = (node) => node instanceof Element
      && (node.matches(dockSlotSelector) || node.querySelector(dockSlotSelector))
    new MutationObserver((mutations) => {
      const slotChanged = mutations.some((mutation) =>
        [...mutation.addedNodes, ...mutation.removedNodes].some(containsDockSlot))
      if (slotChanged) dock()
    }).observe(document.body, { childList: true, subtree: true })
    const brokenInterfaceText = 'The interface could not be loaded'
    const recoverBrokenInterface = () => {
      host.dataset.recovery = 'true'
      const recoveryTarget = `${location.origin}${location.pathname}`
      if (sessionStorage.getItem('kala-desktop-native-recovery') === recoveryTarget) return
      sessionStorage.setItem('kala-desktop-native-recovery', recoveryTarget)
      recover.setAttribute('aria-busy', 'true')
      void invoke('desktop_force_refresh').catch(() => recover.removeAttribute('aria-busy'))
    }
    const containsBrokenInterface = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.parentElement?.textContent?.includes(brokenInterfaceText)
      return node instanceof Element && node.textContent?.includes(brokenInterfaceText)
    }
    if (document.body.textContent?.includes(brokenInterfaceText)) recoverBrokenInterface()
    new MutationObserver((mutations) => {
      const brokenInterfaceAdded = mutations.some((mutation) =>
        mutation.type === 'characterData'
          ? containsBrokenInterface(mutation.target)
          : [...mutation.addedNodes].some(containsBrokenInterface))
      if (brokenInterfaceAdded) recoverBrokenInterface()
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  }
  if (document.readyState === 'loading' || !document.body) document.addEventListener('DOMContentLoaded', installWindowControls, { once: true })
  else installWindowControls()
  if (nativeIntegration) Object.defineProperty(window, '__KALA_DESKTOP_BRIDGE__', {
    value: Object.freeze({
      version: 1,
      applicationDebugging: Object.freeze({
        version: 1,
        begin: (listener) => {
          if (typeof listener !== 'function') throw new TypeError('Debug transport requires a listener')
          const channel = new window.__TAURI__.core.Channel()
          channel.onmessage = listener
          return invoke('application_debug_begin', { channel })
        },
        setContext: (generation, context) => invoke('application_debug', { request: { op: 'context', generation, context } }),
        reply: (generation, id, result) => invoke('application_debug', { request: { op: 'reply', generation, id, result } }),
        receive: (generation, frame) => invoke('application_debug', { request: { op: 'receive', generation, frame } }),
        touch: (generation, grantId) => invoke('application_debug', { request: { op: 'touch', generation, grantId } }),
        abort: (generation, run, error) => invoke('application_debug', { request: { op: 'abort', generation, run, error } }),
        detach: (generation) => invoke('application_debug', { request: { op: 'detach', generation } }),
        unavailable: (generation, error) => invoke('application_debug', { request: { op: 'unavailable', generation, error } }),
        show: () => invoke('application_debug', { request: { op: 'show' } }),
      }),
      getInfo: () => invoke('desktop_status'),
      confirmConnection: () => invoke('desktop_connection_ready'),
      setActivity: (state) => invoke('desktop_ui', { state }),
      notify: (notification) => invoke('desktop_notify', { notification }),
      readClipboardImage: () => invoke('desktop_clipboard_image'),
      subscribe: (listener) => {
        if (typeof listener !== 'function') throw new TypeError('Desktop subscription requires a listener')
        listeners.add(listener)
        if (pendingSession !== null) {
          const sessionId = pendingSession
          pendingSession = null
          listener({ type: 'open-session', sessionId })
        }
        return () => listeners.delete(listener)
      },
    }),
    writable: false, configurable: false,
  })
  window.addEventListener('runlab:navigate-session', (event) => openSession(event.detail?.sessionId))
  window.addEventListener('runlab:window-state', (event) => {
    if (typeof event.detail?.focused === 'boolean' && typeof event.detail?.visible === 'boolean') {
      deliver({ type: 'window-state', focused: event.detail.focused, visible: event.detail.visible })
    }
  })
  openSession(new URL(location.href).searchParams.get('desktopSession'))
})()
// Ordinary links stay in this unprivileged webview. HTTPS identity redirects
// remain possible; native navigation validation rejects local/file schemes.
document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (link?.target === '_blank' && !link.hasAttribute('download')) link.target = '_self'
}, true)
