#!/usr/bin/env node
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { productVariant } from '@agent-kernel/shared'

import { loadProductDeploymentConfig } from '../src/deployment-config.js'
import { defaultAgentSettingsPath, importSettingsFile } from '../src/runtime-config.js'
import { KalaStateStore } from '../src/store/state-store.js'

export function runSettingsFileImport(argv: readonly string[], environment = process.env): { resource: string; revision: string; persisted: true; application: 'restart-required' } {
  if (argv[0] !== 'import' || argv.length !== 5) throw new Error('invalid_settings_import_arguments')
  const options = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!
    const value = argv[index + 1]!
    if (!['--resource', '--input'].includes(name) || options.has(name) || !value || value.startsWith('--')) throw new Error('invalid_settings_import_arguments')
    options.set(name, value)
  }
  const resource = options.get('--resource')
  if (resource !== 'models' && resource !== 'agent') throw new Error('invalid_settings_import_resource')
  const deployment = loadProductDeploymentConfig({ configPath: environment.KALA_DEPLOYMENT_CONFIG })
  if (productVariant(deployment) !== 'portable') throw new Error('settings_file_import_requires_portable')
  const inputPath = resolve(options.get('--input')!)
  const descriptor = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let input: unknown
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > 2 * 1024 * 1024 ||
      (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error('settings_import_input_must_be_protected')
    }
    input = JSON.parse(readFileSync(descriptor, 'utf8'))
  } finally { closeSync(descriptor) }
  const stateRoot = dirname(environment.KALA_SESSIONS_DIR ?? join(homedir(), '.kala', 'sessions'))
  const state = new KalaStateStore(stateRoot, {
    ...(environment.KALA_STATE_MASTER_KEY_PATH ? { keyPath: environment.KALA_STATE_MASTER_KEY_PATH } : {}),
  })
  try {
    const path = resource === 'models' ? join(homedir(), '.config', 'kala', 'models.json') : defaultAgentSettingsPath()
    const result = importSettingsFile(path, resource, input, state)
    return { resource, revision: result.revision, persisted: true, application: 'restart-required' }
  } finally { state.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(runSettingsFileImport(process.argv.slice(2)))}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const declared = /^(invalid_settings_import_(arguments|resource)|settings_file_import_requires_portable|settings_import_input_must_be_protected|settings_integrity_key_missing)$/u.test(message)
    process.stderr.write(`${declared ? message : 'settings_file_import_failed'}\n`)
    process.exitCode = declared ? 2 : 5
  }
}
