#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join, win32 } from 'node:path'
import { ProductE2EHarness, clickElement, clickFirstVisible, waitFor } from './harness.mjs'
import { validateWindowsFixture, removeWindowsFixtureDirectory } from './git-inbox-windows-fixture.mjs'

if (process.env.GIT_INBOX_E2E_ISOLATED !== '1') throw new Error('Set GIT_INBOX_E2E_ISOLATED=1 only for an authorized disposable instance.')
const credentialsPath = process.env.GIT_INBOX_E2E_CREDENTIALS
if (!credentialsPath) throw new Error('GIT_INBOX_E2E_CREDENTIALS must identify a private JSON file with origin/token.')
const { origin, token } = JSON.parse(await readFile(credentialsPath, 'utf8'))
assert(typeof origin === 'string' && typeof token === 'string' && token.length > 0, 'Private credentials must contain origin/token.')
const vm = process.env.GIT_INBOX_E2E_VM ?? 'kala-cu-linux-test'
const workspaceId = process.env.GIT_INBOX_E2E_WORKSPACE_ID
const windowsManifestPath = process.env.GIT_INBOX_E2E_WINDOWS_FIXTURE_MANIFEST
const workspaceRoot = process.env.GIT_INBOX_E2E_WORKSPACE_ROOT ?? (windowsManifestPath ? 'C:\\KalaTest\\workspace' : '/home/ubuntu/kala-test-workspace')
const windowsFixture = windowsManifestPath ? validateWindowsFixture(JSON.parse(await readFile(windowsManifestPath, 'utf8')), workspaceRoot) : null
if (!workspaceId || (!windowsFixture && !vm.endsWith('-test'))) throw new Error('An isolated -test VM or prepared Windows fixture and explicit workspace ID are required.')
if (windowsFixture && !process.env.GIT_INBOX_E2E_WINDOWS_WORKER_ROOT) throw new Error('Prepared Windows acceptance requires its authorized private worker root.')
const runId = randomUUID()
const fixture = windowsFixture?.fixture ?? `${workspaceRoot}/git-inbox-${runId}`
const failureDirectory = windowsFixture ? win32.join(fixture, 'will-disappear') : `${fixture}/will-disappear`
const workspaceName = windowsFixture?.workspaceName ?? 'kala-clean-linux'
const sessionId = `git-inbox-${runId}`
const evidenceRoot = resolve(process.env.PRODUCT_E2E_EVIDENCE_ROOT ?? `.artifacts/git-inbox-acceptance/${runId}`)
// Chromium's Unix singleton socket must fit the 108-byte pathname limit.
const browserRuntime = resolve(`.gib-${process.pid}`)
await mkdir(browserRuntime, { recursive: true })
process.env.TMPDIR = browserRuntime
const harness = new ProductE2EHarness({
  name: 'isolated-git-inbox-full-product',
  chromePath: process.env.CHROME_PATH,
  evidenceRoot,
})
const gitRequests = []
const taskIds = []
let actor
let failure

function remotePython(code, ...args) {
  return execFileSync('lxc', ['exec', vm, '--', 'runuser', '-u', 'ubuntu', '--', 'python3', '-c', code, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim()
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const value = response.status === 204 ? null : await response.json()
  assert(response.ok, `API ${method} ${path}: HTTP ${response.status}: ${JSON.stringify(value)}`)
  return value
}
async function clickText(text, selector = 'button') {
  await clickFirstVisible(actor.page, selector, { textIncludes: text, timeoutMs: 15_000, description: text })
}
async function textIncludes(text) {
  await actor.page.waitForFunction((expected) => document.body.textContent?.includes(expected), { timeout: 30_000 }, text)
}
async function closeCommit() {
  await actor.page.keyboard.press('Escape')
  await actor.page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent?.includes('Commit details')))
}
async function openInbox() {
  await clickFirstVisible(actor.page, 'button[aria-label^="Scheduled run inbox,"]', { description: 'Scheduled run inbox', timeoutMs: 15_000 })
}
async function inboxText() {
  return await actor.page.$eval('#scheduled-task-inbox-popover', (element) => element.textContent)
}
async function rowFor(label) {
  for (const button of await actor.page.$$('#scheduled-task-inbox-popover button.group')) {
    if ((await button.evaluate((element) => element.textContent)).includes(label)) return button
  }
  throw new Error(`Inbox row missing: ${label}`)
}

try {
  const hashes = await harness.step(windowsFixture ? 'use genuine prepared Windows Executor Git fixture' : 'create genuine disposable Git history fixture on Ubuntu Executor workspace', async () => windowsFixture ? windowsFixture.hashes : JSON.parse(remotePython(`
import json, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1]); root.mkdir()
def git(*args):
    return subprocess.check_output(['git','-c','user.name=Git Inbox Acceptance','-c','user.email=acceptance@example.invalid','-c','commit.gpgSign=false',*args],cwd=root,text=True).strip()
git('init','-q','-b','main')
(root/'original.txt').write_text('ROOT_ACCEPTANCE_CONTENT\\n')
git('add','original.txt'); git('commit','-qm','Acceptance root commit','-m','Root full message proof.')
root_hash=git('rev-parse','HEAD')
git('mv','original.txt','renamed.txt'); git('commit','-qm','Acceptance rename commit','-m','Rename metadata proof.')
rename_hash=git('rev-parse','HEAD')
(root/'renamed.txt').write_text('ROOT_ACCEPTANCE_CONTENT\\nMEANINGFUL_ADDED_LINE\\n')
git('add','renamed.txt'); git('commit','-qm','Acceptance changed-content commit','-m','Full author and per-file patch proof.')
changed_hash=git('rev-parse','HEAD')
for i in range(31): git('commit','--allow-empty','-qm',f'History page filler {i:02}')
(root/'will-disappear').mkdir()
print(json.dumps({'root':root_hash,'rename':rename_hash,'changed':changed_hash,'head':git('rev-parse','HEAD')}))
`, fixture)))

  await harness.step('create independent authorized Session through real Host API', async () => {
    const result = await api('/sessions', 'POST', {
      operationId: `create-${runId}`, sessionId, workspaceId, workspaceName, cwd: fixture, executionMode: 'chat',
    })
    assert.equal(result.session.summary.sessionId, sessionId)
    return { sessionId, workspaceId, cwd: fixture }
  })
  await harness.start()
  actor = await harness.newActor('git-inbox-operator', { width: 1600, height: 1050 })
  await actor.page.setRequestInterception(true)
  actor.page.on('request', (request) => {
    const sameOrigin = new URL(request.url()).origin === new URL(origin).origin
    void request.continue(sameOrigin ? { headers: { ...request.headers(), authorization: `Bearer ${token}` } } : {}).catch(() => {})
  })
  const cdp = await actor.page.createCDPSession()
  await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameSent', ({ response }) => {
    const start = response.payloadData.indexOf('["workspace:exec",')
    if (start < 0) return
    try {
      const [, payload] = JSON.parse(response.payloadData.slice(start))
      if (payload.argv?.[0] === 'git') gitRequests.push({ cwd: payload.cwd, argv: payload.argv, timeoutMs: payload.timeoutMs, maxOutputBytes: payload.maxOutputBytes })
    } catch {}
  })
  await harness.step('open genuine Dashboard Session and source-control sidebar', async () => {
    await actor.page.goto(`${origin}/?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    assert(!actor.page.url().includes(token), 'Dashboard must remove bootstrap token from URL.')
    const buttons = await actor.page.$$eval('button', (elements) => elements.map((element) => ({ id: element.dataset.testid, title: element.title, aria: element.getAttribute('aria-label'), text: element.textContent?.trim(), visible: element.getBoundingClientRect().width > 0 })).filter((entry) => entry.visible))
    await writeFile(join(evidenceRoot, 'initial-controls.json'), `${JSON.stringify(buttons, null, 2)}\n`)
    const initialGitPanel = await actor.page.$('[data-testid="source-control-panel"]')
    if (!initialGitPanel || !await initialGitPanel.isVisible()) {
      const gitButton = await actor.page.$('[data-testid="right-panel-source-control-tab"],[data-testid="right-panel-git-tab"]')
      if (!gitButton || !await gitButton.isVisible()) {
        await clickFirstVisible(actor.page, '[data-testid="sidebar-toggle"]', { description: 'Open inspector', timeoutMs: 15_000 })
      }
      await actor.page.waitForSelector('[data-testid="session-file-file"]', { timeout: 15_000 })
      await waitFor(async () => {
        const panel = await actor.page.$('[data-testid="source-control-panel"]')
        if (panel && await panel.isVisible()) return true
        await clickFirstVisible(actor.page, '[data-testid="right-panel-git-tab"]', { description: 'Git sidebar tab', timeoutMs: 5_000 })
        return false
      }, { name: 'hydrated Git sidebar', timeoutMs: 15_000, intervalMs: 500 })
    }
    await actor.page.waitForSelector('[data-testid="source-control-panel"]', { visible: true })
    await clickText('Commit history', '[data-testid="source-control-panel"] [role="tab"]')
    await textIncludes('History page filler 30')
    await harness.screenshot(actor, 'history-first-page')
    return { sessionId, initialHistoryVisible: true }
  })
  await harness.step('paginate real commits and inspect root metadata plus genuine added-file patch', async () => {
    await clickText('Load older commits')
    await textIncludes('Acceptance root commit')
    await clickText('Acceptance root commit', '[data-testid="source-control-panel"] section button')
    await textIncludes('Root full message proof.')
    await textIncludes(hashes.root)
    await textIncludes('Root commit: changes are compared with an empty tree.')
    await textIncludes('+ROOT_ACCEPTANCE_CONTENT')
    const dialog = await actor.page.$eval('[role="dialog"]', (element) => element.textContent)
    assert(dialog.includes('acceptance@example.invalid'))
    assert(dialog.includes('Author:') && dialog.includes('Committer:'))
    await harness.screenshot(actor, 'root-commit-metadata-and-patch')
    await closeCommit()
    return { rootHash: hashes.root, rootPatch: '+ROOT_ACCEPTANCE_CONTENT', metadataVerified: true }
  })
  await harness.step('inspect actual rename and changed-content commit patches', async () => {
    await clickText('Acceptance rename commit', '[data-testid="source-control-panel"] section button')
    await textIncludes('Rename metadata proof.')
    await textIncludes('R100 original.txt → renamed.txt')
    await textIncludes('rename from original.txt')
    await textIncludes('rename to renamed.txt')
    await harness.screenshot(actor, 'rename-commit-patch')
    await closeCommit()
    await clickText('Acceptance changed-content commit', '[data-testid="source-control-panel"] section button')
    await textIncludes('Full author and per-file patch proof.')
    await textIncludes('+MEANINGFUL_ADDED_LINE')
    await harness.screenshot(actor, 'meaningful-content-patch')
    await closeCommit()
    assert(gitRequests.some((request) => request.argv.includes('log') && request.argv.includes('--skip=30')))
    assert(gitRequests.some((request) => request.argv.includes('diff-tree') && request.argv.includes('-p')))
    assert(gitRequests.every((request) => !request.argv.includes('diff-tree') || request.argv.includes('--no-ext-diff') && request.argv.includes('--no-textconv')))
    return { renameHash: hashes.rename, changedHash: hashes.changed, gitExecRequests: gitRequests.length }
  })
  const labels = { queued: `Git inbox queued ${runId.slice(0, 8)}`, failed: `Git inbox failed ${runId.slice(0, 8)}` }
  const runs = await harness.step('let real scheduler dispatch one workspace task and fail another after its directory disappears', async () => {
    const at = new Date(Date.now() + (windowsFixture ? 25_000 : 8_000)).toISOString()
    for (const kind of ['queued', 'failed']) {
      const created = await api('/scheduled-tasks', 'POST', {
        prompt: `${labels[kind]}\nAcceptance dispatch only; do not claim task completion in notifications.`,
        target: { kind: 'workspace', workspaceId, workspaceName, cwd: kind === 'queued' ? fixture : failureDirectory },
        schedule: { kind: 'once', at },
      })
      taskIds.push(created.task.id)
    }
    if (windowsFixture) {
      await removeWindowsFixtureDirectory({ workerRoot: process.env.GIT_INBOX_E2E_WINDOWS_WORKER_ROOT, manifest: windowsFixture, workspaceRoot })
    } else remotePython('import pathlib,sys; pathlib.Path(sys.argv[1]).rmdir()', failureDirectory)
    return await waitFor(async () => {
      const inbox = await api('/scheduled-tasks/inbox')
      const own = inbox.items.filter((item) => taskIds.includes(item.taskId))
      if (own.length !== 2) return false
      assert.equal(own.find((item) => item.taskLabel === labels.queued)?.status, 'enqueued')
      const failed = own.find((item) => item.taskLabel === labels.failed)
      assert.equal(failed?.status, 'failed')
      assert(failed.error, 'Actual dispatch failure must include a useful error.')
      return own
    }, { timeoutMs: windowsFixture ? 60_000 : 45_000, name: 'genuine queued and failed occurrence records' })
  })
  await harness.step('render useful real notification detail and acknowledge only visible records', async () => {
    await waitFor(async () => {
      const trigger = await actor.page.$('button[aria-label^="Scheduled run inbox,"]')
      const label = trigger && await trigger.evaluate((element) => element.getAttribute('aria-label'))
      return label && !label.endsWith('0 unread')
    }, { timeoutMs: 45_000, name: 'Dashboard polling discovers actual run records' })
    await openInbox()
    await textIncludes(labels.queued)
    await textIncludes(labels.failed)
    const text = await inboxText()
    for (const expected of [`Workspace: ${workspaceName}`, fixture, 'Scheduled:', 'Claimed for dispatch:', 'Status updated:', 'Queued', 'Dispatch failed', 'Completion and results are not tracked here.']) assert(text.includes(expected), `Notification detail missing: ${expected}`)
    const failedRun = runs.find((run) => run.status === 'failed')
    assert(text.includes(failedRun.error))
    assert(!text.includes('Run started'))
    await waitFor(async () => {
      const latest = await api('/scheduled-tasks/inbox')
      return latest.items.filter((item) => taskIds.includes(item.taskId)).every((item) => item.seen)
    }, { timeoutMs: 10_000, name: 'real inbox acknowledgement persisted' })
    await harness.screenshot(actor, 'informative-queued-and-failed-notifications')
    return { records: runs.map(({ occurrenceId, taskId, taskLabel, status, scheduledFor, claimedAt, updatedAt, target, sessionId, error }) => ({ occurrenceId, taskId, taskLabel, status, scheduledFor, claimedAt, updatedAt, target, sessionId, error })) }
  })
  await harness.step('navigate from real inbox record to existing task management and occurrence Session', async () => {
    await clickElement(await rowFor(labels.queued), 'Open queued task management')
    await actor.page.waitForSelector('[role="dialog"]')
    await textIncludes(labels.queued)
    await harness.screenshot(actor, 'notification-opens-existing-task')
    await actor.page.keyboard.press('Escape')
    await actor.page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await openInbox()
    const row = await rowFor(labels.queued)
    const sessionButton = await row.evaluateHandle((element) => element.parentElement.querySelector('button:not(.group)'))
    await clickElement(sessionButton.asElement(), 'Open scheduled occurrence conversation')
    const queuedRun = runs.find((run) => run.status === 'enqueued')
    assert(queuedRun.sessionId)
    await actor.page.waitForFunction((id) => new URL(location.href).searchParams.get('sessionId') === id, { timeout: 30_000 }, queuedRun.sessionId)
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    await actor.page.waitForFunction((id) => document.querySelector(`[data-testid="session-row"][data-session-id="${id}"]`)?.getAttribute('data-selected') === 'true', {}, queuedRun.sessionId)
    await harness.screenshot(actor, 'notification-opens-real-occurrence-session')
    return { taskId: queuedRun.taskId, destinationSessionId: queuedRun.sessionId, url: actor.page.url() }
  })
} catch (error) {
  failure = new Error(String(error.stack ?? error).split(token).join('[REDACTED]'))
  console.error(failure.message)
  if (actor) await harness.screenshot(actor, 'failure').catch(() => {})
} finally {
  await writeFile(join(evidenceRoot, 'git-workspace-exec-requests.json'), `${JSON.stringify(gitRequests, null, 2)}\n`)
  const result = await harness.finalize({ isolatedOrigin: origin, executorPlatform: windowsFixture ? 'windows' : 'linux', workspaceId, fixture, independentSessionId: sessionId, ...(failure ? { acceptanceError: failure.message } : {}) })
  await rm(browserRuntime, { recursive: true, force: true })
  const safeReport = JSON.parse(JSON.stringify(result.report).split(token).join('[REDACTED]'))
  await writeFile(result.reportPath, `${JSON.stringify(safeReport, null, 2)}\n`)
  if (!failure) harness.assertClean(safeReport)
  console.log(JSON.stringify({ ok: !failure, reportPath: result.reportPath, steps: result.report.steps.length }))
}
if (failure) process.exitCode = 1
