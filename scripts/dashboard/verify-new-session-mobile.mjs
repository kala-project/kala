#!/usr/bin/env node
// Browser geometry regression for the real NewSessionDialog component.
// Supply CHROME_PATH if Chrome for Testing is installed outside PATH.
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = resolve(import.meta.dirname, '../../packages/dashboard')
const requireDashboard = createRequire(resolve(root, 'package.json'))
const { createServer } = await import(requireDashboard.resolve('vite'))
const executablePath = process.env.CHROME_PATH
if (!executablePath) throw new Error('Set CHROME_PATH to a Chrome/Chromium executable')
const cases = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 676, height: 382 },
]
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'mobile-session-fixture',
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__new_session_mobile__')) return next()
        const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body><div id="root"></div><script type="module" src="/src/test/mobile-session-browser-fixture.tsx"></script></body></html>'
        void vite.transformIndexHtml(req.url, html).then((page) => {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(page)
        }, next)
      })
    },
  }],
})
let browser
try {
  await server.listen()
  const url = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const language of ['zh', 'en']) {
    for (const viewport of cases) {
      const page = await browser.newPage()
      try {
        page.on('pageerror', (error) => console.error('fixture page error:', error))
        page.on('console', (message) => { if (message.type() === 'error') console.error('fixture console:', message.text()) })
        await page.setViewport({ ...viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
        const response = await page.goto(`${url}__new_session_mobile__?lng=${language}`, { waitUntil: 'networkidle0', timeout: 30_000 })
        console.log('fixture response', response?.status(), await page.title())
        await page.waitForSelector('[data-testid="new-session-mode-dag"]', { timeout: 20_000 })
        await page.waitForSelector('[data-testid="new-session-cwd-input"]', { timeout: 20_000 })
        await page.screenshot({ path: join(tmpdir(), `kala-session-${language}-${viewport.width}x${viewport.height}.png`) })
        const ids = ['new-session-runtime-kernel', 'new-session-runtime-copilot', 'new-session-mode-chat', 'new-session-mode-dag', 'dir-picker-up', 'dir-picker-root', 'dir-picker-refresh', 'dir-picker-new-folder', 'workspace-picker-cancel', 'new-session-create']
        for (const id of ids) {
          const result = await page.$eval(`[data-testid="${id}"]`, (button) => {
            button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            const rect = button.getBoundingClientRect()
            const vv = window.visualViewport
            const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            const text = button.innerText?.trim() ?? ''
            const styles = getComputedStyle(button)
            return {
              text,
              disabled: button.disabled,
              hit: Boolean(target && button.contains(target)),
              top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
              visibleTop: vv?.offsetTop ?? 0,
              visibleBottom: (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight),
              whiteSpace: styles.whiteSpace,
              overflow: styles.overflow,
            }
          })
          const visible = result.top >= result.visibleTop - 1 && result.bottom <= result.visibleBottom + 1
          const minHeight = viewport.height < 450 && id.startsWith('dir-picker-') ? 35 : 40
          const readable = result.text.length > 1 && !result.text.includes('…') && result.width >= 44 && result.height >= minHeight
          if (!visible || !readable || (!result.disabled && !result.hit)) throw new Error(`${language} ${viewport.width}x${viewport.height} ${id}: ${JSON.stringify(result)}`)
          console.log(`PASS ${language} ${viewport.width}x${viewport.height} ${id} ${JSON.stringify(result.text)}`)
        }
        for (const id of ['new-session-mode-dag', 'new-session-runtime-copilot']) {
          await page.click(`[data-testid="${id}"]`)
          const selected = await page.$eval(`[data-testid="${id}"]`, (el) => el.getAttribute('aria-checked'))
          if (selected !== 'true') throw new Error(`${id} did not respond to a real browser click at ${viewport.width}x${viewport.height}`)
        }
      } finally {
        await page.close()
      }
    }
  }
  for (const viewport of cases) {
    const page = await browser.newPage()
    try {
      await page.setViewport({ ...viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
      await page.goto(`${url}__new_session_mobile__?lng=zh&surface=explorer`, { waitUntil: 'networkidle0', timeout: 30_000 })
      await page.waitForSelector('[data-testid="hidden-items-toggle"]', { timeout: 20_000 })
      await page.click('[data-testid="hidden-items-toggle"]')
      for (const [id, label] of [['workspace-unhide-missing-hidden-workspace', '显示工作区'], ['session-unhide-hidden-session', '显示会话']]) {
        const result = await page.$eval(`[data-testid="${id}"]`, (button) => {
          button.scrollIntoView({ block: 'nearest' })
          const rect = button.getBoundingClientRect()
          const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return {
            text: button.innerText?.trim(), height: rect.height,
            hit: Boolean(target && button.contains(target)),
            top: rect.top, left: rect.left, right: rect.right,
            targetTag: target?.tagName, targetTestId: target?.getAttribute('data-testid'), targetText: target?.textContent?.trim().slice(0, 60),
            layers: document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).slice(0, 6).map((element) => ({ tag: element.tagName, cls: element.className?.baseVal ?? element.className, z: getComputedStyle(element).zIndex, testid: element.getAttribute('data-testid') })),
            bottom: rect.bottom, viewportHeight: window.visualViewport?.height ?? window.innerHeight,
          }
        })
        if (result.text !== label || result.height < 44 || !result.hit || result.bottom > result.viewportHeight + 1) {
          throw new Error(`hidden Explorer item at ${viewport.width}x${viewport.height}: ${id} ${JSON.stringify(result)}`)
        }
        console.log(`PASS hidden Explorer ${viewport.width}x${viewport.height} ${id} ${label}`)
      }
      await page.click('[data-testid="session-unhide-hidden-session"]')
      const restored = await page.evaluate(() => !localStorage.getItem('ak-hidden-sessions'))
      if (!restored) throw new Error(`hidden Session restore failed at ${viewport.width}x${viewport.height}`)
      await page.screenshot({ path: join(tmpdir(), `kala-explorer-zh-${viewport.width}x${viewport.height}.png`) })
    } finally {
      await page.close()
    }
  }
  const thinkingPage = await browser.newPage()
  try {
    await thinkingPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await thinkingPage.goto(`${url}__new_session_mobile__?lng=zh&surface=thinking`, { waitUntil: 'networkidle0', timeout: 30_000 })
    await thinkingPage.waitForSelector('[data-testid="thinking-update"]', { timeout: 20_000 })
    const text = await thinkingPage.evaluate(() => ({
      title: document.querySelector('[data-testid="thinking-title"]')?.textContent ?? '',
      body: document.querySelector('[data-testid="thinking-update"]')?.textContent ?? '',
    }))
    if (!text.title.includes("I'm investigating") || !text.body.includes("I'm checking John’s report and “quoted text”.")) {
      throw new Error(`Thinking punctuation was not corrected in the browser: ${JSON.stringify(text)}`)
    }
    console.log('PASS Thinking contraction display', JSON.stringify(text))
    await thinkingPage.screenshot({ path: join(tmpdir(), 'kala-thinking-zh-390x844.png') })
  } finally {
    await thinkingPage.close()
  }
} finally {
  await browser?.close()
  await server.close()
}
