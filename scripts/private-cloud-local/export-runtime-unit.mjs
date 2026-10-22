#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { composeArgs, root, selectedProfile } from './profile.mjs'

if (selectedProfile() === 'postgres-s3') throw new Error('PG/S3 Runtime Units cannot be exported from the local tenant-data volume')
const unitId = process.argv[2]
if (!unitId || !/^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/u.test(unitId)) {
  throw new Error('usage: export-runtime-unit.mjs UNIT_ID [PERSISTENT_OUTPUT_DIR]')
}
const outputRoot = resolve(process.argv[3] ?? process.env.KALA_BACKUP_DIR ?? resolve(root, 'deploy/private-cloud/backups'))
if (outputRoot === '/tmp' || outputRoot.startsWith('/tmp/')) throw new Error('Runtime Unit exports must use persistent storage; /tmp is forbidden')
const out = resolve(outputRoot, `unit-${unitId}-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
await mkdir(out, { recursive: true, mode: 0o700 })

const profile = selectedProfile()
const volume = composeVolume(profile, 'tenant-data')
const archive = resolve(out, 'runtime-unit.tar')
const handle = await open(archive, 'w', 0o600)
try {
  await run('docker', [
    'run', '--rm', '--network', 'none',
    '-v', `${volume}:/source:ro`,
    'alpine:3.22.2',
    'tar', '-C', '/source/tenant-runtime-units', '-cf', '-', unitId,
  ], handle.fd)
} finally {
  await handle.close()
}
const manifest = {
  schemaVersion: 1,
  kind: 'kala-runtime-unit-export',
  unitId,
  profile,
  createdAt: new Date().toISOString(),
  gitSha: capture('git', ['rev-parse', 'HEAD']).trim(),
  archive: {
    name: 'runtime-unit.tar',
    bytes: (await stat(archive)).size,
    sha256: await hashFile(archive),
  },
  encryption: { requiredForOffHost: true, applied: false },
}
await writeFile(resolve(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`Runtime Unit export written to ${out}\n`)

function composeVolume(selected, logical) {
  const config = JSON.parse(capture('docker', ['compose', ...composeArgs(selected), 'config', '--format', 'json']))
  if (typeof config.name !== 'string' || !config.name) throw new Error('Compose project name is missing')
  return `${config.name}_${logical}`
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${String(result.status)}`)
  return result.stdout
}

function run(command, args, stdoutFd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', stdoutFd, 'inherit'] })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${String(code)}`)))
  })
}

async function hashFile(path) {
  const digest = createHash('sha256')
  await new Promise((resolveHash, reject) => createReadStream(path).on('data', (chunk) => digest.update(chunk)).on('end', resolveHash).on('error', reject))
  return digest.digest('hex')
}
