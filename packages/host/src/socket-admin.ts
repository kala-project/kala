import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
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

/**
 * The upstream development mode includes complete event arguments and socket
 * handshake headers (including browser cookies). Keep only diagnostic metadata
 * at both outbound paths: namespace broadcasts and the initial per-socket
 * all_sockets response. Do not mutate the application socket or its payload.
 */
export function redactGatewayOwnerAdminEvents(namespace: Namespace): void {
  const snapshot = (value: unknown) => {
    if (!value || typeof value !== 'object') return {}
    const socket = value as Record<string, unknown>
    return {
      id: socket.id,
      nsp: socket.nsp,
      clientId: socket.clientId,
      transport: socket.transport,
      data: {},
      handshake: {},
      rooms: [],
    }
  }
  const emit = namespace.emit
  namespace.emit = function (event: string, ...args: unknown[]) {
    if (event === 'event_received' || event === 'event_sent') {
      const original = args[2]
      const name = Array.isArray(original) && typeof original[0] === 'string'
        && /^[\w:.-]{1,80}$/.test(original[0]) ? original[0] : '[redacted]'
      args[2] = [name, { redacted: true }]
    } else if (event === 'socket_connected') {
      args[0] = snapshot(args[0])
    } else if (event === 'socket_updated') {
      const update = args[0]
      args[0] = update && typeof update === 'object'
        ? { id: (update as Record<string, unknown>).id, nsp: (update as Record<string, unknown>).nsp }
        : {}
    } else if (event === 'room_joined' || event === 'room_left') {
      args[1] = '[redacted]'
    }
    return emit.call(this, event, ...args)
  }
  namespace.prependListener('connection', socket => {
    const socketEmit = socket.emit
    socket.emit = function (this: typeof socket, event: string, ...args: unknown[]) {
      if (event === 'all_sockets') {
        args[0] = Array.isArray(args[0]) ? args[0].map(snapshot) : []
      }
      return socketEmit.call(this, event, ...args)
    } as typeof socket.emit
  })
}

export type SocketAdminMode = 'development' | 'production'

type SocketAdminAssets = {
  enabled: true
  path: string
  username: string
  mode: SocketAdminMode
  distDir?: string
  distSource: 'embedded' | 'filesystem'
}

export type SocketAdminConfig = SocketAdminAssets & (
  | { authentication?: 'password'; passwordHash: string }
  | { authentication: 'gateway-owner'; passwordHash?: never }
)

export type SocketAdminSummary = {
  authentication?: 'password' | 'gateway-owner'
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
  unavailableReason?: string
}

export type EmbeddedSocketAdminAsset = {
  readonly path: string
  readonly contentBase64: string
}

const DEFAULT_PATH = '/admin/socket.io'
const DEFAULT_USERNAME = 'admin'
const DEFAULT_MODE: SocketAdminMode = 'development'

export function loadGatewayOwnerSocketAdminConfig(opts: {
  currentModulePath: string
  embeddedAssets?: readonly EmbeddedSocketAdminAsset[]
}): { runtime?: SocketAdminConfig; summary: SocketAdminSummary; indexHtml?: string } {
  const mode = parseDedicatedMode(process.env.KALA_SOCKET_ADMIN_MODE)
  const summary: SocketAdminSummary = {
    authentication: 'gateway-owner',
    active: false,
    initialized: false,
    path: DEFAULT_PATH,
    username: '',
    runtimeMode: mode,
    configuredMode: mode,
    configPath: '',
  }
  const embeddedIndex = opts.embeddedAssets?.find((asset) => asset.path === 'index.html')
  let distDir: string | undefined
  if (!embeddedIndex) {
    try {
      const require = createRequire(opts.currentModulePath)
      const installed = join(dirname(require.resolve('@socket.io/admin-ui/package.json')), 'ui', 'dist')
      if (existsSync(join(installed, 'index.html'))) distDir = installed
    } catch { /* Missing packaged assets are reported without failing Runtime startup. */ }
  }
  if (!embeddedIndex && !distDir) {
    summary.unavailableReason = 'The installed Socket.IO Admin UI assets are missing from this Runtime image.'
    return { summary }
  }
  const distSource = embeddedIndex ? 'embedded' : 'filesystem'
  const html = embeddedIndex
    ? Buffer.from(embeddedIndex.contentBase64, 'base64').toString('utf8')
    : readFileSync(join(distDir!, 'index.html'), 'utf8')
  // The official UI otherwise opens a connection/password dialog and loads
  // third-party fonts. Keep its assets and cookie-authenticated connection local.
  const indexHtml = html.replace(/<link\b[^>]*href=["']https?:\/\/[^>]*>/gi, '')
    .replace('<head>', '<head><script src="kala-bootstrap.js"></script>')
  return {
    runtime: { enabled: true, authentication: 'gateway-owner', path: DEFAULT_PATH, username: '', mode, distSource, ...(distDir ? { distDir } : {}) },
    summary: { ...summary, active: true, initialized: true, distSource },
    indexHtml,
  }
}

function parseDedicatedMode(value: string | undefined): SocketAdminMode {
  if (value === undefined || value.trim() === '' || value.trim() === 'development') return 'development'
  if (value.trim() === 'production') return 'production'
  throw new Error('KALA_SOCKET_ADMIN_MODE must be production or development')
}

export const GATEWAY_OWNER_SOCKET_ADMIN_BOOTSTRAP = `(() => {
  localStorage.setItem("server_url", location.origin);
  localStorage.setItem("namespace", "/admin");
  localStorage.setItem("ws_only", "true");
  localStorage.setItem("path", "/socket.io");
  localStorage.setItem("parser", "default");
  localStorage.removeItem("session_id");
})();`

export function isGatewaySocketAdminOwner(request: IncomingMessage, unitId: string | undefined): boolean {
  // Used only by Dedicated Hosts composed behind the authenticated Runtime
  // service. The Gateway replaces browser identity/Unit headers at that boundary.
  return Boolean(unitId
    && request.headers['x-agent-runlab-runtime-unit'] === unitId
    && request.headers['x-agent-runlab-organization-role'] === 'owner'
    && typeof request.headers['x-agent-runlab-organization-id'] === 'string'
    && request.headers['x-agent-runlab-organization-id']
    && typeof request.headers['x-agent-runlab-principal'] === 'string'
    && request.headers['x-agent-runlab-principal'])
}

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
