import { execFile } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createConfiguredSecretResolver, createSecretEnvironmentReader } from '@agent-kernel/shared/secret-resolver'
import { ExplicitLLMClientFactory } from './client-factory.js'
import { createRuntimeProviderRuntime } from './runtime-provider-catalog.js'

const exec = promisify(execFile)
const integration = process.env.KALA_RUN_OPENBAO_INTEGRATION === '1' ? describe : describe.skip
const image = 'quay.io/openbao/openbao@sha256:5046911075e137e154ce49ab051502f4ec7cf367d484ae4a4dce665d9b90561f' // 2.7.2
const docker = (...args: string[]) => exec('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' })

integration('external OpenBao JWT / provider catalog', () => {
  it('rotates credentials and workload identity, pins a live stream, and refuses revoked/missing/offline authority without dispatch', async () => {
    const name = `kala-openbao-test-${randomUUID()}`
    const root = `fixture-${randomUUID()}`
    const scratch = await mkdtemp(join(tmpdir(), 'kala-openbao-'))
    const jwtFile = join(scratch, 'jwt')
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwt = (subject: string) => {
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
      const body = Buffer.from(JSON.stringify({ sub: subject, aud: 'kala-test', jti: randomUUID(),
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')
      return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
    }
    const key1 = `fixture-provider-one-${randomUUID()}`
    const key2 = `fixture-provider-two-${randomUUID()}`
    const seen: Array<string | undefined> = []
    let releaseStream = () => {}
    const streamHold = new Promise<void>((resolve) => { releaseStream = resolve })
    let started = () => {}
    const streamStarted = new Promise<void>((resolve) => { started = resolve })
    // Deliberately a local protocol fixture, not a real model/SDK acceptance claim.
    const provider = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push(req.headers.authorization)
      if (input.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })}\n\n`)
        await streamHold
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'fixture', choices: [{ index: 0,
          message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }))
      }
    })
    try {
      await docker('run', '-d', '--rm', '--name', name, '--label', `dev.kala.test.project=${name}`,
        '--publish', '127.0.0.1::8200', '--env', `BAO_DEV_ROOT_TOKEN_ID=${root}`,
        '--memory', '256m', image, 'server', '-dev', '-dev-listen-address=0.0.0.0:8200')
      const { stdout } = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "8200/tcp") 0).HostPort}}', name)
      const origin = `http://127.0.0.1:${stdout.trim()}`
      const api = async (path: string, method = 'POST', body?: unknown) => {
        const response = await fetch(`${origin}/v1/${path}`, { method,
          headers: { 'X-Vault-Token': root, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3_000) })
        if (!response.ok) throw new Error(`OpenBao fixture setup failed: ${method} ${path} (${response.status})`)
        return response.status === 204 ? undefined : response.json()
      }
      let healthy = false
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await api('sys/health', 'GET'); healthy = true; break } catch { await new Promise((r) => setTimeout(r, 100)) }
      }
      if (!healthy) throw new Error('OpenBao fixture did not become ready')
      await api('sys/mounts/kala', 'POST', { type: 'kv', options: { version: '2' } })
      await api('sys/auth/workload', 'POST', { type: 'jwt' })
      await api('auth/workload/config', 'POST', { jwt_validation_pubkeys: [publicKey.export({ type: 'spki', format: 'pem' })] })
      await api('sys/policies/acl/provider-read', 'PUT', {
        policy: 'path "kala/data/providers/*" { capabilities = ["read"] }',
      })
      await api('auth/workload/role/runtime', 'POST', { role_type: 'jwt', user_claim: 'sub',
        bound_audiences: ['kala-test'], bound_subject: 'kala-runtime', token_policies: ['provider-read'],
        token_no_default_policy: true, token_ttl: 30, token_explicit_max_ttl: 60 })
      const put = (value: string) => api('kala/data/providers/openai', 'POST', { data: { apiKey: value } })
      await put(key1)
      await writeFile(jwtFile, jwt('kala-runtime'), { mode: 0o600 })
      const environment = { KALA_SECRET_RESOLVER: 'openbao-jwt', KALA_OPENBAO_ADDR: origin,
        KALA_OPENBAO_AUTH_MOUNT: 'workload', KALA_OPENBAO_KV_MOUNT: 'kala', KALA_OPENBAO_ROLE: 'runtime',
        KALA_OPENBAO_JWT_FILE: jwtFile, KALA_OPENBAO_ALLOW_LOOPBACK_HTTP: '1' }
      const secrets = createConfiguredSecretResolver(environment)!
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Provider fixture port missing')
      const { llm } = await createRuntimeProviderRuntime({ version: 1, defaultModel: 'test:model', providers: [{
        id: 'test', wire: 'openai', models: [{ id: 'model' }], credentialRef: 'bao:providers/openai#apiKey',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      }] }, new ExplicitLLMClientFactory(secrets))
      const call = () => llm.call({ messages: [], tools: [] })
      await call()
      const streaming = llm.call({ messages: [], tools: [], onTextDelta: started })
      await streamStarted
      await put(key2)
      await call()
      releaseStream()
      await streaming
      expect(seen).toEqual([`Bearer ${key1}`, `Bearer ${key1}`, `Bearer ${key2}`])

      // A changed but invalid projected identity may not reuse the previous login token.
      await writeFile(jwtFile, jwt('wrong-workload'))
      await expect(call()).rejects.toMatchObject({ reason: 'denied' })
      expect(seen).toHaveLength(3)
      await writeFile(`${jwtFile}.next`, jwt('kala-runtime'), { mode: 0o600 })
      await rename(`${jwtFile}.next`, jwtFile) // Same path, new projected inode/identity.
      await call()
      expect(seen).toHaveLength(4)
      // Revoke real issued tokens; the first denied read must not auto-login/replay a call.
      const accessors = (await api('auth/token/accessors', 'LIST')).data.keys as string[]
      let revoked = 0
      for (const accessor of accessors) {
        const token = (await api('auth/token/lookup-accessor', 'POST', { accessor })).data
        if (token.path === 'auth/workload/login') { await api('auth/token/revoke-accessor', 'POST', { accessor }); revoked++ }
      }
      expect(revoked).toBeGreaterThan(0)
      await expect(call()).rejects.toMatchObject({ reason: 'denied' })
      expect(seen).toHaveLength(4)
      await call() // A separate new call may acquire a new valid workload login.
      expect(seen).toHaveLength(5)
      await expect(secrets.resolve('bao:admin/unrelated#apiKey')).rejects.toMatchObject({ reason: 'denied' })
      await api('kala/data/providers/openai', 'DELETE')
      await expect(call()).rejects.toMatchObject({ reason: 'denied' })
      expect(seen).toHaveLength(5)
      await put(key2)
      const bootstrap = createSecretEnvironmentReader({ ...environment, BOOTSTRAP_REF: 'bao:providers/openai#apiKey' })
      expect(await bootstrap('BOOTSTRAP')).toBe(key2)
      await call()
      expect(seen).toHaveLength(6)
      await rm(jwtFile)
      await expect(call()).rejects.toMatchObject({ reason: 'unavailable' })
      expect(seen).toHaveLength(6)
      await writeFile(jwtFile, jwt('kala-runtime'), { mode: 0o600 })
      await call()
      expect(seen).toHaveLength(7)
      await docker('stop', '--time', '1', name) // Fail KV reads even with a cached valid login.
      const error = await call().catch((e: unknown) => e)
      expect(error).toMatchObject({ reason: 'unavailable' })
      expect(String(error)).not.toContain(key2)
      expect(String(error)).not.toContain(root)
      expect(seen).toHaveLength(7)
    } finally {
      releaseStream()
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await docker('rm', '--force', name).catch(() => undefined)
      await rm(scratch, { recursive: true, force: true })
    }
  }, 120_000)
})
