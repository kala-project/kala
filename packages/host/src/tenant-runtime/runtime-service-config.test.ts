import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const runtimeService = join(import.meta.dirname, '..', '..', 'bin', 'kala-runtime-service.ts')
const tsx = join(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'tsx')

function runWithExperimentalEnv(values: Record<string, string>) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('KALA_RUNTIME_EXPERIMENTAL_') && !['KALA_RUNTIME_NODE_ID', 'KALA_RUNTIME_NODE_ORIGIN'].includes(name)))
  return spawnSync(tsx, [runtimeService], {
    cwd: import.meta.dirname,
    env: { ...env, ...values },
    encoding: 'utf8',
    timeout: 10_000,
  })
}

describe('kala-runtime-service experimental Docker storage configuration', () => {
  it('rejects DB/S3 settings unless the experimental opt-in is explicit', () => {
    const result = runWithExperimentalEnv({
      KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://unused',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE=1 is required')
  })

  it('fails closed when any required DB/S3 setting is missing', () => {
    const result = runWithExperimentalEnv({
      KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE: '1',
      KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://unused',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT is required')
  })

  it('refuses Session ownership without the operator-migrated schema before connecting to PG', () => {
    const result = runWithExperimentalEnv({
      ...completeStorageEnv(),
      KALA_RUNTIME_NODE_ID: 'runtime-a',
      KALA_RUNTIME_NODE_ORIGIN: 'https://runtime.example',
      KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP: '1',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Session ownership requires experimental storage with an operator-migrated PostgreSQL schema')
  })

  it('rejects malformed Session ownership opt-in instead of silently disabling it', () => {
    const result = runWithExperimentalEnv({ KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP: 'true' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP must be 1')
  })

  it('requires explicit placement node identity in experimental mode', () => {
    const result = runWithExperimentalEnv(completeStorageEnv())
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('KALA_RUNTIME_NODE_ID is required')
  })

  it('fails closed without an external state master key file', () => {
    const values = completeStorageEnv()
    delete values.KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE
    const result = runWithExperimentalEnv({
      ...values,
      KALA_RUNTIME_NODE_ID: 'runtime-a',
      KALA_RUNTIME_NODE_ORIGIN: 'https://runtime.example',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE is required')
  })

  it('rejects a node origin that is not an exact HTTP(S) origin before opening PostgreSQL', () => {
    const result = runWithExperimentalEnv({
      ...completeStorageEnv(),
      KALA_RUNTIME_NODE_ID: 'runtime-a',
      KALA_RUNTIME_NODE_ORIGIN: 'https://runtime.example/path',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('KALA_RUNTIME_NODE_ORIGIN must be an exact HTTP(S) origin')
  })
})

function completeStorageEnv(): Record<string, string> {
  return {
    KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE: '1',
    KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING: 'postgres://unused',
    KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT: 'http://localhost:9000',
    KALA_RUNTIME_EXPERIMENTAL_S3_REGION: 'us-east-1',
    KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET: 'test',
    KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID: 'access',
    KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY: 'secret',
    KALA_RUNTIME_EXPERIMENTAL_S3_MAX_OBJECT_BYTES: '1024',
    KALA_RUNTIME_EXPERIMENTAL_S3_FORCE_PATH_STYLE: 'true',
    KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE: '/does/not/exist/test-state-master-key',
  }
}
