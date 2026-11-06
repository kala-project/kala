import puppeteer from 'puppeteer-core'
import { userInfo } from 'node:os'
import { join } from 'node:path'

const baseUrl = process.env.BOARD_PROTOTYPE_URL ?? 'http://127.0.0.1:4179'
const origin = new URL(baseUrl)
if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.protocol !== 'http:') {
  throw new Error('Board browser acceptance requires a local HTTP prototype')
}
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH
    ?? join(userInfo().homedir, '.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome'),
  headless: true,
  userDataDir: process.env.CHROME_PROFILE_DIR,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.setBypassServiceWorker(true)
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === origin.origin || ['data:', 'blob:'].includes(url.protocol)) void request.continue()
    else void request.abort()
  })
  await page.evaluateOnNewDocument(() => sessionStorage.setItem('ak-board-acceptance', '1'))
  await page.goto(`${origin.origin}/?sessionId=prototype-subagents`,
    { waitUntil: 'domcontentloaded' })
  const row = '[data-testid="sub-agent-row-agent-running"]'
  const state = '[data-testid="sub-agent-command-state-agent-running"]'
  await page.waitForSelector(row, { timeout: 60_000 })
  const assertState = async (label) => {
    await page.waitForFunction((selector, expected) => {
      const element = document.querySelector(selector)
      return element instanceof HTMLElement && element.getClientRects().length > 0
        && element.textContent?.includes(expected)
    }, { timeout: 10_000 }, state, label)
    const status = await page.$eval(row, (element) => element.getAttribute('data-sub-agent-status'))
    if (status !== 'running') throw new Error(`${label} falsely displayed a terminal child: ${status}`)
  }
  await assertState('Queued for next turn (1 pending)')
  await page.evaluate(() => window.__kalaBoardAcceptance.setState('processing', 1))
  await assertState('Processing next turn')
  await assertState('Queued for next turn (1 pending)')
  await page.click('[data-testid="sub-agent-interrupt-agent-running"]')
  await page.waitForFunction(() => window.__kalaBoardAcceptance.stops().length === 1)
  const stops = await page.evaluate(() => window.__kalaBoardAcceptance.stops())
  if (!stops[0].operationId || stops[0].parentSessionId !== 'prototype-subagents' || stops[0].parentCallId !== 'agent-running'
    || stops[0].childSessionId !== 'prototype-subagent-running') {
    throw new Error(`Stop targeted the wrong child: ${JSON.stringify(stops)}`)
  }
  await assertState('UNKNOWN')
  await page.evaluate(() => window.__kalaBoardAcceptance.setState('unknown', 0))
  await new Promise((resolve) => setTimeout(resolve, 2200))
  await assertState('UNKNOWN')
  console.log('Board prototype browser: queued, processing + pending, Stop target, UNKNOWN and nonterminal status passed')
} finally {
  await browser.close()
}
