import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION, TERMINAL_CREATE_CLIENT_TIMEOUT_MS } from '../../shared/dist/index.js'
import { WINDOWS_TERMINAL_NODE, windowsTerminalFixtures } from './terminal-product-fixtures.mjs'

assert.equal(process.env.PRODUCT_E2E_TERMINAL_ISOLATED, '1', 'An explicitly isolated target is required')
const credentials = JSON.parse(await readFile(resolve(process.env.PRODUCT_E2E_TERMINAL_CONFIG), 'utf8'))
const platform = process.env.PRODUCT_E2E_TERMINAL_PLATFORM ?? credentials.platform ?? 'linux'
assert.ok(['linux', 'windows'].includes(platform), 'Explicit target platform must be linux or windows')
const windows = platform === 'windows'
const delayedCreateProof = process.env.PRODUCT_E2E_TERMINAL_DELAYED_CREATE_PROOF === '1'
const workspaceName = process.env.PRODUCT_E2E_TERMINAL_WORKSPACE ?? credentials.workspaceName ?? `kala-clean-${platform}`
assert.ok(workspaceName.startsWith('kala-clean-'), 'Only disposable kala-clean-* Workspaces are allowed')
const cwd = process.env.PRODUCT_E2E_TERMINAL_CWD ?? credentials.cwd ?? (windows ? 'C:\\KalaTest\\workspace' : '/home/ubuntu/kala-test-workspace')
const evidenceRoot = resolve(process.env.PRODUCT_E2E_EVIDENCE_ROOT ?? `.artifacts/terminal-product${windows ? '-windows' : ''}`)
const browserRoot = resolve(`.artifacts/tp-${process.pid}`)
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
await mkdir(browserRoot, { recursive: true, mode: 0o700 })
const sessionId = `terminal-${randomUUID()}`
const artifact = `terminal-acceptance-${randomUUID()}`
const windowsFixtures = windows ? windowsTerminalFixtures({
  artifact,
  nodeExecutable: process.env.PRODUCT_E2E_TERMINAL_NODE ?? credentials.nodeExecutable ?? WINDOWS_TERMINAL_NODE,
}) : null
const report = { target: workspaceName, platform, sessionId, cwd, artifact, steps: [], browserErrors: [],
  ...(process.env.PRODUCT_E2E_TERMINAL_COLD_SCOPE ? { coldStartScope: process.env.PRODUCT_E2E_TERMINAL_COLD_SCOPE } : {}),
}
const frames = { sent: [], received: [] }
let browser
let control
let identity
let page
let failure
const sanitize = (text) => String(text).replaceAll(credentials.token, '[redacted]').replace(/([?&]token=)[^&\s]+/gu, '$1[redacted]')
const ack = (event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 30_000)
  control.emit(event, payload, (result) => { clearTimeout(timer); resolve(result) })
})
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${description}`)
}
const step = async (name, action) => {
  const started = Date.now()
  const evidence = await action()
  report.steps.push({ name, ok: true, durationMs: Date.now() - started, ...evidence })
}
const parseFrame = (payload, direction) => {
  const begin = payload.indexOf('[')
  if (begin < 0) return
  try {
    const [event, body] = JSON.parse(payload.slice(begin))
    if (typeof event === 'string' && (event.startsWith('terminal:') || event.startsWith('server:terminal_'))) {
      frames[direction].push({ event, body, at: Date.now() })
    } else if (direction === 'received' && event && typeof event === 'object' && 'terminalId' in event && !('killed' in event)) {
      frames.received.push({ event: 'terminal:create_ack', body: event, at: Date.now() })
    }
  } catch {}
}
const terminalOutput = () => frames.received.filter(({ event, body }) => event === 'server:terminal_output' && body.sessionId === identity?.sessionId).map(({ body }) => body.data).join('')
const inputsSince = (index) => frames.sent.slice(index).filter(({ event }) => event === 'terminal:input').map(({ body }) => body.data)
const file = async (name) => {
  const response = await ack('workspace:read_binary', { requestId: randomUUID(), workspaceId: report.workspaceId, cwd, path: `${artifact}/${name}`, maxBytes: 16384 })
  assert.equal(response.error, undefined, response.error?.message)
  return Buffer.from(response.base64, 'base64')
}
const command = async (text, marker, virtual = false) => {
  const start = frames.sent.length
  await page.keyboard.type(text)
  if (virtual) {
    await page.$eval('[data-testid="workspace-terminal-dialog"] .xterm-helper-textarea', (input) => {
      input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true }))
    })
  } else {
    await page.keyboard.press('Enter')
  }
  await waitFor(() => terminalOutput().includes(marker), marker)
  assert.equal(inputsSince(start).filter((data) => data === '\r').length, 1)
}

try {
  await step('create independent real Kernel session on the isolated Executor', async () => {
    control = io(`${credentials.origin}/dashboard`, {
      autoConnect: false, transports: ['websocket'], reconnection: false,
      auth: { token: credentials.token, role: 'dashboard', sessionId, clientVersion: PROTOCOL_VERSION },
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session:ready timed out')), 30_000)
      control.once('session:ready', () => { clearTimeout(timer); resolve() })
      control.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
      control.connect()
    })
    const directory = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Executor directory timed out')), 30_000)
      control.once('server:executors', (result) => { clearTimeout(timer); resolve(result) })
      control.emit('client:list_executors', {})
    })
    const workspace = directory.executors.find((item) => item.workspaceName === workspaceName)
    assert.ok(workspace, 'The isolated Executor must be online')
    report.workspaceId = workspace.workspaceId
    report.executorInstallId = workspace.installId
    if (process.env.PRODUCT_E2E_TERMINAL_INSTALL_ID) assert.equal(workspace.installId, process.env.PRODUCT_E2E_TERMINAL_INSTALL_ID)
    if (process.env.PRODUCT_E2E_TERMINAL_WORKSPACE_ID) assert.equal(workspace.workspaceId, process.env.PRODUCT_E2E_TERMINAL_WORKSPACE_ID)
    const created = await ack('client:create_session', { operationId: randomUUID(), sessionId, workspaceId: workspace.workspaceId, cwd, agentRuntime: 'kernel' })
    assert.equal(created.ok, true, created.error)
    control.emit('client:rename_session', { operationId: randomUUID(), sessionId, label: `Terminal acceptance ${sessionId}` })
    return { workspaceId: workspace.workspaceId, agentRuntime: 'kernel' }
  })
  await step('open the actual Dashboard workspace terminal modal', async () => {
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH, headless: true, userDataDir: resolve(browserRoot, 'profile'),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      env: { ...process.env, TMPDIR: browserRoot, TMP: browserRoot, TEMP: browserRoot },
    })
    page = await browser.newPage()
    if (delayedCreateProof) {
      await page.evaluateOnNewDocument(() => {
        // Delay only create-result delivery in this test browser. The real
        // Host/Executor operation and network ACK still run without a proxy.
        const NativeWebSocket = window.WebSocket
        const redispatched = new WeakSet()
        window.terminalAcceptanceAckDelay = 0
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) {
            super(...args)
            this.addEventListener('message', (event) => {
              if (redispatched.has(event) || !window.terminalAcceptanceAckDelay || typeof event.data !== 'string') return
              const begin = event.data.indexOf('[')
              if (begin < 0) return
              let result
              try { [result] = JSON.parse(event.data.slice(begin)) } catch { return }
              if (!result || typeof result !== 'object' || typeof result.terminalId !== 'string' || !result.requestId || 'killed' in result) return
              event.stopImmediatePropagation()
              const delayed = new MessageEvent('message', { data: event.data, origin: event.origin })
              redispatched.add(delayed)
              setTimeout(() => this.dispatchEvent(delayed), window.terminalAcceptanceAckDelay)
            })
          }
        }
      })
    }
    await page.setViewport({ width: 1600, height: 1000 })
    page.setDefaultTimeout(TERMINAL_CREATE_CLIENT_TIMEOUT_MS + 15_000)
    page.on('pageerror', (error) => report.browserErrors.push(sanitize(error.message)))
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      const local = new URL(request.url()).origin === new URL(credentials.origin).origin
      void request.continue(local ? { headers: { ...request.headers(), authorization: `Bearer ${credentials.token}` } } : {})
    })
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    cdp.on('Network.webSocketFrameSent', ({ response }) => parseFrame(response.payloadData, 'sent'))
    cdp.on('Network.webSocketFrameReceived', ({ response }) => parseFrame(response.payloadData, 'received'))
    const url = new URL(credentials.origin)
    url.searchParams.set('token', credentials.token)
    url.searchParams.set('sessionId', sessionId)
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    const row = `[data-testid="workspace-row"][data-workspace-id="${report.workspaceId}"]`
    await page.waitForSelector(row)
    await page.hover(row)
    await page.click(`[data-testid="workspace-terminal-${report.workspaceId}"]`)
    await page.waitForSelector('[data-testid="workspace-terminal-dialog"] [data-terminal-status="running"]')
    const create = frames.sent.find(({ event }) => event === 'terminal:create')
    assert.ok(create, 'The real Dashboard must emit terminal:create')
    assert.equal(create.body.sessionId, `workspace-terminal:${sessionId}:primary`, 'Do not share another acceptance session’s terminal')
    identity = { workspaceId: create.body.workspaceId, sessionId: create.body.sessionId }
    assert.equal(create.body.cwd, cwd)
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
    const acknowledgement = frames.received.find(({ event, body }) => event === 'terminal:create_ack' && body.requestId === create.body.requestId)
    return { terminalSessionId: identity.sessionId, focused: true, browser: await browser.version(),
      ...(acknowledgement ? { createAcknowledgementMs: acknowledgement.at - create.at, reused: acknowledgement.body.reused === true } : {}),
    }
  })
  if (windows) {
    await step('prepare dependency-free Windows proof worker with the pinned official Node runtime', async () => {
      const prepared = await ack('workspace:exec', { requestId: randomUUID(), workspaceId: report.workspaceId, cwd, argv: windowsFixtures.prepareArgv, timeoutMs: 15_000, maxOutputBytes: 16384 })
      assert.equal(prepared.error, undefined, prepared.error?.message)
      assert.equal(prepared.exitCode, 0, prepared.stderr)
      // PowerShell and PSReadLine can become ready after the ConPTY create ACK.
      // These harmless readiness probes are separate from measured Enter tests.
      let nextProbe = 0
      await waitFor(async () => {
        if (terminalOutput().includes('SHELL_READY')) return true
        if (Date.now() >= nextProbe) {
          await page.keyboard.type(windowsFixtures.ready)
          await page.keyboard.press('Enter')
          nextProbe = Date.now() + 3000
        }
        return false
      }, 'Windows PowerShell readiness')
      return { nodeExecutable: windowsFixtures.prepareArgv[0], worker: `${artifact}/probe.cjs` }
    })
  }
  await step('physical Enter executes on a real target PTY and writes a target file', async () => {
    await command(windows ? windowsFixtures.tty : `mkdir '${artifact}'; python3 -c 'import os,json,pathlib; pathlib.Path("${artifact}/pty.json").write_text(json.dumps({"stdin":os.isatty(0),"stdout":os.isatty(1),"cwd":os.getcwd()})); print("PTY_"+"READY",flush=True)'`, 'PTY_READY')
    const pty = JSON.parse((await file('pty.json')).toString())
    let powershell
    if (windows) {
      assert.equal(pty.stdin, true, 'Redirected pipes are not ConPTY acceptance')
      assert.equal(pty.stdout, true, 'Redirected pipes are not ConPTY acceptance')
      assert.equal(pty.platform, 'win32', 'Windows acceptance requires a genuine Windows worker')
      assert.equal(pty.node, 'v22.22.1')
      assert.equal(pty.cwd.replaceAll('/', '\\').toLowerCase(), cwd.replaceAll('/', '\\').toLowerCase())
      powershell = (await file('powershell.txt')).toString().trim()
      assert.match(powershell, /^5\.1\./u, 'This target specifically requires Windows PowerShell 5.1')
    } else {
      assert.deepEqual(pty, { stdin: true, stdout: true, cwd })
    }
    return { pty, ...(powershell ? { powershell } : {}), physicalEnterCRs: 1 }
  })
  await step('real keyboard multiline shell input preserves both lines', async () => {
    const start = frames.sent.length
    await page.keyboard.type(windows ? windowsFixtures.multilineFirst : "printf '%s\\n' 'line-one")
    await page.keyboard.press('Enter')
    await page.keyboard.type(windows ? windowsFixtures.multilineLast : `line-two' > '${artifact}/multiline.txt'; printf 'MULTI_%s\\n' DONE`)
    await page.keyboard.press('Enter')
    await waitFor(() => terminalOutput().includes('MULTI_DONE'), 'multiline execution')
    assert.equal(inputsSince(start).filter((data) => data === '\r').length, 2)
    assert.equal((await file('multiline.txt')).toString(), 'line-one\nline-two\n')
    return { exactFileText: 'line-one\\nline-two\\n', physicalEnterCRs: 2 }
  })
  await step('virtual newline uses the full product path, not an IME candidate submit', async () => {
    await command(windows ? windowsFixtures.virtual : `printf '%s\\n' virtual-newline > '${artifact}/virtual.txt'; printf 'VIRTUAL_%s\\n' DONE`, 'VIRTUAL_DONE', true)
    assert.equal((await file('virtual.txt')).toString(), 'virtual-newline\n')
    const start = frames.sent.length
    const cdp = await page.createCDPSession()
    await page.keyboard.type(windows ? windowsFixtures.imeFirst : "printf '%s\\n' '")
    await cdp.send('Input.imeSetComposition', { text: '终端', selectionStart: 2, selectionEnd: 2 })
    await page.$eval('[data-testid="workspace-terminal-dialog"] .xterm-helper-textarea', (input) => {
      input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', isComposing: true, bubbles: true, cancelable: true }))
    })
    assert.equal(inputsSince(start).filter((data) => data === '\r').length, 0)
    await cdp.send('Input.insertText', { text: '终端✓' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await page.keyboard.type(windows ? windowsFixtures.imeLast : `' > '${artifact}/ime.txt'; printf 'IME_%s\\n' DONE`)
    await page.keyboard.press('Enter')
    await waitFor(() => terminalOutput().includes('IME_DONE'), 'composed text execution')
    assert.equal((await file('ime.txt')).toString(), '终端✓\n')
    return { virtualNewlineCRs: 1, composedText: '终端✓', imeMethod: 'Chrome CDP composition; synthetic composing-beforeinput guard (not native OS IME)' }
  })
  await step('real keyboard Escape reaches the Executor as byte 27 without closing the modal', async () => {
    await command(windows ? windowsFixtures.raw : `python3 -c 'import os,tty,termios,pathlib; old=termios.tcgetattr(0); tty.setraw(0); print("RAW_"+"READY",flush=True); b=os.read(0,1); termios.tcsetattr(0,termios.TCSADRAIN,old); pathlib.Path("${artifact}/escape.bin").write_bytes(b); print("RAW_"+str(b[0]),flush=True)'`, 'RAW_READY')
    const start = frames.sent.length
    await page.keyboard.press('Escape')
    await waitFor(() => terminalOutput().includes('RAW_27'), 'raw Escape output')
    assert.deepEqual(inputsSince(start), ['\u001b'])
    assert.equal((await file('escape.bin')).toString('hex'), '1b')
    assert.ok(await page.$('[data-testid="workspace-terminal-dialog"]'))
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), true)
    await page.screenshot({ path: resolve(evidenceRoot, 'terminal-escape-keeps-modal.png') })
    return { byte: 27, remoteFileHex: '1b', modalStillOpen: true, terminalStillFocused: true }
  })
  await step('exit only this PTY and close the actual modal', async () => {
    await page.keyboard.type('exit')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="workspace-terminal-dialog"] [data-terminal-status="exited"]')
    await page.click('[data-testid="workspace-terminal-close"]')
    await page.waitForSelector('[data-testid="workspace-terminal-dialog"]', { hidden: true })
    assert.deepEqual(report.browserErrors, [])
    return { exited: true, closed: true }
  })
  if (delayedCreateProof) {
    const delayMs = 6500
    const reopen = async () => {
      await page.waitForSelector('[data-testid="dialog-overlay"]', { hidden: true })
      await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== 'none')
      const row = `[data-testid="workspace-row"][data-workspace-id="${report.workspaceId}"]`
      await page.hover(row)
      await page.click(`[data-testid="workspace-terminal-${report.workspaceId}"]`)
      await page.waitForSelector('[data-testid="workspace-terminal-dialog"] [data-terminal-status="starting"]')
    }
    await step('controlled create-ACK delay beyond five seconds still adopts the real ConPTY', async () => {
      await page.evaluate((delay) => { window.terminalAcceptanceAckDelay = delay }, delayMs)
      const start = frames.sent.length
      await reopen()
      await waitFor(() => frames.sent.slice(start).some(({ event }) => event === 'terminal:create'), 'delayed create request')
      const create = frames.sent.slice(start).find(({ event }) => event === 'terminal:create')
      await waitFor(() => frames.received.some(({ event, body }) => event === 'terminal:create_ack' && body.requestId === create.body.requestId), 'actual network create ACK')
      const acknowledged = frames.received.find(({ event, body }) => event === 'terminal:create_ack' && body.requestId === create.body.requestId)
      assert.notEqual(acknowledged.body.reused, true)
      await new Promise((resolve) => setTimeout(resolve, 5250))
      assert.equal(await page.$eval('[data-testid="workspace-terminal-dialog"] [data-testid="session-terminal-panel"]', (panel) => panel.dataset.terminalStatus), 'starting')
      await page.waitForSelector('[data-testid="workspace-terminal-dialog"] [data-terminal-status="running"]')
      await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
      const proof = windows
        ? windowsFixtures.virtual.replace('VIRTUAL', 'DELAYED').replace('virtual-newline', 'delayed-ack')
        : `printf '%s\\n' delayed-ack > '${artifact}/virtual.txt'; printf 'DELAYED_%s\\n' DONE`
      await command(proof, 'DELAYED_DONE')
      assert.equal((await file('virtual.txt')).toString(), 'delayed-ack\n')
      await page.keyboard.type('exit')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid="workspace-terminal-dialog"] [data-terminal-status="exited"]')
      await page.click('[data-testid="workspace-terminal-close"]')
      await page.waitForSelector('[data-testid="workspace-terminal-dialog"]', { hidden: true })
      return { controlledBrowserAckDelayMs: delayMs, nativeColdStartClaimed: false, terminalId: acknowledged.body.terminalId, targetFileText: 'delayed-ack\\n' }
    })
    await step('cancelled pending UI disposes the late fresh ConPTY without an orphan', async () => {
      const start = frames.sent.length
      await reopen()
      await waitFor(() => frames.sent.slice(start).some(({ event }) => event === 'terminal:create'), 'cancelled create request')
      const create = frames.sent.slice(start).find(({ event }) => event === 'terminal:create')
      await waitFor(() => frames.received.some(({ event, body }) => event === 'terminal:create_ack' && body.requestId === create.body.requestId), 'network ACK before UI delivery')
      const acknowledged = frames.received.find(({ event, body }) => event === 'terminal:create_ack' && body.requestId === create.body.requestId)
      assert.notEqual(acknowledged.body.reused, true)
      assert.equal(await page.$eval('[data-testid="workspace-terminal-dialog"] [data-testid="session-terminal-panel"]', (panel) => panel.dataset.terminalStatus), 'starting')
      await page.click('[data-testid="workspace-terminal-close"]')
      await page.waitForSelector('[data-testid="workspace-terminal-dialog"]', { hidden: true })
      await waitFor(() => frames.sent.slice(start).some(({ event, body }) => event === 'terminal:kill' && body.terminalId === acknowledged.body.terminalId), 'late fresh PTY cleanup request')
      await waitFor(() => frames.received.some(({ event, body }) => event === 'server:terminal_exit' && body.terminalId === acknowledged.body.terminalId), 'actual late PTY process exit')
      const retired = await ack('terminal:kill', { requestId: randomUUID(), ...identity, terminalId: acknowledged.body.terminalId })
      assert.equal(retired.killed, false)
      assert.equal(retired.error, 'terminal not found')
      return { controlledBrowserAckDelayMs: delayMs, cancelledWhileStarting: true, freshTerminalId: acknowledged.body.terminalId, cleanupObserved: true, processExitObserved: true, subsequentKill: 'terminal not found' }
    })
  }
  report.ok = true
} catch (error) {
  failure = error
  report.ok = false
  report.error = sanitize(error.stack ?? error.message)
  if (page) await page.screenshot({ path: resolve(evidenceRoot, 'terminal-failure.png') }).catch(() => {})
} finally {
  if (failure && page && identity) {
    await page.keyboard.down('Control').catch(() => {})
    await page.keyboard.press('c').catch(() => {})
    await page.keyboard.up('Control').catch(() => {})
    await page.keyboard.type('exit').catch(() => {})
    await page.keyboard.press('Enter').catch(() => {})
    if (control?.connected) {
      const created = frames.received.filter(({ event, body }) => event === 'terminal:create_ack' && body.sessionId === identity.sessionId)
      for (const { body } of created) {
        await ack('terminal:kill', { requestId: randomUUID(), ...identity, terminalId: body.terminalId }).catch(() => {})
      }
    }
  }
  await browser?.close()
  control?.disconnect()
  await rm(browserRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  const path = resolve(evidenceRoot, 'report.json')
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: report.ok, steps: report.steps, error: report.error, reportPath: path }))
  if (failure) process.exitCode = 1
}
