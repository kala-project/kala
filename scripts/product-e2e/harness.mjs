import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import puppeteer from 'puppeteer-core'

export class ProductE2EHarness {
  constructor(options = {}) {
    this.name = options.name ?? 'product-e2e'
    this.chromePath = options.chromePath ?? process.env.CHROME_PATH ?? '/snap/bin/chromium'
    this.headless = options.headless ?? true
    this.evidenceRoot = options.evidenceRoot ?? process.env.PRODUCT_E2E_EVIDENCE_ROOT ?? join(tmpdir(), `agent-runlab-program-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`)
    this.browser = null
    this.contexts = []
    this.resources = []
    this.steps = []
    this.failures = []
  }

  async start() {
    await mkdir(this.evidenceRoot, { recursive: true })
    this.browser = await puppeteer.launch({ executablePath: this.chromePath, headless: this.headless, protocolTimeout: 120_000, args: ['--no-sandbox'] })
    return this
  }

  async newActor(name, viewport = { width: 1440, height: 900 }) {
    if (!this.browser) throw new Error('harness is not started')
    const context = await this.browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport(viewport)
    page.setDefaultTimeout(60_000)
    const actor = { name, context, page, requests: [], requestFailures: [], responses: [], consoleErrors: [], pageErrors: [] }
    page.on('request', (request) => actor.requests.push({ method: request.method(), url: request.url(), navigation: request.isNavigationRequest() }))
    page.on('requestfailed', (request) => {
      const error = request.failure()?.errorText ?? 'unknown'
      const url = request.url()
      if (error === 'net::ERR_ABORTED' && url.endsWith('/manifest.webmanifest')) return
      actor.requestFailures.push({ url, error })
    })
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().includes('favicon')) actor.responses.push({ status: response.status(), url: response.url() })
    })
    page.on('console', (message) => { if (message.type() === 'error') actor.consoleErrors.push(message.text()) })
    page.on('pageerror', (error) => actor.pageErrors.push(String(error)))
    this.contexts.push(actor)
    return actor
  }

  async step(name, action, verify) {
    const startedAt = Date.now()
    try {
      const value = await action()
      const evidence = verify ? await verify(value) : value
      this.steps.push({ name, ok: true, durationMs: Date.now() - startedAt, evidence: serializable(evidence) })
      return value
    } catch (error) {
      const failure = { name, ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.stack ?? error.message : String(error) }
      this.steps.push(failure)
      this.failures.push(failure)
      throw error
    }
  }

  registerResource(kind, id, cleanup) {
    this.resources.push({ kind, id, cleanup, cleaned: false })
  }

  registerProcess(name, child, logs = []) {
    this.registerResource('process', name, async () => stopProcess(child))
    child.stdout?.on('data', (chunk) => logs.push(`[stdout] ${chunk.toString()}`))
    child.stderr?.on('data', (chunk) => logs.push(`[stderr] ${chunk.toString()}`))
    return { child, logs }
  }

  async screenshot(actor, name, options = {}) {
    const path = join(this.evidenceRoot, `${safeName(actor.name)}-${safeName(name)}.png`)
    await actor.page.screenshot({ path, fullPage: options.fullPage ?? false })
    return path
  }

  async finalize(extra = {}) {
    // Freeze browser evidence and close actors before tearing down Host/Executor.
    // Pages persist state during unload; stopping Host first creates teardown-only
    // connection errors that are not product-journey failures.
    const actors = this.contexts.map((actor) => ({
      name: actor.name,
      url: actor.page.url(),
      failedResponses: [...actor.responses],
      requestFailures: [...actor.requestFailures],
      consoleErrors: [...actor.consoleErrors],
      pageErrors: [...actor.pageErrors],
    }))
    for (const actor of this.contexts) await actor.context.close().catch(() => {})
    await this.browser?.close().catch(() => {})
    this.browser = null

    const cleanup = []
    for (const resource of [...this.resources].reverse()) {
      try {
        await resource.cleanup()
        resource.cleaned = true
        cleanup.push({ kind: resource.kind, id: resource.id, ok: true })
      } catch (error) {
        const entry = { kind: resource.kind, id: resource.id, ok: false, error: String(error) }
        cleanup.push(entry)
        this.failures.push({ name: `cleanup:${resource.kind}:${resource.id}`, ok: false, error: String(error) })
      }
    }
    const report = { name: this.name, generatedAt: new Date().toISOString(), steps: this.steps, actors, cleanup, failures: this.failures, ...extra }
    const reportPath = join(this.evidenceRoot, 'report.json')
    await mkdir(this.evidenceRoot, { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return { report, reportPath, evidenceRoot: this.evidenceRoot }
  }

  assertClean(report) {
    const actorFailures = report.actors.flatMap((actor) => [
      ...actor.failedResponses.map((item) => `${actor.name}: HTTP ${item.status} ${item.url}`),
      ...(actor.requestFailures ?? []).map((item) => `${actor.name}: request ${item.error} ${item.url}`),
      ...actor.consoleErrors.map((item) => `${actor.name}: console ${item}`),
      ...actor.pageErrors.map((item) => `${actor.name}: page ${item}`),
    ])
    const failures = [...report.failures.map((item) => `${item.name}: ${item.error}`), ...actorFailures]
    if (failures.length > 0) throw new Error(`product E2E failed:\n${failures.join('\n')}`)
  }
}

export async function clickByTestId(page, testId) {
  const selector = `[data-testid="${testId}"]`
  await page.waitForSelector(selector)
  const elements = await page.$$(selector)
  for (const element of elements) {
    if (await element.isVisible()) {
      await clickElement(element, testId)
      return
    }
  }
  throw new Error(`no visible element found for data-testid="${testId}"`)
}

export async function clickElement(element, description = 'element') {
  if (!element) throw new Error(`cannot pointer-click missing ${description}`)
  await element.scrollIntoView()
  const box = await element.boundingBox()
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`cannot pointer-click hidden ${description}`)
  }
  const hit = await element.evaluate((candidate) => {
    if (!candidate.isConnected) return { reachable: false, target: 'detached' }
    const rect = candidate.getBoundingClientRect()
    const points = [
      [0.5, 0.5],
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ]
    const match = points.map(([x, y]) => ({
      x: rect.width * x,
      y: rect.height * y,
      target: document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y),
    })).find(({ target }) => target === candidate || candidate.contains(target))
    return {
      reachable: match !== undefined,
      target: match?.target?.getAttribute('data-testid') ?? match?.target?.tagName ?? null,
      offset: match ? { x: match.x, y: match.y } : undefined,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })
  if (!hit.reachable) {
    throw new Error(`cannot pointer-click covered ${description}; ${JSON.stringify(hit)}`)
  }
  await element.click({ offset: hit.offset })
}

export async function clickFirstVisible(page, selector, options = {}) {
  await page.waitForSelector(selector)
  await waitFor(async () => {
    const elements = await page.$$(selector)
    for (const element of elements) {
      if (!await element.isVisible()) continue
      const matches = await element.evaluate((candidate, expected) => {
        if (expected.enabled !== false && (
          candidate.hasAttribute('disabled')
          || candidate.getAttribute('aria-disabled') === 'true'
        )) return false
        const text = candidate.textContent?.trim() ?? ''
        if (expected.text !== undefined && text !== expected.text) return false
        if (expected.textIncludes !== undefined && !text.includes(expected.textIncludes)) return false
        return true
      }, options)
      if (!matches) continue
      try {
        await clickElement(element, options.description ?? selector)
        return true
      } catch (error) {
        if (String(error).includes('detached') || String(error).includes('Node is detached') || String(error).includes('cannot pointer-click covered')) continue
        throw error
      }
    }
    if (elements.length > 0) {
      const diagnostics = await page.$$eval(selector, (candidates) => candidates.map((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return {
          text: candidate.textContent?.trim() ?? '',
          disabled: candidate.hasAttribute('disabled') || candidate.getAttribute('aria-disabled') === 'true',
          rect: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
        }
      }))
      throw new Error(`matching elements are not actionable: ${JSON.stringify(diagnostics)}`)
    }
    return false
  }, { timeoutMs: options.timeoutMs ?? 5_000, name: options.description ?? selector })
}

export async function hoverAncestorAndClickFirst(page, selector, ancestorSelector, options = {}) {
  await page.waitForSelector(selector)
  await waitFor(async () => {
    const elements = await page.$$(selector)
    for (const element of elements) {
      const matches = await element.evaluate((candidate, expected) => {
        if (expected.enabled !== false && (
          candidate.hasAttribute('disabled')
          || candidate.getAttribute('aria-disabled') === 'true'
        )) return false
        const text = candidate.textContent?.trim() ?? ''
        return expected.textIncludes === undefined || text.includes(expected.textIncludes)
      }, options)
      if (!matches) continue
      const ancestorHandle = await element.evaluateHandle((candidate, expectedSelector) =>
        candidate.closest(expectedSelector), ancestorSelector)
      const ancestor = ancestorHandle.asElement()
      if (!ancestor) continue
      const targetTestId = await element.evaluate((candidate) => candidate.getAttribute('data-testid'))
      await ancestor.scrollIntoView()
      await ancestor.hover()
      const refreshed = targetTestId
        ? await page.$$(`[data-testid="${targetTestId}"]`)
        : await page.$$(selector)
      const target = await findVisibleElement(refreshed, async (candidate) =>
        await candidate.evaluate((item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true'))
      if (!target) continue
      const refreshedAncestorHandle = await target.evaluateHandle((candidate, expectedSelector) =>
        candidate.closest(expectedSelector), ancestorSelector)
      await refreshedAncestorHandle.asElement()?.hover()
      try {
        await clickElement(target, options.description ?? selector)
        return true
      } catch {
        return false
      }
    }
    return false
  }, { timeoutMs: options.timeoutMs ?? 15_000, name: options.description ?? selector })
}

export async function waitForText(page, text, timeout = 60_000) {
  await page.waitForFunction((expected) => document.body.innerText.includes(expected), { timeout }, text)
}

export function startProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: options.detached ?? true,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

export async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = { code: code ?? -1, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
      if (options.allowFailure || code === 0) resolve(result)
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}): ${result.stderr || result.stdout}`))
    })
    child.stdin.end(options.stdin)
  })
}

export async function waitForHttp(url, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let last
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      last = new Error(`HTTP ${response.status}`)
    } catch (error) { last = error }
    await sleep(options.intervalMs ?? 150)
  }
  throw new Error(`timed out waiting for ${url}: ${last instanceof Error ? last.message : String(last)}`)
}

export async function waitFor(check, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let last
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { last = error }
    await sleep(options.intervalMs ?? 150)
  }
  throw new Error(`timed out waiting for ${options.name ?? 'condition'}${last ? `: ${String(last)}` : ''}`)
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function loginWithPassword(page, { productOrigin, loginName, password, loginUrl = `${productOrigin}/auth/login` }) {
  const start = new URL(loginUrl)
  if (start.origin !== new URL(productOrigin).origin || start.pathname !== '/auth/login') throw new Error('login URL must be on the product authentication endpoint')
  await navigateLoginPage(page, start.href)
  await page.waitForSelector('input[name=loginName]')
  // ZITADEL's login app hydrates after the input first appears and can replace
  // that node once. Wait for hydration before entering credentials.
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  await typeStableValue(page, 'input[name=loginName]', loginName)
  await submitVisibleForm(page, 'input[name=loginName]', loginName)
  await page.waitForSelector('input[name=password]')
  await typeStableValue(page, 'input[name=password]', password)
  await submitVisibleForm(page, 'input[name=password]')
  try {
    await page.waitForFunction(async (origin) => {
      if (location.pathname.includes('/password/change')) return true
      if (location.origin !== new URL(origin).origin) return false
      const response = await fetch('/auth/me')
      return response.ok && (await response.json()).authenticated === true
    }, { timeout: 45_000 }, productOrigin)
  } catch {
    const location = new URL(page.url())
    const stage = location.pathname.includes('/password/change') ? 'password-change' : location.pathname.startsWith('/ui/v2/login') ? 'identity-login' : location.origin === new URL(productOrigin).origin ? 'product' : 'unknown'
    const passwordForm = Boolean(await page.$('input[name=password]'))
    throw new Error(`login did not reach an authenticated session or password change (stage=${stage}, passwordForm=${passwordForm})`)
  }
  let effectivePassword = password
  if (page.url().includes('/password/change')) {
    effectivePassword = `${password}N2!`
    const fields = await page.$$('input[type=password]')
    if (fields.length === 0) throw new Error('password-change form has no password inputs')
    const values = fields.length >= 3 ? [password, effectivePassword, effectivePassword] : [effectivePassword, effectivePassword]
    for (let index = 0; index < Math.min(fields.length, values.length); index += 1) {
      await fields[index].type(values[index])
    }
    const buttons = await page.$$('button')
    const submit = await findVisibleElement(buttons, async (button) => {
      const value = await button.evaluate((element) => ({
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        text: element.textContent?.trim() ?? '',
      }))
      return !value.disabled && /continue|change|save/iu.test(value.text)
    })
    await clickElement(submit, 'password change submit')
  }
  // The simple-chat layout has no app-shell-nav. Verify the actual authenticated
  // session instead of depending on one of the possible dashboard layouts.
  await page.waitForFunction(async (origin) => {
    if (location.origin !== new URL(origin).origin) return false
    const response = await fetch('/auth/me')
    return response.ok && (await response.json()).authenticated === true
  }, { timeout: 45_000 }, productOrigin)
  return effectivePassword
}

export async function navigateLoginPage(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      return
    } catch (error) {
      if (attempt === 3 || !(error instanceof Error) || error.message !== `net::ERR_NETWORK_CHANGED at ${url}`) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    }
  }
}

async function typeStableValue(page, selector, value, replaceExisting = false) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForSelector(selector)
    await page.click(selector)
    if (replaceExisting) {
      await page.keyboard.down('Control')
      await page.keyboard.press('KeyA')
      await page.keyboard.up('Control')
      await page.keyboard.press('Backspace')
    }
    await page.keyboard.type(value)
    if (await page.$eval(selector, (input) => input.value).catch(() => '') === value) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`input value did not stabilize: ${selector}`)
}

async function findVisibleElement(elements, predicate) {
  for (const element of elements) {
    if (await element.isVisible() && await predicate(element)) return element
  }
  return null
}

export async function waitForIdentitySubmit(page, selector, retryValue) {
  const attempts = retryValue === undefined ? 1 : 3
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => !button.disabled && /continue|next|sign in/iu.test(button.textContent ?? '')), { timeout: 30_000 / attempts })
      return
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error
      const input = await page.$(selector)
      if (attempt === attempts - 1 || !input) {
        const path = new URL(page.url()).pathname
        const form = await page.evaluate((fieldSelector) => {
          const field = document.querySelector(fieldSelector)
          return {
            readyState: document.readyState,
            inputLength: field instanceof HTMLInputElement ? field.value.length : null,
            inputDisabled: field instanceof HTMLInputElement ? field.disabled : null,
            buttons: [...document.querySelectorAll('button')].map((button) => ({
              disabled: button.disabled,
              expectedAction: /continue|next|sign in/iu.test(button.textContent ?? ''),
            })),
            alerts: document.querySelectorAll('[role=alert]').length,
          }
        }, selector)
        throw new Error(`identity form did not enable (path=${path}, form=${JSON.stringify(form)})`, { cause: error })
      }
      await typeStableValue(page, selector, retryValue, true)
    }
  }
}

async function submitVisibleForm(page, selector, retryValue) {
  await waitForIdentitySubmit(page, selector, retryValue)
  const buttons = await page.$$('button')
  const button = await findVisibleElement(buttons, async (candidate) =>
    await candidate.evaluate((item) =>
      !item.disabled && /continue|next|sign in/iu.test(item.textContent ?? '')))
  await clickElement(button, `submit button for ${selector}`)
}

function safeName(value) { return value.replace(/[^a-zA-Z0-9_-]+/gu, '-') }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  const stopped = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)])
  if (!stopped) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    await Promise.race([exited, sleep(2_000)])
  }
}
function serializable(value) {
  if (value === undefined) return null
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}
