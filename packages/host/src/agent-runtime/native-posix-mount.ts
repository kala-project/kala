import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { startNativePosixBridge } from '../store/native-posix-bridge.js'
import type { NativePosixFileSystem } from '../store/native-posix-fs.js'

export type NativePosixMount = { baseDirectory: string; assertReady(): Promise<void>; close(): Promise<void> }

/** Mounting is delegated to the operator's host broker, never to a privileged Runtime. */
export async function mountNativePosixSession(options: {
  root: string
  sessionId: string
  scope: string
  fs: NativePosixFileSystem
  onError(error: unknown): void
  onOperation?(operation: number, bytes: number, durationMs: number): void
}): Promise<NativePosixMount> {
  if (!isAbsolute(options.root) || !/^[a-z0-9_-][a-z0-9._-]{0,127}$/iu.test(options.sessionId)) {
    throw new Error('Invalid native POSIX mount root or external Session ID')
  }
  const root = await lstat(options.root)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077)) {
    throw new Error('Native POSIX root must be a private operator-provisioned directory')
  }
  await options.fs.stat('/')
  const key = createHash('sha256').update(options.scope).update(randomUUID()).digest('hex')
  const directory = join(options.root, key)
  await mkdir(directory, { mode: 0o700 })
  const bridgeDirectory = join(directory, 'bridge')
  const baseDirectory = join(directory, 'home')
  const mountpoint = join(baseDirectory, 'session-state', options.sessionId)
  await mkdir(bridgeDirectory, { mode: 0o700 })
  await mkdir(mountpoint, { recursive: true, mode: 0o700 })
  const bridge = await startNativePosixBridge({
    socketPath: join(bridgeDirectory, 'native.sock'), fs: options.fs, onError: options.onError,
    ...(options.onOperation ? { onOperation: options.onOperation } : {}),
  })
  async function request(action: 'mount' | 'unmount'): Promise<void> {
    const requestId = randomUUID()
    const temporary = join(directory, `${requestId}.tmp`)
    await writeFile(temporary, JSON.stringify({ requestId, action, sessionId: options.sessionId }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(directory, 'request.json'))
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      let raw: string | undefined
      try { raw = await readFile(join(directory, 'response.json'), 'utf8') } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (raw) {
        const response: unknown = JSON.parse(raw)
        if (typeof response === 'object' && response !== null && 'requestId' in response && response.requestId === requestId) {
          if (!('ok' in response) || response.ok !== true) throw new Error(`Native POSIX broker ${action} failed`)
          return
        }
      }
      await delay(50)
    }
    throw new Error(`Native POSIX broker ${action} timed out`)
  }
  try {
    await request('mount')
    if ((await statfs(mountpoint)).type !== 0x65735546) throw new Error('Native POSIX mount is not a FUSE filesystem')
    await options.fs.stat('/')
    let closed = false
    return { baseDirectory, assertReady: async () => {
      if (closed || (await statfs(mountpoint)).type !== 0x65735546) {
        throw new Error('Native POSIX mount is unavailable; refusing local filesystem access')
      }
      await options.fs.stat('/')
    }, close: async () => {
      if (closed) return
      await request('unmount')
      await bridge.close()
      closed = true
    } }
  } catch (error) {
    try { await request('unmount') } catch (cleanupError) { options.onError(cleanupError) }
    await bridge.close()
    throw error
  }
}
