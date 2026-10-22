#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { composeArgs, root, selectedProfile } from './profile.mjs'

if (selectedProfile() === 'postgres-s3') throw new Error('Local-volume Runtime Unit exports cannot be restored into PG/S3 Runtime authority')
const input = resolve(process.argv[2] ?? '')
if (!process.argv[2] || input === '/tmp' || input.startsWith('/tmp/')) {
  throw new Error('usage: restore-runtime-unit.mjs PERSISTENT_EXPORT_DIR')
}
const manifest = JSON.parse(await readFile(resolve(input, 'manifest.json'), 'utf8'))
if (manifest.kind !== 'kala-runtime-unit-export' || manifest.schemaVersion !== 1) throw new Error('unsupported Runtime Unit export')
if (!/^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/u.test(manifest.unitId)) throw new Error('invalid Runtime Unit id in export')
if (manifest.archive?.name !== 'runtime-unit.tar'
  || !Number.isSafeInteger(manifest.archive.bytes)
  || manifest.archive.bytes < 1
  || !/^[a-f0-9]{64}$/u.test(manifest.archive.sha256)) {
  throw new Error('invalid Runtime Unit archive manifest')
}
const archive = resolve(input, manifest.archive.name)
if ((await stat(archive)).size !== manifest.archive.bytes || await hashFile(archive) !== manifest.archive.sha256) {
  throw new Error('Runtime Unit export failed integrity verification')
}
const archiveEntries = capture('docker', [
  'run', '--rm', '--network', 'none', '-v', `${archive}:/backup/runtime-unit.tar:ro`,
  'alpine:3.22.2', 'tar', '-tf', '/backup/runtime-unit.tar',
]).split(/\r?\n/u).filter(Boolean)
if (archiveEntries.length === 0 || archiveEntries.some((entry) =>
  entry.startsWith('/') || entry.split('/').includes('..') || (entry !== manifest.unitId && !entry.startsWith(`${manifest.unitId}/`)))) {
  throw new Error('Runtime Unit archive contains an unsafe or mismatched path')
}
const verboseEntries = capture('docker', [
  'run', '--rm', '--network', 'none', '-v', `${archive}:/backup/runtime-unit.tar:ro`,
  'alpine:3.22.2', 'tar', '-tvf', '/backup/runtime-unit.tar',
]).split(/\r?\n/u).filter(Boolean)
if (verboseEntries.length !== archiveEntries.length || verboseEntries.some((entry) => !['-', 'd'].includes(entry[0]))) {
  throw new Error('Runtime Unit archive contains unsupported links or special files')
}

const profile = selectedProfile()
const running = capture('docker', ['compose', ...composeArgs(profile), 'ps', '--status', 'running', '--services'])
if (running.split(/\r?\n/u).includes('runtime-host')) {
  throw new Error('runtime-host must be stopped before restoring a Runtime Unit')
}
const volume = composeVolume(profile, 'tenant-data')
const exists = spawnSync('docker', [
  'run', '--rm', '--network', 'none', '-v', `${volume}:/target`,
  'alpine:3.22.2', 'test', '-e', `/target/tenant-runtime-units/${manifest.unitId}`,
], { cwd: root, env: process.env })
if (exists.status === 0) throw new Error(`Runtime Unit ${manifest.unitId} already exists; restore refuses to overwrite live data`)
run('docker', [
  'run', '--rm', '--network', 'none',
  '-v', `${volume}:/target`,
  '-v', `${archive}:/backup/runtime-unit.tar:ro`,
  'alpine:3.22.2', 'sh', '-ceu',
  'mkdir -p /target/tenant-runtime-units && tar -xf /backup/runtime-unit.tar -C /target/tenant-runtime-units',
])
process.stdout.write(`${JSON.stringify({ event: 'runtime_unit_restored', unitId: manifest.unitId, profile, volume })}\n`)

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

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`)
}

async function hashFile(path) {
  const digest = createHash('sha256')
  await new Promise((resolveHash, reject) => createReadStream(path).on('data', (chunk) => digest.update(chunk)).on('end', resolveHash).on('error', reject))
  return digest.digest('hex')
}
