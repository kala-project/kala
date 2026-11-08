import { createPublicKey, verify } from 'node:crypto'
import { constants, chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ExecutorInstallMode, ExecutorInstallStatusSnapshot, ExecutorPrivilegeMode } from '@agent-kernel/shared'

import type { InstallerSession } from './installer-session.js'
import { parseManifest } from './update.js'

export type BootstrapEnvironment = {
  HOST_URL: string
  EXECUTOR_INSTALL_ID: string
  EXECUTOR_INSTALL_BOOTSTRAP: string
  EXECUTOR_INSTALL_MODE: ExecutorInstallMode
  EXECUTOR_PRIVILEGE_MODE: ExecutorPrivilegeMode
  EXECUTOR_INSTALL_ROOT: string
  EXECUTOR_INSTALL_LABEL?: string
}

export type ExecutorUpdateAssets = {
  manifestUrl: string
  publicKey: string
}

export function bootstrapEnvironment(env: NodeJS.ProcessEnv): BootstrapEnvironment {
  const required = (name: keyof BootstrapEnvironment): string => {
    const value = env[name]?.trim()
    if (!value || value.includes('\0')) throw new Error(`Missing or invalid ${name}`)
    return value
  }
  const mode = required('EXECUTOR_INSTALL_MODE')
  if (mode !== 'service' && mode !== 'temporary') throw new Error('Invalid EXECUTOR_INSTALL_MODE')
  const privilegeMode = required('EXECUTOR_PRIVILEGE_MODE')
  if (privilegeMode !== 'restricted' && privilegeMode !== 'privileged') throw new Error('Invalid EXECUTOR_PRIVILEGE_MODE')
  return {
    HOST_URL: required('HOST_URL'), EXECUTOR_INSTALL_ID: required('EXECUTOR_INSTALL_ID'),
    EXECUTOR_INSTALL_BOOTSTRAP: required('EXECUTOR_INSTALL_BOOTSTRAP'), EXECUTOR_INSTALL_MODE: mode,
    EXECUTOR_PRIVILEGE_MODE: privilegeMode,
    EXECUTOR_INSTALL_ROOT: required('EXECUTOR_INSTALL_ROOT'),
    ...(env.EXECUTOR_INSTALL_LABEL?.trim() ? { EXECUTOR_INSTALL_LABEL: env.EXECUTOR_INSTALL_LABEL.trim() } : {}),
  }
}

export function assertSupportedInstallerPrivileges(env: BootstrapEnvironment, isRoot: boolean): void {
  if (env.EXECUTOR_INSTALL_MODE === 'service' && isRoot && env.EXECUTOR_PRIVILEGE_MODE === 'restricted') {
    throw new Error('Restricted installations cannot run as a root system service; use a non-root user service or explicitly choose privileged mode')
  }
}

export async function installationRequest<T>(env: BootstrapEnvironment, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${env.HOST_URL.replace(/\/$/u, '')}/install/session/${encodeURIComponent(env.EXECUTOR_INSTALL_ID)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.EXECUTOR_INSTALL_BOOTSTRAP}`, ...init.headers },
  })
  if (!response.ok) throw new Error(`installation request failed: ${response.status} ${await response.text()}`)
  return await response.json() as T
}

export async function reportInstallation(env: BootstrapEnvironment, status: string, metadata?: Record<string, unknown>): Promise<ExecutorInstallStatusSnapshot> {
  return await installationRequest(env, '/events', { method: 'POST', body: JSON.stringify({ status, ...(metadata ? { metadata } : {}) }) })
}

export async function waitForApproval(env: BootstrapEnvironment, intervalMs = 1_000): Promise<void> {
  while (true) {
    const snapshot = await installationRequest<ExecutorInstallStatusSnapshot>(env, '/status')
    if (snapshot.status === 'paired') return
    if (snapshot.status === 'rejected' || snapshot.status === 'expired' || snapshot.status === 'failed') throw new Error(`installation ${snapshot.status}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export async function redeemInstallation(env: BootstrapEnvironment, workspaceId: string): Promise<{ token: string }> {
  return await installationRequest(env, '/redeem', { method: 'POST', body: JSON.stringify({ workspaceId, ...(env.EXECUTOR_INSTALL_LABEL ? { label: env.EXECUTOR_INSTALL_LABEL } : {}) }) })
}

export async function downloadExecutorUpdateAssets(hostUrl: string): Promise<ExecutorUpdateAssets> {
  const origin = new URL(hostUrl)
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Executor update assets require HTTPS or a loopback Host')
  }
  const assetsUrl = `${origin.toString().replace(/\/$/u, '')}/install/assets`
  const manifestUrl = `${assetsUrl}/executor-update-manifest.json`
  const publicKeyUrl = `${assetsUrl}/executor-update-public-key.pem`
  const [manifestResponse, publicKeyResponse] = await Promise.all([fetch(manifestUrl), fetch(publicKeyUrl)])
  if (!manifestResponse.ok) throw new Error(`failed to download Executor update manifest: ${manifestResponse.status}`)
  if (!publicKeyResponse.ok) throw new Error(`failed to download Executor update verification key: ${publicKeyResponse.status}`)
  const [envelopeText, publicKey] = await Promise.all([manifestResponse.text(), publicKeyResponse.text()])
  if (envelopeText.length > 64 * 1024 || publicKey.length > 8 * 1024) throw new Error('Executor update metadata exceeds its size limit')
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Executor update verification key must be Ed25519')
  const envelope: unknown = JSON.parse(envelopeText)
  if (!envelope || typeof envelope !== 'object' || !('signed' in envelope) || !('signature' in envelope)
    || typeof envelope.signed !== 'string' || typeof envelope.signature !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(envelope.signature)
    || !verify(null, Buffer.from(envelope.signed), key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Executor update manifest signature verification failed')
  }
  const manifest = parseManifest(envelope.signed)
  if (manifest.channel !== 'stable' || manifest.artifact.url !== './kala-executor.cjs' || manifest.artifact.file !== 'kala-executor') {
    throw new Error('Executor update manifest does not describe the expected stable asset')
  }
  return { manifestUrl, publicKey }
}

export function pinExecutorUpdateKey(root: string, publicKey: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'update-public-key.pem')
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || readFileSync(path, 'utf8') !== publicKey) {
      throw new Error('Existing Executor update verification key differs or is unsafe; rotate it through a trusted operator procedure')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    writeFileSync(fd, publicKey)
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  } finally { closeSync(fd) }
}

export function writeInstallerSession(path: string, session: InstallerSession): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

export function defaultManagedRoot(home: string, system: boolean): string {
  return system ? '/var/lib/kala/executor' : join(home, '.local', 'state', 'kala', 'executor')
}
