import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import type { HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import { validateNativeFsLimits, type NativeFsLimits } from './native-session-fs.js'

export const NATIVE_POSIX_BLOCK_BYTES = 64 * 1024
export const NATIVE_POSIX_REQUEST_BYTES = 1024 * 1024
export type NativePosixStat = {
  kind: 'file' | 'directory'
  bytes: number
  mode: number
  modifiedAt: number
  createdAt: number
}
export interface NativePosixFileSystem {
  stat(path: string): Promise<NativePosixStat>
  readdir(path: string): Promise<string[]>
  create(path: string, mode: number): Promise<void>
  mkdir(path: string, mode: number): Promise<void>
  read(path: string, offset: number, size: number): Promise<Buffer>
  write(path: string, offset: number, content: Buffer): Promise<void>
  truncate(path: string, size: number): Promise<void>
  remove(path: string, directory: boolean): Promise<void>
  rename(path: string, destination: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  touch(path: string, modifiedAt: number): Promise<void>
  sync(path: string): Promise<void>
}

export function nativePosixSchemaStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_native_posix_usage (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
      total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
      total_nodes BIGINT NOT NULL CHECK (total_nodes >= 0),
      PRIMARY KEY (tenant_id, session_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_native_posix_nodes (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
      bytes BIGINT NOT NULL CHECK (bytes >= 0),
      mode INTEGER NOT NULL CHECK (mode BETWEEN 0 AND 511),
      modified_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, session_id, path),
      FOREIGN KEY (tenant_id, session_id) REFERENCES ${schema}.tenant_session_native_posix_usage
        (tenant_id, session_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_native_posix_blocks (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL,
      block_no BIGINT NOT NULL CHECK (block_no >= 0),
      content BYTEA NOT NULL CHECK (octet_length(content) = ${NATIVE_POSIX_BLOCK_BYTES}),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      PRIMARY KEY (tenant_id, session_id, path, block_no),
      FOREIGN KEY (tenant_id, session_id, path) REFERENCES ${schema}.tenant_session_native_posix_nodes
        (tenant_id, session_id, path) ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  ]
}

export function nativePosixPath(path: string): string {
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').includes('..') || Buffer.byteLength(path) > 4096
    || Buffer.from(path).toString('utf8') !== path) nativePosixError('EINVAL', 'Invalid native filesystem path')
  return posix.normalize(path)
}

export function nativePosixError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}
function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) nativePosixError('EINVAL', `Invalid native ${label}`)
  return value
}
function modeBits(mode: number): number {
  integer(mode, 'mode')
  return mode & 0o777
}
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex') }
const zeroBlock = Buffer.alloc(NATIVE_POSIX_BLOCK_BYTES)
const zeroHash = hash(zeroBlock)
type Transaction = <T>(operation: (sql: HotStateSqlExecutor) => Promise<T>) => Promise<T>

/**
 * Fixed-size binary blocks, acknowledged only after the caller's fenced PG
 * transaction commits. No local writeback cache or whole-file string exists.
 */
export class PostgresNativePosixFileSystem implements NativePosixFileSystem {
  readonly #usage: string
  readonly #nodes: string
  readonly #blocks: string
  readonly #limits: Readonly<NativeFsLimits>
  constructor(
    readonly tenantId: string,
    readonly sessionId: string,
    readonly transaction: Transaction,
    options: { schema?: string; limits?: NativeFsLimits } = {},
  ) {
    const schema = options.schema ?? 'public'
    if (!/^[a-z_][a-z0-9_]*$/iu.test(schema)) throw new TypeError('Invalid native filesystem schema')
    this.#usage = `"${schema}".tenant_session_native_posix_usage`
    this.#nodes = `"${schema}".tenant_session_native_posix_nodes`
    this.#blocks = `"${schema}".tenant_session_native_posix_blocks`
    this.#limits = validateNativeFsLimits(options.limits ?? {})
  }
  #scope(path?: string): readonly unknown[] {
    return path === undefined ? [this.tenantId, this.sessionId] : [this.tenantId, this.sessionId, path]
  }
  async #run<T>(operation: (sql: HotStateSqlExecutor) => Promise<T>): Promise<T> {
    return this.transaction(async sql => {
      await sql.query(`INSERT INTO ${this.#usage} (tenant_id,session_id,total_bytes,total_nodes)
        VALUES ($1,$2,0,0) ON CONFLICT DO NOTHING`, this.#scope())
      await sql.query(`SELECT total_bytes FROM ${this.#usage}
        WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE`, this.#scope())
      return operation(sql)
    })
  }
  async #node(sql: HotStateSqlExecutor, path: string): Promise<NativePosixStat> {
    if (path === '/') return { kind: 'directory', bytes: 0, mode: 0o700, modifiedAt: 0, createdAt: 0 }
    const { rows } = await sql.query(`SELECT kind,bytes,mode,modified_at,created_at FROM ${this.#nodes}
      WHERE tenant_id=$1 AND session_id=$2 AND path=$3`, this.#scope(path))
    const row = rows[0]
    if (!row) nativePosixError('ENOENT', 'Native path does not exist')
    if (row.kind !== 'file' && row.kind !== 'directory') nativePosixError('EIO', 'Invalid native node kind')
    const bytes = Number(row.bytes)
    if (!Number.isSafeInteger(bytes) || bytes < 0) nativePosixError('EIO', 'Invalid native file size')
    return { kind: row.kind, bytes, mode: Number(row.mode),
      modifiedAt: Number(row.modified_at), createdAt: Number(row.created_at) }
  }
  async #file(sql: HotStateSqlExecutor, path: string): Promise<NativePosixStat> {
    const node = await this.#node(sql, path)
    if (node.kind !== 'file') nativePosixError('EISDIR', 'Native path is a directory')
    return node
  }
  async #directory(sql: HotStateSqlExecutor, path: string): Promise<void> {
    if ((await this.#node(sql, path)).kind !== 'directory') nativePosixError('ENOTDIR', 'Native parent is not a directory')
  }
  async #account(sql: HotStateSqlExecutor, bytes: number, nodes: number): Promise<void> {
    const { rows } = await sql.query(`SELECT total_bytes,total_nodes FROM ${this.#usage}
      WHERE tenant_id=$1 AND session_id=$2`, this.#scope())
    const previousBytes = Number(rows[0]?.total_bytes), previousNodes = Number(rows[0]?.total_nodes)
    const totalBytes = previousBytes + bytes, totalNodes = previousNodes + nodes
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(totalNodes) || totalBytes < 0 || totalNodes < 0) {
      nativePosixError('EIO', 'Native storage accounting is corrupt')
    }
    if ((this.#limits.maxSessionBytes && totalBytes > this.#limits.maxSessionBytes && bytes > 0)
      || (this.#limits.maxNodes && totalNodes > this.#limits.maxNodes && nodes > 0)) {
      nativePosixError('ENOSPC', 'Native session storage quota exceeded')
    }
    await sql.query(`UPDATE ${this.#usage} SET total_bytes=$3,total_nodes=$4
      WHERE tenant_id=$1 AND session_id=$2`, [...this.#scope(), totalBytes, totalNodes])
  }
  #fileQuota(previous: number, next: number): void {
    integer(next, 'file size')
    if (this.#limits.maxFileBytes && next > this.#limits.maxFileBytes && next > previous) {
      nativePosixError('ENOSPC', 'Native file storage quota exceeded')
    }
  }
  async #readBlock(sql: HotStateSqlExecutor, path: string, index: number, fileSize: number): Promise<Buffer> {
    if (index * NATIVE_POSIX_BLOCK_BYTES >= fileSize) return Buffer.alloc(NATIVE_POSIX_BLOCK_BYTES)
    const { rows } = await sql.query(`SELECT content,sha256 FROM ${this.#blocks}
      WHERE tenant_id=$1 AND session_id=$2 AND path=$3 AND block_no=$4`, [...this.#scope(path), index])
    const row = rows[0]
    if (!row || !Buffer.isBuffer(row.content) || row.content.length !== NATIVE_POSIX_BLOCK_BYTES
      || hash(row.content) !== row.sha256) nativePosixError('EIO', 'Native binary block failed integrity validation')
    return Buffer.from(row.content)
  }
  async #putBlock(sql: HotStateSqlExecutor, path: string, index: number, content: Buffer): Promise<void> {
    await sql.query(`INSERT INTO ${this.#blocks} (tenant_id,session_id,path,block_no,content,sha256)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,session_id,path,block_no)
      DO UPDATE SET content=EXCLUDED.content,sha256=EXCLUDED.sha256`,
    [...this.#scope(path), index, content, hash(content)])
  }
  async #extend(sql: HotStateSqlExecutor, path: string, previous: number, next: number): Promise<void> {
    const first = Math.ceil(previous / NATIVE_POSIX_BLOCK_BYTES), end = Math.ceil(next / NATIVE_POSIX_BLOCK_BYTES)
    if (first < end) await sql.query(`INSERT INTO ${this.#blocks}
      (tenant_id,session_id,path,block_no,content,sha256)
      SELECT $1,$2,$3,n,$6,$7 FROM generate_series($4::bigint,$5::bigint) n`,
    [...this.#scope(path), first, end - 1, zeroBlock, zeroHash])
  }
  async #size(sql: HotStateSqlExecutor, path: string, previous: number, next: number): Promise<void> {
    this.#fileQuota(previous, next)
    await this.#account(sql, next - previous, 0)
    await sql.query(`UPDATE ${this.#nodes} SET bytes=$4,modified_at=$5
      WHERE tenant_id=$1 AND session_id=$2 AND path=$3`, [...this.#scope(path), next, Date.now()])
  }
  async stat(path: string): Promise<NativePosixStat> {
    const p = nativePosixPath(path)
    return this.#run(sql => this.#node(sql, p))
  }
  async readdir(path: string): Promise<string[]> {
    const p = nativePosixPath(path), prefix = p === '/' ? '/' : `${p}/`
    return this.#run(async sql => {
      await this.#directory(sql, p)
      const { rows } = await sql.query(`SELECT path FROM ${this.#nodes}
        WHERE tenant_id=$1 AND session_id=$2 AND starts_with(path,$3)
          AND strpos(substr(path,length($3)+1),'/')=0 ORDER BY path`, this.#scope(prefix))
      return rows.map(row => String(row.path).slice(prefix.length))
    })
  }
  async #create(path: string, mode: number, kind: NativePosixStat['kind']): Promise<void> {
    const p = nativePosixPath(path), bits = modeBits(mode)
    if (p === '/') nativePosixError('EEXIST', 'Native root already exists')
    return this.#run(async sql => {
      await this.#directory(sql, posix.dirname(p))
      const exists = await sql.query(`SELECT 1 FROM ${this.#nodes}
        WHERE tenant_id=$1 AND session_id=$2 AND path=$3`, this.#scope(p))
      if (exists.rows.length) nativePosixError('EEXIST', 'Native path already exists')
      await this.#account(sql, 0, 1)
      const now = Date.now()
      await sql.query(`INSERT INTO ${this.#nodes} (tenant_id,session_id,path,kind,bytes,mode,modified_at,created_at)
        VALUES ($1,$2,$3,$4,0,$5,$6,$6)`, [...this.#scope(p), kind, bits, now])
    })
  }
  async create(path: string, mode: number): Promise<void> { return this.#create(path, mode, 'file') }
  async mkdir(path: string, mode: number): Promise<void> { return this.#create(path, mode, 'directory') }
  async read(path: string, offset: number, size: number): Promise<Buffer> {
    const p = nativePosixPath(path)
    integer(offset, 'read offset'); integer(size, 'read size')
    if (size > NATIVE_POSIX_REQUEST_BYTES) nativePosixError('EINVAL', 'Native read exceeds request bound')
    return this.#run(async sql => {
      const node = await this.#file(sql, p)
      const end = Math.min(node.bytes, offset + size)
      if (offset >= end) return Buffer.alloc(0)
      const output = Buffer.alloc(end - offset)
      const firstBlock = Math.floor(offset / NATIVE_POSIX_BLOCK_BYTES)
      const lastBlock = Math.floor((end - 1) / NATIVE_POSIX_BLOCK_BYTES)
      const { rows } = await sql.query(`SELECT block_no,content,sha256 FROM ${this.#blocks}
        WHERE tenant_id=$1 AND session_id=$2 AND path=$3 AND block_no BETWEEN $4 AND $5 ORDER BY block_no`,
      [...this.#scope(p), firstBlock, lastBlock])
      if (rows.length !== lastBlock - firstBlock + 1) nativePosixError('EIO', 'Native binary file is incomplete')
      for (let cursor = offset; cursor < end;) {
        const index = Math.floor(cursor / NATIVE_POSIX_BLOCK_BYTES)
        const row = rows[index - firstBlock]!
        if (Number(row.block_no) !== index || !Buffer.isBuffer(row.content)
          || row.content.length !== NATIVE_POSIX_BLOCK_BYTES || hash(row.content) !== row.sha256) {
          nativePosixError('EIO', 'Native binary block failed integrity validation')
        }
        const block = row.content
        const start = cursor % NATIVE_POSIX_BLOCK_BYTES, count = Math.min(end - cursor, block.length - start)
        block.copy(output, cursor - offset, start, start + count)
        cursor += count
      }
      return output
    })
  }
  async write(path: string, offset: number, content: Buffer): Promise<void> {
    const p = nativePosixPath(path)
    integer(offset, 'write offset')
    if (!Buffer.isBuffer(content) || content.length > NATIVE_POSIX_REQUEST_BYTES) {
      nativePosixError('EINVAL', 'Native write exceeds request bound')
    }
    return this.#run(async sql => {
      const node = await this.#file(sql, p)
      if (!content.length) return
      const next = Math.max(node.bytes, offset + content.length)
      this.#fileQuota(node.bytes, next)
      await this.#extend(sql, p, node.bytes, next)
      for (let consumed = 0; consumed < content.length;) {
        const cursor = offset + consumed, index = Math.floor(cursor / NATIVE_POSIX_BLOCK_BYTES)
        const start = cursor % NATIVE_POSIX_BLOCK_BYTES
        const count = Math.min(content.length - consumed, NATIVE_POSIX_BLOCK_BYTES - start)
        const block = start === 0 && count === NATIVE_POSIX_BLOCK_BYTES
          ? Buffer.alloc(NATIVE_POSIX_BLOCK_BYTES)
          : await this.#readBlock(sql, p, index, next)
        content.copy(block, start, consumed, consumed + count)
        await this.#putBlock(sql, p, index, block)
        consumed += count
      }
      await this.#size(sql, p, node.bytes, next)
    })
  }
  async truncate(path: string, size: number): Promise<void> {
    const p = nativePosixPath(path)
    integer(size, 'truncate size')
    return this.#run(async sql => {
      const node = await this.#file(sql, p)
      this.#fileQuota(node.bytes, size)
      if (size > node.bytes) await this.#extend(sql, p, node.bytes, size)
      else if (size < node.bytes) {
        await sql.query(`DELETE FROM ${this.#blocks}
          WHERE tenant_id=$1 AND session_id=$2 AND path=$3 AND block_no >= $4`,
        [...this.#scope(p), Math.ceil(size / NATIVE_POSIX_BLOCK_BYTES)])
        if (size % NATIVE_POSIX_BLOCK_BYTES) {
          const index = Math.floor(size / NATIVE_POSIX_BLOCK_BYTES)
          const block = await this.#readBlock(sql, p, index, node.bytes)
          block.fill(0, size % NATIVE_POSIX_BLOCK_BYTES)
          await this.#putBlock(sql, p, index, block)
        }
      }
      await this.#size(sql, p, node.bytes, size)
    })
  }
  async #remove(sql: HotStateSqlExecutor, path: string, directory: boolean): Promise<void> {
    if (path === '/') nativePosixError('EBUSY', 'Native root cannot be removed')
    const node = await this.#node(sql, path)
    if ((node.kind === 'directory') !== directory) nativePosixError(directory ? 'ENOTDIR' : 'EISDIR', 'Native removal kind mismatch')
    if (directory) {
      const children = await sql.query(`SELECT 1 FROM ${this.#nodes}
        WHERE tenant_id=$1 AND session_id=$2 AND starts_with(path,$3) LIMIT 1`, this.#scope(`${path}/`))
      if (children.rows.length) nativePosixError('ENOTEMPTY', 'Native directory is not empty')
    }
    await sql.query(`DELETE FROM ${this.#nodes} WHERE tenant_id=$1 AND session_id=$2 AND path=$3`, this.#scope(path))
    await this.#account(sql, -node.bytes, -1)
  }
  async remove(path: string, directory: boolean): Promise<void> {
    const p = nativePosixPath(path)
    return this.#run(sql => this.#remove(sql, p, directory))
  }
  async rename(path: string, destination: string): Promise<void> {
    const p = nativePosixPath(path), next = nativePosixPath(destination)
    return this.#run(async sql => {
      const node = await this.#node(sql, p)
      if (p === next) return
      if (p === '/' || next === '/' || next.startsWith(`${p}/`)) nativePosixError('EINVAL', 'Invalid native rename')
      await this.#directory(sql, posix.dirname(next))
      const target = await sql.query(`SELECT kind FROM ${this.#nodes}
        WHERE tenant_id=$1 AND session_id=$2 AND path=$3`, this.#scope(next))
      if (target.rows.length) await this.#remove(sql, next, node.kind === 'directory')
      await sql.query(`UPDATE ${this.#nodes} SET path=$4 || substr(path,length($3)+1)
        WHERE tenant_id=$1 AND session_id=$2 AND (path=$3 OR starts_with(path,$3 || '/'))`,
      [...this.#scope(p), next])
    })
  }
  async chmod(path: string, mode: number): Promise<void> {
    const p = nativePosixPath(path), bits = modeBits(mode)
    return this.#run(async sql => {
      await this.#node(sql, p)
      if (p !== '/') await sql.query(`UPDATE ${this.#nodes} SET mode=$4
        WHERE tenant_id=$1 AND session_id=$2 AND path=$3`, [...this.#scope(p), bits])
    })
  }
  async touch(path: string, modifiedAt: number): Promise<void> {
    const p = nativePosixPath(path)
    integer(modifiedAt, 'modified time')
    return this.#run(async sql => {
      await this.#node(sql, p)
      if (p !== '/') await sql.query(`UPDATE ${this.#nodes} SET modified_at=$4
        WHERE tenant_id=$1 AND session_id=$2 AND path=$3`, [...this.#scope(p), modifiedAt])
    })
  }
  async sync(path: string): Promise<void> {
    const p = nativePosixPath(path)
    return this.#run(async sql => { await this.#node(sql, p) })
  }
}
