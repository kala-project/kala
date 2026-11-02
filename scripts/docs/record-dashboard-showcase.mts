#!/usr/bin/env node
/**
 * Records the real Dashboard against a disposable Host + Executor.
 *
 * The production/user Host on 127.0.0.1:13000 is neither contacted nor recorded.
 * The checked-in GIF is replaced only after every DOM and media assertion passes.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { createConfig, step, type AgentEvent, type Message } from '../../packages/kernel/src/index.js'
import { SessionStore } from '../../packages/host/src/store/session.js'
import { applyTodoGraphOperations } from '../../packages/host/src/extensions/todo-graph.js'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const PORT = Number(process.env.KALA_SHOWCASE_PORT ?? 43187)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535 || PORT === 13000) throw new Error(`Unsafe showcase port: ${PORT}`)
const HOST_URL = `http://127.0.0.1:${PORT}`
if (HOST_URL === 'http://127.0.0.1:13000') throw new Error('Refusing to use the production/user Host')

const WORKSPACES = [
  { name: 'macbook', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', token: 'showcase-macbook-token' },
  { name: 'ubuntu', id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', token: 'showcase-ubuntu-token' },
  { name: 'gpu-box', id: '01ARZ3NDEKTSV4RRFFQ69G5FAX', token: 'showcase-gpu-box-token' },
  { name: 'cloud-01', id: '01ARZ3NDEKTSV4RRFFQ69G5FAY', token: 'showcase-cloud-01-token' },
] as const
const PRIMARY_WORKSPACE = WORKSPACES[0]
const WORKSPACE_ID = PRIMARY_WORKSPACE.id
const SESSION_ID = '01KALASHOWCASE000000000001'
const RELEASE_REVIEW_PROMPT = 'Review the V3 dashboard release candidate.\n\nVerify the attached design, task graph, tool activity,\ncontext usage, composer modes, source changes, tests,\nand runtime trace.\n\nReturn an evidence-backed GO / NO-GO recommendation.'
const scratch = mkdtempSync(join(tmpdir(), 'kala-showcase-'))
const sessionsDir = join(scratch, 'sessions')
const workspaceRoots = new Map(WORKSPACES.map((item) => [item.id, join(scratch, 'workspaces', item.name)]))
const captureFrames = join(scratch, 'frames')
const candidateMp4 = join(scratch, 'kala-dashboard-preview.mp4')
const palette = join(scratch, 'palette.png')
const candidateGif = join(scratch, 'kala-dashboard-preview.gif')
const finalMp4 = join(ROOT, 'docs/assets/kala-dashboard-preview.mp4')
const finalGif = join(ROOT, 'docs/assets/kala-dashboard-preview.gif')
const attachmentPath = join(ROOT, 'docs/assets/kala-dashboard-preview.png')
const chromium = process.env.CHROMIUM_PATH ?? '/snap/bin/chromium'
const browserUrl = process.env.KALA_SHOWCASE_BROWSER_URL?.trim()
const tsxPackageDir = readdirSync(join(ROOT, 'node_modules/.pnpm')).find((entry) => entry.startsWith('tsx@'))
if (!tsxPackageDir) throw new Error('tsx is not installed; run pnpm install first')
const tsxCli = join(ROOT, 'node_modules/.pnpm', tsxPackageDir, 'node_modules/tsx/dist/cli.mjs')

mkdirSync(sessionsDir, { recursive: true })
mkdirSync(captureFrames, { recursive: true })
for (const item of WORKSPACES) {
  const root = workspaceRoots.get(item.id)!
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, '.kala-workspace-id'), `${item.id}\n`)
  writeFileSync(join(root, 'SHOWCASE.md'), `# ${item.name} release workspace\n\nV3 fixture: isolated, reproducible, and browser-recorded.\n`)
  writeFileSync(join(root, 'release-status.json'), `${JSON.stringify({ machine: item.name, release: 'V3', checks: 'passing' }, null, 2)}\n`)
  mkdirSync(join(root, 'bin'))
  const fixturePnpm = join(root, 'bin', 'pnpm')
  writeFileSync(fixturePnpm, '#!/bin/sh\n[ "$*" = "test dashboard" ] || exit 2\nsleep 0.25\necho "204 focused tests passed"\nsleep 0.3\necho "Dashboard build completed successfully"\n')
  chmodSync(fixturePnpm, 0o755)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'showcase@localhost'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Kala Showcase'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'Seed isolated V3 showcase'], { cwd: root })
  writeFileSync(join(root, 'release-status.json'), `${JSON.stringify({ machine: item.name, release: 'V3', checks: 'passing', approval: 'ready for review' }, null, 2)}\n`)
}

type Assertion = { name: string; detail: string }
const assertions: Assertion[] = []
const hostLog: string[] = []
const executorLog: string[] = []
let host: ChildProcess | undefined
const executors: ChildProcess[] = []
let browser: Browser | undefined
let page: Page | undefined

async function main(): Promise<void> {
  await seedSessions()
  if (process.env.KALA_SHOWCASE_SKIP_BUILD !== '1') {
    const dashboardDir = join(ROOT, 'packages/dashboard')
    await run(process.execPath, ['scripts/build.mjs'], 660_000, false, dashboardDir)
  }
  host = start(process.execPath, [tsxCli, 'packages/host/bin/kala-host.ts'], {
    KALA_PORT: String(PORT), KALA_SESSIONS_DIR: sessionsDir, KALA_DASHBOARD_DIR: join(ROOT, 'packages/dashboard/dist'),
    KALA_PROVIDER: 'openai', OPENAI_API_KEY: 'showcase-offline-not-used', HOST_MODEL: 'gpt-4o-mini',
    KALA_EXECUTOR_TOKENS: JSON.stringify(WORKSPACES.map((item) => ({ token: item.token, workspaceId: item.id, label: item.name }))),
  }, hostLog)
  await waitForLog(hostLog, `host listening on http://127.0.0.1:${PORT}`, 30_000)

  for (const item of WORKSPACES) executors.push(startExecutor(item))
  await waitForExecutors(30_000)

  browser = browserUrl
    ? await puppeteer.connect({ browserURL: browserUrl })
    : await puppeteer.launch({
      executablePath: chromium,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080', '--hide-scrollbars'],
      defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    })
  page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('ak-theme', 'dark')
    localStorage.setItem('ak-tool-activity-icon-scale', '100')
    // CDP screencasts omit the OS cursor. Render only the actual browser mouse position.
    document.addEventListener('DOMContentLoaded', () => {
      const cursor = document.createElement('div')
      cursor.setAttribute('data-testid', 'showcase-recording-cursor')
      cursor.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:30px;pointer-events:none;z-index:2147483647;filter:drop-shadow(1px 2px 1px #0009);transform:translate(-40px,-40px)'
      cursor.innerHTML = '<svg width="24" height="30" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg"><path d="M2 1V23L7 18L12 28L16 26L11 17H22Z" fill="white" stroke="black" stroke-width="1.6" stroke-linejoin="round"/></svg>'
      document.body.append(cursor)
      document.addEventListener('mousemove', (event) => { cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)` })
    }, { once: true })
  })
  page.setDefaultTimeout(20_000)
  const browserErrors: string[] = []
  page.on('pageerror', (error) => { browserErrors.push(String(error)); console.error(`BROWSER PAGEERROR ${String(error).slice(0, 180)}`) })
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })

  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
  await page.waitForSelector('[data-testid="session-row"]')
  await assertDom('isolated host URL', (expected) => location.origin === expected && location.port !== '13000', HOST_URL, HOST_URL)
  await assertDom('dark mode throughout', () => document.documentElement.classList.contains('dark') && localStorage.getItem('ak-theme') === 'dark', 'document and persisted preference are dark')
  await assertDom('four online workspaces', (names) => {
    const rows = [...document.querySelectorAll('[data-testid="workspace-row"]')]
    return (names as string[]).every((name) => rows.some((row) => row.textContent?.includes(name) && row.getAttribute('data-online') === 'true'))
  }, 'macbook, ubuntu, gpu-box, and cloud-01 are online', WORKSPACES.map((item) => item.name))
  await assertDom('two sessions per workspace', (labels) => (labels as string[]).every((label) => [...document.querySelectorAll('[data-testid="session-row"]')].some((row) => row.textContent?.includes(label))), 'every online machine exposes at least two visible sessions', [
    'Dashboard showcase', 'macbook release notes',
    'ubuntu release review', 'ubuntu verification log',
    'gpu-box release review', 'gpu-box verification log',
    'Release deployment', 'cloud-01 verification log',
  ])

  const row = await findByText('[data-testid="session-row"]', 'Dashboard showcase')
  await row.click()
  await page.waitForSelector('[data-testid="message-image-preview-trigger"]')
  await page.waitForSelector('[data-testid^="sub-agent-row-"]')
  await assertDom('completed subagents', () => {
    const rows = [...document.querySelectorAll('[data-testid^="sub-agent-row-"]')]
    return rows.length === 3 && rows.every((row) => row.getAttribute('data-sub-agent-status') === 'completed')
  }, 'exactly 3 completed subagent rows')
  await page.mouse.move(900, 430)
  await page.mouse.wheel({ deltaY: -1800 })
  await sleep(400)
  await page.waitForFunction(() => { const image = document.querySelector('[data-testid="message-image-preview-trigger"] img') as HTMLImageElement | null; return Boolean(image?.complete && image.naturalWidth > 0) })
  await assertDom('attachment rendered', () => {
    const image = document.querySelector('[data-testid="message-image-preview-trigger"] img') as HTMLImageElement | null
    return Boolean(image?.complete && image.naturalWidth > 0)
  }, 'user-message image loaded')
  const contextLabel = await page.$eval('[data-testid="context-usage-bar"], [data-testid="context-usage-indicator"]', (node) => node.getAttribute('aria-label') ?? '')
  console.log(`CONTEXT ${contextLabel}`)
  await assertDom('nontrivial context usage', () => {
    const label = document.querySelector('[data-testid="context-usage-bar"], [data-testid="context-usage-indicator"]')?.getAttribute('aria-label') ?? ''
    const percent = Number(label.match(/(\d+(?:\.\d+)?)%/u)?.[1] ?? 0)
    return percent === 46
  }, 'context meter reports target 46% usage')
  await assertDom('meaningful release prompt', () => document.body.innerText.includes('Review the V3 dashboard release candidate.'), 'the initial user message specifies the V3 review')
  await page.mouse.move(280, 230, { steps: 12 })
  await sleep(150)

  console.log('RECORD start')
  const recorder = await startFrameRecorder(page)
  let recordedFrames = 0
  try {
    await recordFlow()
  } finally {
    console.log('RECORD stopping')
    recordedFrames = await recorder.stop()
    console.log(`RECORD stopped (${recordedFrames} frames)`)
  }
  if (recordedFrames < 1_410 || recordedFrames > 1_590) throw new Error(`V4 requires 48–52 seconds of real browser frames: ${recordedFrames}`)
  assertions.push({ name: 'real browser frames', detail: `${recordedFrames} timestamped CDP frames captured from the isolated Dashboard` })

  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  await transcodeAndVerify()

  // Same-filesystem atomic installation happens only after DOM and candidate media verification.
  const stagedMp4 = `${finalMp4}.tmp-${process.pid}`
  const stagedGif = `${finalGif}.tmp-${process.pid}`
  copyFileSync(candidateMp4, stagedMp4)
  copyFileSync(candidateGif, stagedGif)
  renameSync(stagedMp4, finalMp4)
  renameSync(stagedGif, finalGif)
  console.log(JSON.stringify({
    hostUrl: HOST_URL, workspaceNames: WORKSPACES.map((item) => item.name), sessionId: SESSION_ID,
    assertions, outputs: { mp4: finalMp4, gif: finalGif },
  }, null, 2))
}

const TRANSCRIPT = '[data-testid="chat-panel"] [data-virtuoso-scroller="true"]'
const timeline: { name: string; start: number; end: number }[] = []
async function reveal(selector: string): Promise<void> {
  if (!page) throw new Error('page unavailable')
  for (let i = 0; i < 80; i++) {
    const found = await page.evaluate((s) => { const node = document.querySelector(s); if (!node) return false; node.scrollIntoView({ block: 'center', behavior: 'instant' }); return true }, selector)
    if (found) { await sleep(100); return }
    const moved = await page.$eval(TRANSCRIPT, (node) => { const old = node.scrollTop; node.scrollTop += Math.max(220, node.clientHeight * .5); return node.scrollTop !== old })
    await sleep(80)
    if (!moved) break
  }
  throw new Error(`Virtual transcript did not mount ${selector}`)
}
async function point(selector: string): Promise<void> {
  const el = await page!.$(selector)
  const box = await el?.boundingBox()
  if (box) await page!.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
}
async function shot(name: string, origin: number, begin: number, finish: number, action: () => Promise<void>, targets: string[]): Promise<void> {
  const started = Date.now()
  if (started > origin + (begin + .75) * 1000) throw new Error(`Late shot ${name} at ${((started-origin)/1000).toFixed(2)}s`)
  console.log(`SCENE ${name} start ${((started-origin)/1000).toFixed(2)}s`)
  await action()
  let tick = 0
  while (Date.now() < origin + finish * 1000 - 65) {
    await point(targets[tick % targets.length]!)
    if (name === 'final GO result' || name === 'final workspace switch' || name === 'cloud-01 closing overview') {
      await page!.mouse.move(960, 485, { steps: 3 })
      await page!.mouse.wheel({ deltaY: tick % 2 ? 45 : -45 })
    } else if (tick % 2 === 0) await page!.$eval(TRANSCRIPT, (node, offset) => { node.scrollTop += offset }, tick % 4 === 0 ? 18 : -18)
    await sleep(150)
    tick++
  }
  const ended = Date.now()
  if (ended > origin + (finish + .75) * 1000) throw new Error(`Shot ${name} overran: ${((ended-origin)/1000).toFixed(2)}s`)
  timeline.push({ name, start: (started-origin)/1000, end: (ended-origin)/1000 })
  await assertDom(`${name}: dark, four online, no error`, (names) => document.documentElement.classList.contains('dark')
    && ![...document.querySelectorAll('[role="alert"]')].some((node) => /offline|reconnect|error/i.test(node.textContent ?? ''))
    && (names as string[]).every((machine) => [...document.querySelectorAll('[data-testid="workspace-row"]')].some((row) => row.textContent?.includes(machine) && row.getAttribute('data-online') === 'true')),
  'online dark error-free', WORKSPACES.map((item) => item.name))
  console.log(`SCENE ${name} end ${((ended-origin)/1000).toFixed(2)}s`)
}
async function recordFlow(): Promise<void> {
  if (!page) throw new Error('page unavailable')
  const origin = Date.now()
  await assertDom('first frame clean full dashboard', () => !!document.querySelector('[data-testid="right-panel"]')
    && document.querySelector('[data-testid="session-row"][data-selected="true"]')?.textContent?.includes('Dashboard showcase') === true
    && !document.querySelector('[role="dialog"], [data-testid="task-graph-popover"]'), 'no graph or dialog; macbook session and right sidebar visible')
  await shot('dashboard overview', origin, 0, 2.5, async () => { await point('[data-testid="workspace-row"]'); await point('[data-testid="session-row"][data-selected="true"]') }, ['[data-testid="workspace-row"]', '[data-testid="session-row"][data-selected="true"]'])
  await shot('task graph', origin, 2.5, 7, async () => {
    await page!.click('[data-testid="task-graph-trigger"]'); await page!.waitForSelector('[data-testid="task-graph-view"]')
    await assertDom('nine-node graph', () => document.querySelectorAll('[data-testid="task-graph-view"] [data-node-id]').length === 9, 'all statuses shown')
    for (const id of ['brief', 'panels', 'publish']) {
      await page!.evaluate((v) => document.querySelector(`[data-node-id="${v}"]`)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }), id)
      await point(`[data-node-id="${id}"]`); await sleep(130)
    }
    await page!.keyboard.press('Escape'); await page!.waitForSelector('[data-testid="task-graph-popover"]', { hidden: true })
  }, ['[data-testid="task-graph-trigger"]', '[data-testid="session-row"][data-selected="true"]'])
  await shot('initial prompt and attachment preview', origin, 7, 10.5, async () => {
    await reveal('[data-testid="message-image-preview-trigger"]'); await page!.$eval('[data-testid="message-image-preview-trigger"]', (node) => (node as HTMLElement).click())
    await page!.waitForSelector('[data-testid="message-image-preview-full"]'); await sleep(670)
    await page!.click('[data-testid="message-image-preview-close"]'); await page!.waitForSelector('[data-testid="message-image-preview-dialog"]', { hidden: true })
  }, ['[data-testid="message-image-preview-trigger"]', '[data-testid="task-graph-trigger"]'])
  await shot('tool dots expand scroll collapse', origin, 10.5, 15.5, async () => {
    await reveal('[data-testid="tool-activity-rail"]')
    await assertDom('14 visible individual dots', () => (document.querySelector('[data-testid="tool-activity-rail"]')?.querySelectorAll('[data-testid^="tool-card-dot-"]').length ?? 0) >= 14 && !document.querySelector('[data-testid="tool-activity-omission"]'), '14+ visible, no aggregation/omission')
    for (const dot of (await page!.$$('[data-testid="tool-activity-rail"] [data-testid^="tool-card-dot-"]')).slice(0, 3)) {
      const box = await dot.boundingBox(); if (box) await page!.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 6 }); await sleep(125)
    }
    await page!.click('[data-testid="tool-activity-direction"]'); await page!.waitForSelector('[data-testid="tool-activity-collapse-bottom"]')
    await assertDom('activity contains six categories', () => ['Read', 'Search', 'Edit', 'Test', 'Build', 'Verify'].every((word) => document.querySelector('[data-testid^="tool-call-group-"]')?.textContent?.includes(word)), 'read search edit test build verify')
    for (let i = 0; i < 7; i++) { await page!.evaluate((n) => { const node = document.querySelector('[data-testid="tool-activity-collapse-bottom"]'); if (n % 2) node?.scrollIntoView({ block: 'center', behavior: 'smooth' }); else document.querySelector('[data-testid^="tool-call-group-details-"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, i); await sleep(230) }
    await page!.click('[data-testid="tool-activity-collapse-bottom"]'); await page!.waitForSelector('[data-testid="tool-activity-rail"]')
  }, ['[data-testid="tool-activity-rail"]', '[data-testid="task-graph-trigger"]'])
  await shot('three completed subagents', origin, 15.5, 18.5, async () => {
    await reveal('[data-testid="sub-agent-row-agent-ux"]'); await page!.click('[data-sub-agent-toggle="agent-ux"]'); await page!.waitForSelector('[data-testid="nested-transcript"]')
    await assertDom('subagent result expanded', () => !!document.querySelector('[data-testid="nested-transcript"]'), 'completed specialist result')
  }, ['[data-sub-agent-toggle="agent-ux"]', '[data-testid="task-graph-trigger"]'])
  await shot('46% context detail', origin, 18.5, 21.5, async () => {
    await page!.click('[data-testid="context-usage-bar"], [data-testid="context-usage-indicator"]'); await page!.waitForSelector('[data-testid="context-pressure-popover"]')
    await assertDom('context 59.2k / 128k at 46%', () => { const text = document.querySelector('[data-testid="context-pressure-popover"]')?.textContent ?? ''; const totals = document.querySelector('[data-testid="context-usage-totals"]')?.textContent ?? ''; return text.includes('46%') && ['Used', '59.2k', 'Limit', '128k', 'Remaining', '68.8k'].every((value) => totals.includes(value)) }, 'used 59.2k, limit 128k, remaining 68.8k and 46%')
    await sleep(350); await page!.click('[data-testid="context-breakdown-toggle"]'); await sleep(400); await page!.keyboard.press('Escape')
  }, ['[data-testid="context-usage-bar"], [data-testid="context-usage-indicator"]', '[data-testid="composer-mode-toggle"]'])
  await shot('composer switches', origin, 21.5, 25, async () => {
    for (const mode of ['simple', 'full', 'simple', 'full'] as const) {
      await page!.click('[data-testid="composer-mode-toggle"]'); await page!.waitForSelector(`[data-testid="composer-${mode}-shell"], [data-testid="composer-${mode}-frame"]`)
      await assertDom(`composer ${mode}`, (value) => !!document.querySelector(`[data-testid="composer-${value}-shell"], [data-testid="composer-${value}-frame"]`), `${mode} visible`, mode)
      await sleep(180)
    }
  }, ['[data-testid="composer-mode-toggle"]', '[data-testid="task-graph-trigger"]'])
  await shot('Files preview', origin, 25, 28, async () => {
    await page!.click('[data-testid="right-panel-files-tab"]'); await page!.waitForSelector('[data-testid="session-file-file"]')
    await (await findByText('[data-testid="session-file-file"]', 'release-status.json')).click(); await page!.waitForSelector('[data-testid="session-file-view-dialog"]')
    await page!.waitForSelector('[data-testid="session-file-json-preview"] .monaco-editor')
    await assertDom('Files real JSON preview', () => document.querySelector('[data-testid="session-file-view-dialog"]')?.textContent?.includes('release-status.json') === true && !!document.querySelector('[data-testid="session-file-json-preview"] .monaco-editor'), 'selected fixture file is displayed in Monaco JSON preview')
    await sleep(650)
    await page!.click('[data-testid="session-file-view-close"]'); await page!.waitForSelector('[data-testid="session-file-view-dialog"]', { hidden: true })
  }, ['[data-testid="right-panel-files-tab"]', '[data-testid="session-file-file"]'])
  await shot('Git diff side-by-side to inline', origin, 28, 31, async () => {
    await page!.click('[data-testid="right-panel-git-tab"]'); await page!.waitForSelector('[data-testid="source-control-file"]')
    await (await findByText('[data-testid="source-control-file"]', 'release-status.json')).click(); await page!.waitForSelector('[data-testid="source-control-diff-dialog"]')
    await page!.waitForSelector('[data-testid="source-control-diff-dialog"] .monaco-diff-editor')
    await assertDom('real side-by-side diff', () => !!document.querySelector('[data-testid="source-control-diff-dialog"] .monaco-diff-editor') && document.querySelector('[data-testid="source-control-diff-side-by-side"]')?.getAttribute('aria-pressed') === 'true', 'fixture JSON Monaco diff loaded side-by-side')
    await page!.click('[data-testid="source-control-diff-inline"]')
    await assertDom('real inline diff', () => document.querySelector('[data-testid="source-control-diff-inline"]')?.getAttribute('aria-pressed') === 'true', 'diff switched layout')
    await sleep(320)
    await page!.keyboard.press('Escape'); await page!.waitForSelector('[data-testid="source-control-diff-dialog"]', { hidden: true })
  }, ['[data-testid="right-panel-git-tab"]', '[data-testid="source-control-file"]'])
  await shot('Terminal dynamic command', origin, 31, 34, async () => {
    await page!.click('[data-testid="right-panel-terminal-tab"]'); await page!.waitForSelector('[data-testid="session-terminal-panel"]')
    await page!.click('[data-testid="terminal-toolbar"] button'); await page!.waitForFunction(() => document.querySelector('[data-testid="session-terminal-panel"]')?.getAttribute('data-terminal-status') === 'running')
    await page!.click('[data-testid="session-terminal-panel"] .xterm textarea'); await page!.keyboard.type('pnpm test dashboard', { delay: 9 }); await page!.keyboard.press('Enter')
    await sleep(750)
    await assertDom('real PTY command and dynamic output', () => { const rows = [...document.querySelectorAll('[data-testid="session-terminal-panel"] .xterm-rows > div')].map((row) => row.textContent ?? '').join('\n'); return ['pnpm test dashboard', '204 focused tests passed', 'Dashboard build completed successfully'].every((line) => rows.includes(line)) }, 'fixture command executed in an isolated PTY and both result lines rendered')
  }, ['[data-testid="right-panel-terminal-tab"]', '[data-testid="session-terminal-panel"]'])
  await shot('Inspector status trace event detail', origin, 34, 38, async () => {
    await page!.click('[data-testid="right-panel-inspector-tab"]'); await page!.waitForSelector('[data-testid="inspector-sidebar-tabs"]')
    await page!.click('[data-testid="inspector-sidebar-tab-status"]'); await page!.waitForSelector('[data-testid="inspector-view-panel-status"]')
    await assertDom('Inspector Status runtime', () => !!document.querySelector('[data-testid="inspector-view-panel-status"]'), 'Status and runtime visible')
    await page!.$eval('[data-testid="inspector-sidebar-tab-trace"]', (node) => (node as HTMLElement).click())
    await page!.waitForSelector('[data-testid="trace-toolbar"]', { timeout: 1_500 })
    await assertDom('Inspector Trace selected', () => document.querySelector('[data-testid="inspector-sidebar-tab-trace"]')?.getAttribute('aria-pressed') === 'true', 'trace timeline is the active Inspector view')
    await page!.click('[data-testid="trace-mode-switch-list"]'); await page!.waitForSelector('[data-testid="timeline-row"]')
    await page!.evaluate(() => document.querySelectorAll('[data-testid="timeline-row"]')[6]?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    const eventRow = await findByText('[data-testid="timeline-row"]', 'tool_result')
    await eventRow.$eval('[data-testid="timeline-row-inspect-json"]', (el) => (el as HTMLElement).click())
    await page!.waitForSelector('[data-testid="timeline-row-details"]')
    await assertDom('Inspector event detail', () => !!document.querySelector('[data-testid="timeline-row-details"]'), 'real tool_result Event Detail dialog opened')
    await sleep(240); await page!.keyboard.press('Escape'); await page!.waitForSelector('[data-testid="timeline-row-details"]', { hidden: true })
  }, ['[data-testid="inspector-sidebar-tab-status"]', '[data-testid="inspector-sidebar-tab-trace"]'])
  await shot('sidebar collapse and reopen', origin, 38, 40, async () => {
    await page!.click('[data-testid="right-panel-collapse"]'); await page!.waitForSelector('[data-testid="right-panel"]', { hidden: true }); await sleep(390)
    await page!.click('[data-testid="sidebar-toggle"]'); await page!.waitForSelector('[data-testid="right-panel"]')
    await page!.mouse.move(940, 510); await page!.mouse.wheel({ deltaY: -320 })
  }, ['[data-testid="sidebar-toggle"]', '[data-testid="right-panel-inspector-tab"]'])
  await shot('final GO result', origin, 40, 43, async () => {
    await page!.mouse.move(940, 510); await page!.mouse.wheel({ deltaY: 3500 }); await sleep(240)
    await assertDom('GO with seven checks', () => { const text = document.querySelector('[data-testid="chat-panel"]')?.textContent ?? ''; return ['GO', '204 focused tests passed', 'No blocking release issues found'].every((x) => text.includes(x)) }, 'release recommendation visible')
  }, ['[data-testid="chat-panel"]', '[data-testid="right-panel-inspector-tab"]'])
  await shot('final workspace switch', origin, 43, 50, async () => {
    for (const name of ['ubuntu', 'gpu-box', 'cloud-01']) {
      const label = name === 'cloud-01' ? 'Release deployment' : `${name} release review`
      await (await findByText('[data-testid="session-row"]', label)).click()
      await page!.waitForFunction((expected) => document.querySelector('[data-testid="session-row"][data-selected="true"]')?.textContent?.includes(String(expected)), {}, label)
      await page!.waitForFunction((machine) => document.querySelector('[data-testid="chat-panel"]')?.textContent?.includes(`${machine} release evidence`) === true, { timeout: 1_500 }, name)
      await assertDom(`${name} distinct content`, (machine) => document.querySelector('[data-testid="chat-panel"]')?.textContent?.includes(`${machine} release evidence`) === true, 'machine-specific evidence visible', name)
      await page!.mouse.move(960, 485, { steps: 12 }); await page!.mouse.wheel({ deltaY: -280 })
      for (let step = 0; step < 4; step++) { await sleep(270); await page!.mouse.wheel({ deltaY: step % 2 ? 55 : -55 }) }
    }
  }, ['[data-testid="right-panel-files-tab"]', '[data-testid="right-panel-git-tab"]'])
  await shot('cloud-01 closing overview', origin, 50, 51.3, async () => {
    await assertDom('closing view unobstructed', () => !!document.querySelector('[data-testid="right-panel"]') && document.querySelector('[data-testid="session-row"][data-selected="true"]')?.textContent?.includes('Release deployment') === true && !document.querySelector('[role="dialog"]'), 'cloud-01 and right panel, no dialog')
  }, ['[data-testid="right-panel-files-tab"]', '[data-testid="right-panel-inspector-tab"]'])
  console.log(`V4 SCENE TIMELINE ${JSON.stringify(timeline)}`)
}

async function seedSessions(): Promise<void> {
  const imageData = readFileSync(attachmentPath).toString('base64')
  const config = createConfig({
    systemPrompt: 'You are Kala, a careful coding agent. Present concise verified results.',
    contextLimit: 128_000,
    tools: [
      tool('view', 'Read release files', 'read'), tool('multi_grep', 'Search changes', 'read'),
      tool('replace_in_file', 'Edit release data', 'read'), tool('shell', 'Run focused checks', 'shell'),
      tool('todo_graph', 'Maintain the task dependency graph', 'memory'), tool('agent', 'Delegate focused work', 'agent'),
    ],
  })
  const store = new SessionStore(sessionsDir)
  const primaryRoot = workspaceRoots.get(WORKSPACE_ID)!
  const parent = await store.create({
    sessionId: SESSION_ID, config, workspaceId: WORKSPACE_ID, workspaceName: PRIMARY_WORKSPACE.name,
    initialCwd: primaryRoot, initialApprovalMode: 'auto',
  })
  const append = async (event: AgentEvent, usage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }) => {
    const current = store.get(SESSION_ID)!
    const transition = step(current.state, event, current.config)
    await store.record(SESSION_ID, event, transition.effects, transition.next, usage, undefined, 'claude-sonnet-4.5')
    return transition
  }

  await append({ kind: 'user_message', text: 'Dashboard showcase', content: [
    { type: 'text', text: RELEASE_REVIEW_PROMPT },
    { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: imageData } },
  ] })

  const calls = [
    call('graph-call', 'todo_graph', { operations: [{ op: 'replace' }] }, 'Build the nine-node release dependency graph'),
    ...Array.from({ length: 14 }, (_, index) => {
      const category = ['Read', 'Search', 'Edit', 'Test', 'Build', 'Verify'][index % 6]!
      const name = ['view', 'multi_grep', 'replace_in_file', 'shell', 'view', 'shell'][index % 6]!
      return call(`evidence-${index + 1}`, name, { path: 'release-status.json', command: `echo ${category} passed` }, `${category} V3 dashboard evidence ${index + 1}`)
    }),
  ]
  await append({ kind: 'llm_response', message: { role: 'assistant', content: [
    { type: 'thinking', text: 'I will inspect the isolated workspace, map release dependencies, run focused checks, and delegate three specialist reviews.' },
    { type: 'text', text: 'I’m validating the release candidate against the attached design and collecting launch evidence.' }, ...calls,
  ] }, usage: { inputTokens: 20_000, outputTokens: 2_300, cacheCreationTokens: 4_000, cacheReadTokens: 8_500 }, finishReason: 'tool_use' }, { inputTokens: 20_000, outputTokens: 2_300, cacheCreationTokens: 4_000, cacheReadTokens: 8_500 })

  const graph = applyTodoGraphOperations({ version: 1, revision: 0, nodes: [], edges: [], summary: { total: 0, completed: 0, active: 0, ready: 0, blocked: 0, cancelled: 0 }, ready: [], blocked: [], changed: [] }, [{
    op: 'replace',
    nodes: [
      { id: 'brief', content: 'Review release candidate', status: 'completed', priority: 'high' },
      { id: 'design', content: 'Compare attached dashboard design', status: 'completed', priority: 'high' },
      { id: 'isolation', content: 'Verify isolated four-machine runtime', status: 'completed', priority: 'high' },
      { id: 'activity', content: 'Validate grouped tool activity', status: 'completed', priority: 'medium' },
      { id: 'agents', content: 'Complete three specialist reviews', status: 'completed', priority: 'high' },
      { id: 'panels', content: 'Check right panel', status: 'in_progress', priority: 'high' },
      { id: 'context', content: 'Confirm context telemetry', status: 'completed', priority: 'medium' },
      { id: 'media', content: 'Verify MP4 and GIF media', status: 'pending', priority: 'high' },
      { id: 'publish', content: 'Produce release recommendation', status: 'pending', priority: 'high' },
    ],
    edges: [
      { from: 'brief', to: 'design' }, { from: 'brief', to: 'isolation' },
      { from: 'design', to: 'activity' }, { from: 'isolation', to: 'agents' },
      { from: 'activity', to: 'panels' }, { from: 'agents', to: 'panels' },
      { from: 'panels', to: 'context' }, { from: 'context', to: 'media' }, { from: 'media', to: 'publish' },
    ],
  }])
  await append({ kind: 'tool_result', callId: 'graph-call', ok: true, content: JSON.stringify(graph) })
  for (let index = 1; index <= 14; index += 1) await append({ kind: 'tool_result', callId: `evidence-${index}`, ok: true, content: `Dashboard evidence ${index}: passed in isolated fixture. No model call.` })

  await append({ kind: 'llm_response', message: { role: 'assistant', content: [
    { type: 'text', text: 'All fourteen fixture-backed checks passed. I’m asking UX, release, and operations specialists for independent sign-off.' },
    call('agent-ux', 'agent', { agent_type: 'UI Review', message: 'Audit the dashboard story and attachment presentation.' }, 'Audit dashboard UX and attachment fidelity'),
    call('agent-rel', 'agent', { agent_type: 'Test Review', message: 'Check release readiness evidence and identify risk.' }, 'Verify launch evidence and residual risk'),
    call('agent-ops', 'agent', { agent_type: 'Release Review', message: 'Verify machine isolation, online status, and operational readiness.' }, 'Verify isolated machine operations'),
  ] }, usage: { inputTokens: 20_000, outputTokens: 3_100, cacheCreationTokens: 4_000, cacheReadTokens: 14_000 }, finishReason: 'tool_use' }, { inputTokens: 20_000, outputTokens: 3_100, cacheCreationTokens: 4_000, cacheReadTokens: 14_000 })

  await seedChild(store, config, '01KALACHILDUX000000000001', 'agent-ux', 'UI Review', 'The attachment, grouped activity, composer transitions, and panel tour are visually launch-ready.')
  await seedChild(store, config, '01KALACHILDREL0000000001', 'agent-rel', 'Test Review', 'The nine-node dependency graph and release evidence are complete with no blocker.')
  await seedChild(store, config, '01KALACHILDOPS0000000001', 'agent-ops', 'Release Review', 'All four isolated machines remain online and no user instance or model endpoint is involved.')
  await append({ kind: 'tool_result', callId: 'agent-ux', ok: true, content: envelope('01KALACHILDUX000000000001', 'UI Review', 'Audit dashboard UX and attachment fidelity', 'Visual and interaction review passed.', 3, 3240) })
  await append({ kind: 'tool_result', callId: 'agent-rel', ok: true, content: envelope('01KALACHILDREL0000000001', 'Test Review', 'Verify launch evidence and residual risk', 'Release evidence passed with no blocker.', 4, 4180) })
  await append({ kind: 'tool_result', callId: 'agent-ops', ok: true, content: envelope('01KALACHILDOPS0000000001', 'Release Review', 'Verify isolated machine operations', 'Isolation and online status verified.', 3, 3560) })
  await append({ kind: 'llm_response', message: { role: 'assistant', content: [
    { type: 'text', text: 'GO\n\n• Dashboard build passed\n• 204 focused tests passed\n• Task Graph verified\n• Attachment rendering passed\n• Composer modes verified\n• Right-panel tools verified\n• No blocking release issues found' },
  ] }, usage: { inputTokens: 18_880, outputTokens: 3_750, cacheCreationTokens: 4_000, cacheReadTokens: 20_500 }, finishReason: 'stop' }, { inputTokens: 18_880, outputTokens: 3_750, cacheCreationTokens: 4_000, cacheReadTokens: 20_500 })
  await store.updateRuntimeContextSnapshot(store.get(SESSION_ID)!, {
    model: { ref: 'showcase:fixture-v3', id: 'fixture-v3', provider: 'showcase' },
    contextWindow: { tokens: 128_000, source: 'manual_config' },
    usage: { inputTokens: 59_200, totalTokens: 59_200 },
    breakdown: {
      system: 12_800, tools: 2_080, transcript: 44_320, memory: 0, attachments: 0, pendingUserInput: 0,
      transcriptBreakdown: { userMessages: 8_000, assistantMessages: 18_000, toolResults: 18_320 },
    },
    estimator: { total: { kind: 'provider_reported', confidence: 'exact' }, breakdown: { kind: 'heuristic', confidence: 'rough' }, version: 'showcase-v3' },
    updatedAt: Date.now(),
  })

  let simpleIndex = 1
  for (const item of WORKSPACES) {
    const titles = item.id === WORKSPACE_ID ? ['macbook release notes'] : item.name === 'cloud-01' ? ['Release deployment', 'cloud-01 verification log'] : [`${item.name} release review`, `${item.name} verification log`]
    for (const title of titles) {
      await seedSimpleSession(store, config, `01KALASIMPLE${String(simpleIndex).padStart(12, '0')}`, item, title)
      simpleIndex += 1
    }
  }
  if (parent.logPath.includes('13000')) throw new Error('Unexpected production reference in seeded session')
}

async function seedSimpleSession(store: SessionStore, config: ReturnType<typeof createConfig>, sessionId: string, item: typeof WORKSPACES[number], title: string): Promise<void> {
  await store.create({ sessionId, config, workspaceId: item.id, workspaceName: item.name, initialCwd: workspaceRoots.get(item.id)!, initialApprovalMode: 'auto' })
  for (const event of [
    { kind: 'user_message', text: title, content: [{ type: 'text', text: `Review the isolated ${item.name} V3 release evidence.` }] },
    { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: `${item.name} is online; fixture-backed release checks are passing.\n\n## ${title}\n\n${Array.from({ length: 24 }, (_, index) => `- ${item.name} release evidence ${String(index + 1).padStart(2, '0')}: ${['design validated', 'tool results checked', 'workspace reachable', 'tests passing', 'build successful', 'runtime healthy'][index % 6]}`).join('\n')}\n\nRelease status: ready.` }] }, usage: { inputTokens: 8_000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 1_000 }, finishReason: 'stop' },
  ] as AgentEvent[]) {
    const rec = store.get(sessionId)!
    const transition = step(rec.state, event, rec.config)
    await store.record(sessionId, event, transition.effects, transition.next, transition.next.usage)
  }
}

async function seedChild(store: SessionStore, config: ReturnType<typeof createConfig>, sessionId: string, parentCallId: string, agentType: string, result: string): Promise<void> {
  await store.create({ sessionId, config, parentSessionId: SESSION_ID, parentCursor: 2, parentCallId, agentType, subAgentStartedAt: new Date().toISOString(), workspaceId: WORKSPACE_ID, workspaceName: PRIMARY_WORKSPACE.name, initialCwd: workspaceRoots.get(WORKSPACE_ID)! })
  for (const event of [
    { kind: 'user_message', text: `Complete the focused ${agentType} review.` },
    { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: result }] }, usage: { inputTokens: 6_000, outputTokens: 700, cacheCreationTokens: 0, cacheReadTokens: 1_000 }, finishReason: 'stop' },
  ] as AgentEvent[]) {
    const rec = store.get(sessionId)!
    const transition = step(rec.state, event, rec.config)
    await store.record(sessionId, event, transition.effects, transition.next, transition.next.usage)
  }
}

function tool(name: string, description: string, risk: 'read' | 'shell' | 'memory' | 'agent') {
  return { name, description, inputSchema: { type: 'object', additionalProperties: true }, requiresApproval: false, risk, executionKind: risk === 'memory' || risk === 'agent' ? 'host' as const : 'executor' as const }
}
function call(callId: string, name: string, input: Record<string, unknown>, intent: string): Message['content'][number] {
  return { type: 'tool_call', callId, name, input, intent }
}
function envelope(sessionId: string, agentType: string, intention: string, result: string, turns: number, duration: number): string {
  return `<sub_agent\n  session_id="${sessionId}"\n  agent_type="${agentType}"\n  intention="${intention}"\n  status="completed"\n  turns="${turns}"\n  duration_ms="${duration}"\n>\n<result>\n${result}\n</result>\n</sub_agent>`
}

async function startFrameRecorder(targetPage: Page): Promise<{ stop(): Promise<number> }> {
  const client = await targetPage.createCDPSession()
  let latest: Buffer | undefined
  let frameCount = 0
  let resolveFirstFrame: (() => void) | undefined
  const firstFrame = new Promise<void>((resolvePromise) => { resolveFirstFrame = resolvePromise })
  client.on('Page.screencastFrame', (event) => {
    latest = Buffer.from(event.data, 'base64')
    resolveFirstFrame?.()
    resolveFirstFrame = undefined
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
  })
  await client.send('Page.enable')
  await client.send('Page.startScreencast', {
    format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
  })
  await Promise.race([
    firstFrame,
    sleep(10_000).then(() => { throw new Error('Timed out waiting for the first real browser frame') }),
  ])
  const timer = setInterval(() => {
    if (!latest) return
    writeFileSync(join(captureFrames, `frame-${String(frameCount).padStart(6, '0')}.jpg`), latest)
    frameCount += 1
  }, 1000 / 30)
  return {
    async stop() {
      clearInterval(timer)
      if (latest) {
        writeFileSync(join(captureFrames, `frame-${String(frameCount).padStart(6, '0')}.jpg`), latest)
        frameCount += 1
      }
      await client.send('Page.stopScreencast')
      await client.detach()
      return frameCount
    },
  }
}

async function transcodeAndVerify(): Promise<void> {
  await run('/usr/bin/ffmpeg', ['-y', '-framerate', '30', '-i', join(captureFrames, 'frame-%06d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', candidateMp4], 300_000)
  await run('/usr/bin/ffmpeg', ['-y', '-i', candidateMp4, '-vf', 'fps=25/2,scale=1200:675:flags=lanczos,palettegen=stats_mode=diff', palette], 300_000)
  await run('/usr/bin/ffmpeg', ['-y', '-i', candidateMp4, '-i', palette, '-lavfi', 'fps=25/2,scale=1200:675:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle', candidateGif], 300_000)
  const mp4 = await probe(candidateMp4)
  const gif = await probe(candidateGif)
  const duration = Number(gif.format.duration)
  const gifStream = gif.streams[0]
  const mp4Stream = mp4.streams[0]
  if (mp4Stream.width !== 1920 || mp4Stream.height !== 1080) throw new Error(`MP4 is not 1920x1080: ${mp4Stream.width}x${mp4Stream.height}`)
  if (gifStream.width !== 1200 || gifStream.height !== 675) throw new Error(`GIF is not 1200x675: ${gifStream.width}x${gifStream.height}`)
  if (duration < 48 || duration > 52.9) throw new Error(`GIF duration outside V4 target 48–52s: ${duration}`)
  const frames = Number(gifStream.nb_read_frames ?? gifStream.nb_frames)
  const fps = frames / duration
  if (fps < 12 || fps > 15.1) throw new Error(`GIF effective frame rate outside 12-15fps: ${fps}`)
  if (frames < 600) throw new Error(`GIF has too few frames: ${frames}`)
  const frameMd5 = await run('/usr/bin/ffmpeg', ['-v', 'error', '-i', candidateGif, '-f', 'framemd5', '-'], 120_000, true)
  const hashes = frameMd5.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').at(-1)?.trim() ?? '')
  const motionFrames = hashes.slice(1).filter((hash, index) => hash !== hashes[index]).length
  const uniqueFrames = new Set(hashes).size
  if (motionFrames < 10 || uniqueFrames < 10) throw new Error(`GIF motion too low: ${motionFrames} changed transitions, ${uniqueFrames} unique frames`)
  // A blinking cursor can produce unique frames during an otherwise static shot.
  // Compare downsampled real MP4 frames and require substantial pixel changes every 1.2s.
  const samples = execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-i', candidateMp4, '-vf', 'fps=6,scale=320:180,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 25 * 1024 * 1024, timeout: 120_000 })
  const sampleSize = 320 * 180
  let longestQuiet = 0
  let quiet = 0
  const quietShots: string[] = []
  for (let offset = sampleSize; offset + sampleSize <= samples.length; offset += sampleSize) {
    let changed = 0
    for (let index = 0; index < sampleSize; index++) if (Math.abs(samples[offset + index]! - samples[offset - sampleSize + index]!) > 12) changed++
    if (changed < 58) quiet++
    else {
      if (quiet >= 7) quietShots.push(`${((offset / sampleSize - quiet) / 6).toFixed(2)}–${(offset / sampleSize / 6).toFixed(2)}s`)
      quiet = 0
    }
    longestQuiet = Math.max(longestQuiet, quiet)
  }
  if (quiet >= 7) quietShots.push(`${((samples.length / sampleSize - quiet) / 6).toFixed(2)}–${(samples.length / sampleSize / 6).toFixed(2)}s`)
  if (longestQuiet >= 8) throw new Error(`Near-static video shot exceeds 1.2s: ${longestQuiet} consecutive quiet 6fps samples at ${quietShots.join(', ')}`)
  assertions.push({ name: 'media verified', detail: `MP4 1920x1080; GIF 1200x675, ${duration.toFixed(2)}s, ${fps.toFixed(2)}fps, ${frames} frames, ${motionFrames} changed transitions, ${uniqueFrames} unique frames; longest near-static stretch ${(longestQuiet / 6).toFixed(2)}s` })
}

async function probe(path: string): Promise<any> {
  const output = await run('/usr/bin/ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'format=duration,size:stream=width,height,avg_frame_rate,nb_frames,nb_read_frames', '-of', 'json', path], 30_000, true)
  return JSON.parse(output)
}

async function assertDom(name: string, predicate: (...args: any[]) => boolean, detail: string, ...args: unknown[]): Promise<void> {
  if (!page) throw new Error('page unavailable')
  const ok = await page.evaluate(predicate, ...args)
  if (!ok) throw new Error(`DOM assertion failed: ${name}`)
  assertions.push({ name, detail })
  console.log(`ASSERT ${name}: ${detail}`)
}
async function findByText(selector: string, text: string) {
  if (!page) throw new Error('page unavailable')
  const handles = await page.$$(selector)
  for (const handle of handles) if ((await handle.evaluate((node) => node.textContent ?? '')).includes(text)) return handle
  throw new Error(`Could not find ${selector} containing ${text}`)
}
function startExecutor(item: typeof WORKSPACES[number]): ChildProcess {
  const root = workspaceRoots.get(item.id)!
  return start(process.execPath, [tsxCli, 'packages/executor/bin/kala-executor.ts'], {
    HOST_URL, WORKSPACE_NAME: item.name, SANDBOX_ROOTS: root, KALA_WORKSPACE_ID_FILE: join(root, '.kala-workspace-id'),
    KALA_EXECUTOR_PROFILE: `showcase-${item.name}-${process.pid}`,
    EXECUTOR_TOKEN: item.token, PATH: `${join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  }, executorLog)
}
async function waitForExecutors(timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (executorLog.filter((line) => line.includes('executor announced')).length >= WORKSPACES.length) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for four isolated executors\n${executorLog.slice(-40).join('\n')}`)
}
function start(command: string, args: string[], env: Record<string, string>, log: string[]): ChildProcess {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const collect = (chunk: Buffer) => {
    const lines = chunk.toString().split(/\r?\n/u).filter(Boolean)
    log.push(...lines)
    if (process.env.KALA_SHOWCASE_DEBUG === '1') for (const line of lines) console.error(`[${command}] ${line}`)
  }
  child.stdout?.on('data', collect); child.stderr?.on('data', collect)
  return child
}
async function waitForLog(log: string[], needle: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (log.some((line) => line.includes(needle))) return; await sleep(100) }
  throw new Error(`Timed out waiting for ${needle}\n${log.slice(-30).join('\n')}`)
}
async function run(command: string, args: string[], timeout: number, capture = false, cwd = ROOT): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk; if (!capture) process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { stderr += chunk; if (!capture) process.stderr.write(chunk) })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out`)) }, timeout)
    child.on('error', reject)
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited ${code}\n${stderr}`)) })
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  console.error('ABORTED: checked-in showcase assets were not replaced.')
  process.exitCode = 1
}).finally(async () => {
  await page?.close().catch(() => undefined)
  if (browserUrl) browser?.disconnect()
  else await browser?.close().catch(() => undefined)
  for (const executor of executors) executor.kill('SIGTERM')
  host?.kill('SIGTERM')
  await sleep(500)
  rmSync(scratch, { recursive: true, force: true })
})
