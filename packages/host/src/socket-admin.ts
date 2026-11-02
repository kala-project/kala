import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { SocketAdminRecord } from './socket-admin-store.js'
import type { Namespace } from 'socket.io'

/**
 * Admin UI development mode copies incoming/outgoing arguments verbatim.
 * Sanitize its public event boundary before instrumentation is installed: this
 * also covers in-flight bytes and avoids patching third-party/private listeners.
 * Keep ordinary diagnostics and debug event names, never opaque TCP payloads.
 */
export function redactApplicationDebugAdminEvents(namespace: Namespace): void {
  const emit = namespace.emit
  namespace.emit = function (event: string, ...args: unknown[]) {
    if ((event === 'event_received' || event === 'event_sent') && Array.isArray(args[2])) {
      const name: unknown = args[2][0]
      if (typeof name === 'string' && (name.startsWith('app_debug:') || name.startsWith('executor:app_debug_'))) {
        args[2] = [name, { redacted: true, reason: 'Opaque application debugging traffic is excluded from event inspection.' }]
      }
    }
    return emit.call(this, event, ...args)
  }
}

export type SocketAdminMode = 'development' | 'production'

export type SocketAdminConfig = {
  enabled: true
  path: string
  username: string
  passwordHash: string
  mode: SocketAdminMode
  distDir?: string
  distSource: 'embedded' | 'filesystem'
}

export type SocketAdminSummary = {
  active: boolean
  initialized: boolean
  path: string
  username: string
  runtimeMode: SocketAdminMode
  configuredMode: SocketAdminMode
  configPath: string
  distSource?: 'embedded' | 'filesystem'
  createdAt?: string
  restartRequired?: boolean
}

export type EmbeddedSocketAdminAsset = {
  readonly path: string
  readonly contentBase64: string
}

const DEFAULT_PATH = '/admin/socket.io'
const DEFAULT_USERNAME = 'admin'
const DEFAULT_MODE: SocketAdminMode = 'development'

export function loadSocketAdminConfig(opts: {
  currentModulePath: string
  configPath: string
  record: SocketAdminRecord | null
  embeddedAssets?: readonly EmbeddedSocketAdminAsset[]
}): { runtime?: SocketAdminConfig; summary: SocketAdminSummary } {
  const username = process.env.KALA_SOCKET_ADMIN_USER?.trim() || DEFAULT_USERNAME
  const envMode = process.env.KALA_SOCKET_ADMIN_MODE === undefined ? undefined : parseMode(process.env.KALA_SOCKET_ADMIN_MODE)
  const path = normalizeMountPath(process.env.KALA_SOCKET_ADMIN_PATH ?? DEFAULT_PATH)
  if (!opts.record) {
    const mode = envMode ?? DEFAULT_MODE
    return {
      summary: {
        active: false,
        initialized: false,
        path,
        username,
        runtimeMode: mode,
        configuredMode: mode,
        configPath: opts.configPath,
      },
    }
  }
  const loadedUsername = opts.record.username || username
  const mode = envMode ?? opts.record.mode ?? DEFAULT_MODE
  const explicitDist = process.env.KALA_SOCKET_ADMIN_DIST?.trim()
  if (explicitDist) {
    const distDir = resolve(explicitDist)
    requireAdminDist(distDir)
    return {
      runtime: { enabled: true, path, username: loadedUsername, passwordHash: opts.record.passwordHash, mode, distDir, distSource: 'filesystem' },
      summary: activeSummary({ path, username: loadedUsername, mode, configPath: opts.configPath, distSource: 'filesystem', createdAt: opts.record.createdAt }),
    }
  }
  if (opts.embeddedAssets && opts.embeddedAssets.length > 0) {
    return {
      runtime: { enabled: true, path, username: loadedUsername, passwordHash: opts.record.passwordHash, mode, distSource: 'embedded' },
      summary: activeSummary({ path, username: loadedUsername, mode, configPath: opts.configPath, distSource: 'embedded', createdAt: opts.record.createdAt }),
    }
  }
  const distDir = findSocketAdminDist([process.cwd(), dirname(opts.currentModulePath)])
  if (!distDir) {
    throw new Error('Socket.IO Admin UI dist is missing; run `pnpm prepare:socket-admin-ui` or set KALA_SOCKET_ADMIN_DIST')
  }
  requireAdminDist(distDir)
  return {
    runtime: { enabled: true, path, username: loadedUsername, passwordHash: opts.record.passwordHash, mode, distDir, distSource: 'filesystem' },
    summary: activeSummary({ path, username: loadedUsername, mode, configPath: opts.configPath, distSource: 'filesystem', createdAt: opts.record.createdAt }),
  }
}

export function normalizeMountPath(value: string): string {
  const trimmed = value.trim() || DEFAULT_PATH
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+$/, '') || DEFAULT_PATH
}

function parseMode(value: string | undefined): SocketAdminMode {
  const trimmed = value?.trim()
  if (!trimmed) return DEFAULT_MODE
  if (trimmed === 'development') return 'development'
  if (trimmed === 'production') return 'production'
  throw new Error('KALA_SOCKET_ADMIN_MODE must be production or development')
}

function activeSummary(input: {
  path: string
  username: string
  mode: SocketAdminMode
  configPath: string
  distSource: 'embedded' | 'filesystem'
  createdAt: string
}): SocketAdminSummary {
  return {
    active: true,
    initialized: true,
    path: input.path,
    username: input.username,
    runtimeMode: input.mode,
    configuredMode: input.mode,
    configPath: input.configPath,
    distSource: input.distSource,
    createdAt: input.createdAt,
  }
}

function requireAdminDist(dir: string): void {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`Socket.IO Admin UI dist missing index.html at ${dir}`)
  }
}

function findSocketAdminDist(starts: readonly string[]): string | undefined {
  for (const start of starts) {
    let dir = resolve(start)
    for (;;) {
      const candidate = join(dir, '.presq', 'socket.io-admin-ui', 'dist')
      if (existsSync(join(candidate, 'index.html'))) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}
