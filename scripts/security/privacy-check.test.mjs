import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

import { formatFindings, loadPrivacyPolicy, scanEntry } from './privacy-check-lib.mjs'

const root = resolve(import.meta.dirname, '../..')
const policy = loadPrivacyPolicy(root)

test('allows public examples and registered runtime assets', () => {
  assert.deepEqual(scan('docs/example.md', 'home=/home/example ip=192.0.2.10 email=user@example.com path=`/home/example`'), [])
  assert.deepEqual(scan('docs/example.md', 'systemctl status kala-dedicated-unit@blue.service'), [])
  assert.deepEqual(scan('deploy/aspire/Program.cs', 'http://gateway:13001'), [])
  assert.deepEqual(scan('deploy/private-cloud/compose.postgres-s3-base.yaml', 'http://runtime-ingress:13001'), [])
  assert.deepEqual(scan('packages/dashboard/public/favicon.svg', readFileSync(join(root, 'packages/dashboard/public/favicon.svg'))), [])
})

test('does not allow an entire real email domain for one historical dependency notice', () => {
  const domain = ['izs', 'me'].join('.')
  assert.equal(policy.allowedEmailDomains.has(domain), false)
  const findings = scan('docs/example.md', `contact@${domain}`)
  assert(findings.some(({ rule }) => rule === 'privacy.non-example-email'))
  assert.equal(formatFindings(findings).includes(domain), false)
  assert(policy.ruleExceptions.every((exception) => exception.path === 'pnpm-lock.yaml' && exception.rule === 'privacy.non-example-email'))
})

test('blocks structural private data without echoing matched values', () => {
  const home = ['/home', 'private-user'].join('/')
  const ip = [10, 23, 45, 67].join('.')
  const findings = scan('docs/example.md', `home=${home}\nip=${ip}`)
  assert.deepEqual(findings.map(({ rule }) => rule), ['privacy.private-ipv4', 'privacy.personal-home'])
  const output = formatFindings(findings)
  assert.equal(output.includes(home), false)
  assert.equal(output.includes(ip), false)
})

test('blocks public-release narrative and credential URLs without over-matching ordinary words', () => {
  assert(scan('docs/example.md', ['port', 'folio'].join('')).some(({ rule }) => rule === 'privacy.career-narrative'))
  assert.equal(scan('docs/example.md', 'generic numeric').some(({ rule }) => rule === 'privacy.career-narrative'), false)
  assert(scan('docs/example.md', 'https://' + 'user' + ':' + 'pass' + '@example.invalid').some(({ rule }) => rule === 'privacy.url-credentials'))
})

test('blocks unregistered images, binary files, and private denylist values', () => {
  assert(scan('docs/design/preview.png', Buffer.from([0, 1, 2])).some(({ rule }) => rule === 'privacy.design-image'))
  assert(scan('docs/assets/kala-dashboard-preview.gif', Buffer.from([0, 1, 2])).some(({ rule }) => rule === 'privacy.asset-content-drift'))
  assert(scan('fixtures/new.bin', Buffer.from([0, 1, 2])).some(({ rule }) => rule === 'privacy.unregistered-binary'))
  const marker = ['machine', 'only', 'marker'].join('-')
  assert(scan('docs/example.md', marker, [marker]).some(({ rule }) => rule === 'privacy.private-denylist'))
  const pathFinding = scanEntry({ path: `docs/${marker}/example.md`, content: `docs/${marker}/example.md`, policy, denylist: [marker], source: 'path' })
  assert(pathFinding.some(({ rule }) => rule === 'privacy.private-denylist'))
  assert.equal(formatFindings(pathFinding).includes(marker), false)
  const contentFinding = scanEntry({ path: `docs/${marker}/example.md`, content: [10, 2, 3, 4].join('.'), policy, denylist: [marker] })
  assert.equal(formatFindings(contentFinding).includes(marker), false)
  assert(scan('packages/dashboard/public/icons/icon-192.png', Buffer.from([0, 1, 2])).some(({ rule }) => rule === 'privacy.asset-content-drift'))
  const credential = ['sk-', 'test', 'A'.repeat(24)].join('')
  assert(scan('docs/example.md', credential).some(({ rule }) => rule === 'privacy.api-token'))
})

test('word-scoped private usernames are case insensitive without matching ordinary substrings', () => {
  const first = ['er', 'ic'].join('')
  const second = ['lucky', first].join('')
  const denylist = [`word:${first}`, `word:${second}`]
  assert.equal(scan('docs/example.md', 'generic numeric', denylist).length, 0)
  assert(scan('docs/example.md', `account=${first.toUpperCase()}`, denylist).some(({ rule }) => rule === 'privacy.private-denylist'))
  assert(scan('docs/example.md', `account=${second.toUpperCase()}`, denylist).some(({ rule }) => rule === 'privacy.private-denylist'))
  assert(scanEntry({ path: `docs/${second}/notes.md`, content: '', policy, denylist, source: 'path' }).some(({ rule }) => rule === 'privacy.private-denylist'))
})

test('historical approved assets reject unreviewed bytes and findings never disclose sensitive paths', () => {
  const asset = 'packages/dashboard/public/favicon.svg'
  assert(scanEntry({ path: asset, content: Buffer.from('altered'), policy, source: 'history-file' })
    .some(({ rule }) => rule === 'privacy.asset-content-drift'))
  const firstAssetCommit = spawnSync('git', ['log', '--reverse', '--format=%H', 'HEAD', '--', asset], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n')[0]
  const oldBytes = firstAssetCommit ? spawnSync('git', ['show', `${firstAssetCommit}:${asset}`], { cwd: root }).stdout : Buffer.alloc(0)
  if (oldBytes.length) {
    assert.equal(scanEntry({ path: asset, content: oldBytes, policy, source: 'history-file' }).length, 0)
    // A shallow CI checkout treats HEAD as the first asset commit; in that case
    // these bytes are current, not an earlier version that should be rejected.
    if (!oldBytes.equals(readFileSync(join(root, asset)))) {
      assert(scanEntry({ path: asset, content: oldBytes, policy, source: 'file' })
        .some(({ rule }) => rule === 'privacy.asset-content-drift'))
    }
  }
  const privateIp = [10, 23, 45, 67].join('.')
  const sensitive = `docs/${['private', 'user'].join('.')}@${['personal', 'example'].join('.')}/${privateIp}/secret.md`
  const findings = scanEntry({ path: sensitive, content: sensitive, policy, source: 'path' })
  assert(findings.length > 0)
  const output = formatFindings(findings)
  assert(!output.includes(privateIp))
  assert(!output.includes('private.user@personal.example'))
  assert(!output.includes('secret.md'))
})

test('hook installer configures a fresh clone, is idempotent, and preserves conflicting hooks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'privacy-installer-'))
  try {
    run(directory, 'git', ['init', '-q'])
    const installer = join(root, 'scripts/security/install-git-hooks.mjs')
    run(directory, 'node', [installer])
    run(directory, 'node', [installer])
    assert.equal(run(directory, 'git', ['config', '--local', '--get', 'core.hooksPath']).stdout.trim(), '.githooks')
    run(directory, 'git', ['config', '--local', 'core.hooksPath', 'custom-hooks'])
    const conflict = spawnSync('node', [installer], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(conflict.status, 0)
    assert.equal(run(directory, 'git', ['config', '--local', '--get', 'core.hooksPath']).stdout.trim(), 'custom-hooks')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('versioned hooks block a real commit and allow a public example commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'privacy-hook-'))
  try {
    run(directory, 'git', ['init', '-q'])
    run(directory, 'git', ['config', 'user.name', 'Example User'])
    run(directory, 'git', ['config', 'user.email', 'example@users.noreply.github.com'])
    run(directory, 'mkdir', ['-p', 'scripts/security', 'security', '.githooks'])
    for (const path of ['scripts/security/privacy-check.mjs', 'scripts/security/privacy-check-lib.mjs', 'security/privacy-policy.json', '.githooks/pre-commit', '.githooks/commit-msg', '.githooks/pre-push']) {
      const target = join(directory, path)
      run(directory, 'cp', [join(root, path), target])
    }
    run(directory, 'git', ['config', 'core.hooksPath', '.githooks'])
    const privateIp = [10, 77, 88, 99].join('.')
    writeFileSync(join(directory, 'sample.txt'), `endpoint=${privateIp}\n`)
    run(directory, 'git', ['add', 'sample.txt'])
    writeFileSync(join(directory, 'sample.txt'), 'endpoint=192.0.2.10\n')
    const blocked = spawnSync('git', ['commit', '-m', 'add sample'], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(blocked.status, 0)
    assert.equal(`${blocked.stdout}${blocked.stderr}`.includes(privateIp), false)
    run(directory, 'git', ['add', 'sample.txt'])
    const messageBlocked = spawnSync('git', ['commit', '-m', `connect ${privateIp}`], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(messageBlocked.status, 0)
    assert.equal(`${messageBlocked.stdout}${messageBlocked.stderr}`.includes(privateIp), false)
    run(directory, 'git', ['commit', '-q', '-m', 'add public example'])
    assert.equal(run(directory, 'git', ['rev-list', '--count', 'HEAD']).stdout.trim(), '1')

    const bare = `${directory}-remote.git`
    run(directory, 'git', ['init', '--bare', '-q', bare])
    run(directory, 'git', ['remote', 'add', 'origin', bare])
    run(directory, 'git', ['push', '-q', '-u', 'origin', 'HEAD:main'])
    writeFileSync(join(directory, 'sample.txt'), `endpoint=${privateIp}\n`)
    run(directory, 'git', ['add', 'sample.txt'])
    run(directory, 'git', ['commit', '--no-verify', '-q', '-m', 'bypassed local commit hook'])
    const pushBlocked = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(pushBlocked.status, 0)
    assert.equal(`${pushBlocked.stdout}${pushBlocked.stderr}`.includes(privateIp), false)
    rmSync(bare, { recursive: true, force: true })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function scan(path, content, denylist = []) {
  return scanEntry({ path, content, policy, denylist })
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`)
  return result
}
