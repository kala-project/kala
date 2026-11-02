#!/usr/bin/env node
// A source-built product E2E fixture, NOT a signed release candidate. Real RC
// acceptance separately downloads and verifies the exact published assets.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { generateExecutorInstallerPowerShell } from '../release/executor-installer.mjs'
import { verifyWindowsNodePtyCompanion, WINDOWS_NODE_PTY_FILES } from '../release/windows-executor-packager.mjs'
import { verifyWindowsServiceHost, WINDOWS_SERVICE_HOST } from '../release/windows-service-host.mjs'

const hostDir = resolve(required('--host-release'))
const executorDir = resolve(required('--executor-release'))
if (hostDir === executorDir) throw new Error('Windows Host and companion build outputs must be separate')
const windowsAssets = ['node-pty-win32-x64.tar.gz', WINDOWS_SERVICE_HOST.asset, 'install-executor.ps1']
const checksumPath = join(hostDir, 'SHA256SUMS')
const lines = readFileSync(checksumPath, 'utf8').trimEnd().split(/\r?\n/u)
const names = new Set()
for (const line of lines) {
  const match = line.match(/^[0-9a-f]{64}  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u)
  if (!match || names.has(match[1]) || windowsAssets.includes(match[1])) throw new Error('Host build has an invalid or preexisting Windows checksum entry')
  names.add(match[1])
  const actual = createHash('sha256').update(readFileSync(join(hostDir, match[1]))).digest('hex')
  if (actual !== line.slice(0, 64)) throw new Error(`Host source-built asset checksum mismatch: ${match[1]}`)
}
if (!names.has('kala-dashboard-with-runtime.cjs') || !names.has('kala-executor.cjs')) throw new Error('Host and Executor CJS must already be in the local release checksum index')
if (createHash('sha256').update(readFileSync(join(hostDir, 'kala-executor.cjs'))).digest('hex')
  !== createHash('sha256').update(readFileSync(join(executorDir, 'kala-executor.cjs'))).digest('hex')) {
  throw new Error('Windows Executor CJS differs from the Host build')
}
verifyWindowsNodePtyCompanion(join(executorDir, 'node-pty-win32-x64.tar.gz'))
verifyWindowsServiceHost(join(executorDir, WINDOWS_SERVICE_HOST.asset))
for (const relative of WINDOWS_NODE_PTY_FILES) {
  const path = join(executorDir, ...relative.split('/'))
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size === 0) throw new Error(`Windows source-built fixture is missing ${relative}`)
}
for (const name of windowsAssets.slice(0, 2)) copyFileSync(join(executorDir, name), join(hostDir, name))
writeFileSync(join(hostDir, 'install-executor.ps1'), generateExecutorInstallerPowerShell({ repo: 'xingsy97/kala', tag: 'latest' }))
for (const name of windowsAssets) {
  const file = join(hostDir, name)
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  lines.push(`${digest}  ${basename(file)}`)
}
writeFileSync(checksumPath, lines.join('\n') + '\n')
process.stdout.write('Windows source-built Host/Executor integration fixture ready (local source-build checksums only; not signed release evidence)\n')

function required(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${flag}`)
  return process.argv[index + 1]
}
