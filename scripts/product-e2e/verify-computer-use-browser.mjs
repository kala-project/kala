#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ProductE2EHarness, clickByTestId, clickFirstVisible } from './harness.mjs'

if (process.env.PRODUCT_E2E_COMPUTER_ISOLATED !== '1') throw new Error('Use an explicitly isolated target, never production')
const credentials = JSON.parse(readFileSync(resolve(process.env.PRODUCT_E2E_COMPUTER_CONFIG), 'utf8'))
const transport = JSON.parse(readFileSync(resolve(process.env.PRODUCT_E2E_COMPUTER_TRANSPORT_REPORT), 'utf8'))
assert.ok(transport.ok && transport.target.startsWith('kala-clean-'), 'A successful isolated transport acceptance is required first')
const harness = new ProductE2EHarness({ name: 'real-computer-use-browser' })
let actor
let failure
try {
  await harness.start()
  actor = await harness.newActor('desktop-user', { width: 1600, height: 1000 })
  const page = actor.page
  const inputFrames = []
  const inputResults = new Map()
  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameSent', ({ response }) => {
    const frame = response.payloadData
    if (!frame.includes('"computer:request"')) return
    const [, request] = JSON.parse(frame.slice(frame.indexOf('[')))
    if (request.operation === 'input') inputFrames.push({ requestId: request.requestId, action: request.action })
  })
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    const frame = response.payloadData
    if (!frame.startsWith('43/dashboard,')) return
    const [result] = JSON.parse(frame.slice(frame.indexOf('[')))
    if (result?.requestId && inputFrames.some((input) => input.requestId === result.requestId)) inputResults.set(result.requestId, result)
  })
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const local = new URL(request.url()).origin === new URL(credentials.origin).origin
    void request.continue(local ? { headers: { ...request.headers(), authorization: `Bearer ${credentials.token}` } } : {})
  })
  await harness.step('open real isolated session and Computer sidebar', async () => {
    const url = new URL(credentials.origin)
    url.searchParams.set('token', credentials.token)
    url.searchParams.set('sessionId', transport.sessionId)
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await clickByTestId(page, 'right-panel-computer-tab')
    await page.waitForSelector('[data-testid="computer-consent"]')
    assert.equal(await page.$eval('[data-testid="computer-start"]', (button) => button.disabled), true)
    assert.equal(await page.$('[data-testid="computer-screen"]'), null)
  })
  await harness.step('explicit consent produces a decoded actual desktop image', async () => {
    await clickByTestId(page, 'computer-consent')
    await page.waitForFunction(() => !document.querySelector('[data-testid="computer-start"]')?.disabled)
    await clickByTestId(page, 'computer-start')
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-testid="computer-screen"]')
      return image?.complete && image.naturalWidth > 0
    })
    const dimensions = await page.$eval('[data-testid="computer-screen"]', (image) => ({ width: image.naturalWidth, height: image.naturalHeight }))
    assert.deepEqual(dimensions, { width: transport.image.width, height: transport.image.height })
    await harness.screenshot(actor, 'shared-desktop')
    return dimensions
  })
  await harness.step('expanded desktop escapes ancestor clipping and retains remote Escape', async () => {
    await clickFirstVisible(page, 'button[aria-label="Expand desktop"]')
    await page.waitForSelector('[data-testid="computer-expanded-dialog"]')
    await page.waitForFunction(() => {
      const bounds = document.querySelector('[data-testid="computer-expanded-dialog"]')?.getBoundingClientRect()
      return bounds && bounds.left >= 0 && bounds.top >= 0 && bounds.width > innerWidth * 0.9 && bounds.right <= innerWidth
    })
    await page.focus('[data-computer-input="true"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="computer-expanded-dialog"]')
    await harness.screenshot(actor, 'expanded-desktop')
    await clickFirstVisible(page, 'button[aria-label="Expand desktop"]')
    await page.waitForSelector('[data-testid="computer-expanded-dialog"]', { hidden: true })
    assert.ok(await page.$('[data-testid="computer-stop"]'))
  })
  await harness.step('scaled physical pointer input explicitly takes over from Agent control', async () => {
    await clickByTestId(page, 'computer-agent-permission')
    await page.waitForFunction(() => document.querySelector('[data-testid="computer-agent-permission"]')?.checked === true)
    const point = await page.$eval('[data-testid="computer-screen"]', (image) => {
      const bounds = image.getBoundingClientRect()
      const clientX = Math.round(bounds.left + bounds.width / 3)
      const clientY = Math.round(bounds.top + bounds.height / 3)
      return { x: Math.floor((clientX - bounds.left) * image.naturalWidth / bounds.width), y: Math.floor((clientY - bounds.top) * image.naturalHeight / bounds.height), clientX, clientY }
    })
    await page.mouse.click(point.clientX, point.clientY)
    const expected = { type: 'click', x: transport.image.originX + point.x, y: transport.image.originY + point.y, button: 'left' }
    const deadline = Date.now() + 20_000
    let input
    while (Date.now() < deadline) {
      input = inputFrames.find(({ action }) => JSON.stringify(action) === JSON.stringify(expected))
      if (input && inputResults.has(input.requestId)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(input, 'Browser did not send the physical screenshot coordinates')
    const result = inputResults.get(input.requestId)
    assert.ok(result, 'Native pointer input was not acknowledged')
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status.allowAgent, false)
    await page.waitForFunction(() => document.querySelector('[data-testid="computer-agent-permission"]')?.checked === false)
    assert.equal(await page.$('[role="alert"]'), null)
    return expected
  })
  await harness.step('switching sidebar tools revokes sharing and clears the image', async () => {
    await clickByTestId(page, 'right-panel-files-tab')
    await clickByTestId(page, 'right-panel-computer-tab')
    await page.waitForSelector('[data-testid="computer-consent"]')
    assert.equal(await page.$('[data-testid="computer-screen"]'), null)
    assert.equal(await page.$eval('[data-testid="computer-consent"]', (input) => input.checked), false)
    await clickByTestId(page, 'computer-consent')
    await page.waitForFunction(() => !document.querySelector('[data-testid="computer-start"]')?.disabled)
    await clickByTestId(page, 'computer-start')
    await page.waitForSelector('[data-testid="computer-screen"]')
    await clickByTestId(page, 'computer-stop')
    await page.waitForSelector('[data-testid="computer-consent"]')
  })
  await harness.step('mobile drawer and nested expanded desktop retain remote Escape', async () => {
    await page.setViewport({ width: 390, height: 844 })
    await clickByTestId(page, 'sidebar-toggle')
    await page.waitForSelector('[data-testid="inspector-drawer-mobile"]')
    await clickFirstVisible(page, '[data-testid="right-panel-computer-tab"]')
    await clickFirstVisible(page, '[data-testid="computer-consent"]')
    await page.waitForFunction(() => !document.querySelector('[data-testid="computer-start"]')?.disabled)
    await clickFirstVisible(page, '[data-testid="computer-start"]')
    await page.waitForSelector('[data-testid="computer-screen"]')
    await clickFirstVisible(page, 'button[aria-label="Expand desktop"]')
    await page.waitForSelector('[data-testid="computer-expanded-dialog"]')
    await page.focus('[data-computer-input="true"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="computer-expanded-dialog"]')
    await harness.screenshot(actor, 'mobile-expanded-desktop')
    await clickFirstVisible(page, 'button[aria-label="Expand desktop"]')
    await page.waitForSelector('[data-testid="inspector-drawer-mobile"]')
    await clickFirstVisible(page, '[data-testid="computer-stop"]')
    await page.waitForSelector('[data-testid="computer-consent"]')
    await clickFirstVisible(page, '[data-testid="right-panel-collapse"]')
    await page.waitForSelector('[data-testid="inspector-drawer-mobile"]', { hidden: true })
  })
} catch (error) {
  failure = error
  if (actor) await harness.screenshot(actor, 'failure')
} finally {
  const { report, reportPath } = await harness.finalize()
  if (failure) console.error(failure.stack)
  try { harness.assertClean(report) } catch (error) { console.error(error.message); failure ??= error }
  console.log(JSON.stringify({ ok: !failure, steps: report.steps, reportPath }))
  if (failure) process.exitCode = 1
}
