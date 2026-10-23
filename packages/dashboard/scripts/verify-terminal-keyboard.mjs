import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const dashboardRoot = fileURLToPath(new URL('..', import.meta.url))
const dashboardRequire = createRequire(new URL('../package.json', import.meta.url))
const executorRequire = createRequire(new URL('../../executor/package.json', import.meta.url))
const hostRequire = createRequire(new URL('../../host/package.json', import.meta.url))
const { createServer } = await import(dashboardRequire.resolve('vite'))
const { Server } = await import(hostRequire.resolve('socket.io'))
const { tsImport } = await import(executorRequire.resolve('tsx/esm/api'))
const { createTerminalManager } = await tsImport(new URL('../../executor/src/terminal-manager.ts', import.meta.url).href, import.meta.url)
const { createSandbox } = await tsImport(new URL('../../executor/src/sandbox.ts', import.meta.url).href, import.meta.url)
const stateRoot = resolve(dashboardRoot, `../../.artifacts/tk-${process.pid}`)
await mkdir(stateRoot, { recursive: true })
// Every writable browser/shell artifact stays under the repository, never the
// OS temporary directory. A real PTY is required, not a pipe-shell mock.
process.env.TMPDIR = stateRoot
process.env.TEMP = stateRoot
process.env.TMP = stateRoot
process.env.HOME = stateRoot
process.env.USERPROFILE = stateRoot
process.env.SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'

const server = await createServer({
  root: dashboardRoot,
  configFile: false,
  cacheDir: resolve(stateRoot, 'vite-cache'),
  plugins: [(await import(dashboardRequire.resolve('@vitejs/plugin-react'))).default()],
  optimizeDeps: { entries: ['scripts/fixtures/terminal-keyboard.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
})
let browser
let sockets
const received = []
const output = []
let terminalIdentity
let terminalExited = false
const manager = createTerminalManager({
  sandbox: createSandbox({ roots: [stateRoot] }),
  emitOutput(payload) { output.push(payload.data); sockets?.of('/dashboard').emit('server:terminal_output', payload) },
  emitExit(payload) {
    terminalExited = true
    sockets?.of('/dashboard').emit('server:terminal_exit', payload)
  },
})
const errors = []
try {
  sockets = new Server(server.httpServer)
  sockets.of('/dashboard').on('connection', (socket) => {
    socket.on('terminal:create', async (payload, ack) => {
      const result = await manager.create({ ...payload, cwd: stateRoot })
      if (result.terminalId) terminalIdentity = { workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: result.terminalId }
      ack(result)
    })
    socket.on('terminal:input', (payload) => { received.push(payload); manager.input(payload) })
    socket.on('terminal:resize', (payload) => manager.resize(payload))
    socket.on('terminal:kill', (payload, ack) => ack(manager.kill(payload)))
  })
  await server.listen()
  const address = server.httpServer.address()
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
    userDataDir: resolve(stateRoot, 'browser-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage', `--crash-dumps-dir=${resolve(stateRoot, 'crashes')}`],
    env: { ...process.env },
  })
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/terminal-keyboard.html`)
  await page.waitForSelector('[data-terminal-status="running"]')
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
  await page.evaluate(() => {
    window.terminalKeyboardCapture = []
    window.terminalKeyboardBubble = []
    document.addEventListener('keydown', (event) => window.terminalKeyboardCapture.push(event.key), true)
    window.addEventListener('keydown', (event) => window.terminalKeyboardBubble.push(event.key))
  })
  const runCommand = async (command, marker, virtual = false) => {
    const start = received.length
    await page.keyboard.type(command)
    if (virtual) {
      await page.$eval('.xterm-helper-textarea', (element) => element.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertLineBreak', bubbles: true, cancelable: true,
      })))
    } else {
      await page.keyboard.press('Enter')
    }
    await waitFor(() => output.join('').includes(marker), marker)
    assert.equal(received.slice(start).filter(({ data }) => data === '\r').length, 1, 'Enter sends exactly one CR on the real socket')
  }
  const windows = process.platform === 'win32'
  await runCommand(windows
    ? 'Write-Output ("PTY_" + [Console]::IsInputRedirected)'
    : 'test -t 0 && test -t 1 && printf "PTY_%s\\n" CONFIRMED',
  windows ? 'PTY_False' : 'PTY_CONFIRMED')
  const shortcutStart = received.length
  await page.keyboard.down('Control')
  await page.keyboard.press('k')
  await page.keyboard.up('Control')
  await waitFor(() => received.slice(shortcutStart).some(({ data }) => data === '\u000b'), 'xterm Ctrl+K shortcut')
  const shortcutEvents = await page.evaluate(() => ({
    captured: window.terminalKeyboardCapture.includes('k'),
    bubbled: window.terminalKeyboardBubble.includes('k'),
    focused: document.activeElement?.classList.contains('xterm-helper-textarea'),
  }))
  assert.deepEqual(shortcutEvents, { captured: true, bubbled: false, focused: true })
  await page.keyboard.down('Control')
  await page.keyboard.press('u')
  await page.keyboard.up('Control')
  await runCommand(windows
    ? 'Write-Output ("PHYSICAL_" + (6 * 7))'
    : 'printf "PHYSICAL_%s\\n" "$((6 * 7))"', 'PHYSICAL_42')
  await runCommand(windows
    ? 'Write-Output ("VIRTUAL_" + (6 * 7))'
    : 'printf "VIRTUAL_%s\\n" "$((6 * 7))"', 'VIRTUAL_42', true)

  await runCommand(windows
    ? 'Write-Output ("READER_" + "READY"); $k = [Console]::ReadKey($true); Write-Output ("ESC_" + [int]$k.KeyChar)'
    : 'python3 -c \'import os,sys,tty,termios; old=termios.tcgetattr(0); tty.setraw(0); print("READER_"+"READY",flush=True); b=os.read(0,1); termios.tcsetattr(0,termios.TCSADRAIN,old); print("ESC_"+str(b[0]),flush=True)\'',
  'READER_READY')
  const escapeStart = received.length
  await page.keyboard.press('Escape')
  await waitFor(() => output.join('').includes('ESC_27'), 'real PTY Escape byte')
  assert.deepEqual(received.slice(escapeStart).map(({ data }) => data), ['\u001b'])
  assert.ok(await page.$('[data-testid="terminal-dialog"]'), 'focused Escape must not dismiss terminal')
  assert.ok(await page.evaluate(() => window.terminalKeyboardCapture.includes('Escape')), 'Escape reaches capture observers')
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await waitFor(() => terminalExited, 'isolated shell exit')
  await page.click('[data-testid="terminal-close"]')
  await page.waitForSelector('[data-testid="terminal-dialog"]', { hidden: true })
  await page.waitForSelector('[data-testid="dialog-overlay"]', { hidden: true })
  await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== 'none')
  await page.click('[data-testid="ordinary-open"]')
  await page.waitForSelector('[data-testid="ordinary-dialog"]')
  await page.focus('[aria-label="Ordinary input"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="ordinary-dialog"]', { hidden: true })
  assert.deepEqual(errors, [])
  console.log(`PASS ${process.platform}: real xterm → Socket.IO → Executor TerminalManager → real PTY physical Enter, virtual newline, raw Escape, focus, close button and ordinary-dialog Escape`)
  console.log('Scope: isolated component/PTY acceptance; this does not replace provisioned full Host/Executor Linux and Windows product acceptance.')
} finally {
  if (terminalIdentity && !terminalExited) {
    manager.input({ ...terminalIdentity, data: '\u0003' })
    await sleep(100)
    manager.input({ ...terminalIdentity, data: 'exit\r' })
    const deadline = Date.now() + 3000
    while (!terminalExited && Date.now() < deadline) await sleep(50)
  }
  manager.closeAll()
  await browser?.close()
  sockets?.close()
  await server.close()
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${description}; output tail=${output.join('').slice(-1000)}`)
}
