import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('imports only fixed installation resources with protected input and never prints credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'kala-settings-import-'))
  roots.push(root)
  const input = join(root, 'input.json')
  const secret = 'fixture-provider-credential-not-for-output'
  writeFileSync(input, JSON.stringify({
    providers: [{ id: 'local', wire: 'openai', baseUrl: 'http://127.0.0.1:8137', apiKey: secret }],
    models: [{ providerId: 'local', id: 'model' }], defaultModel: 'local:model',
  }), { mode: 0o600 })
  const { KALA_STATE_MASTER_KEY_PATH: _key, KALA_DEPLOYMENT_CONFIG: _deployment, ...environment } = process.env
  const invoke = (...argv: string[]) => spawnSync(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('../../bin/kala-settings-file.ts', import.meta.url)), ...argv,
  ], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...environment, HOME: root, KALA_SESSIONS_DIR: join(root, 'state', 'sessions') },
    encoding: 'utf8',
  })
  const first = invoke('import', '--resource', 'models', '--input', input)
  expect(first.status, first.stderr).toBe(0)
  expect(first.stdout + first.stderr).not.toContain(secret)
  const result = JSON.parse(first.stdout)
  expect(result).toMatchObject({ resource: 'models', revision: '2', persisted: true, application: 'restart-required' })
  const target = join(root, '.config', 'kala', 'models.json')
  expect(JSON.parse(readFileSync(target, 'utf8')).providers[0].apiKey).toBe(secret)
  expect(JSON.parse(invoke('import', '--resource', 'models', '--input', input).stdout).revision).toBe('3')
  expect(invoke('import', '--resource', '../other', '--input', input).status).toBe(2)
  expect(invoke('import', '--resource', 'models', '--input', input, '--output', target).status).toBe(2)
  if (process.platform !== 'win32') {
    chmodSync(input, 0o644)
    const rejected = invoke('import', '--resource', 'models', '--input', input)
    expect(rejected.status).toBe(2)
    expect(rejected.stderr).toContain('settings_import_input_must_be_protected')
  }
})
