import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativePosixFileSystem } from './native-posix-fs.js'
import { startNativePosixBridge } from './native-posix-bridge.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function frame(op: number, path: Buffer, content = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(32)
  header.write('KFS1')
  header.writeUInt32BE(op, 4)
  header.writeUInt32BE(path.length, 8)
  header.writeUInt32BE(content.length, 12)
  return Buffer.concat([header, path, content])
}
async function call(socketPath: string, request: Buffer): Promise<{ errno: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const parts: Buffer[] = []
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(request.subarray(0, 7))
      socket.write(request.subarray(7))
    })
    socket.on('data', bytes => parts.push(bytes))
    socket.once('end', () => {
      const response = Buffer.concat(parts)
      expect(response.length).toBe(8 + response.readUInt32BE(4))
      resolve({ errno: response.readUInt32BE(0), body: response.subarray(8) })
    })
  })
}

describe('private native POSIX bridge', () => {
  it('handles fragmented binary writes and rejects unbounded or malformed requests without dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-native-bridge-'))
    roots.push(root)
    const write = vi.fn(async () => undefined)
    const stat = vi.fn(async () => ({ kind: 'file' as const, bytes: 42, mode: 0o600, modifiedAt: 123, createdAt: 100 }))
    const fs: NativePosixFileSystem = {
      stat, write, readdir: async () => [], create: async () => {}, mkdir: async () => {},
      read: async () => Buffer.alloc(0), truncate: async () => {}, remove: async () => {},
      rename: async () => {}, chmod: async () => {}, touch: async () => {}, sync: async () => {},
    }
    const onError = vi.fn()
    const onOperation = vi.fn()
    const socketPath = join(root, 'native.sock')
    const bridge = await startNativePosixBridge({ socketPath, fs, onError, onOperation })
    try {
      const bytes = Buffer.from([0, 255, 0, 129])
      const request = frame(6, Buffer.from('/cache.db'), bytes)
      request.writeBigUInt64BE(65534n, 16)
      await expect(call(socketPath, request)).resolves.toMatchObject({ errno: 0 })
      expect(write).toHaveBeenCalledWith('/cache.db', 65534, bytes)
      const invalid = frame(6, Buffer.from('/cache.db'))
      invalid.writeUInt32BE(1024 * 1024 + 1, 12)
      await expect(call(socketPath, invalid)).resolves.toMatchObject({ errno: 22 })
      await expect(call(socketPath, frame(1, Buffer.from([0xff])))).resolves.toMatchObject({ errno: 22 })
      expect(write).toHaveBeenCalledTimes(1)
      expect(stat).not.toHaveBeenCalled()
      const response = await call(socketPath, frame(1, Buffer.from('/cache.db')))
      expect(response.errno).toBe(0)
      expect(response.body.readBigUInt64BE(8)).toBe(42n)
      expect(onOperation).toHaveBeenCalledTimes(2)
      expect(onOperation).toHaveBeenCalledWith(6, bytes.length, expect.any(Number))
      expect(onOperation).toHaveBeenCalledWith(1, 0, expect.any(Number))
      expect(onError).not.toHaveBeenCalled()
    } finally {
      await bridge.close()
    }
  })

  it('reports an owner-fenced backend error instead of returning success-shaped data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kala-native-bridge-'))
    roots.push(root)
    const failure = Object.assign(new Error('fenced'), { code: 'RUNTIME_RESOURCE_OWNERSHIP_FENCED' })
    const fs: NativePosixFileSystem = {
      stat: async () => { throw failure }, write: async () => {}, readdir: async () => [],
      create: async () => {}, mkdir: async () => {}, read: async () => Buffer.alloc(0),
      truncate: async () => {}, remove: async () => {}, rename: async () => {},
      chmod: async () => {}, touch: async () => {}, sync: async () => {},
    }
    const onError = vi.fn()
    const socketPath = join(root, 'native.sock')
    const bridge = await startNativePosixBridge({ socketPath, fs, onError })
    try {
      await expect(call(socketPath, frame(1, Buffer.from('/cache.db')))).resolves.toMatchObject({ errno: 5 })
      expect(onError).toHaveBeenCalledWith(failure)
      await expect(startNativePosixBridge({ socketPath, fs, onError })).rejects.toThrow('already exists')
    } finally {
      await bridge.close()
    }
  })
})
