#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertArenaKeeper } from '../../packages/executor/dist/src/arena-keeper.js'

const [configFile, workspace, journal, caFile, operatorFile] = process.argv.slice(2)
if (process.argv.length !== 7 || [configFile, workspace, journal, caFile, operatorFile].some((value) => !value || !isAbsolute(value))) {
  throw new Error('Usage: check-arena-executor-readiness.mjs <managed-executor-config> <original-workspace> <original-journal> <TLS-CA-file> <operator-URL-file>')
}
const configInfo = lstatSync(configFile)
if (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.uid !== process.getuid?.()
  || (configInfo.mode & 0o077)) throw new Error('Managed Executor config must be owner-only')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
if (config.version !== 1 || typeof config.host !== 'string'
  || !config.host.startsWith('https://') || typeof config.arenaKeeperIdentityFile !== 'string') {
  throw new Error('External Executor requires managed HTTPS config and opt-in independent Arena keeper')
}
await assertArenaKeeper(config.arenaKeeperIdentityFile)
const root = realpathSync(workspace)
if (root !== workspace || !lstatSync(root).isDirectory()
  || !realpathSync(journal).startsWith(`${root}/`)
  || !relative(root, realpathSync(journal)) || !lstatSync(journal).isFile()) {
  throw new Error('Original Executor workspace/journal mount is missing or not canonical')
}
for (const path of [operatorFile, caFile]) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o077) !== 0) throw new Error('TLS CA and operator secret files must be owner-only regular files')
}
const deploy = dirname(fileURLToPath(import.meta.url))
const docker = process.env.KALA_ARENA_ACCEPTANCE_DOCKER === 'sudo'
  ? ['sudo', '-n', 'docker'] : ['docker']
const compose = JSON.parse(execFileSync(docker[0], [...docker.slice(1), 'compose',
  '-f', join(deploy, 'compose.postgres-s3-base.yaml'),
  '-f', join(deploy, 'compose.storage-postgres-s3.yaml'),
  '-f', join(deploy, 'compose.storage-postgres-s3.parallel.yaml'),
  'config', '--no-interpolate', '--format', 'json'], { encoding: 'utf8' }))
if (!compose.services?.['runtime-schema-init']
  || Object.keys(compose.services).some((name) => /executor|arena-operator/u.test(name))
  || JSON.stringify(compose.services).includes('arena_operator_url')
  || compose.services['runtime-schema-init'].secrets?.some((secret) => secret.source !== 'runtime_postgres_owner_url')) {
  throw new Error('Old Compose cannot own external Executor/keeper/operator or change schema-init secrets')
}
console.log(JSON.stringify({
  oldComposeOwnsExecutor: false, oldComposeCanAutomaticallyEnrollExecutor: false,
  independentKeeper: true, originalWorkspaceMounted: true,
  tlsCaFilePresent: true, operatorFilePresent: true, readyForProduction: false,
  durableDispatchIntentRequiresCurrentSchema: true,
  requiredCombinedSchemaVersion: 25,
  privateArenaSchema12to18CannotAutoUpgrade: true,
  offlineProbeReconciliationAvailable: false,
  externalExecutorAcceptanceRequired: [
    'verify exact Board v12–v18 and Arena v19–v25 migration history before enabling prepared Arena dispatch; reject old private Arena v12–v18 histories',
    'prove the separately managed Executor uses this keeper in the original PID namespace',
    'prove the real Executor mounts the canonical workspace and its original durable journal',
    'prove the live Executor validates the Host TLS certificate against this CA',
    'prove the original organization-bound operator credential and tenant authorization separately',
  ],
  note: 'Read-only topology and metadata preflight only; the old Compose cannot enroll or manage the external Executor',
}))
