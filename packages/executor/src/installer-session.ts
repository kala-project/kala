import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'

import type { ServiceMode } from './cli-args.js'
import type { ExecutorPrivilegeMode } from '@agent-kernel/shared'

export type InstallerSession = {
  version: 1
  mode: ServiceMode
  privilegeMode: ExecutorPrivilegeMode
  executable: string
  host: string
  profile?: string
  name?: string
  sandboxRoots: string[]
  credential: { token?: string; invite?: string }
  installationId?: string
  workspaceId?: string
  routeHint?: string
  installationSource?: 'dashboard-native' | 'private-cloud-invite'
  managedRoot?: string
  update?: { manifestUrl: string; publicKeyFile: string; channel: 'stable' | 'beta' | 'nightly'; intervalMinutes: number }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`Invalid installer session ${name}`)
  }
  return value
}

/** Reads a private, regular JSON session file without following symlinks. */
export function readInstallerSession(path: string): InstallerSession {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Installer session must be a regular file')
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) {
    throw new Error('Installer session permissions must be 0600')
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let raw: string
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Installer session changed while opening')
    }
    raw = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }

  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Installer session is not valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid installer session')
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('Unsupported installer session version')
  if (input.mode !== 'system' && input.mode !== 'user') throw new Error('Invalid installer session mode')
  // Legacy system services were already root-run before this field existed.
  const privilegeMode = input.privilegeMode === undefined
    ? (input.mode === 'system' ? 'privileged' : 'restricted')
    : input.privilegeMode
  if (privilegeMode !== 'restricted' && privilegeMode !== 'privileged') {
    throw new Error('Invalid installer session privilegeMode')
  }
  const executable = optionalString(input.executable, 'executable')
  const host = optionalString(input.host, 'host')
  if (!executable || !host) throw new Error('Installer session requires executable and host')
  if (!Array.isArray(input.sandboxRoots) || input.sandboxRoots.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid installer session sandboxRoots')
  }
  const credentialInput = input.credential
  if (!credentialInput || typeof credentialInput !== 'object' || Array.isArray(credentialInput)) {
    throw new Error('Installer session requires credential')
  }
  const credentialObject = credentialInput as Record<string, unknown>
  const token = optionalString(credentialObject.token, 'credential.token')
  const invite = optionalString(credentialObject.invite, 'credential.invite')
  if ((token ? 1 : 0) + (invite ? 1 : 0) !== 1) throw new Error('Installer session requires exactly one credential')

  return {
    version: 1,
    mode: input.mode,
    privilegeMode,
    executable,
    host,
    ...(optionalString(input.profile, 'profile') ? { profile: input.profile as string } : {}),
    ...(optionalString(input.name, 'name') ? { name: input.name as string } : {}),
    sandboxRoots: [...input.sandboxRoots] as string[],
    credential: { ...(token ? { token } : {}), ...(invite ? { invite } : {}) },
    ...(optionalString(input.installationId, 'installationId') ? { installationId: input.installationId as string } : {}),
    ...(optionalString(input.workspaceId, 'workspaceId') ? { workspaceId: String(input.workspaceId) } : {}),
    ...(optionalString(input.routeHint, 'routeHint') ? { routeHint: String(input.routeHint) } : {}),
    ...(parseInstallationSource(input.installationSource) ? { installationSource: parseInstallationSource(input.installationSource) } : {}),
    ...(optionalString(input.managedRoot, 'managedRoot') ? { managedRoot: input.managedRoot as string } : {}),
    ...(parseUpdate(input.update) ? { update: parseUpdate(input.update)! } : {}),
  }
}

function parseInstallationSource(value: unknown): InstallerSession['installationSource'] {
  if (value === undefined || value === 'dashboard-native' || value === 'private-cloud-invite') return value
  throw new Error('Invalid installer session installationSource')
}

export function renderExecutorServiceConfig(session: InstallerSession, credentialFile: string): string {
  return `${JSON.stringify({
    version: 1, host: session.host,
    ...(session.profile ? { profile: session.profile } : {}),
    ...(session.name ? { name: session.name } : {}),
    sandboxRoots: session.sandboxRoots, privilegeMode: session.privilegeMode, credentialFile,
    ...(session.installationId ? { installationId: session.installationId } : {}),
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.routeHint ? { routeHint: session.routeHint } : {}),
    installationSource: session.installationSource ?? 'dashboard-native',
    ...(session.managedRoot ? { managedRoot: session.managedRoot, serviceMode: session.mode } : {}),
    ...(session.update ? { update: { enabled: true, ...session.update } } : {}),
  }, null, 2)}\n`
}

function parseUpdate(value: unknown): InstallerSession['update'] | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid installer session update')
  const input = value as Record<string, unknown>
  const manifestUrl = optionalString(input.manifestUrl, 'update.manifestUrl')
  const publicKeyFile = optionalString(input.publicKeyFile, 'update.publicKeyFile')
  if (!manifestUrl || !publicKeyFile || !/^https?:\/\//u.test(manifestUrl) ||
      !['stable', 'beta', 'nightly'].includes(String(input.channel)) || !Number.isSafeInteger(input.intervalMinutes) || Number(input.intervalMinutes) < 5) {
    throw new Error('Invalid installer session update')
  }
  return { manifestUrl, publicKeyFile, channel: input.channel as 'stable' | 'beta' | 'nightly', intervalMinutes: Number(input.intervalMinutes) }
}
