import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ExecutorMcpPatchSchema, type ExecutorMcpPatchRequest, type ExecutorMcpPatchAck, type ExecutorMcpConfigStatusAck } from '@agent-kernel/shared'
import { parseDashboardMcpServers, type DashboardMcpServerConfig } from './mcp-config.js'
import { readSecureConfig, writeDashboardMcpServers } from './mcp-managed-config.js'

const TICKET_LIFETIME = 86_400_000
type Receipt = { requestId: string; ticketExpiresAt: number; requestHmac: string; resultRevision: string; committedAt: string }
type Metadata = { formatVersion: 1; revision: string; receipts: Receipt[] }
type Ticket = { requestId: string; workspaceId: string; installationId: string; issuedAt: number; expiresAt: number }
export type McpCandidate = { activate(): void; close(): Promise<void> }

function metadata(value: unknown): Metadata | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_mcp_metadata')
  const input = value as Partial<Metadata>
  if (input.formatVersion !== 1 || typeof input.revision !== 'string' || !/^[1-9][0-9]{0,39}$/u.test(input.revision)
    || !Array.isArray(input.receipts) || input.receipts.length > 512) throw new Error('invalid_mcp_metadata')
  const ids = new Set<string>()
  for (const receipt of input.receipts) {
    if (!receipt || typeof receipt.requestId !== 'string' || ids.has(receipt.requestId)
      || !Number.isSafeInteger(receipt.ticketExpiresAt) || !/^[a-f0-9]{64}$/u.test(receipt.requestHmac)
      || !/^[1-9][0-9]{0,39}$/u.test(receipt.resultRevision) || !Number.isFinite(Date.parse(receipt.committedAt))) throw new Error('invalid_mcp_metadata')
    ids.add(receipt.requestId)
  }
  return input as Metadata
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export class ManagedMcpSettingsProtocol {
  constructor(private readonly configPath: string, private readonly workspaceId: string, private readonly installationId: string, private readonly now: () => number = Date.now) {}

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const directory = dirname(this.configPath)
    const parent = lstatSync(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid())
      || (process.platform !== 'win32' && (parent.mode & 0o022) !== 0)) throw new Error('unsafe_mcp_configuration_directory')
    const lock = join(directory, '.mcp-config.lock')
    try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error('mcp_configuration_locked') }
    try { return await operation() } finally { rmdirSync(lock) }
  }

  private key(versioned: boolean): Buffer {
    const path = join(dirname(this.configPath), '.mcp-config-integrity.key')
    if (!existsSync(path)) {
      if (versioned) throw new Error('mcp_integrity_key_missing')
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd) } finally { closeSync(fd) }
      syncDirectory(dirname(path))
    }
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== 32
      || (process.getuid && before.uid !== process.getuid()) || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) throw new Error('unsafe_mcp_integrity_key')
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const current = fstatSync(fd)
      if (current.dev !== before.dev || current.ino !== before.ino) throw new Error('unsafe_mcp_integrity_key')
      return readFileSync(fd)
    } finally { closeSync(fd) }
  }

  private ticket(key: Buffer): { requestId: string; editToken: string } {
    const issuedAt = this.now(), requestId = randomUUID()
    const body: Ticket = { requestId, workspaceId: this.workspaceId, installationId: this.installationId, issuedAt, expiresAt: issuedAt + TICKET_LIFETIME }
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
    return { requestId, editToken: `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}` }
  }

  private verifyTicket(key: Buffer, request: ExecutorMcpPatchRequest): Ticket {
    const [encoded, signature, extra] = request.editToken.split('.')
    if (!encoded || !signature || extra) throw new Error('invalid_edit_ticket')
    const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', key).update(encoded).digest()
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid_edit_ticket')
    let ticket: Ticket
    try { ticket = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Ticket } catch { throw new Error('invalid_edit_ticket') }
    if (ticket.requestId !== request.requestId || ticket.workspaceId !== this.workspaceId || ticket.installationId !== this.installationId
      || !Number.isSafeInteger(ticket.issuedAt) || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt - ticket.issuedAt !== TICKET_LIFETIME
      || ticket.issuedAt > this.now() || ticket.expiresAt <= this.now()) throw new Error('expired_or_foreign_edit_ticket')
    return ticket
  }

  async status(): Promise<ExecutorMcpConfigStatusAck> {
    return this.locked(async () => {
      const snapshot = readSecureConfig(this.configPath)
      const servers = parseDashboardMcpServers(snapshot.value.mcpServers)
      const current = metadata(snapshot.value._kalaManagedMcp)
      const key = this.key(Boolean(current))
      const revision = current?.revision ?? '1'
      if (!current) writeDashboardMcpServers(this.configPath, servers, snapshot, { formatVersion: 1, revision, receipts: [] })
      return { ok: true, servers: servers.map(({ name }) => ({ name })), revision, editProtocol: 'patch-v1', ...this.ticket(key) }
    })
  }

  async patch(raw: unknown, prepare: (servers: DashboardMcpServerConfig[]) => Promise<McpCandidate>): Promise<ExecutorMcpPatchAck> {
    const request = ExecutorMcpPatchSchema.parse(raw)
    if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024) throw new Error('mcp_request_too_large')
    return this.locked(async () => {
      const snapshot = readSecureConfig(this.configPath)
      const current = metadata(snapshot.value._kalaManagedMcp)
      if (!current) throw new Error('mcp_status_required')
      const key = this.key(true), ticket = this.verifyTicket(key, request)
      const digest = createHmac('sha256', key).update(JSON.stringify(request)).digest('hex')
      const previous = current.receipts.find(receipt => receipt.requestId === request.requestId)
      if (previous) {
        if (previous.requestHmac !== digest) throw new Error('edit_ticket_reused_with_different_request')
        return { ok: true, duplicate: true, requestResultRevision: previous.resultRevision, currentRevision: current.revision, revision: current.revision }
      }
      if (request.expectedRevision !== current.revision) throw new Error('configuration_conflict')
      const receipts = current.receipts.filter(receipt => receipt.ticketExpiresAt > this.now())
      if (receipts.length >= 512) throw new Error('deduplication_capacity_exceeded')
      const servers = parseDashboardMcpServers(snapshot.value.mcpServers)
      const merged = new Map(servers.map(server => [server.name, server]))
      for (const operation of request.operations) {
        if (operation.op === 'delete') {
          if (!merged.delete(operation.name)) throw new Error('mcp_server_not_found')
        } else merged.set(operation.name, { name: operation.name, command: operation.command, args: operation.args })
      }
      const validated = parseDashboardMcpServers([...merged.values()])
      const candidate = await prepare(validated)
      const revision = (BigInt(current.revision) + 1n).toString()
      try {
        writeDashboardMcpServers(this.configPath, validated, snapshot, { formatVersion: 1, revision, receipts: [
          ...receipts, { requestId: request.requestId, ticketExpiresAt: ticket.expiresAt, requestHmac: digest, resultRevision: revision, committedAt: new Date(this.now()).toISOString() },
        ] })
      } catch (error) { await candidate.close(); throw error }
      candidate.activate()
      return { ok: true, revision, requestResultRevision: revision, currentRevision: revision, duplicate: false }
    })
  }

  async replace(servers: DashboardMcpServerConfig[], prepare: (servers: DashboardMcpServerConfig[]) => Promise<McpCandidate>): Promise<ExecutorMcpPatchAck> {
    return this.locked(async () => {
      const snapshot = readSecureConfig(this.configPath)
      parseDashboardMcpServers(snapshot.value.mcpServers)
      const current = metadata(snapshot.value._kalaManagedMcp)
      this.key(Boolean(current))
      const validated = parseDashboardMcpServers(servers), candidate = await prepare(validated)
      const revision = (BigInt(current?.revision ?? '1') + 1n).toString()
      try { writeDashboardMcpServers(this.configPath, validated, snapshot, {
        formatVersion: 1, revision, receipts: current?.receipts.filter(receipt => receipt.ticketExpiresAt > this.now()) ?? [],
      }) } catch (error) { await candidate.close(); throw error }
      candidate.activate()
      return { ok: true, revision }
    })
  }
}
