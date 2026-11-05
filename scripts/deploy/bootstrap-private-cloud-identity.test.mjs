import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapPrivateCloudIdentity, parseCliArgs } from './bootstrap-private-cloud-identity.mjs'

const IMAGE = `alpine@sha256:${'a'.repeat(64)}`
const PAT = 'test-bootstrap-pat-never-log'
const CLIENT_SECRET = 'test-client-secret-never-log'

test('native Operator runs bundled identity enrollment in-process without a host Node executable', async () => {
  const source = await readFile(join(import.meta.dirname, 'kala-private-cloud.mjs'), 'utf8')
  assert.match(source, /import \{ bootstrapPrivateCloudIdentity \} from '\.\/bootstrap-private-cloud-identity\.mjs'/u)
  assert.match(source, /await bootstrapPrivateCloudIdentity\(\{ configDir, bootstrapVolume: volume, identityImage: image \}\)/u)
  assert.doesNotMatch(source, /captureSync\(process\.execPath, \[join\(release\.dir, 'bootstrap-private-cloud-identity\.mjs'/u)
})

async function fixture(t, environment = {}) {
  const configDir = await mkdtemp(join(tmpdir(), 'kala-identity-bootstrap-'))
  const secretsDir = join(configDir, 'secrets')
  await mkdir(secretsDir, { mode: 0o700 })
  await writeProtected(join(configDir, 'deployment.env'), [
    `KALA_PUBLIC_URLS=${environment.appOrigin ?? 'http://localhost:13001'}`,
    `KALA_PUBLIC_LISTEN=127.0.0.1:${environment.appPort ?? '13001'}`,
    'OIDC_ISSUER=https://<identity-domain>',
    'OIDC_DISCOVERY_ORIGIN=https://<identity-domain>',
    ...(environment.identityPort ? [`KALA_IDENTITY_PORT=${environment.identityPort}`] : []),
    `OIDC_ISSUER=${environment.identityOrigin ?? 'http://localhost:13002'}`,
    'OIDC_DISCOVERY_ORIGIN=http://identity-proxy:8080',
    '',
  ].join('\n'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  return {
    configDir,
    secretsDir,
    options: { configDir, bootstrapVolume: 'dynamic_project_identity-zitadel-bootstrap', identityImage: IMAGE },
  }
}

async function writeProtected(path, contents) {
  await writeFile(path, contents, { mode: 0o600 })
}

function okJson(value) {
  return { ok: true, status: 200, json: async () => value }
}

test('registers the fixed localhost OIDC client and atomically saves protected enrollment state', async (t) => {
  const { options, secretsDir } = await fixture(t)
  await writeProtected(join(secretsDir, 'oidc_client_id'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_ID\n')
  await writeProtected(join(secretsDir, 'oidc_client_secret'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_SECRET\n')
  const dockerCalls = []
  const apiCalls = []

  const result = await bootstrapPrivateCloudIdentity(options, {
    randomUUID: () => 'attempt-1',
    runDocker: async (args) => { dockerCalls.push(args); return `${PAT}\n` },
    fetch: async (url, request) => {
      apiCalls.push({ url, request, body: JSON.parse(request.body) })
      return apiCalls.length === 1
        ? okJson({ id: 'project-1' })
        : okJson({ appId: 'application-1', clientId: 'client-1', clientSecret: CLIENT_SECRET })
    },
  })

  assert.deepEqual(result, { ok: true, reused: false, projectId: 'project-1', applicationId: 'application-1' })
  assert.deepEqual(dockerCalls, [
    [
      'run', '--rm', '--network', 'none',
      '-v', 'dynamic_project_identity-zitadel-bootstrap:/bootstrap:ro',
      IMAGE, 'cat', '/bootstrap/bootstrap.pat',
    ],
    [
      'run', '--rm', '--network', 'none',
      '-v', 'dynamic_project_identity-zitadel-bootstrap:/bootstrap',
      IMAGE, 'rm', '-f', '/bootstrap/bootstrap.pat',
    ],
  ])
  assert.equal(apiCalls[0].url, 'http://127.0.0.1:13002/management/v1/projects')
  assert.deepEqual(apiCalls[0].body, {
    name: 'Kala Private Cloud', projectRoleAssertion: false, projectRoleCheck: false, hasProjectCheck: false,
  })
  assert.equal(apiCalls[1].url, 'http://127.0.0.1:13002/management/v1/projects/project-1/apps/oidc')
  assert.deepEqual(apiCalls[1].body.redirectUris, ['http://localhost:13001/auth/callback'])
  assert.deepEqual(apiCalls[1].body.postLogoutRedirectUris, ['http://localhost:13001/'])
  assert.equal(apiCalls[1].body.devMode, true)
  for (const call of apiCalls) {
    assert.equal(call.request.headers.authorization, `Bearer ${PAT}`)
    assert.equal(call.request.headers['x-zitadel-instance-host'], 'localhost:13002')
    assert.equal(call.request.headers['x-zitadel-public-host'], 'localhost:13002')
  }

  assert.equal(await readFile(join(secretsDir, 'oidc_client_id'), 'utf8'), 'client-1\n')
  assert.equal(await readFile(join(secretsDir, 'oidc_client_secret'), 'utf8'), `${CLIENT_SECRET}\n`)
  const metadata = JSON.parse(await readFile(join(secretsDir, 'identity-zitadel-enrollment.json'), 'utf8'))
  assert.deepEqual({ ...metadata, clientSecretSha256: '<hash>' }, {
    schemaVersion: 1,
    status: 'enrolled',
    issuer: 'http://localhost:13002',
    redirectUri: 'http://localhost:13001/auth/callback',
    projectId: 'project-1',
    applicationId: 'application-1',
    clientId: 'client-1',
    clientSecretSha256: '<hash>',
  })
  assert.notEqual(metadata.clientSecretSha256, CLIENT_SECRET)
  for (const name of ['oidc_client_id', 'oidc_client_secret', 'identity-zitadel-enrollment.json']) {
    assert.equal((await stat(join(secretsDir, name))).mode & 0o777, 0o600)
  }
})

test('enrolls a separate HTTPS issuer through loopback-only bootstrap without changing bundled behavior', async (t) => {
  const { configDir, secretsDir, options } = await fixture(t)
  await writeProtected(join(configDir, 'deployment.env'), [
    'KALA_PUBLIC_URLS=http://localhost:13001',
    'KALA_PUBLIC_LISTEN=127.0.0.1:13001',
    'KALA_IDENTITY_MODE=external',
    'KALA_IDENTITY_PORT=13002',
    'OIDC_ISSUER=https://localhost:13002',
    'OIDC_DISCOVERY_ORIGIN=https://192.0.2.1:13002',
  ].join('\n') + '\n')
  await writeProtected(join(secretsDir, 'oidc_client_id'), 'REPLACE_WITH_EXTERNAL_OIDC_CLIENT_ID\n')
  await writeProtected(join(secretsDir, 'oidc_client_secret'), 'REPLACE_WITH_EXTERNAL_OIDC_CLIENT_SECRET\n')
  const apiCalls = []
  await bootstrapPrivateCloudIdentity({ ...options, externalRequestPort: '13003' }, {
    runDocker: async () => 'bootstrap-pat\n',
    fetch: async (url, request) => {
      apiCalls.push({ url, body: JSON.parse(request.body) })
      return okJson(apiCalls.length === 1 ? { id: 'project-1' } : { appId: 'app-1', clientId: 'client-1', clientSecret: CLIENT_SECRET })
    },
  })
  assert.ok(apiCalls.every((call) => call.url.startsWith('http://127.0.0.1:13003/')))
  assert.equal(JSON.parse(await readFile(join(secretsDir, 'identity-zitadel-enrollment.json'), 'utf8')).issuer, 'https://localhost:13002')
  await assert.rejects(bootstrapPrivateCloudIdentity({ ...options, externalRequestPort: '13002' }), /distinct localhost TCP port/u)
})

test('creates two verified acceptance users before OIDC enrollment and returns their exact distinct subjects without passwords', async (t) => {
  const { options, secretsDir, configDir } = await fixture(t)
  await writeProtected(join(secretsDir, 'oidc_client_id'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_ID\n')
  await writeProtected(join(secretsDir, 'oidc_client_secret'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_SECRET\n')
  const usersFile = join(configDir, 'acceptance-users.json')
  const users = [
    { name: 'alice', email: 'alice@example.test', password: 'Alice-password-1!' },
    { name: 'bob', email: 'bob@example.test', password: 'Bob-password-2!!' },
  ]
  await writeProtected(usersFile, JSON.stringify({ users }))
  const calls = []
  const responses = [
    { userId: 'alice-subject' }, { userId: 'bob-subject' }, { id: 'project-users' },
    { appId: 'application-users', clientId: 'client-users', clientSecret: CLIENT_SECRET },
  ]

  const result = await bootstrapPrivateCloudIdentity({ ...options, acceptanceUsersFile: usersFile }, {
    runDocker: async (args) => args.includes('cat') ? PAT : '',
    fetch: async (url, request) => { calls.push({ url, body: JSON.parse(request.body) }); return okJson(responses.shift()) },
  })

  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:13002/management/v1/users/human',
    'http://127.0.0.1:13002/management/v1/users/human',
    'http://127.0.0.1:13002/management/v1/projects',
    'http://127.0.0.1:13002/management/v1/projects/project-users/apps/oidc',
  ])
  assert.deepEqual(calls.slice(0, 2).map((call) => ({
    userName: call.body.userName,
    verified: call.body.email.isEmailVerified,
    initialPassword: call.body.initialPassword,
    hasUnsupportedPasswordField: Object.hasOwn(call.body, 'password'),
  })), [
    { userName: users[0].email, verified: true, initialPassword: users[0].password, hasUnsupportedPasswordField: false },
    { userName: users[1].email, verified: true, initialPassword: users[1].password, hasUnsupportedPasswordField: false },
  ])
  assert.deepEqual(result.acceptanceUsers, [
    { name: 'alice', email: users[0].email, subject: 'alice-subject' },
    { name: 'bob', email: users[1].email, subject: 'bob-subject' },
  ])
  assert.doesNotMatch(JSON.stringify(result), /Alice-password|Bob-password/u)
})

test('reuses only credentials whose protected enrollment metadata is consistent', async (t) => {
  const { options, secretsDir } = await fixture(t)
  let dockerCount = 0
  let fetchCount = 0
  const dependencies = {
    runDocker: async () => { dockerCount += 1; return PAT },
    fetch: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? okJson({ id: 'project-2' })
        : okJson({ appId: 'application-2', clientId: 'client-2', clientSecret: CLIENT_SECRET })
    },
  }
  await bootstrapPrivateCloudIdentity(options, dependencies)
  const firstDockerCount = dockerCount
  const firstFetchCount = fetchCount

  const reused = await bootstrapPrivateCloudIdentity(options, {
    runDocker: async (args) => {
      assert.deepEqual(args.slice(-3), ['rm', '-f', '/bootstrap/bootstrap.pat'])
      return ''
    },
    fetch: async () => { throw new Error('fetch must not run during reuse') },
  })
  assert.deepEqual(reused, { ok: true, reused: true, projectId: 'project-2', applicationId: 'application-2' })
  assert.equal(firstDockerCount, 2)
  assert.equal(firstFetchCount, 2)
})

test('keeps the bootstrap PAT until enrollment succeeds and retries only PAT removal', async (t) => {
  const { options, secretsDir } = await fixture(t)
  await writeProtected(join(secretsDir, 'oidc_client_id'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_ID\n')
  await writeProtected(join(secretsDir, 'oidc_client_secret'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_SECRET\n')
  const dockerCalls = []
  let fetchCount = 0

  await assert.rejects(bootstrapPrivateCloudIdentity(options, {
    runDocker: async (args) => {
      dockerCalls.push(args)
      if (args.includes('cat')) return PAT
      throw new Error(`cleanup failed without exposing ${PAT}`)
    },
    fetch: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? okJson({ id: 'project-cleanup' })
        : okJson({ appId: 'application-cleanup', clientId: 'client-cleanup', clientSecret: CLIENT_SECRET })
    },
  }), /not safe to retry automatically.*bootstrap PAT removal/u)

  assert.equal(dockerCalls.length, 2)
  assert.match(dockerCalls[0].join(' '), /bootstrap:ro.*cat \/bootstrap\/bootstrap\.pat/u)
  assert.match(dockerCalls[1].join(' '), /bootstrap.*rm -f \/bootstrap\/bootstrap\.pat/u)
  assert.equal(fetchCount, 2)

  const reused = await bootstrapPrivateCloudIdentity(options, {
    runDocker: async (args) => {
      assert.deepEqual(args.slice(-3), ['rm', '-f', '/bootstrap/bootstrap.pat'])
      return ''
    },
    fetch: async () => { throw new Error('enrollment API must not be called while retrying PAT removal') },
  })
  assert.deepEqual(reused, { ok: true, reused: true, projectId: 'project-cleanup', applicationId: 'application-cleanup' })
})

test('refuses populated restored credentials without matching enrollment metadata', async (t) => {
  const { options, secretsDir } = await fixture(t)
  await writeProtected(join(secretsDir, 'oidc_client_id'), 'restored-client\n')
  await writeProtected(join(secretsDir, 'oidc_client_secret'), 'restored-secret\n')
  let externalCalls = 0

  await assert.rejects(
    bootstrapPrivateCloudIdentity(options, {
      runDocker: async () => { externalCalls += 1; return PAT },
      fetch: async () => { externalCalls += 1; return okJson({}) },
    }),
    /not safe to retry automatically.*metadata is missing.*three enrollment files together/u,
  )
  assert.equal(externalCalls, 0)
})

test('records a project-only partial registration and reports recovery without secrets', async (t) => {
  const { options, secretsDir } = await fixture(t)
  await writeProtected(join(secretsDir, 'oidc_client_id'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_ID\n')
  await writeProtected(join(secretsDir, 'oidc_client_secret'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_SECRET\n')
  let apiCall = 0
  let failure
  try {
    await bootstrapPrivateCloudIdentity(options, {
      randomUUID: () => 'attempt-partial',
      runDocker: async () => PAT,
      fetch: async () => {
        apiCall += 1
        if (apiCall === 1) return okJson({ id: 'partial-project' })
        return {
          ok: false,
          status: 503,
          json: async () => ({ message: `do not expose ${PAT} or ${CLIENT_SECRET}` }),
        }
      },
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /not safe to retry automatically.*OIDC application creation.*HTTP 503.*reconcile/u)
  assert.doesNotMatch(failure.message, new RegExp(`${PAT}|${CLIENT_SECRET}`, 'u'))
  const metadata = JSON.parse(await readFile(join(secretsDir, 'identity-zitadel-enrollment.json'), 'utf8'))
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    status: 'registering',
    attemptId: 'attempt-partial',
    issuer: 'http://localhost:13002',
    redirectUri: 'http://localhost:13001/auth/callback',
    projectId: 'partial-project',
  })
  assert.equal(await readFile(join(secretsDir, 'oidc_client_id'), 'utf8'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_ID\n')
  assert.equal(await readFile(join(secretsDir, 'oidc_client_secret'), 'utf8'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_SECRET\n')

  await assert.rejects(
    bootstrapPrivateCloudIdentity(options, { runDocker: async () => PAT, fetch: async () => okJson({}) }),
    /metadata exists.*not populated/u,
  )
})

test('uses changed deployment ports for loopback requests, OIDC redirects, headers, and metadata', async (t) => {
  const { options, secretsDir } = await fixture(t, {
    appOrigin: 'http://localhost:14101',
    appPort: '14101',
    identityPort: '14102',
    identityOrigin: 'http://localhost:14102',
  })
  await writeProtected(join(secretsDir, 'oidc_client_id'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_ID\n')
  await writeProtected(join(secretsDir, 'oidc_client_secret'), 'REPLACE_WITH_LOCAL_OIDC_CLIENT_SECRET\n')
  const apiCalls = []

  await bootstrapPrivateCloudIdentity(options, {
    runDocker: async (args) => args.includes('cat') ? PAT : '',
    fetch: async (url, request) => {
      apiCalls.push({ url, request, body: JSON.parse(request.body) })
      return apiCalls.length === 1
        ? okJson({ id: 'custom-project' })
        : okJson({ appId: 'custom-application', clientId: 'custom-client', clientSecret: CLIENT_SECRET })
    },
  })

  assert.equal(apiCalls[0].url, 'http://127.0.0.1:14102/management/v1/projects')
  assert.equal(apiCalls[1].url, 'http://127.0.0.1:14102/management/v1/projects/custom-project/apps/oidc')
  assert.deepEqual(apiCalls[1].body.redirectUris, ['http://localhost:14101/auth/callback'])
  assert.deepEqual(apiCalls[1].body.postLogoutRedirectUris, ['http://localhost:14101/'])
  for (const call of apiCalls) {
    assert.equal(call.request.headers['x-zitadel-instance-host'], 'localhost:14102')
    assert.equal(call.request.headers['x-zitadel-public-host'], 'localhost:14102')
  }
  const metadata = JSON.parse(await readFile(join(secretsDir, 'identity-zitadel-enrollment.json'), 'utf8'))
  assert.equal(metadata.issuer, 'http://localhost:14102')
  assert.equal(metadata.redirectUri, 'http://localhost:14101/auth/callback')
})

test('rejects non-local or inconsistent deployment origins before external operations', async (t) => {
  for (const [name, lines, expected] of [
    ['app IP', ['KALA_PUBLIC_URLS=http://127.0.0.1:14101', 'KALA_PUBLIC_LISTEN=127.0.0.1:14101', 'KALA_IDENTITY_PORT=14102', 'OIDC_ISSUER=http://localhost:14102', 'OIDC_DISCOVERY_ORIGIN=http://identity-proxy:8080'], /KALA_PUBLIC_URLS.*localhost origin/u],
    ['listen mismatch', ['KALA_PUBLIC_URLS=http://localhost:14101', 'KALA_PUBLIC_LISTEN=127.0.0.1:14103', 'KALA_IDENTITY_PORT=14102', 'OIDC_ISSUER=http://localhost:14102', 'OIDC_DISCOVERY_ORIGIN=http://identity-proxy:8080'], /KALA_PUBLIC_LISTEN.*KALA_PUBLIC_URLS/u],
    ['issuer mismatch', ['KALA_PUBLIC_URLS=http://localhost:14101', 'KALA_PUBLIC_LISTEN=127.0.0.1:14101', 'KALA_IDENTITY_PORT=14102', 'OIDC_ISSUER=http://localhost:14103', 'OIDC_DISCOVERY_ORIGIN=http://identity-proxy:8080'], /OIDC_ISSUER.*KALA_IDENTITY_PORT/u],
  ]) {
    await t.test(name, async (t) => {
      const { options, configDir } = await fixture(t)
      await writeProtected(join(configDir, 'deployment.env'), `${lines.join('\n')}\n`)
      let externalCalls = 0
      await assert.rejects(bootstrapPrivateCloudIdentity(options, {
        runDocker: async () => { externalCalls += 1; return PAT },
        fetch: async () => { externalCalls += 1; return okJson({}) },
      }), expected)
      assert.equal(externalCalls, 0)
    })
  }
})

test('CLI contract rejects relative config paths, mutable images, and arbitrary options', async () => {
  const parsed = parseCliArgs([
    '--config-dir', '/operator/config',
    '--bootstrap-volume', 'project_bootstrap',
    '--identity-image', IMAGE,
  ])
  assert.deepEqual(parsed, {
    configDir: '/operator/config', bootstrapVolume: 'project_bootstrap', identityImage: IMAGE,
  })
  assert.equal(parseCliArgs([
    '--config-dir', '/operator/config', '--bootstrap-volume', 'project_bootstrap', '--identity-image', IMAGE,
    '--acceptance-users-file', '/private/users.json',
  ]).acceptanceUsersFile, '/private/users.json')
  await assert.rejects(bootstrapPrivateCloudIdentity({ ...parsed, configDir: 'relative' }), /absolute path/u)
  await assert.rejects(bootstrapPrivateCloudIdentity({ ...parsed, identityImage: 'alpine:3.22' }), /immutable Alpine image digest/u)
  assert.throws(() => parseCliArgs([...[
    '--config-dir', '/operator/config', '--bootstrap-volume', 'project_bootstrap', '--identity-image', IMAGE,
  ], '--origin', 'https://example.test']), /Usage/u)
})
