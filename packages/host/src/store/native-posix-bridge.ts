import { chmod, lstat, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { dirname } from 'node:path'
import { TextDecoder } from 'node:util'
import { performance } from 'node:perf_hooks'

import {
  NATIVE_POSIX_REQUEST_BYTES,
  nativePosixError,
  type NativePosixFileSystem,
} from './native-posix-fs.js'

const HEADER_BYTES = 32
const MAX_PATH_BYTES = 4096
const MAGIC = Buffer.from('KFS1')
const errno: Readonly<Record<string, number>> = {
  EPERM: 1, ENOENT: 2, EIO: 5, EACCES: 13, EBUSY: 16, EEXIST: 17,
  ENOTDIR: 20, EISDIR: 21, EINVAL: 22, EFBIG: 27, ENOSPC: 28, EROFS: 30, ENOTEMPTY: 39,
  RUNTIME_RESOURCE_OWNERSHIP_FENCED: 5, RUNTIME_RESOURCE_OWNERSHIP_EXPIRED: 5,
}
const decoder = new TextDecoder('utf-8', { fatal: true })
function decodePath(value: Buffer): string {
  try { return decoder.decode(value) } catch (error) {
    if (!(error instanceof TypeError)) throw error
    nativePosixError('EINVAL', 'Native filename is not valid UTF-8')
  }
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) nativePosixError('EINVAL', 'Native offset exceeds safe integer range')
  return Number(value)
}

/** Private Unix socket, one bounded operation per connection, fixed Session scope. */
export async function startNativePosixBridge(options: {
  socketPath: string
  fs: NativePosixFileSystem
  onError(error: unknown): void
  onOperation?(operation: number, bytes: number, durationMs: number): void
}): Promise<{ server: Server; close(): Promise<void> }> {
  const parent = await lstat(dirname(options.socketPath))
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error('Native bridge requires a private non-symlink socket directory')
  }
  try {
    await lstat(options.socketPath)
    throw new Error('Native bridge socket already exists; refusing to replace it')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const connections = new Set<import('node:net').Socket>()
  const server = createServer(socket => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    socket.on('error', options.onError)
    socket.setTimeout(60_000, () => socket.destroy(new Error('Native bridge request timed out')))
    let data = Buffer.alloc(0)
    let expected: number | undefined
    let dispatched = false
    const respond = (status: number, body = Buffer.alloc(0)) => {
      const header = Buffer.alloc(8)
      header.writeUInt32BE(status, 0)
      header.writeUInt32BE(body.length, 4)
      socket.end(Buffer.concat([header, body]))
    }
    socket.on('data', bytes => {
      if (dispatched) { socket.destroy(); return }
      if (data.length + bytes.length > HEADER_BYTES + MAX_PATH_BYTES + NATIVE_POSIX_REQUEST_BYTES) {
        dispatched = true; respond(errno.EINVAL!); return
      }
      data = Buffer.concat([data, bytes])
      if (data.length >= HEADER_BYTES && expected === undefined) {
        const pathLength = data.readUInt32BE(8), contentLength = data.readUInt32BE(12)
        if (!data.subarray(0, 4).equals(MAGIC) || !pathLength || pathLength > MAX_PATH_BYTES
          || contentLength > NATIVE_POSIX_REQUEST_BYTES || data.readUInt32BE(24) > NATIVE_POSIX_REQUEST_BYTES) {
          dispatched = true; respond(errno.EINVAL!); return
        }
        expected = HEADER_BYTES + pathLength + contentLength
      }
      if (expected !== undefined && data.length >= expected) {
        dispatched = true
        if (data.length !== expected) { respond(errno.EINVAL!); return }
        const operation = data.readUInt32BE(4)
        const startedAt = performance.now()
        void dispatch(data, options.fs).then(body => {
          try {
            options.onOperation?.(operation, operation === 5 ? body.length : operation === 6 ? data.readUInt32BE(12) : 0, performance.now() - startedAt)
          } catch (error) {
            options.onError(error)
          }
          respond(0, body)
        }, error => {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
          if (!code || !errno[code] || errno[code] === errno.EIO) options.onError(error)
          respond(code && errno[code] ? errno[code]! : errno.EIO!)
        })
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => { server.off('error', reject); resolve() })
  })
  server.on('error', options.onError)
  await chmod(options.socketPath, 0o600)
  const identity = await lstat(options.socketPath)
  return {
    server,
    close: async () => {
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      try {
        const current = await lstat(options.socketPath)
        if (current.ino === identity.ino && current.dev === identity.dev && current.isSocket()) await unlink(options.socketPath)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    },
  }
}

async function dispatch(request: Buffer, fs: NativePosixFileSystem): Promise<Buffer> {
  const op = request.readUInt32BE(4), pathLength = request.readUInt32BE(8)
  const path = decodePath(request.subarray(HEADER_BYTES, HEADER_BYTES + pathLength))
  const content = request.subarray(HEADER_BYTES + pathLength)
  const offset = safeNumber(request.readBigUInt64BE(16))
  const size = request.readUInt32BE(24), flags = request.readUInt32BE(28)
  switch (op) {
    case 1: {
      const stat = await fs.stat(path), body = Buffer.alloc(32)
      body.writeUInt32BE(stat.kind === 'file' ? 1 : 2, 0)
      body.writeUInt32BE(stat.mode, 4)
      body.writeBigUInt64BE(BigInt(stat.bytes), 8)
      body.writeBigUInt64BE(BigInt(stat.modifiedAt), 16)
      body.writeBigUInt64BE(BigInt(stat.createdAt), 24)
      return body
    }
    case 2: {
      const names = await fs.readdir(path)
      const encoded = names.map(name => Buffer.from(name))
      const length = encoded.reduce((size, name) => size + 4 + name.length, 4)
      if (length > NATIVE_POSIX_REQUEST_BYTES) nativePosixError('EFBIG', 'Native directory response exceeds bridge bound')
      const body = Buffer.alloc(length)
      body.writeUInt32BE(encoded.length, 0)
      let cursor = 4
      for (const name of encoded) {
        body.writeUInt32BE(name.length, cursor); cursor += 4
        name.copy(body, cursor); cursor += name.length
      }
      return body
    }
    case 3: await fs.create(path, flags); break
    case 4: await fs.mkdir(path, flags); break
    case 5: return fs.read(path, offset, size)
    case 6: await fs.write(path, offset, content); break
    case 7: await fs.truncate(path, offset); break
    case 8: await fs.remove(path, false); break
    case 9: await fs.remove(path, true); break
    case 10: await fs.rename(path, decodePath(content)); break
    case 11: await fs.sync(path); break
    case 12: await fs.chmod(path, flags); break
    case 13: await fs.touch(path, offset); break
    default: nativePosixError('EINVAL', 'Unknown native filesystem operation')
  }
  return Buffer.alloc(0)
}
