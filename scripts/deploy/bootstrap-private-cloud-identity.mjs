#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const DEFAULT_IDENTITY_PORT = 13002
const PROJECT_NAME = 'Kala Private Cloud'
const APPLICATION_NAME = 'Kala Gateway'
const METADATA_NAME = 'identity-zitadel-enrollment.json'
const PLACEHOLDER_PREFIX = 'REPLACE_'
const IMAGE_PATTERN = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?(?:[a-z0-9._-]+\/)*alpine(?:[:][a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/u

// Enrollment is one recoverable unit: the two credential files and metadata must
// be backed up and restored together. Populated credentials are reused only when
// the metadata's client ID and secret hash prove that all three files agree.
export function parseCliArgs(argv) {
  const requiredOptions = new Set(['--config-dir', '--bootstrap-volume', '--identity-image'])
  const allowed = new Set([...requiredOptions, '--acceptance-users-file', '--external-request-port'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    if (!allowed.has(option) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('Usage: node bootstrap-private-cloud-identity.mjs --config-dir ABSOLUTE_DIR --bootstrap-volume VOLUME_NAME --identity-image IMMUTABLE_ALPINE_DIGEST')
    }
    if (values.has(option)) throw new Error(`Duplicate option: ${option}`)
    values.set(option, argv[index + 1])
  }
  if ([...requiredOptions].some((option) => !values.has(option))) {
    throw new Error('Usage: node bootstrap-private-cloud-identity.mjs --config-dir ABSOLUTE_DIR --bootstrap-volume VOLUME_NAME --identity-image IMMUTABLE_ALPINE_DIGEST [--acceptance-users-file PRIVATE_JSON]')
  }
  return {
    configDir: values.get('--config-dir'),
    bootstrapVolume: values.get('--bootstrap-volume'),
    identityImage: values.get('--identity-image'),
    ...(values.has('--acceptance-users-file') ? { acceptanceUsersFile: values.get('--acceptance-users-file') } : {}),
    ...(values.has('--external-request-port') ? { externalRequestPort: values.get('--external-request-port') } : {}),
  }
}

export async function bootstrapPrivateCloudIdentity(options, dependencies = {}) {
  validateOptions(options)
  const local = await readLocalDeployment(options.configDir, options.externalRequestPort)
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const runDocker = dependencies.runDocker ?? defaultRunDocker
  const createAttemptId = dependencies.randomUUID ?? randomUUID
  if (typeof fetchImpl !== 'function') throw new Error('This command requires a Node.js runtime with fetch support')
  const acceptanceUsers = options.acceptanceUsersFile ? await readAcceptanceUsers(options.acceptanceUsersFile) : []

  const secretsDir = join(options.configDir, 'secrets')
  const clientIdPath = join(secretsDir, 'oidc_client_id')
  const clientSecretPath = join(secretsDir, 'oidc_client_secret')
  const metadataPath = join(secretsDir, METADATA_NAME)
  await ensurePrivateDirectory(secretsDir)

  const [clientIdFile, clientSecretFile, metadataFile] = await Promise.all([
    readStateFile(clientIdPath),
    readStateFile(clientSecretPath),
    readStateFile(metadataPath),
  ])
  const credentialState = classifyCredentials(clientIdFile, clientSecretFile)
  if (credentialState === 'populated') {
    if (acceptanceUsers.length) throw new Error('Acceptance users can only be created during the initial bundled identity enrollment')
    const metadata = parseMetadata(metadataFile, metadataPath)
    validateEnrolledMetadata(metadata, clientIdFile.value, clientSecretFile.value, local)
    await removeBootstrapPat(runDocker, options)
    return { ok: true, reused: true, projectId: metadata.projectId, applicationId: metadata.applicationId }
  }
  if (credentialState !== 'clean') {
    throw recoveryError('local OIDC credential files are incomplete or inconsistent')
  }
  if (metadataFile.exists) {
    throw recoveryError('saved enrollment metadata exists but the OIDC credential files are not populated')
  }

  let pat
  try {
    pat = (await runDocker([
      'run', '--rm', '--network', 'none',
      '-v', `${options.bootstrapVolume}:/bootstrap:ro`,
      options.identityImage,
      'cat', '/bootstrap/bootstrap.pat',
    ])).trim()
  } catch {
    throw new Error('Unable to read the Zitadel bootstrap PAT from the supplied Docker volume')
  }
  if (!pat) throw new Error('The Zitadel bootstrap PAT is empty')

  let phase = 'before project creation'
  let metadata = {
    schemaVersion: 1,
    status: 'registering',
    attemptId: createAttemptId(),
    issuer: local.identityOrigin,
    redirectUri: local.redirectUri,
  }
  await atomicWriteJson(metadataPath, metadata)

  const post = async (path, body) => {
    let response
    try {
      response = await fetchImpl(`${local.requestOrigin}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${pat}`,
          'content-type': 'application/json',
          'x-zitadel-instance-host': local.identityHost,
          'x-zitadel-public-host': local.identityHost,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error(`Zitadel request ${path} did not receive a response`)
    }
    if (!response.ok) throw new Error(`Zitadel request ${path} failed with HTTP ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new Error(`Zitadel request ${path} returned invalid JSON`)
    }
  }

  try {
    const enrolledUsers = []
    for (const user of acceptanceUsers) {
      phase = `${user.name} acceptance user creation`
      const created = await post('/management/v1/users/human', {
        userName: user.email,
        profile: { firstName: user.name === 'alice' ? 'Alice' : 'Bob', lastName: 'Acceptance', displayName: `${user.name === 'alice' ? 'Alice' : 'Bob'} Acceptance` },
        email: { email: user.email, isEmailVerified: true },
        initialPassword: user.password,
      })
      const subject = requireApiValue(created?.userId, `${user.name} user id`)
      enrolledUsers.push({ name: user.name, email: user.email, subject })
      metadata = { ...metadata, acceptanceUsers: enrolledUsers.map(({ name, subject: userSubject }) => ({ name, subject: userSubject })) }
      await atomicWriteJson(metadataPath, metadata)
    }

    phase = 'project creation'
    const project = await post('/management/v1/projects', {
      name: PROJECT_NAME,
      projectRoleAssertion: false,
      projectRoleCheck: false,
      hasProjectCheck: false,
    })
    const projectId = requireApiValue(project?.id, 'project id')
    metadata = { ...metadata, projectId }
    await atomicWriteJson(metadataPath, metadata)

    phase = 'OIDC application creation'
    const application = await post(`/management/v1/projects/${encodeURIComponent(projectId)}/apps/oidc`, {
      name: APPLICATION_NAME,
      redirectUris: [local.redirectUri],
      responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
      grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
      appType: 'OIDC_APP_TYPE_WEB',
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
      postLogoutRedirectUris: [local.postLogoutRedirectUri],
      version: 'OIDC_VERSION_1_0',
      devMode: true,
      accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
    })
    const applicationId = requireApiValue(application?.appId, 'application id')
    const clientId = requireApiValue(application?.clientId, 'client id')
    const clientSecret = requireApiValue(application?.clientSecret, 'client secret')

    phase = 'local credential persistence'
    metadata = { ...metadata, applicationId, clientId, clientSecretSha256: sha256(clientSecret) }
    await atomicWriteJson(metadataPath, metadata)
    await atomicWriteSecret(clientSecretPath, clientSecret)
    await atomicWriteSecret(clientIdPath, clientId)
    await atomicWriteJson(metadataPath, {
      schemaVersion: 1,
      status: 'enrolled',
      issuer: local.identityOrigin,
      redirectUri: local.redirectUri,
      projectId,
      applicationId,
      clientId,
      clientSecretSha256: sha256(clientSecret),
    })
    phase = 'bootstrap PAT removal'
    await removeBootstrapPat(runDocker, options)
    return { ok: true, reused: false, projectId, applicationId, ...(enrolledUsers.length ? { acceptanceUsers: enrolledUsers } : {}) }
  } catch (error) {
    throw recoveryError(`registration stopped during ${phase}: ${safeCause(error)}`)
  } finally {
    pat = undefined
  }
}

async function removeBootstrapPat(runDocker, options) {
  try {
    await runDocker([
      'run', '--rm', '--network', 'none',
      '-v', `${options.bootstrapVolume}:/bootstrap`,
      options.identityImage,
      'rm', '-f', '/bootstrap/bootstrap.pat',
    ])
  } catch {
    throw new Error('Unable to remove the one-time Zitadel bootstrap PAT from the supplied Docker volume')
  }
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('Bootstrap options are required')
  if (typeof options.configDir !== 'string' || !isAbsolute(options.configDir)) throw new Error('--config-dir must be an absolute path')
  if (typeof options.bootstrapVolume !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(options.bootstrapVolume)) {
    throw new Error('--bootstrap-volume must be a Docker volume name')
  }
  if (typeof options.identityImage !== 'string' || !IMAGE_PATTERN.test(options.identityImage)) {
    throw new Error('--identity-image must be an immutable Alpine image digest')
  }
  if (options.acceptanceUsersFile !== undefined && (typeof options.acceptanceUsersFile !== 'string' || !isAbsolute(options.acceptanceUsersFile))) throw new Error('--acceptance-users-file must be an absolute path')
  if (options.externalRequestPort !== undefined && (!/^[1-9][0-9]{3,4}$/u.test(options.externalRequestPort) || Number(options.externalRequestPort) > 65535 || options.externalRequestPort === '13002')) throw new Error('--external-request-port must be a distinct localhost TCP port')
}

async function readAcceptanceUsers(path) {
  const file = await readStateFile(path)
  if (!file.exists) throw new Error('The acceptance users file does not exist')
  let parsed
  try { parsed = JSON.parse(file.value) } catch { throw new Error('The acceptance users file is not valid JSON') }
  if (!Array.isArray(parsed?.users) || parsed.users.length !== 2) throw new Error('The acceptance users file must contain exactly Alice and Bob')
  const users = parsed.users.map((user) => ({
    name: typeof user?.name === 'string' ? user.name.trim().toLowerCase() : '',
    email: typeof user?.email === 'string' ? user.email.trim() : '',
    password: typeof user?.password === 'string' ? user.password : '',
  }))
  if (users.map((user) => user.name).sort().join(',') !== 'alice,bob') throw new Error('The acceptance users file must name exactly Alice and Bob')
  if (users.some((user) => !/^[^\s@]+@[^\s@]+$/u.test(user.email) || user.password.length < 16 || /[\r\n\0]/u.test(user.password))) throw new Error('Each acceptance user requires a valid email and a password of at least 16 characters')
  if (new Set(users.map((user) => user.email.toLowerCase())).size !== 2 || new Set(users.map((user) => user.password)).size !== 2) throw new Error('Acceptance users must have distinct emails and passwords')
  return users
}

async function readLocalDeployment(configDir, externalRequestPort) {
  await requirePrivateDirectory(configDir)
  const path = join(configDir, 'deployment.env')
  const file = await readStateFile(path)
  if (!file.exists) throw new Error('configuration is missing deployment.env')
  const environment = {}
  for (const line of file.value.split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)
    if (!match) throw new Error('deployment.env contains an invalid line')
    environment[match[1]] = match[2]
  }

  const appOrigin = requireLocalhostOrigin(environment.KALA_PUBLIC_URLS, 'KALA_PUBLIC_URLS')
  const appPort = appOrigin.slice(appOrigin.lastIndexOf(':') + 1)
  if (environment.KALA_PUBLIC_LISTEN !== `127.0.0.1:${appPort}`) {
    throw new Error('KALA_PUBLIC_LISTEN must bind the KALA_PUBLIC_URLS port on 127.0.0.1')
  }
  const identityPort = environment.KALA_IDENTITY_PORT ?? String(DEFAULT_IDENTITY_PORT)
  const numericIdentityPort = Number(identityPort)
  if (!/^[1-9][0-9]{0,4}$/u.test(identityPort) || numericIdentityPort > 65535) {
    throw new Error('KALA_IDENTITY_PORT must be a decimal TCP port from 1 through 65535')
  }
  const external = externalRequestPort !== undefined
  const identityOrigin = external ? environment.OIDC_ISSUER : requireLocalhostOrigin(environment.OIDC_ISSUER, 'OIDC_ISSUER')
  if (external) {
    if (environment.KALA_IDENTITY_MODE !== 'external' || identityOrigin !== 'https://localhost:13002' || identityPort !== '13002') throw new Error('independent OIDC enrollment requires an external HTTPS localhost:13002 issuer')
  } else {
    if (identityOrigin !== `http://localhost:${identityPort}`) throw new Error('OIDC_ISSUER must use KALA_IDENTITY_PORT on localhost')
    if (environment.OIDC_DISCOVERY_ORIGIN !== 'http://identity-proxy:8080') throw new Error('OIDC_DISCOVERY_ORIGIN must remain http://identity-proxy:8080 for bundled identity')
  }
  return {
    identityOrigin,
    identityHost: `localhost:${identityPort}`,
    requestOrigin: `http://127.0.0.1:${external ? externalRequestPort : identityPort}`,
    redirectUri: `${appOrigin}/auth/callback`,
    postLogoutRedirectUri: `${appOrigin}/`,
  }
}

function requireLocalhostOrigin(value, name) {
  const match = typeof value === 'string' && value.match(/^http:\/\/localhost:([1-9][0-9]{0,4})$/u)
  if (!match || Number(match[1]) > 65535) throw new Error(`${name} must be one HTTP localhost origin with an explicit valid port`)
  return value
}

async function requirePrivateDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} must be a real directory`)
  if ((info.mode & 0o077) !== 0) throw new Error(`${path} must not grant access to group or other users`)
}

async function defaultRunDocker(args) {
  const { stdout } = await execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  })
  return stdout
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} must be a real directory`)
  if ((info.mode & 0o077) !== 0) throw new Error(`${path} must not grant access to group or other users`)
}

async function readStateFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} must be a regular file, not a symlink`)
    if ((info.mode & 0o077) !== 0) throw new Error(`${path} must have mode 0600 or stricter`)
    return { exists: true, value: await readFile(path, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: undefined }
    throw error
  }
}

function classifyCredentials(clientIdFile, clientSecretFile) {
  if (!clientIdFile.exists && !clientSecretFile.exists) return 'clean'
  if (!clientIdFile.exists || !clientSecretFile.exists) return 'inconsistent'
  const clientId = clientIdFile.value.trim()
  const clientSecret = clientSecretFile.value.trim()
  if (!clientId || !clientSecret) return 'inconsistent'
  const idPlaceholder = clientId.startsWith(PLACEHOLDER_PREFIX)
  const secretPlaceholder = clientSecret.startsWith(PLACEHOLDER_PREFIX)
  if (idPlaceholder && secretPlaceholder) return 'clean'
  if (idPlaceholder || secretPlaceholder) return 'inconsistent'
  clientIdFile.value = clientId
  clientSecretFile.value = clientSecret
  return 'populated'
}

function parseMetadata(file, path) {
  if (!file.exists) throw recoveryError('OIDC credentials are populated but saved enrollment metadata is missing')
  try {
    return JSON.parse(file.value)
  } catch {
    throw recoveryError(`${path} is not valid JSON`)
  }
}

function validateEnrolledMetadata(metadata, clientId, clientSecret, local) {
  const consistent = metadata?.schemaVersion === 1
    && metadata.status === 'enrolled'
    && metadata.issuer === local.identityOrigin
    && metadata.redirectUri === local.redirectUri
    && metadata.clientId === clientId
    && metadata.clientSecretSha256 === sha256(clientSecret)
    && isApiValue(metadata.projectId)
    && isApiValue(metadata.applicationId)
  if (!consistent) throw recoveryError('saved enrollment metadata does not match the local OIDC credentials')
}

function requireApiValue(value, label) {
  if (!isApiValue(value)) throw new Error(`Zitadel did not return a valid ${label}`)
  return value
}

function isApiValue(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\r\n\0]/u.test(value)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function atomicWriteSecret(path, value) {
  await atomicWrite(path, `${value}\n`)
}

async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function recoveryError(reason) {
  return new Error(`Identity enrollment is not safe to retry automatically: ${reason}. Inspect the saved enrollment metadata and the Zitadel project/application, then reconcile or restore the three enrollment files together; deleting files and rerunning can create another client.`)
}

function safeCause(error) {
  if (error instanceof Error && /^(?:Zitadel request|Zitadel did not return)/u.test(error.message)) return error.message
  return 'a local persistence operation failed'
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

if (isMainModule()) {
  void (async () => {
    try {
      const result = await bootstrapPrivateCloudIdentity(parseCliArgs(process.argv.slice(2)))
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } catch (error) {
      process.stderr.write(`Identity bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
      process.exitCode = 1
    }
  })()
}
