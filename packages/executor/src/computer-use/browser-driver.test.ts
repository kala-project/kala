import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { describe, expect, it } from 'vitest'
import { createBrowserDriver } from './browser-driver.js'

describe('explicit browser attachment', () => {
  it.each(['https://example.com', 'http://localhost:9222', 'http://0.0.0.0:9222', 'http://127.0.0.1:9222/private', 'ws://127.0.0.1:9222/devtools/page/123'])('rejects an unapproved browser endpoint: %s', async (endpoint) => {
    const driver = createBrowserDriver(endpoint)
    await expect(driver.semantic({ operation: 'observe', backend: 'browser' })).rejects.toThrow('loopback')
  })

  it('reports missing local attachment instead of launching a replacement browser', async () => {
    await expect(createBrowserDriver(undefined).semantic({ operation: 'observe', backend: 'browser' })).rejects.toThrow('machine owner')
  })

  it('cancels stalled local discovery promptly without following a remote browser endpoint', async () => {
    let began!: () => void
    const started = new Promise<void>((done) => { began = done })
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{"webSocketDebuggerUrl":')
      began()
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test endpoint')
    const driver = createBrowserDriver(`http://127.0.0.1:${address.port}/`)
    const controller = new AbortController()
    const result = driver.semantic({ operation: 'observe', backend: 'browser' }, controller.signal)
    const rejected = expect(result).rejects.toThrow()
    await started
    controller.abort()
    await rejected
    driver.disconnect()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })

  it.each(['ws://example.com:9222/devtools/browser/test', 'ws://127.0.0.1:1/devtools/browser/test'])('rejects discovery that changes the approved endpoint: %s', async (endpoint) => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ webSocketDebuggerUrl: endpoint }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test endpoint')
    const driver = createBrowserDriver(`http://127.0.0.1:${address.port}/`)
    try {
      await expect(driver.semantic({ operation: 'observe', backend: 'browser' })).rejects.toThrow(/loopback|same configured/)
    } finally {
      driver.disconnect()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it.skipIf(!process.env.CHROME_PATH)('operates existing authenticated tabs using scoped AX refs, bounds output, and leaves the browser open on revocation', async () => {
    const root = await mkdtemp(resolve('.browser-acceptance-'))
    const submissions: string[] = []
    const server = createServer((request, response) => {
      if (request.url === '/submit') {
        let body = ''
        request.on('data', (chunk: Buffer) => { body += chunk.toString() })
        request.on('end', () => { submissions.push(body); response.end('saved') })
        return
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(`<title>Existing authenticated tab</title>
        <label>Name <input id="name"></label><input type="password" aria-label="Password" value="DO_NOT_RETURN">
        <button onclick="fetch('/submit',{method:'POST',body:document.querySelector('#name').value})">Save</button>
        <button disabled>Disabled</button><p id="state">Ready</p>`)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test endpoint')
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH, headless: true, userDataDir: join(root, 'profile'),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const driver = createBrowserDriver(`http://127.0.0.1:${new URL(browser.wsEndpoint()).port}/`)
    try {
      const page = await browser.newPage()
      await page.setCookie({ name: 'fixture_session', value: 'existing-session', url: `http://127.0.0.1:${address.port}` })
      await page.goto(`http://127.0.0.1:${address.port}`)
      const list = await driver.semantic({ operation: 'observe', backend: 'browser' })
      const tabId = list.tabs!.find((tab) => tab.title === 'Existing authenticated tab')!.id
      const first = await driver.semantic({ operation: 'observe', backend: 'browser', tabId })
      expect(JSON.stringify(first)).not.toContain('DO_NOT_RETURN')
      expect(first.elements.length).toBeLessThanOrEqual(64)
      const field = first.elements.find((element) => element.name.trim() === 'Name' && element.actions.includes('setValue'))!
      const save = first.elements.find((element) => element.name === 'Save')!
      const observation = await driver.semantic({
        operation: 'act', backend: 'browser', snapshotId: first.snapshotId,
        actions: [{ ref: field.ref, action: 'setValue', value: 'Semantic 中文 😀' }, { ref: save.ref, action: 'invoke' }],
      })
      await expect.poll(() => submissions).toEqual(['Semantic 中文 😀'])
      expect(observation.snapshotId).not.toBe(first.snapshotId)
      expect(await page.cookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fixture_session', value: 'existing-session' })]))
      await expect(driver.semantic({ operation: 'act', backend: 'browser', snapshotId: first.snapshotId, actions: [{ ref: save.ref, action: 'invoke' }] })).rejects.toThrow('Stale')
      const password = observation.elements.find((element) => element.name === 'Password')!
      await expect(driver.semantic({
        operation: 'act', backend: 'browser', snapshotId: observation.snapshotId,
        actions: [{ ref: password.ref, action: 'setValue', value: 'must-not-fill' }],
      })).rejects.toThrow('Protected password')
      expect(await page.$eval('input[type=password]', (element) => element.value)).toBe('DO_NOT_RETURN')
      const latest = await driver.semantic({ operation: 'observe', backend: 'browser', tabId })
      const disabled = latest.elements.find((element) => element.name === 'Disabled')!
      await expect(driver.semantic({
        operation: 'act', backend: 'browser', snapshotId: latest.snapshotId,
        actions: [{ ref: disabled.ref, action: 'invoke' }, { ref: save.ref, action: 'invoke' }],
      })).rejects.toThrow('1 later actions skipped')
      expect(submissions).toHaveLength(1)
      const fresh = await driver.semantic({ operation: 'observe', backend: 'browser', tabId })
      await page.goto(`http://127.0.0.1:${address.port}/new-document`)
      await expect(driver.semantic({ operation: 'act', backend: 'browser', snapshotId: fresh.snapshotId, actions: [{ ref: save.ref, action: 'invoke' }] })).rejects.toThrow('Stale')
      const filtered = await driver.semantic({ operation: 'observe', backend: 'browser', tabId, query: 'Save' })
      expect(filtered.elements.length).toBeGreaterThan(0)
      expect(filtered.elements.every((element) => element.name.includes('Save'))).toBe(true)
      await page.evaluate(() => {
        for (let i = 0; i < 70; i++) {
          const button = document.createElement('button')
          button.textContent = `Bounded button ${i}`
          document.body.append(button)
        }
      })
      const bounded = await driver.semantic({ operation: 'observe', backend: 'browser', tabId })
      expect(bounded.elements).toHaveLength(64)
      expect(bounded.truncated).toBe(true)
      driver.disconnect()
      expect(browser.connected).toBe(true)
      expect(page.isClosed()).toBe(false)
    } finally {
      driver.disconnect()
      await browser.close()
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
