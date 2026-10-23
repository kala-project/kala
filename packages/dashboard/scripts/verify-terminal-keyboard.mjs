import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

// Local-only acceptance, using existing dependencies and an approved Chrome:
// KALA_TERMINAL_DISABLE_PTY=1 CHROME_PATH=/path/to/chrome node packages/dashboard/scripts/verify-terminal-keyboard.mjs
// Linux additionally requires the existing script, python3 and tmux programs.
// Evidence persists under .artifacts/terminal-keyboard/evidence (override with
// TERMINAL_EVIDENCE_DIR); all disposable state and tmux sockets are repo-local.
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
const evidenceRoot = resolve(process.env.TERMINAL_EVIDENCE_DIR ?? resolve(dashboardRoot, '../../.artifacts/terminal-keyboard/evidence'))
await mkdir(stateRoot, { recursive: true })
await mkdir(evidenceRoot, { recursive: true })
// Every writable browser/shell artifact stays under the repository, never the
// OS temporary directory. A real PTY is required, not a pipe-shell mock.
process.env.TMPDIR = stateRoot
process.env.TEMP = stateRoot
process.env.TMP = stateRoot
process.env.HOME = stateRoot
process.env.USERPROFILE = stateRoot
process.env.SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
const fallback = process.env.KALA_TERMINAL_DISABLE_PTY === '1'
const appSource = await readFile(resolve(dashboardRoot, 'src/app.tsx'), 'utf8')
const sizeFunction = appSource.match(/export function workspaceTerminalDialogSizeClass[\s\S]*?\n}/)?.[0]
assert.ok(sizeFunction, 'production workspace terminal sizing helper exists')
const dialogClasses = [...sizeFunction.matchAll(/'([^']+)'/g)].map((match) => match[1])
assert.equal(dialogClasses.length, 3, 'fixture uses production base, expanded and normal classes')

const server = await createServer({
  root: dashboardRoot,
  configFile: false,
  cacheDir: resolve(stateRoot, 'vite-cache'),
  define: { __TERMINAL_DIALOG_CLASSES__: JSON.stringify(dialogClasses) },
  resolve: { alias: { '@agent-kernel/shared': resolve(dashboardRoot, '../shared/src/browser.ts') } },
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
const evidence = { platform: process.platform, fallback, checks: [], layouts: [], raw: [] }
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

  const toolbarKey = async (label) => {
    const buttons = await page.$$('[data-testid="terminal-touch-keys"] button')
    const button = (await Promise.all(buttons.map(async (element) => ({
      element, label: await element.evaluate((node) => node.textContent),
    })))).find((entry) => entry.label === label)?.element
    assert.ok(button, `toolbar key ${label}`)
    await button.click()
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
      `${label} preserves xterm focus`)
  }
  const controlKey = async (key) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(key)
    await page.keyboard.up('Control')
  }
  if (!windows) {
    // Read inside a genuinely raw PTY: a shell in canonical mode accepts both
    // CR and LF and therefore cannot detect the original script-bridge bug.
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
    const tmuxSocket = resolve(stateRoot, 'tmux.sock')
    const rawCase = async (application, tmux = false) => {
      const cursor = application ? '\u001bO' : '\u001b['
      const physical = '\r\n\u0004\u0003\u001a\u000b\u0015\t\u001b'
        + ['A', 'B', 'D', 'C'].map((key) => cursor + key).join('')
      const toolbar = '\u001b\t\r\u0003\u0004\u001a\u0002'
        + ['A', 'B', 'D', 'C'].map((key) => cursor + key).join('')
      const expected = physical + toolbar
      const token = `${tmux ? 'TMUX' : 'RAW'}_${application ? 'APP' : 'NORMAL'}`
      const source = [
        'import os,tty,termios',
        'old=termios.tcgetattr(0)',
        'tty.setraw(0)',
        `os.write(1,b"\\x1b[?1${application ? 'h' : 'l'}"+b"${token}_"+b"READY\\r\\n")`,
        'data=b""',
        `exec("while len(data)<${expected.length}:\\n data+=os.read(0,${expected.length}-len(data))")`,
        'termios.tcsetattr(0,termios.TCSADRAIN,old)',
        `os.write(1,b"\\x1b[?1l${token}_"+data.hex().encode()+b"\\r\\n")`,
      ].join('; ')
      const reader = `python3 -c ${quote(source)}`
      const command = tmux
        ? `tmux -S ${quote(tmuxSocket)} -f /dev/null new-session -s keyboard ${quote(`exec ${reader}`)}`
        : reader
      await runCommand(command, `${token}_READY`)
      if (tmux) {
        const panes = execFileSync('tmux', ['-S', tmuxSocket, 'list-panes', '-F', '#{pane_current_command}:#{pane_pid}'], { encoding: 'utf8' }).trim()
        assert.match(panes, /python3:\d+/, 'reader runs in a real isolated tmux pane')
        evidence.checks.push({ tmuxPane: panes })
      }
      await sleep(150)
      const start = received.length
      await page.keyboard.press('Enter')
      for (const key of ['j', 'd', 'c', 'z', 'k', 'u']) await controlKey(key)
      await page.keyboard.press('Tab')
      await page.keyboard.press('Escape')
      await sleep(600) // Let tmux disambiguate a standalone Escape.
      for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) await page.keyboard.press(key)
      await toolbarKey('Esc')
      await sleep(600)
      for (const key of ['Tab', 'Enter', 'Ctrl+C', 'Ctrl+D', 'Ctrl+Z']) await toolbarKey(key)
      if (tmux) await controlKey('b') // tmux C-b C-b sends one literal prefix.
      await toolbarKey('Ctrl+B')
      for (const key of ['↑', '↓', '←', '→']) await toolbarKey(key)
      await waitFor(() => output.join('').includes(`${token}_${Buffer.from(expected).toString('hex')}`), `${token} exact raw control bytes`)
      const socketBytes = received.slice(start).map(({ data }) => data).join('')
      assert.equal(socketBytes, physical + (tmux ? '\u001b\t\r\u0003\u0004\u001a\u0002\u0002' : '\u001b\t\r\u0003\u0004\u001a\u0002')
        + ['A', 'B', 'D', 'C'].map((key) => cursor + key).join(''), 'physical and toolbar encoding agree with DECCKM')
      const observedHex = output.join('').match(new RegExp(`${token}_([0-9a-f]+)`))?.[1]
      assert.equal(observedHex, Buffer.from(expected).toString('hex'))
      evidence.raw.push({ token, expectedHex: Buffer.from(expected).toString('hex'), observedHex, socketHex: Buffer.from(socketBytes).toString('hex') })
      assert.ok(await page.$('[data-testid="terminal-dialog"]'), 'raw Escape does not dismiss terminal')
      await sleep(250)
    }
    await rawCase(false)
    await rawCase(true)
    await rawCase(true, true)
  }

  for (const layout of [
    { name: 'desktop', width: 1280, height: 900, expanded: false },
    { name: 'desktop-expanded', width: 1280, height: 900, expanded: true },
    { name: 'mobile', width: 390, height: 844, expanded: false },
    { name: 'mobile-narrow', width: 320, height: 640, expanded: false },
    { name: 'mobile-keyboard', width: 390, height: 844, visualHeight: 300, offsetTop: 80, expanded: false },
    { name: 'desktop-short-visual', width: 1280, height: 900, visualHeight: 280, offsetTop: 110, expanded: true },
  ]) {
    await page.setViewport({ width: layout.width, height: layout.height })
    await page.evaluate(({ visualHeight, offsetTop }) => {
      const viewport = window.visualViewport
      if (visualHeight) {
        Object.defineProperty(viewport, 'height', { configurable: true, value: visualHeight })
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: offsetTop })
      } else {
        delete viewport.height
        delete viewport.offsetTop
      }
      viewport.dispatchEvent(new Event('resize'))
    }, layout)
    if (layout.width >= 640) {
      const expanded = await page.$eval('[data-testid="terminal-dialog"]', (node) => node.dataset.expanded === 'true')
      if (expanded !== layout.expanded) await page.click('[data-testid="terminal-expand"]')
    }
    await sleep(200)
    const bounds = await page.evaluate(() => {
      const rect = (selector) => {
        const { x, y, width, height, bottom, right } = document.querySelector(selector).getBoundingClientRect()
        return { x, y, width, height, bottom, right }
      }
      return {
        dialog: rect('[data-testid="terminal-dialog"]'),
        footer: rect('[data-testid="terminal-touch-keys"]'),
        terminal: rect('[data-testid="terminal-viewport"]'),
        buttons: [...document.querySelectorAll('[data-testid="terminal-touch-keys"] button')].map((node) => {
          const { x, y, right, bottom, width, height } = node.getBoundingClientRect()
          return { label: node.textContent, x, y, right, bottom, width, height }
        }),
      }
    })
    const top = layout.offsetTop ?? 0
    const bottom = top + (layout.visualHeight ?? layout.height)
    for (const [label, rect] of [['dialog', bounds.dialog], ['footer', bounds.footer], ...bounds.buttons.map((button) => [button.label, button])]) {
      assert.ok(rect.y >= top - 1 && rect.bottom <= bottom + 1, `${layout.name} ${label} inside visual viewport: ${JSON.stringify(rect)}`)
      assert.ok(rect.x >= -1 && rect.right <= layout.width + 1 && rect.width > 0 && rect.height > 0, `${layout.name} ${label} horizontally visible`)
    }
    assert.ok(bounds.terminal.height > 40, `${layout.name} leaves usable terminal space`)
    evidence.layouts.push({ ...layout, ...bounds })
    await page.screenshot({ path: resolve(evidenceRoot, `${layout.name}.png`) })
  }
  await page.setViewport({ width: 1280, height: 900 })
  await page.evaluate(() => {
    delete window.visualViewport.height
    delete window.visualViewport.offsetTop
    window.visualViewport.dispatchEvent(new Event('resize'))
  })
  await page.focus('.xterm-helper-textarea')

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
  evidence.checks.push('physical Enter', 'virtual Enter', 'Ctrl+K shortcut ownership', 'footer bounds', 'terminal Escape', 'ordinary-dialog Escape', 'shell exit')
  if (!windows) evidence.checks.push('raw control bytes', 'tmux Enter versus Ctrl+J and application-mode arrows', 'toolbar focus')
  await writeFile(resolve(evidenceRoot, 'report.json'), JSON.stringify(evidence, null, 2))
  await rm(resolve(evidenceRoot, 'failure.json'), { force: true })
  console.log(`PASS ${process.platform} (${fallback ? 'fallback' : 'preferred PTY'}): real xterm → Socket.IO → Executor TerminalManager; ${windows ? 'Enter, Escape' : 'raw controls, tmux, cursor modes'}, footer bounds, Escape ownership`)
  console.log(`Evidence: ${evidenceRoot}`)
  console.log('Scope: isolated component/PTY acceptance; this does not replace provisioned full Host/Executor Linux and Windows product acceptance.')
} catch (error) {
  await writeFile(resolve(evidenceRoot, 'failure.json'), JSON.stringify({ ...evidence, error: String(error), outputTail: output.join('').slice(-5000), errors }, null, 2))
  throw error
} finally {
  if (process.platform !== 'win32') {
    try { execFileSync('tmux', ['-S', resolve(stateRoot, 'tmux.sock'), 'kill-server'], { stdio: 'ignore' }) } catch {}
  }
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
