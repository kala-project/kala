import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { SessionFsProvider } from '@github/copilot-sdk'

export type NativeFsTables = { usage: string; nodes: string; chunks: string }
export type NativeFsQuery = { sql: string; values: readonly (string | number)[] }
export type NativeFsQueryResult = { rows: Record<string, unknown>[]; rowCount: number }
export type NativeFsRequest =
  | { op: 'readFile' | 'exists' | 'stat' | 'readdir'; path: string }
  | { op: 'write' | 'append'; path: string; content: string }
  | { op: 'mkdir'; path: string; recursive: boolean }
  | { op: 'rm'; path: string; recursive: boolean; force: boolean }
  | { op: 'rename'; path: string; destination: string }

/** SQLite executes the complete plan synchronously; PG awaits it in one fenced transaction. */
export type NativeFsPlan = Generator<NativeFsQuery, unknown, NativeFsQueryResult>
export const MAX_NATIVE_SESSION_BYTES = 256 * 1024 * 1024
export const MAX_NATIVE_FILE_BYTES = 128 * 1024 * 1024
const MAX_NODES = 10_000
const CHUNK_CHARACTERS = 16 * 1024

type Node = { path: string; kind: 'file' | 'directory'; bytes: number; next_chunk: number; created_at: string; modified_at: string }

export function nativeFsSchemaStatements(t: NativeFsTables): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${t.usage} (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
      total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
      total_nodes INTEGER NOT NULL CHECK (total_nodes >= 0),
      PRIMARY KEY (tenant_id, session_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.nodes} (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
      bytes INTEGER NOT NULL CHECK (bytes >= 0), next_chunk INTEGER NOT NULL CHECK (next_chunk >= 0),
      created_at TEXT NOT NULL, modified_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, session_id, path),
      FOREIGN KEY (tenant_id, session_id) REFERENCES ${t.usage} (tenant_id, session_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.chunks} (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL,
      chunk_no INTEGER NOT NULL CHECK (chunk_no >= 0), content TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes >= 0), sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      PRIMARY KEY (tenant_id, session_id, path, chunk_no),
      FOREIGN KEY (tenant_id, session_id, path) REFERENCES ${t.nodes} (tenant_id, session_id, path) ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  ]
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function pathKey(path: string): string {
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').includes('..') || Buffer.byteLength(path) > 4096
    || Buffer.from(path, 'utf8').toString('utf8') !== path) fail('EINVAL', 'Invalid SDK session filesystem path')
  return posix.normalize(path)
}
function hash(content: string): string { return createHash('sha256').update(content).digest('hex') }
function* chunks(content: string): Generator<string> {
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + CHUNK_CHARACTERS, content.length)
    // Never split an astral code point between database TEXT values.
    const last = content.charCodeAt(end - 1)
    if (end < content.length && last >= 0xd800 && last <= 0xdbff) end--
    yield content.slice(start, end)
    start = end
  }
}

/**
 * Query plans share filesystem semantics, not runtime handles or credentials.
 * Append reads metadata only and INSERTs new immutable chunks; old native
 * history is never copied into Session projections or their audit events.
 */
export function* nativeFsPlan(request: NativeFsRequest, t: NativeFsTables, tenantId: string, sessionId: string): NativeFsPlan {
  const base = 'tenant_id = ? AND session_id = ?'
  const scope = [tenantId, sessionId]
  const p = pathKey(request.path)
  const now = new Date().toISOString()
  const usage = (yield { sql: `SELECT total_bytes, total_nodes FROM ${t.usage} WHERE ${base}`, values: scope }).rows[0]
  if (!usage) fail('EIO', 'SDK native storage usage row is missing')
  let totalBytes = Number(usage.total_bytes), totalNodes = Number(usage.total_nodes)
  function account(bytes: number, nodes: number) {
    totalBytes += bytes; totalNodes += nodes
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(totalNodes) || totalBytes < 0 || totalNodes < 0) fail('EIO', 'SDK native storage accounting is corrupt')
    if (totalBytes > MAX_NATIVE_SESSION_BYTES || totalNodes > MAX_NODES) fail('ENOSPC', 'SDK native session storage quota exceeded')
  }
  function* get(path: string): Generator<NativeFsQuery, Node | undefined, NativeFsQueryResult> {
    if (path === '/') return { path, kind: 'directory', bytes: 0, next_chunk: 0, created_at: new Date(0).toISOString(), modified_at: new Date(0).toISOString() }
    const row = (yield { sql: `SELECT path, kind, bytes, next_chunk, created_at, modified_at FROM ${t.nodes} WHERE ${base} AND path = ?`, values: [...scope, path] }).rows[0]
    if (!row) return undefined
    return { ...row, bytes: Number(row.bytes), next_chunk: Number(row.next_chunk) } as Node
  }
  function* requireDirectory(path: string): Generator<NativeFsQuery, void, NativeFsQueryResult> {
    const entry = yield* get(path)
    if (!entry) fail('ENOENT', 'SDK session directory does not exist')
    if (entry.kind !== 'directory') fail('ENOTDIR', 'SDK session path is not a directory')
  }
  function* insertDirectory(path: string): Generator<NativeFsQuery, void, NativeFsQueryResult> {
    account(0, 1)
    yield { sql: `INSERT INTO ${t.nodes} (tenant_id, session_id, path, kind, bytes, next_chunk, created_at, modified_at) VALUES (?, ?, ?, 'directory', 0, 0, ?, ?)`, values: [...scope, path, now, now] }
  }
  function* parents(path: string): Generator<NativeFsQuery, void, NativeFsQueryResult> {
    const parts = posix.dirname(path).split('/').filter(Boolean)
    let parent = ''
    for (const part of parts) {
      parent += `/${part}`
      const entry = yield* get(parent)
      if (!entry) yield* insertDirectory(parent)
      else if (entry.kind !== 'directory') fail('ENOTDIR', 'SDK session path is not a directory')
    }
  }
  function* subtree(path: string): Generator<NativeFsQuery, Node[], NativeFsQueryResult> {
    const prefix = `${path}/`
    const result = yield { sql: `SELECT path, kind, bytes, next_chunk, created_at, modified_at FROM ${t.nodes} WHERE ${base} AND (path = ? OR substr(path, 1, length(?)) = ?)`, values: [...scope, path, prefix, prefix] }
    return result.rows.map((row) => ({ ...row, bytes: Number(row.bytes), next_chunk: Number(row.next_chunk) } as Node))
  }
  function* erase(path: string, nodes: Node[]): Generator<NativeFsQuery, void, NativeFsQueryResult> {
    const prefix = `${path}/`
    yield { sql: `DELETE FROM ${t.nodes} WHERE ${base} AND (path = ? OR substr(path, 1, length(?)) = ?)`, values: [...scope, path, prefix, prefix] }
    account(-nodes.reduce((sum, row) => sum + row.bytes, 0), -nodes.length)
  }
  const entry = yield* get(p)
  switch (request.op) {
    case 'exists': return Boolean(entry)
    case 'stat':
      if (!entry) fail('ENOENT', 'SDK session path does not exist')
      return { isFile: entry.kind === 'file', isDirectory: entry.kind === 'directory', size: entry.bytes, mtime: entry.modified_at, birthtime: entry.created_at }
    case 'readFile': {
      if (!entry) fail('ENOENT', 'SDK session file does not exist')
      if (entry.kind !== 'file') fail('EISDIR', 'SDK session path is a directory')
      if (entry.bytes > MAX_NATIVE_FILE_BYTES) fail('EIO', 'SDK native file size exceeds supported limit')
      const result = yield { sql: `SELECT chunk_no, content, bytes, sha256 FROM ${t.chunks} WHERE ${base} AND path = ? ORDER BY chunk_no`, values: [...scope, p] }
      let size = 0
      const text: string[] = []
      for (const [index, row] of result.rows.entries()) {
        if (Number(row.chunk_no) !== index || typeof row.content !== 'string' || Buffer.byteLength(row.content) !== Number(row.bytes) || hash(row.content) !== row.sha256) fail('EIO', 'SDK native chunk failed integrity validation')
        text.push(row.content); size += Number(row.bytes)
      }
      if (size !== entry.bytes || result.rows.length !== entry.next_chunk) fail('EIO', 'SDK native file is incomplete')
      return text.join('')
    }
    case 'readdir': {
      yield* requireDirectory(p)
      // Metadata only, never fetch file contents while listing directories.
      const prefix = p === '/' ? '/' : `${p}/`
      const result = yield { sql: `SELECT path, kind FROM ${t.nodes} WHERE ${base} AND substr(path, 1, length(?)) = ?`, values: [...scope, prefix, prefix] }
      return result.rows.filter((row) => posix.dirname(String(row.path)) === p && row.path !== p)
        .map((row) => ({ name: posix.basename(String(row.path)), type: row.kind }))
    }
    case 'write': case 'append': {
      if (entry?.kind === 'directory') fail('EISDIR', 'Cannot write an SDK directory')
      if (request.content.includes('\0') || Buffer.from(request.content).toString() !== request.content) fail('EINVAL', 'SDK native files must contain valid UTF-8 text without NUL')
      const added = Buffer.byteLength(request.content)
      const before = entry?.bytes ?? 0
      const after = (request.op === 'append' ? before : 0) + added
      if (after > MAX_NATIVE_FILE_BYTES) fail('ENOSPC', 'SDK native file exceeds the supported 128 MiB limit')
      yield* parents(p)
      account(after - before, entry ? 0 : 1)
      if (!entry) {
        yield { sql: `INSERT INTO ${t.nodes} (tenant_id, session_id, path, kind, bytes, next_chunk, created_at, modified_at) VALUES (?, ?, ?, 'file', 0, 0, ?, ?)`, values: [...scope, p, now, now] }
      } else if (request.op === 'write') {
        yield { sql: `DELETE FROM ${t.chunks} WHERE ${base} AND path = ?`, values: [...scope, p] }
      }
      let next = request.op === 'append' ? entry?.next_chunk ?? 0 : 0
      for (const content of chunks(request.content)) {
        yield { sql: `INSERT INTO ${t.chunks} (tenant_id, session_id, path, chunk_no, content, bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)`, values: [...scope, p, next++, content, Buffer.byteLength(content), hash(content)] }
      }
      yield { sql: `UPDATE ${t.nodes} SET bytes = ?, next_chunk = ?, modified_at = ? WHERE ${base} AND path = ?`, values: [after, next, now, ...scope, p] }
      break
    }
    case 'mkdir':
      if (entry) { if (request.recursive && entry.kind === 'directory') return; fail('EEXIST', 'SDK session path already exists') }
      if (request.recursive) yield* parents(p)
      else yield* requireDirectory(posix.dirname(p))
      yield* insertDirectory(p)
      break
    case 'rm': {
      if (p === '/') fail('EINVAL', 'Cannot remove SDK namespace root')
      if (!entry) { if (request.force) return; fail('ENOENT', 'SDK session path does not exist') }
      const nodes = yield* subtree(p)
      if (!request.recursive && nodes.length > 1) fail('ENOTEMPTY', 'SDK directory is not empty')
      yield* erase(p, nodes)
      break
    }
    case 'rename': {
      const destination = pathKey(request.destination)
      if (p === '/' || destination === '/' || destination.startsWith(`${p}/`)) fail('EINVAL', 'Invalid SDK session rename')
      if (!entry) fail('ENOENT', 'SDK rename source does not exist')
      if (p === destination) return
      yield* requireDirectory(posix.dirname(destination))
      const target = yield* get(destination)
      if (target) {
        const targets = yield* subtree(destination)
        if (target.kind !== entry.kind || targets.length > 1) fail('EEXIST', 'SDK rename destination is incompatible or not empty')
        yield* erase(destination, targets)
      }
      for (const row of yield* subtree(p)) {
        // Chunk FKs update their path in the same transaction, without copying content.
        yield { sql: `UPDATE ${t.nodes} SET path = ?, modified_at = ? WHERE ${base} AND path = ?`, values: [destination + row.path.slice(p.length), now, ...scope, row.path] }
      }
      break
    }
  }
  yield { sql: `UPDATE ${t.usage} SET total_bytes = ?, total_nodes = ? WHERE ${base}`, values: [totalBytes, totalNodes, ...scope] }
}

export function createNativeSessionFsProvider(execute: (request: NativeFsRequest) => Promise<unknown>): SessionFsProvider {
  return {
    readFile: async (path) => await execute({ op: 'readFile', path }) as string,
    writeFile: async (path, content) => { await execute({ op: 'write', path, content }) },
    appendFile: async (path, content) => { await execute({ op: 'append', path, content }) },
    exists: async (path) => await execute({ op: 'exists', path }) as boolean,
    stat: async (path) => await execute({ op: 'stat', path }) as Awaited<ReturnType<SessionFsProvider['stat']>>,
    mkdir: async (path, recursive) => { await execute({ op: 'mkdir', path, recursive }) },
    readdir: async (path) => (await execute({ op: 'readdir', path }) as { name: string }[]).map((entry) => entry.name),
    readdirWithTypes: async (path) => await execute({ op: 'readdir', path }) as Awaited<ReturnType<SessionFsProvider['readdirWithTypes']>>,
    rm: async (path, recursive, force) => { await execute({ op: 'rm', path, recursive, force }) },
    rename: async (path, destination) => { await execute({ op: 'rename', path, destination }) },
  }
}
