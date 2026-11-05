import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import test from 'node:test'

const assets = resolve(process.env.KALA_RELEASE_ASSETS_DIR ?? 'release')
const manager = 'kala-portable.ps1'
const runtime = 'kala-dashboard-with-runtime.cjs'

function powershell(script, command, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, command,
    ], { env, signal: AbortSignal.timeout(120_000) })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (status) => resolveResult({ status, stdout, stderr }))
  })
}

test('Windows Portable manager installs the exact release and retains user data on uninstall', {
  skip: process.platform !== 'win32',
}, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-portable-windows-'))
  const root = join(scratch, 'app')
  const data = join(scratch, 'data')
  const allowed = new Set(['SHA256SUMS', manager, runtime])
  const transfers = []
  let corruptRuntime = false
  const server = createServer((request, response) => {
    const name = request.url?.slice(1)
    const transfer = { name, finished: false }
    transfers.push(transfer)
    response.once('finish', () => { transfer.finished = true })
    if (!name || !allowed.has(name)) {
      response.writeHead(404).end()
      return
    }
    if (corruptRuntime && name === runtime) {
      response.writeHead(200).end('corrupted')
      return
    }
    const stream = createReadStream(join(assets, name))
    stream.once('error', (error) => response.destroy(error))
    stream.pipe(response)
  })
  try {
    for (const name of allowed) assert.ok(existsSync(join(assets, name)), `${name} must be built before Windows acceptance`)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const env = {
      ...process.env,
      KALA_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
      KALA_PORTABLE_HOME: root,
      KALA_PORTABLE_DATA_DIR: data,
    }
    const script = join(assets, manager)
    const runManager = async (path, command) => {
      try { return await powershell(path, command, env) }
      catch (error) { throw new Error(`${command}: ${error.message}; transfers=${JSON.stringify(transfers)}`, { cause: error }) }
    }
    const install = await runManager(script, 'install')
    assert.equal(install.status, 0, install.stderr)
    for (const [source, installed] of [
      [manager, join(root, 'bin', manager)],
      [runtime, join(root, 'runtime', runtime)],
    ]) {
      const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
      assert.equal(digest(installed), digest(join(assets, source)))
    }
    corruptRuntime = true
    const rejected = await runManager(script, 'install')
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /checksum mismatch/u)
    assert.equal(
      createHash('sha256').update(readFileSync(join(root, 'runtime', runtime))).digest('hex'),
      createHash('sha256').update(readFileSync(join(assets, runtime))).digest('hex'),
    )
    corruptRuntime = false
    const status = await runManager(join(root, 'bin', manager), 'status')
    assert.equal(status.status, 3, status.stderr)
    assert.match(status.stdout, /stopped tag=v0\.3\.0/u)
    writeFileSync(join(data, 'retain-me'), 'yes')
    const uninstall = await runManager(join(root, 'bin', manager), 'uninstall')
    assert.equal(uninstall.status, 0, uninstall.stderr)
    assert.equal(existsSync(root), false)
    assert.equal(readFileSync(join(data, 'retain-me'), 'utf8'), 'yes')
  } finally {
    if (server.listening) {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    }
    rmSync(scratch, { recursive: true, force: true })
  }
})
