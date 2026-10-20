import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'

import type { ManagedMcpServer, PlatformTenancy } from '@agent-kernel/shared'

import type { AuthConfig, DashboardActor } from '../auth-control.js'
import type { AuditLogger } from '../audit-log.js'
import type { ExecutorRegistry } from '../connection/executor.js'
import type { ExecutorInstallationStorage, ManagedExecutorInstallationBinding } from '../store/executor-installation.js'
import { authorizeSensitiveExecutorManagement } from './executor-installation-routes.js'
import { validatedPublicOrigin } from './public-access-gate.js'
import { claimRoute } from './routes.js'

const MAX_MCP_SETTINGS_BODY_BYTES = 64 * 1024
const MAX_MCP_SERVERS = 16
const MAX_MCP_ARGS = 64
const MAX_MCP_STRING_LENGTH = 8 * 1024
const MCP_SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u

type McpExecutorAccess = Pick<ExecutorRegistry, 'snapshot' | 'hasTrustedManagedExecutor' | 'mcpConfigStatus' | 'configureMcp'>
type McpInstallationAccess = Pick<ExecutorInstallationStorage, 'managedBinding' | 'managedBindingsForWorkspace'>

type McpSettingsSummary = {
  supported: boolean
  note?: string
  workspaceId: string
  /** Names only: command and args can carry credentials. */
  servers: Array<{ name: string }>
}

export function attachMcpSettingsRoutes(server: HttpServer, options: {
  installations: McpInstallationAccess
  executors: McpExecutorAccess
  tenancy: PlatformTenancy
  auth?: AuthConfig
  audit?: AuditLogger
}): void {
  const configuring = new Set<string>()

  server.on('request', async (req, res) => {
    if (res.headersSent || res.writableEnded) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/settings/mcp') return
    claimRoute(req)

    if (req.method !== 'GET' && req.method !== 'PUT') {
      sendError(res, 405, 'method_not_allowed')
      return
    }
    if (!sameOrigin(req)) {
      sendError(res, 403, 'origin_forbidden')
      return
    }

    const authorization = authorizeSensitiveExecutorManagement(req, options.tenancy, options.auth)
    if (!authorization.ok) {
      sendError(res, authorization.status, authorization.error)
      return
    }

    if (req.method === 'GET') {
      const workspaceId = url.searchParams.get('workspaceId')?.trim() ?? ''
      if (!workspaceId) {
        sendError(res, 400, 'workspace_id_required')
        return
      }
      const selected = await selectManagedExecutor(workspaceId, authorization.actor, options.installations, options.executors).catch(() => undefined)
      if (!selected) {
        audit(options.audit, 'mcp_config.read', authorization.actor, workspaceId, [], 'error', 'installation_store_unavailable')
        sendError(res, 500, 'internal_error')
        return
      }
      if (!selected.ok) {
        audit(options.audit, 'mcp_config.read', authorization.actor, workspaceId, [], 'denied', selected.error)
        sendError(res, selected.status, selected.error)
        return
      }
      void options.executors.mcpConfigStatus(workspaceId, selected.binding.id, randomUUID()).then((ack) => {
        if (!ack.ok) {
          audit(options.audit, 'mcp_config.read', authorization.actor, workspaceId, [], 'error', 'executor_request_failed')
          sendError(res, 502, 'mcp_status_unavailable')
          return
        }
        const servers = parseServerNames(ack.servers)
        if (!servers) {
          audit(options.audit, 'mcp_config.read', authorization.actor, workspaceId, [], 'error', 'invalid_executor_response')
          sendError(res, 502, 'mcp_status_unavailable')
          return
        }
        audit(options.audit, 'mcp_config.read', authorization.actor, workspaceId, servers.map((item) => item.name), 'ok')
        sendSummary(res, workspaceId, servers)
      }).catch(() => {
        audit(options.audit, 'mcp_config.read', authorization.actor, workspaceId, [], 'error', 'executor_request_failed')
        sendError(res, 502, 'mcp_status_unavailable')
      })
      return
    }

    void readJson(req).then(async (body) => {
      const input = parsePutBody(body)
      if (!input) {
        sendError(res, 400, 'invalid_request')
        return
      }
      const selected = await selectManagedExecutor(input.workspaceId, authorization.actor, options.installations, options.executors)
        .catch(() => { throw new InstallationStoreUnavailableError() })
      const names = input.servers.map((item) => item.name)
      if (!selected.ok) {
        audit(options.audit, 'mcp_config.update', authorization.actor, input.workspaceId, names, 'denied', selected.error)
        sendError(res, selected.status, selected.error)
        return
      }
      if (configuring.has(selected.binding.id)) {
        audit(options.audit, 'mcp_config.update', authorization.actor, input.workspaceId, names, 'denied', 'configuration_in_progress')
        sendError(res, 409, 'configuration_in_progress')
        return
      }

      configuring.add(selected.binding.id)
      void options.executors.configureMcp(input.workspaceId, selected.binding.id, {
        requestId: randomUUID(),
        servers: input.servers,
      }).then((ack) => {
        if (!ack.ok) {
          audit(options.audit, 'mcp_config.update', authorization.actor, input.workspaceId, names, 'error', 'executor_request_failed')
          sendError(res, 502, 'mcp_configuration_failed')
          return
        }
        audit(options.audit, 'mcp_config.update', authorization.actor, input.workspaceId, names, 'ok')
        sendSummary(res, input.workspaceId, input.servers)
      }).catch(() => {
        audit(options.audit, 'mcp_config.update', authorization.actor, input.workspaceId, names, 'error', 'executor_request_failed')
        sendError(res, 502, 'mcp_configuration_failed')
      }).finally(() => configuring.delete(selected.binding.id))
    }).catch((error: unknown) => {
      if (error instanceof InstallationStoreUnavailableError) {
        sendError(res, 500, 'internal_error')
        return
      }
      sendError(res, error instanceof RequestTooLargeError ? 413 : 400, error instanceof RequestTooLargeError ? 'request_too_large' : 'invalid_request')
    })
  })
}

async function selectManagedExecutor(
  workspaceId: string,
  actor: DashboardActor,
  installations: McpInstallationAccess,
  executors: Pick<McpExecutorAccess, 'snapshot' | 'hasTrustedManagedExecutor'>,
): Promise<{ ok: true; binding: ManagedExecutorInstallationBinding } | { ok: false; status: number; error: string }> {
  const executor = executors.snapshot().find((candidate) => candidate.workspaceId === workspaceId)
  if (!executor) {
    const bindings = await installations.managedBindingsForWorkspace(workspaceId)
    const ownershipError = bindings.length > 0 ? bindingOwnershipError(actor, bindings) : undefined
    if (ownershipError) return { ok: false, status: 403, error: ownershipError }
    return { ok: false, status: 409, error: bindings.length > 0 ? 'workspace_offline' : 'unmanaged_workspace' }
  }
  if (!executor.installId) return { ok: false, status: 409, error: 'unmanaged_executor' }
  const binding = await installations.managedBinding(executor.installId)
  if (!binding || binding.workspaceId !== workspaceId) return { ok: false, status: 409, error: 'unmanaged_executor' }
  if (!executors.hasTrustedManagedExecutor(workspaceId, binding.id)) return { ok: false, status: 409, error: 'unmanaged_executor' }
  const ownershipError = bindingOwnershipError(actor, [binding])
  return ownershipError
    ? { ok: false, status: 403, error: ownershipError }
    : { ok: true, binding }
}

function bindingOwnershipError(actor: DashboardActor, bindings: readonly ManagedExecutorInstallationBinding[]): string | undefined {
  if (actor.kind !== 'ingress') return undefined
  if (bindings.some((binding) => binding.organizationId === actor.organizationId)) return undefined
  return bindings.some((binding) => binding.organizationId === undefined) ? 'tenant_attribution_missing' : 'tenant_forbidden'
}

function parsePutBody(value: unknown): { workspaceId: string; servers: ManagedMcpServer[] } | undefined {
  if (!isExactObject(value, ['workspaceId', 'servers'])) return undefined
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId.trim() : ''
  if (!workspaceId || workspaceId.length > MAX_MCP_STRING_LENGTH) return undefined
  const servers = parseServers(value.servers)
  return servers ? { workspaceId, servers } : undefined
}

function parseServerNames(value: unknown): Array<{ name: string }> | undefined {
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) return undefined
  const names = new Set<string>()
  for (const item of value) {
    if (!isExactObject(item, ['name']) || typeof item.name !== 'string' || !MCP_SERVER_NAME.test(item.name) || names.has(item.name)) return undefined
    names.add(item.name)
  }
  return value as Array<{ name: string }>
}

function parseServers(value: unknown): ManagedMcpServer[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) return undefined
  const names = new Set<string>()
  const servers: ManagedMcpServer[] = []
  for (const item of value) {
    if (!isExactObject(item, ['name', 'command', 'args'])) return undefined
    if (typeof item.name !== 'string' || typeof item.command !== 'string' || !Array.isArray(item.args)) return undefined
    const name = item.name
    const command = item.command
    if (!MCP_SERVER_NAME.test(name) || !command || command.length > MAX_MCP_STRING_LENGTH || /[\0\r\n]/u.test(command) || names.has(name)) return undefined
    if (item.args.length > MAX_MCP_ARGS || item.args.some((arg) => typeof arg !== 'string' || arg.length > MAX_MCP_STRING_LENGTH || arg.includes('\0'))) return undefined
    names.add(name)
    servers.push({ name, command, args: [...item.args] as string[] })
  }
  return servers
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = header(req, 'origin')
  if (!origin) return true
  const validated = validatedPublicOrigin(req)
  if (validated) return origin === validated
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(header(req, 'content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_MCP_SETTINGS_BODY_BYTES) throw new RequestTooLargeError()
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_MCP_SETTINGS_BODY_BYTES) throw new RequestTooLargeError()
    chunks.push(buffer)
  }
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

class RequestTooLargeError extends Error {}
class InstallationStoreUnavailableError extends Error {}

function audit(logger: AuditLogger | undefined, action: string, actor: DashboardActor, workspaceId: string, serverNames: string[], outcome: 'ok' | 'denied' | 'error', error?: string): void {
  logger?.log({
    action,
    actor,
    target: { workspaceId },
    outcome,
    metadata: { serverNames },
    ...(error ? { error } : {}),
  })
}

function sendSummary(res: ServerResponse, workspaceId: string, servers: readonly { name: string }[]): void {
  const body: McpSettingsSummary = { supported: true, workspaceId, servers: servers.map(({ name }) => ({ name })) }
  sendJson(res, 200, body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error })
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
