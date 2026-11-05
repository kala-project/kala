import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { desktopBootstrapAvailable, desktopBootstrapScript, desktopInstallCommands, desktopLocalInstallCommands, loadDesktopRelease, validateDesktopOrigin, validateDesktopRelease } from '../public/downloads/desktop/release-data.js'
import { aptInstallSnippet } from '../public/downloads/desktop/apt-snippet.js'
import { verifyDesktopPublication } from './build.mjs'

const publishedBase = new URL('../public/downloads/desktop/', import.meta.url)
// The immutable Desktop .deb is staged during deployment, not checked into
// source. Test its real bytes when present; clean CI uses an isolated fixture.
const base = existsSync(new URL('release.json', publishedBase)) ? publishedBase : await desktopFixture()
const release = JSON.parse(await readFile(new URL('release.json', base), 'utf8'))

async function desktopFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'kala-desktop-test-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const version = '0.2.0~rc.13'
  const file = 'kala-desktop-fixture.deb'
  const packageBytes = Buffer.from('test-only desktop package fixture\n')
  const dependenciesBytes = Buffer.from('{"fixture":true}\n')
  const prefix = `${version}-${digest(packageBytes)}`
  const dependencies = `${prefix}.dependencies.json`
  const checksums = `${prefix}.SHA256SUMS.txt`
  const checksumBytes = Buffer.from(`${digest(packageBytes)}  ${file}\n${digest(dependenciesBytes)}  ${dependencies}\n`)
  const manifest = {
    schemaVersion: 2, version, platform: 'linux-amd64',
    artifact: { file, sha256: digest(packageBytes), size: packageBytes.length },
    dependencies: { file: dependencies, sha256: digest(dependenciesBytes) },
    checksums: { file: checksums, sha256: digest(checksumBytes) },
  }
  await Promise.all([
    writeFile(join(directory, file), packageBytes),
    writeFile(join(directory, dependencies), dependenciesBytes),
    writeFile(join(directory, checksums), checksumBytes),
    writeFile(join(directory, 'release.json'), JSON.stringify(manifest)),
  ])
  return pathToFileURL(`${directory}/`)
}

test('immutable Desktop metadata matches actual package/checksum bytes', async () => {
  assert.equal(validateDesktopRelease(release).version, release.version)
  for (const item of [release.artifact, release.dependencies, release.checksums]) {
    const bytes = await readFile(new URL(item.file, base))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256)
    if (item.size) assert.equal(bytes.length, item.size)
  }
  const checksums = await readFile(new URL(release.checksums.file, base), 'utf8')
  assert(checksums.includes(`${release.artifact.sha256}  ${release.artifact.file}`))
  assert(checksums.includes(`${release.dependencies.sha256}  ${release.dependencies.file}`))
})

test('Dashboard build refuses stale or incomplete Desktop publication', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kala-desktop-publication-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  verifyDesktopPublication(directory, '0.3.0')
  await writeFile(join(directory, 'install.sh'), 'stale installer')
  assert.throws(() => verifyDesktopPublication(directory, '0.3.0'), /without release metadata/)
  await rm(join(directory, 'install.sh'))
  await writeFile(join(directory, 'old.deb'), 'stale package')
  assert.throws(() => verifyDesktopPublication(directory, '0.3.0'), /without release metadata/)
  await rm(join(directory, 'old.deb'))
  await writeFile(join(directory, 'install.sh'), 'stale installer')
  await writeFile(join(directory, 'release.json'), JSON.stringify(release))
  assert.throws(() => verifyDesktopPublication(directory, `${release.version}-stale`), /does not match Dashboard/)
  for (const asset of [release.artifact, release.dependencies, release.checksums]) {
    await writeFile(join(directory, asset.file), await readFile(new URL(asset.file, base)))
  }
  assert.throws(() => verifyDesktopPublication(directory, release.version), /installer does not match/)
  await writeFile(join(directory, 'install.sh'), `${desktopBootstrapScript(release)}\n`)
  verifyDesktopPublication(directory, release.version)
  await writeFile(join(directory, release.artifact.file), 'tampered package')
  assert.throws(() => verifyDesktopPublication(directory, release.version), /asset mismatch/)
})

test('rejects missing, malformed, unsafe and mutable release metadata', () => {
  for (const invalid of [null, [], {}, { ...release, platform: 'windows' },
    { ...release, schemaVersion: 1 }, { ...release, version: "1.2.3';bad" },
    { ...release, artifact: { ...release.artifact, file: '../evil.deb' } },
    { ...release, artifact: { ...release.artifact, file: 'file with spaces.deb' } },
    { ...release, artifact: { ...release.artifact, file: "file';bad.deb" } },
    { ...release, artifact: { ...release.artifact, sha256: 'a' } },
    { ...release, artifact: { ...release.artifact, size: 0 } },
    { ...release, artifact: { ...release.artifact, size: 1.2 } },
    { ...release, dependencies: { ...release.dependencies, file: 'latest.dependencies.json' } },
    { ...release, checksums: { ...release.checksums, sha256: null } },
  ]) assert.throws(() => validateDesktopRelease(invalid), /invalid/)
})

test('shared loader fails closed on absent metadata, missing files, HTML fallback and network failure', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch')
  fetch.mock.mockImplementation(async () => new Response('', { status: 404 }))
  await assert.rejects(loadDesktopRelease, /No packaged desktop release/)
  fetch.mock.mockImplementation(async () => new Response('{"schemaVersion":2}', { status: 200 }))
  await assert.rejects(loadDesktopRelease, /metadata is invalid/)
  for (const response of [new Response('', { status: 404 }), new Response('', { headers: { 'content-type': 'Text/HTML' } })]) {
    fetch.mock.mockImplementation(async (url) => url.endsWith('/release.json') ? Response.json(release) : response)
    await assert.rejects(loadDesktopRelease, /files are incomplete/)
  }
  fetch.mock.mockImplementation(async () => { throw new Error('Network unavailable') })
  await assert.rejects(loadDesktopRelease, /Network unavailable/)
  fetch.mock.mockImplementation(async (url, options) => {
    assert(url.startsWith('/downloads/desktop/'))
    assert.equal(options.cache, 'no-store')
    if (url.endsWith('/release.json')) return Response.json(release)
    assert.equal(options.method, 'HEAD')
    return new Response(null, { headers: { 'content-type': 'application/octet-stream' } })
  })
  assert.equal((await loadDesktopRelease()).artifact.file, release.artifact.file)
})

test('one-command installation is offered only when all Runtime assets are served', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch')
  fetch.mock.mockImplementation(async (url, options) => {
    assert(url.startsWith('/install/assets/'))
    assert.equal(options.method, 'HEAD')
    return new Response(null, { status: 404 })
  })
  assert.equal(await desktopBootstrapAvailable(), false)
  fetch.mock.mockImplementation(async () => new Response(null, { headers: { 'content-type': 'text/html' } }))
  assert.equal(await desktopBootstrapAvailable(), false)
  fetch.mock.mockImplementation(async () => new Response(null, { headers: { 'content-type': 'application/octet-stream' } }))
  assert.equal(await desktopBootstrapAvailable(), true)
})

test('shared install command is one curl line backed by a checksum-verifying bootstrap script', () => {
  const command = desktopInstallCommands(release, 'https://runlab.example.org')
  assert(command.includes("curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location 'https://runlab.example.org/install/assets/desktop-install.sh' | bash -s -- 'https://runlab.example.org'"))
  assert(command.includes('Cloudflare Access must allow /install/assets/*'))
  assert(command.startsWith('bash -o pipefail -c '))
  assert(!command.includes('\n'))
  const script = desktopBootstrapScript(release)
  for (const item of [release.artifact, release.dependencies, release.checksums]) {
    assert(script.includes(`'${item.sha256}  ${item.file}'`))
  }
  for (const name of ['desktop-package.deb', 'desktop-dependencies.json', 'desktop-SHA256SUMS.txt']) {
    assert(script.includes(`$origin/install/assets/${name}`))
  }
  assert(script.includes(`sha256sum --strict --check '${release.checksums.file}'`))
  const verified = script.indexOf(`sha256sum --strict --check '${release.checksums.file}'`)
  const readable = script.indexOf(`chmod 644 -- "$tmp/${release.artifact.file}"`)
  const traversable = script.indexOf('chmod 755 -- "$tmp"')
  const installed = script.indexOf(`sudo apt install -y -- "$tmp/${release.artifact.file}"`)
  assert(verified < readable && readable < traversable && traversable < installed)
  assert(!script.includes('APT::Sandbox::User'))
  assert(!script.includes('--insecure'))
  assert(script.startsWith('# KALA_DESKTOP_INSTALLER_V1\n'))
  assert(!script.includes('trusted=yes'))
  assert(script.includes('mktemp -d /tmp/agent-runlab-install.XXXXXXXXXX'))
})

test('one-line installer reports blocked endpoints and unexpected HTML clearly', async (t) => {
  const directory = resolve('.artifacts', `desktop-command-errors-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const curl = resolve(directory, 'curl')
  const command = desktopInstallCommands(release, 'https://runlab.example.org')
  const run = () => spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
  })
  await writeFile(curl, '#!/bin/sh\necho "curl: (22) HTTP 403" >&2\nexit 22\n')
  await chmod(curl, 0o755)
  let result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HTTP 403/)
  assert.match(result.stderr, /Cloudflare Access must allow \/install\/assets\/\*/)
  const parentShell = spawnSync('bash', ['--noprofile', '--norc', '-c', `${command}\nstatus=$?\nprintf '__CALLER_SURVIVED__:%s\\n' "$status"\n`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
  })
  assert.equal(parentShell.status, 0)
  assert.match(parentShell.stdout, /__CALLER_SURVIVED__:22/)
  await writeFile(curl, '#!/bin/sh\nprintf "<!DOCTYPE html><title>Cloudflare Access</title>"\n')
  result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cloudflare Access must allow \/install\/assets\/\*/)
})

test('installation command accepts only canonical trusted HTTPS origins or explicit loopback HTTP', () => {
  for (const origin of ['https://runlab.example.org', 'https://runlab.example.org:8443', 'http://127.0.0.1:13000', 'http://localhost:13000', 'http://[::1]:13000']) {
    assert.equal(validateDesktopOrigin(origin), origin)
    assert(desktopInstallCommands(release, origin).includes(`${origin}/install/assets/desktop-install.sh`))
  }
  const credentialOrigin = `https://${'user'}:${'pass'}@runlab.example.org`
  for (const origin of [null, '', 'http://runlab.example.org', credentialOrigin, 'https://runlab.example.org/path',
    'https://runlab.example.org/', 'https://runlab.example.org?query', 'https://runlab.example.org#fragment',
    "https://runlab.example.org';touch bad", 'https://runlab.example.org\nbad', 'http://127.1:13000',
    'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost.example.invalid', 'https://runlab.example.org:99999']) {
    assert.throws(() => validateDesktopOrigin(origin))
  }
})

test('full copied Bash downloads and verifies all files, fails on tamper, and cleans only its owned directory', async (t) => {
  const directory = resolve('.artifacts', `desktop-command-test-${randomUUID()}`, 'working directory with spaces')
  const bin = resolve(directory, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(resolve(bin, 'package.json'), '{"type":"commonjs"}\n')
  t.after(() => rm(resolve(directory, '..'), { recursive: true, force: true }))
  const fixtures = resolve(directory, 'fixtures')
  await mkdir(fixtures)
  for (const tool of ['bash', 'rm', 'rmdir', 'sha256sum', 'mktemp', 'chmod', 'install']) {
    const target = process.env.PATH.split(':').map((path) => resolve(path, tool)).find((path) => existsSync(path))
    assert(target, `Missing test prerequisite ${tool}`)
    await symlink(target, resolve(bin, tool))
  }
  const publicAliases = [
    [release.artifact, 'desktop-package.deb'],
    [release.dependencies, 'desktop-dependencies.json'],
    [release.checksums, 'desktop-SHA256SUMS.txt'],
  ]
  for (const [item, alias] of publicAliases) {
    const bytes = await readFile(new URL(item.file, base))
    await writeFile(resolve(fixtures, item.file), bytes)
    await writeFile(resolve(fixtures, alias), bytes)
  }
  const executable = async (name, content) => {
    await writeFile(resolve(bin, name), content)
    await chmod(resolve(bin, name), 0o755)
  }
  await executable('dpkg', '#!/bin/sh\nprintf "%s\\n" "${TEST_ARCH:-amd64}"\n')
  await executable('sudo', `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'apt-get') {
  fs.appendFileSync(process.env.BOOTSTRAP_LOG, JSON.stringify(args) + '\\n')
  if (process.env.BOOTSTRAP_FAIL) process.exit(100)
  if (args[1] === 'install') {
    fs.copyFileSync(path.join(process.env.TEST_BIN, 'curl.fixture'), path.join(process.env.TEST_BIN, 'curl'))
    fs.chmodSync(path.join(process.env.TEST_BIN, 'curl'), 0o755)
  }
  process.exit(0)
}
const stdin = fs.readFileSync(0, 'utf8')
if (!args.includes('-y') && stdin.trim() !== 'y') process.exit(1)
if ((fs.statSync(args.at(-1)).mode & 0o777) !== 0o644) process.exit(2)
if ((fs.statSync(path.dirname(args.at(-1))).mode & 0o777) !== 0o755) process.exit(3)
fs.writeFileSync(process.env.INSTALL_LOG, JSON.stringify({ args, stdin }))
`)
  await executable('curl', `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2), url = new URL(args.at(-1))
if (args.includes('--insecure') || args.includes('--location') || url.origin !== 'https://runlab.example.org') process.exit(9)
const file = path.basename(url.pathname)
const directory = path.dirname(args[args.indexOf('--output') + 1])
fs.appendFileSync(process.env.DOWNLOAD_LOG, JSON.stringify({ directory, mode: fs.statSync(directory).mode & 0o777 }) + '\\n')
if (file === process.env.FAIL_FILE) process.exit(22)
const bytes = file === process.env.TAMPER_FILE ? Buffer.from('tampered') : fs.readFileSync(path.join(process.env.FIXTURES, file))
fs.writeFileSync(args[args.indexOf('--output') + 1], bytes)
`)
  const installLog = resolve(directory, 'installed.json')
  const bootstrapLog = resolve(directory, 'bootstrap.jsonl')
  const downloadLog = resolve(directory, 'downloads.jsonl')
  const run = (extra = {}, commands = desktopBootstrapScript(release)) => spawnSync(resolve(bin, 'bash'), [], {
    cwd: fixtures, input: `set -- 'https://runlab.example.org'\n${commands}`, encoding: 'utf8',
    env: { ...process.env, HOME: directory, TMPDIR: fixtures, PATH: bin, TEST_BIN: bin, FIXTURES: fixtures, INSTALL_LOG: installLog, BOOTSTRAP_LOG: bootstrapLog, DOWNLOAD_LOG: downloadLog, ...extra },
  })
  const assertTemporaryDownloadsCleaned = async () => {
    const downloads = (await readFile(downloadLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert(downloads.length > 0)
    for (const { directory: temporary, mode } of downloads) {
      assert.match(temporary, /^\/tmp\/agent-runlab-install\.[A-Za-z0-9]{10}$/)
      assert.equal(mode, 0o700)
      assert.equal(existsSync(temporary), false, `Temporary downloads remain in ${temporary}`)
    }
  }
  const sentinel = resolve(directory, 'keep-me')
  await writeFile(sentinel, 'untouched')
  const success = run()
  assert.equal(success.status, 0, success.stderr)
  const { args, stdin } = JSON.parse(await readFile(installLog, 'utf8'))
  assert.deepEqual(args.slice(0, 4), ['apt', 'install', '-y', '--'])
  assert.equal(stdin, '', 'Dependency confirmation must work even when heredoc input is exhausted')
  assert(args[4].startsWith('/tmp/agent-runlab-install.'))
  assert(args[4].endsWith(`/${release.artifact.file}`))
  await assertTemporaryDownloadsCleaned()
  await rm(installLog)
  for (const [, alias] of publicAliases) {
    for (const extra of [{ TAMPER_FILE: alias }, { FAIL_FILE: alias }]) {
      const failed = run(extra)
      assert.notEqual(failed.status, 0)
      await assert.rejects(readFile(installLog), { code: 'ENOENT' })
      await assertTemporaryDownloadsCleaned()
      assert(!(await readdir(directory)).some((name) => name.startsWith('.agent-runlab-install-')))
    }
  }
  assert.notEqual(run({ TEST_ARCH: 'arm64' }).status, 0)
  await rename(resolve(bin, 'curl'), resolve(bin, 'curl.fixture'))
  const bootstrapped = run()
  assert.equal(bootstrapped.status, 0, bootstrapped.stderr)
  assert.deepEqual((await readFile(bootstrapLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)), [
    ['apt-get', '-o', 'APT::Update::Error-Mode=any', 'update'],
    ['apt-get', 'install', '-y', 'ca-certificates', 'curl'],
  ])
  await rm(installLog)
  await rm(resolve(bin, 'curl'))
  assert.notEqual(run({ BOOTSTRAP_FAIL: '1' }).status, 0)
  await assert.rejects(readFile(installLog), { code: 'ENOENT' })
  assert(!(await readdir(directory)).some((name) => name.startsWith('.agent-runlab-install-')))
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched')
  await assertTemporaryDownloadsCleaned()

  const downloads = resolve(directory, 'Downloads')
  await mkdir(downloads, { mode: 0o700 })
  await chmod(directory, 0o700)
  const localFile = resolve(downloads, release.artifact.file)
  const originalBytes = await readFile(new URL(release.artifact.file, base))
  await writeFile(localFile, originalBytes, { mode: 0o600 })
  const localCommand = desktopLocalInstallCommands(release)
  assert(!localCommand.includes('curl'))
  assert(!localCommand.includes('APT::Sandbox::User'))
  const verifyLocal = async (extra = {}) => {
    const result = run(extra, localCommand)
    assert.equal(result.status, 0, result.stderr)
    const { args } = JSON.parse(await readFile(installLog, 'utf8'))
    assert(args.at(-1).startsWith('/tmp/agent-runlab-install.'))
    assert.equal(existsSync(args.at(-1)), false)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(downloads)).mode & 0o777, 0o700)
    await rm(installLog)
  }
  await verifyLocal()
  assert.equal((await stat(localFile)).mode & 0o777, 0o600)
  assert.deepEqual(await readFile(localFile), originalBytes)
  const renamed = resolve(downloads, release.artifact.file.replaceAll('~', '_'))
  await rename(localFile, renamed)
  await verifyLocal()
  const custom = resolve(downloads, 'package with spaces.deb')
  await rename(renamed, custom)
  await verifyLocal({ KALA_DESKTOP_PACKAGE: custom })
  await executable('xdg-user-dir', '#!/bin/sh\nprintf "%s\\n" "$TEST_DOWNLOADS"\n')
  await rename(custom, localFile)
  await verifyLocal({ TEST_DOWNLOADS: downloads })
  await writeFile(localFile, 'corrupt')
  assert.notEqual(run({ KALA_DESKTOP_PACKAGE: localFile }, localCommand).status, 0)
  await assert.rejects(readFile(installLog), { code: 'ENOENT' })
  const missing = run({ KALA_DESKTOP_PACKAGE: resolve(downloads, 'missing.deb') }, localCommand)
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /Downloaded package not found/)
})

test('APT uses existing approved URL/key validation and complete one-paste block', () => {
  const config = { schemaVersion: 1, url: 'https://packages.example.org/desktop', fingerprint: 'a'.repeat(40) }
  const command = aptInstallSnippet(config)
  assert(command.startsWith("bash <<'KALA_DESKTOP_INSTALL'\nset -euo pipefail"))
  assert(command.endsWith('\nKALA_DESKTOP_INSTALL'))
  assert(command.includes(config.fingerprint.toUpperCase()))
  assert(command.includes('Signed-By: /etc/apt/keyrings/kala-desktop.gpg'))
  for (const invalid of [null, {}, { ...config, url: 'http://packages.example.org' }, { ...config, fingerprint: 'bad' },
    { ...config, url: 'https://packages.example.org/../bad' }]) assert.throws(() => aptInstallSnippet(invalid))
})

test('standalone page uses the same loader and command generator', async (t) => {
  const elements = new Map()
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/release.json') ? Response.json(release) : new Response(null))
  const oldDocument = globalThis.document
  const oldLocation = globalThis.location
  globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id) } }
  globalThis.location = { origin: 'https://runlab.example.org' }
  try {
    await import('../public/downloads/desktop/install.js')
    assert.equal(elements.get('available').hidden, false)
    assert.equal(elements.get('deb').href, `/downloads/desktop/${release.artifact.file}`)
    assert.equal(elements.get('commands').textContent, desktopInstallCommands(release, globalThis.location.origin))
    assert.equal(elements.get('local-commands').textContent, desktopLocalInstallCommands(release))
  } finally {
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
    if (oldLocation === undefined) delete globalThis.location
    else globalThis.location = oldLocation
  }
})
