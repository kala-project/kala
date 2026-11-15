import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(new URL('../src/sw.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const recovery = readFileSync(new URL('../src/lib/dashboard-version-recovery.ts', import.meta.url), 'utf8')
const runtimeMetrics = readFileSync(new URL('../src/features/chat/RuntimeMetrics.tsx', import.meta.url), 'utf8')

test('PWA navigation is network-first with a precached offline fallback', () => {
  assert.match(source, /fetch\(options\.request, \{ cache: 'no-store' \}\)/u)
  assert.match(source, /createHandlerBoundToURL\(APP_SHELL_URL\)/u)
})

test('stale Vite lazy chunks trigger one bounded recovery reload', () => {
  assert.match(main, /vite:preloadError/u)
  assert.match(main, /recoverStaleDashboard/u)
  assert.match(recovery, /storage\?\.getItem\(key\) === '1'/u)
  assert.match(recovery, /registration\?\.waiting/u)
  assert.match(recovery, /window\.location\.reload\(\)/u)
})

test('composer context indicator ships statically discoverable stroke colors', () => {
  for (const className of ['stroke-sky-500/85', 'stroke-amber-400/85', 'stroke-rose-500/85']) {
    assert.ok(runtimeMetrics.includes(className), 'missing static Tailwind class: ' + className)
  }
  assert.doesNotMatch(runtimeMetrics, /\.replace\('border-', 'stroke-'\)/u)
})

test('the actual static server refuses native Console paths instead of serving the Dashboard shell', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kala-native-route-'))
  await writeFile(join(directory, 'index.html'), '<title>Dashboard fixture</title>')
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const child = spawn(process.execPath, [new URL('../../../deploy/private-cloud/images/dashboard-server.mjs', import.meta.url).pathname], {
    env: { ...process.env, DASHBOARD_ROOT: directory, DASHBOARD_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Dashboard server exited before readiness') })])
    for (const path of ['/silo', '/silo/', '/silo/login', '/auth/silo/open']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await response.json(), { error: 'native_console_route_unavailable' })
    }
    const ordinary = await fetch(`http://127.0.0.1:${port}/ordinary-client-route`)
    assert.equal(ordinary.status, 200)
    assert.equal(await ordinary.text(), '<title>Dashboard fixture</title>')
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    await rm(directory, { recursive: true, force: true })
  }
})
