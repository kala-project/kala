import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

// Run against the local prototype server, never a deployment. All identity and
// observation responses below are fictional; requests cannot leave loopback.
const base = new URL(process.env.STYLE_URL ?? 'http://127.0.0.1:4179/')
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'STYLE_URL must be loopback')
const artifacts = resolve('.style-runtime')
await mkdir(artifacts, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH,
  userDataDir: resolve(artifacts, 'browser-profile'),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'],
})
const page = await browser.newPage()
page.setDefaultTimeout(45_000)
let observations = 0
let failObservations = true
let owner = true
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.setRequestInterception(true)
page.on('request', (request) => {
  const url = new URL(request.url())
  const json = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (['data:', 'blob:'].includes(url.protocol)) return void request.continue()
  if (url.origin !== base.origin) return void request.abort()
  if (url.pathname === '/runtime/capabilities') return void json({
    product: 'dedicated',
    deployment: { schemaVersion: 1, architecture: 'platform', tenancy: 'single-tenant', runtimeProfile: 'full' },
    capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
  })
  if (url.pathname === '/auth/me') return void json({
    authenticated: true, profile: { displayName: 'Owner', initials: 'O', email: 'owner@example.test' },
    organization: { id: 'style-check', name: 'Local style check', status: 'active', role: owner ? 'owner' : 'member' },
    ...(owner ? { deploymentServices: { observability: true } } : {}),
    cacheNamespace: 'local-style-check', expiresAt: '2099-01-01T00:00:00Z',
  })
  if (url.pathname === '/organization/observability') {
    observations++
    return void json(failObservations ? {} : {
      checkedAt: '2026-11-02T00:00:00Z', retainedLogs: 1, retainedSpans: 0,
      resources: [{ name: 'Local service', hasLogs: true, hasTraces: true, hasMetrics: true }],
      logs: [{ service: 'Local service', message: 'Local verification event', attributes: {} }], spans: [],
    }, failObservations ? 503 : 200)
  }
  if (url.pathname === '/auth/sessions') return void json({ sessions: Array.from({ length: 30 }, (_, index) => ({
    id: `local-${index}`, current: index === 0, device: { label: `Local browser ${index}` },
    createdAt: '2026-11-01T00:00:00Z', lastSeenAt: '2026-11-02T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
  })) })
  return void request.continue()
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const click = async (selector) => {
  await page.waitForSelector(selector, { visible: true })
  await page.$eval(selector, (element) => element.scrollIntoView({ block: 'nearest' }))
  await wait(250)
  await page.click(selector)
}
async function checkFooter(selector, shot) {
  await wait(300)
  const geometry = await page.$eval(selector, (footer) => {
    const nodes = ['account-menu-trigger', 'app-shell-download-desktop', 'app-shell-nav-settings-icon'].map((id) => footer.querySelector(`[data-testid="${id}"]`))
    return nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, center: box.y + box.height / 2, text: node.textContent, name: node.getAttribute('aria-label') }
    })
  })
  assert(geometry.every((item) => item.height >= 44 && item.width >= 44 && item.x >= 0), JSON.stringify(geometry))
  assert(Math.max(...geometry.map((item) => item.center)) - Math.min(...geometry.map((item) => item.center)) < 2, 'footer actions must occupy one aligned row')
  assert(geometry[0].x < geometry[1].x && geometry[1].x < geometry[2].x, 'account must precede icon actions')
  assert.equal(geometry[0].text, 'Owner')
  assert.equal(geometry[1].text, '')
  assert.equal(geometry[2].text, '')
  assert(geometry.every((item) => item.name), 'all footer actions need accessible names')
  assert(await page.$eval(selector, (node) => !node.querySelector('button button, summary button')), 'no nested buttons')
  await page.screenshot({ path: resolve(artifacts, `${shot}.png`) })
}
async function checkTypography(selector) {
  const undersized = await page.$eval(selector, (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const small = []
    while (walker.nextNode()) {
      const text = walker.currentNode
      const node = text.parentElement
      if (!text.textContent.trim() || !node.getClientRects().length) continue
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0 || style.visibility === 'hidden') continue
      const scale = node instanceof SVGGraphicsElement ? Math.abs(node.getScreenCTM()?.a ?? 1) : 1
      if (parseFloat(style.fontSize) * scale < 11.99) small.push(`${text.textContent.trim()}: ${style.fontSize} × ${scale}`)
    }
    return small
  })
  assert.deepEqual(undersized, [], `sub-caption text in ${selector}`)
}
async function checkLongAlert() {
  await page.evaluate(async () => {
    const resources = performance.getEntriesByType('resource').map((resource) => resource.name)
    const loaded = async (pattern) => {
      const module = await import(resources.find((url) => pattern.test(url)))
      return module.default ?? module
    }
    const React = await loaded(/\/react\.js\?/)
    const { createRoot } = await loaded(/\/react-dom_client\.js\?/)
    const uiUrl = resources.find((url) => url.includes('/components/ui/alert-dialog.tsx'))
    const { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription } = await import(uiUrl)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    window.__styleAlertCleanup = () => { root.unmount(); host.remove() }
    root.render(React.createElement(AlertDialog, { open: true }, React.createElement(AlertDialogContent, { 'data-testid': 'style-long-alert' },
      React.createElement(AlertDialogTitle, null, 'Confirm'),
      React.createElement(AlertDialogDescription, null, 'Long confirmation'),
      ...Array.from({ length: 60 }, (_, key) => React.createElement('p', { key }, `Confirmation detail ${key}`)))))
  })
  await page.waitForSelector('[data-testid="style-long-alert"] [data-radix-scroll-area-viewport]')
  await wait(300)
  const bounds = await page.$eval('[data-testid="style-long-alert"]', (node) => {
    const viewport = node.querySelector('[data-radix-scroll-area-viewport]')
    viewport.scrollTop = viewport.scrollHeight
    const box = node.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, height: innerHeight, viewport: viewport.clientHeight, total: viewport.scrollHeight, scrolled: viewport.scrollTop }
  })
  assert(bounds.top >= 0 && bounds.bottom <= bounds.height + 1 && bounds.viewport > 0 && bounds.scrolled > 0, JSON.stringify(bounds))
  await page.evaluate(() => { window.__styleAlertCleanup(); delete window.__styleAlertCleanup })
}
try {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('ak-theme', 'dark')
    localStorage.setItem('ak-interface-scale', '90')
    localStorage.setItem('ak-chat-font-size', '0')
    localStorage.setItem('ak-code-block-font-size', '10')
    localStorage.setItem('ak-session-explorer-font-size', '0')
    localStorage.setItem('ak-file-explorer-font-size', '0')
  })
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.goto(base.href, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="desktop-sidebar-footer"] [data-testid="account-menu-trigger"]')
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  await page.waitForFunction(() => document.documentElement.dataset.akInterfaceDensity === 'compact')
  await checkFooter('[data-testid="desktop-sidebar-footer"]', 'desktop-footer-dark')
  await checkTypography('[data-testid="desktop-sidebar-footer"]')
  await checkTypography('[data-testid="chat-panel"]')
  await page.evaluate(() => { localStorage.setItem('ak-theme', 'light'); window.dispatchEvent(new Event('ak-theme-change')) })
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
  await checkFooter('[data-testid="desktop-sidebar-footer"]', 'desktop-footer-light')
  await page.evaluate(() => { localStorage.setItem('ak-theme', 'dark'); window.dispatchEvent(new Event('ak-theme-change')) })
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  await click('[data-testid="account-menu-trigger"]')
  assert(await page.$eval('[role="menu"]', (menu) => menu.parentElement === document.body && menu.contains(document.activeElement)))
  await page.keyboard.press('Escape')
  assert(await page.$eval('[data-testid="account-menu-trigger"]', (trigger) => document.activeElement === trigger))
  await click('[data-testid="product-switcher-trigger"]')
  await click('[data-testid="product-switcher-management"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="deployment-center"] [role="alert"]')?.textContent.includes('503'))
  assert.equal(await page.$('[data-testid="deployment-center"] [data-testid="deployment-identity-console"]'), null)
  const count = observations
  await wait(500)
  assert.equal(observations, count, 'observations must never poll')
  failObservations = false
  await page.$eval('[data-testid="deployment-center"] button', () => {
    const refresh = [...document.querySelectorAll('[data-testid="deployment-center"] button')].find((button) => button.textContent === 'Refresh')
    refresh.click()
  })
  await page.waitForFunction(() => document.querySelector('[data-testid="deployment-center"]')?.textContent.includes('Local verification event'))
  assert.equal(await page.$('[data-testid="deployment-center"] [role="alert"]'), null)
  await checkTypography('[data-testid="deployment-center"]')
  await page.screenshot({ path: resolve(artifacts, 'management.png') })
  await click('[data-testid="deployment-center-close"]')
  await click('[data-testid="account-menu-trigger"]')
  await click('[data-testid="account-details"]')
  const scrolled = await page.$eval('[data-testid="account-center"] [data-radix-scroll-area-viewport]', (viewport) => {
    viewport.scrollTop = viewport.scrollHeight
    return { top: viewport.scrollTop, height: viewport.clientHeight, total: viewport.scrollHeight }
  })
  assert(scrolled.top > 0 && scrolled.height <= 900, `account viewport not bounded: ${JSON.stringify(scrolled)}`)
  await checkTypography('[data-testid="account-center"]')
  await click('[data-testid="account-center-close"]')
  await click('[data-testid="sidebar-collapse-button"]')
  await page.waitForSelector('[data-testid="desktop-rail-management"]', { visible: true })
  assert(await page.$eval('[data-testid="desktop-rail-management"]', (node) => !node.closest('[data-testid="desktop-rail-footer"]')))
  await page.screenshot({ path: resolve(artifacts, 'collapsed-rail.png') })
  await page.setViewport({ width: 390, height: 740, deviceScaleFactor: 1 })
  await click('[data-testid="explorer-toggle"]')
  await checkFooter('[data-testid="narrow-drawer-footer"]', 'mobile-footer')
  await checkTypography('[data-testid="narrow-drawer-footer"]')
  await click('[data-testid="explorer-drawer"] [data-testid="product-switcher-trigger"]')
  await page.waitForSelector('[data-testid="product-switcher-management"]', { visible: true })
  await page.keyboard.press('Escape')
  await page.goto(base.href, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="chat-panel"]')
  await checkLongAlert()
  owner = false
  await page.goto(base.href, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="chat-panel"]')
  assert.equal(await page.$('[data-testid="desktop-rail-management"], [data-testid="product-switcher-management"]'), null, 'non-owner must not receive management')
  assert.deepEqual(errors, [], 'browser runtime errors')
  console.log('PASS desktop/mobile footer, collapsed rail, account and long-alert scrolling, minimum typography, Owner navigation, portal/focus/Escape, explicit 503 recovery and manual-only refresh')
} catch (error) {
  console.error('Browser errors:', errors)
  console.error(await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => 'page unavailable'))
  await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
