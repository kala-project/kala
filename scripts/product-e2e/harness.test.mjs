import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProductE2EHarness, clickByTestId, navigateLoginPage, waitForIdentitySubmit } from './harness.mjs'

test('retries only a transient network change on the initial login navigation', async () => {
  const url = 'http://localhost:13001/auth/login'
  const transient = new Error(`net::ERR_NETWORK_CHANGED at ${url}`)
  let attempts = 0
  await navigateLoginPage({
    async goto(actual, options) {
      assert.equal(actual, url)
      assert.deepEqual(options, { waitUntil: 'domcontentloaded' })
      if (++attempts < 3) throw transient
    },
  }, url)
  assert.equal(attempts, 3)

  attempts = 0
  await assert.rejects(navigateLoginPage({ async goto() { attempts++; throw transient } }, url), transient)
  assert.equal(attempts, 3)

  attempts = 0
  const other = new Error('net::ERR_CONNECTION_REFUSED')
  await assert.rejects(navigateLoginPage({ async goto() { attempts++; throw other } }, url), other)
  assert.equal(attempts, 1)
})

test('retypes the hydrated identity input only when the submit button stays disabled', async () => {
  const events = []
  const timeout = Object.assign(new Error('waiting timed out'), { name: 'TimeoutError' })
  let waits = 0
  const page = {
    async waitForFunction(_predicate, options) {
      assert.equal(options.timeout, 10_000)
      if (++waits === 1) throw timeout
    },
    async $(selector) { assert.equal(selector, 'input[name=loginName]'); return {} },
    async waitForSelector() { events.push('selector') },
    async click() { events.push('click') },
    keyboard: {
      async down(key) { events.push(`down:${key}`) },
      async press(key) { events.push(`press:${key}`) },
      async up(key) { events.push(`up:${key}`) },
      async type() { events.push('type') },
    },
    async $eval() { return 'alice@example.test' },
  }
  await waitForIdentitySubmit(page, 'input[name=loginName]', 'alice@example.test')
  assert.equal(waits, 2)
  assert.deepEqual(events, ['selector', 'click', 'down:Control', 'press:KeyA', 'up:Control', 'press:Backspace', 'type'])

  const other = new Error('navigation failed')
  await assert.rejects(waitForIdentitySubmit({ async waitForFunction() { throw other } }, 'input[name=loginName]', 'alice@example.test'), other)
  await assert.rejects(waitForIdentitySubmit({
    async waitForFunction() { throw timeout },
    async $() { return null },
    url() { return 'https://identity.example/ui/v2/login?state=secret' },
    async evaluate() { return { inputLength: 0, buttons: [{ disabled: true, expectedAction: true }] } },
  }, 'input[name=loginName]', 'alice@example.test'), (error) => {
    assert.match(error.message, /path=\/ui\/v2\/login, form=\{"inputLength":0,"buttons":\[\{"disabled":true,"expectedAction":true\}\]\}/u)
    assert.doesNotMatch(error.message, /secret/u)
    return true
  })
})

test('records task evidence and cleans resources in reverse order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-e2e-harness-'))
  const harness = new ProductE2EHarness({ evidenceRoot: root })
  const cleanupOrder = []
  harness.registerResource('session', 'a', async () => cleanupOrder.push('a'))
  harness.registerResource('workspace', 'b', async () => cleanupOrder.push('b'))
  await harness.step('persist side effect', async () => ({ id: 'side-effect' }), (value) => ({ persistedId: value.id }))
  const { report, reportPath } = await harness.finalize({ revision: 'test' })
  assert.deepEqual(cleanupOrder, ['b', 'a'])
  assert.equal(report.steps[0].evidence.persistedId, 'side-effect')
  assert.equal(report.cleanup.every((entry) => entry.ok), true)
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).revision, 'test')
})

test('coverage ledger accounts for every normative critical user journey', async () => {
  const matrix = await readFile(new URL('../../docs/development/testing/critical-user-action-matrix.md', import.meta.url), 'utf8')
  const ledger = await readFile(new URL('../../docs/testing/system-e2e-coverage-ledger.md', import.meta.url), 'utf8')
  const mappings = new Map([
    ['Private Cloud::Register/sign in', ['Private Cloud identity/isolation']],
    ['Private Cloud::Sign out', ['Private Cloud identity/isolation']],
    ['Platform::Account/settings entry', ['Account/settings entry']],
    ['Platform::Add Workspace', ['Add Workspace — Linux service']],
    ['Platform::New Workspace Session', ['New Session']],
    ['Platform::Select Agent Runtime', ['Agent Runtime selection']],
    ['Platform::Send direct message', ['Direct message']],
    ['Platform::Queue message', ['Queue message']],
    ['Platform::File', ['Files and preview']],
    ['Platform::Git', ['Git']],
    ['Platform::Shell', ['Interactive Terminal', 'Background Shell registry']],
    ['Platform::Artifact preview', ['Artifact preview']],
    ['Platform::Agent tool chain', ['Agent tool chain']],
    ['Platform::Copilot Runtime journey', ['GitHub Copilot Runtime']],
    ['Platform::Sub-agent', ['Sub-agent lifecycle']],
    ['Platform::Streaming scroll', ['Streaming scroll']],
    ['Platform::Notifications', ['Notifications']],
    ['Platform::PWA', ['PWA install/update/offline']],
    ['Dedicated::Benchmark/Evaluation', ['Dedicated benchmark/evaluation']],
    ['Private Cloud::Benchmark/Evaluation', ['Private Cloud benchmark denial']],
    ['Platform::Responsive surfaces', ['Responsive surfaces']],
  ])
  const entries = [...matrix.matchAll(/^\| (Platform|Dedicated|Private Cloud) \| ([^|]+?) \|/gmu)]
    .map((match) => `${match[1]}::${match[2].trim()}`)
  const missingMappings = entries.filter((entry) => !mappings.has(entry))
  assert.deepEqual(missingMappings, [], `matrix entries without ledger mapping: ${missingMappings.join(', ')}`)
  for (const [entry, ledgerJourneys] of mappings) {
    for (const ledgerJourney of ledgerJourneys) {
      assert.match(ledger, new RegExp(`\\\\| ${escapeRegex(ledgerJourney)} `, 'u'), `${entry} is missing ${ledgerJourney} from the coverage ledger`)
    }
  }
})

test('complete coverage claims cite production system E2E scripts', async () => {
  const ledger = await readFile(new URL('../../docs/testing/system-e2e-coverage-ledger.md', import.meta.url), 'utf8')
  const completeRows = ledger.split('\n')
    .filter((line) => line.startsWith('| ') && /\| Complete(?: \(| \|)/u.test(line))
  const violations = completeRows
    .filter((line) => !line.includes('`scripts/product-e2e/'))
    .map((line) => line.split('|')[1].trim())

  assert.deepEqual(violations, [], `Complete claims without production system E2E evidence: ${violations.join(', ')}`)
})

test('persists the final report when cleanup removes the evidence directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-e2e-harness-cleanup-'))
  const harness = new ProductE2EHarness({ evidenceRoot: root })
  harness.registerResource('temporary-root', root, async () => rm(root, { recursive: true, force: true }))

  const { reportPath } = await harness.finalize()

  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).name, 'product-e2e')
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

test('assertClean rejects HTTP, console, page, and cleanup failures', () => {
  const harness = new ProductE2EHarness()
  assert.throws(() => harness.assertClean({
    actors: [{ name: 'mobile', failedResponses: [{ status: 500, url: 'http://test/api' }], consoleErrors: [], pageErrors: [] }],
    failures: [],
  }), /HTTP 500/u)
})

test('clickByTestId uses a real pointer click on the visible matching element', async () => {
  const hidden = {
    async isVisible() { return false },
  }
  const calls = []
  const visible = {
    async isVisible() { return true },
    async scrollIntoView() { calls.push('scroll') },
    async boundingBox() { return { x: 10, y: 20, width: 100, height: 40 } },
    async evaluate() { return { reachable: true, target: 'BUTTON' } },
    async click() { calls.push('click') },
  }
  const page = {
    async waitForSelector(selector) { calls.push(selector) },
    async $$(selector) {
      calls.push(`all:${selector}`)
      return [hidden, visible]
    },
  }

  await clickByTestId(page, 'target')

  assert.deepEqual(calls, [
    '[data-testid="target"]',
    'all:[data-testid="target"]',
    'scroll',
    'click',
  ])
})

test('system E2E journeys do not bypass browser hit-testing with DOM click', async () => {
  const root = new URL('.', import.meta.url)
  const files = (await readdir(root))
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  const violations = []
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8')
    source.split('\n').forEach((line, index) => {
      if (/\.click\(\)/u.test(line) && !(file === 'harness.mjs' && line.includes('await element.click()'))) {
        violations.push(`${file}:${index + 1}`)
      }
    })
  }
  assert.deepEqual(violations, [], `DOM-dispatched clicks bypass pointer hit-testing: ${violations.join(', ')}`)
})

test('Windows terminal E2E executes the API PowerShell command without claiming or invoking the internal installer itself', async () => {
  const source = await readFile(new URL('verify-windows-terminal.mjs', import.meta.url), 'utf8')

  assert.match(source, /'-Command', created\.command/u)
  assert.match(source, /api\/executor-install-capabilities/u)
  assert.doesNotMatch(source, /\/install\/session/u)
  assert.doesNotMatch(source, /'--internal-installer'/u)
  assert.doesNotMatch(source, /console\.error\(logs\.join/u)
})

test('release workflows hard-gate captured Windows assets with temporary and service API command lifecycles', async () => {
  for (const workflow of ['release.yml', 'private-cloud-release.yml']) {
    const source = await readFile(new URL(`../../.github/workflows/${workflow}`, import.meta.url), 'utf8')
    const temporary = source.indexOf('Real Windows API created.command temporary')
    const service = source.indexOf('Real Windows API created.command service')
    const upload = source.indexOf('name: windows-captured-assets') >= 0
      ? source.indexOf('name: windows-captured-assets')
      : source.indexOf('name: private-cloud-windows-captured-assets')

    assert.ok(temporary >= 0, `${workflow} is missing the Windows temporary created.command gate`)
    assert.ok(service > temporary, `${workflow} is missing the Windows service created.command gate`)
    assert.ok(upload > service, `${workflow} uploads Windows assets before the real-machine gates`)
    assert.match(source, /prepare-windows-release-fixture\.mjs/u)
    assert.doesNotMatch(source.slice(0, upload), /gh release download/u)
  }
})

test('real Windows invite.ps1 preflight is followed by a valid Private Cloud temporary and service lifecycle before capture upload', async () => {
  const script = await readFile(new URL('verify-windows-terminal.mjs', import.meta.url), 'utf8')
  const workflow = await readFile(new URL('../../.github/workflows/private-cloud-release.yml', import.meta.url), 'utf8')
  const invite = await readFile(new URL('verify-private-cloud-windows-invite.mjs', import.meta.url), 'utf8')

  assert.match(script, /install\/invite\.ps1/u)
  assert.match(script, /isolated-invalid-invite/u)
  assert.match(script, /not a Private Cloud topology E2E/u)
  assert.match(invite, /verifyTemporaryInvite\(\{ origin, unitId \}\)[\s\S]*verifyServiceInvite\(\{ origin, unitId \}\)/u)
  assert.match(invite, /'install\/invite\.ps1'|\/install\/invite\.ps1/u)
  const lifecycle = workflow.indexOf('run: node scripts/product-e2e/verify-private-cloud-windows-invite.mjs')
  const upload = workflow.indexOf('name: private-cloud-windows-captured-assets')
  assert.ok(lifecycle > 0 && upload > lifecycle, 'the valid Private Cloud Windows lifecycle must gate captured assets')
})
