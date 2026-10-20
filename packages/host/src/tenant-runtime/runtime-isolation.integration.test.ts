import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
// Startup isolation only: these two existing file-backed Runtime processes do not
// share a Session store, route traffic, or exercise the PostgreSQL hot-state API.
const integrationDescribe = process.env.KALA_RUN_RUNTIME_ISOLATION === '1' ? describe : describe.skip
const nodeImage = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'

integrationDescribe('isolated current Private Cloud Runtime startup', () => {
  const project = `kala-runtime-smoke-${randomUUID()}`
  const containers = [`${project}-a`, `${project}-b`]
  const repository = resolve(import.meta.dirname, '../../../..')

  afterAll(async () => {
    await Promise.all(containers.map((name) => docker('rm', '--force', name).catch(() => undefined)))
  }, 30_000)

  it('starts two fresh Kala processes without any existing Runtime network or persistent data', async () => {
    for (const name of containers) {
      await docker('run', '--detach', '--name', name,
        '--label', `dev.kala.test.project=${project}`,
        '--network', 'none', '--read-only',
        '--tmpfs', '/state:rw,nosuid,size=128m', '--tmpfs', '/tmp:rw,nosuid,size=32m',
        '--mount', `type=bind,source=${repository},target=/app,readonly`,
        '--workdir', '/app/packages/host',
        '--env', 'KALA_DEPLOYMENT_CONFIG=/app/deploy/private-cloud/deployment.json',
        '--env', 'KALA_RUNTIME_HOST_DATA_ROOT=/state',
        '--env', 'KALA_RUNTIME_KALA_BIND_HOST=127.0.0.1',
        '--env', 'KALA_INGRESS_SHARED_SECRET=isolated-runtime-test-only-secret-32bytes',
        '--env', 'KALA_RUNTIME_HOST_LLM_API_KEY=isolated-test-placeholder',
        '--env', 'KALA_RUNTIME_HOST_LLM_MODEL=test-only-model',
        '--env', 'KALA_RUNTIME_HOST_LLM_BASE_URL=http://127.0.0.1:9/v1',
        nodeImage, 'node', '--import', 'tsx', 'bin/kala-runtime-service.ts')
      await eventually(async () => {
        const { stdout, stderr } = await docker('logs', name)
        if (stdout.includes('tenant_runtime_service_ready')) return
        const { stdout: running } = await docker('inspect', '--format', '{{.State.Running}}', name)
        if (running.trim() !== 'true') throw new Error(`${name} stopped: ${stdout}\n${stderr}`)
        throw new Error(`${name} not ready: ${stdout}\n${stderr}`)
      }, 20_000)
      const { stdout } = await docker('exec', name, 'node', '-e',
        "fetch('http://127.0.0.1:13002/internal/health').then(r => console.log(r.status)).catch(e => { console.error(e); process.exit(1) })")
      expect(Number(stdout.trim())).toBeGreaterThanOrEqual(200)
      expect(Number(stdout.trim())).toBeLessThan(500)
    }
  }, 90_000)
})

async function docker(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })
}

async function eventually(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await operation()
      return
    } catch (error) {
      if (error instanceof Error && error.message.includes(' stopped: ')) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError
}
