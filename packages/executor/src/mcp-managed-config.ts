import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { parseDashboardMcpServers, type DashboardMcpServerConfig } from './mcp-config.js'

const MAX_CONFIG_BYTES = 1024 * 1024

type SecureConfig = {
  value: Record<string, unknown>
  dev: number
  ino: number
  raw: string
}

export function readSecureConfig(path: string): SecureConfig {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('managed Executor config must be a regular file')
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('managed Executor config permissions must not allow group or other access')
  if (process.getuid && before.uid !== process.getuid()) throw new Error('managed Executor config owner is not the current identity')
  if (before.size > MAX_CONFIG_BYTES) throw new Error('managed Executor config is too large')

  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let raw: string
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('managed Executor config changed while opening')
    raw = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }

  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('managed Executor config must contain an object')
  return { value: parsed as Record<string, unknown>, dev: before.dev, ino: before.ino, raw }
}

export function readDashboardMcpServers(path: string): DashboardMcpServerConfig[] {
  const config = readSecureConfig(path)
  return parseDashboardMcpServers(config.value.mcpServers, 'managed Executor config mcpServers')
}

/**
 * Replaces only mcpServers while retaining every unrelated managed config key.
 * The existing file is checked again immediately before the atomic rename so a
 * path swap cannot redirect this write through a symlink or different inode.
 */
export function writeDashboardMcpServers(path: string, servers: readonly DashboardMcpServerConfig[], expected?: ReturnType<typeof readSecureConfig>, metadata?: unknown): void {
  const config = expected ?? readSecureConfig(path)
  // Refuse to let Dashboard management overwrite a config containing literal
  // env values, even though the replacement payload itself is secret-free.
  parseDashboardMcpServers(config.value.mcpServers, 'managed Executor config mcpServers')
  if (config.value._kalaManagedMcp && metadata === undefined) throw new Error('versioned MCP config requires the patch-v1 preserving writer')
  const next = `${JSON.stringify({ ...config.value, mcpServers: servers, ...(metadata ? { _kalaManagedMcp: metadata } : {}) }, null, 2)}\n`
  if (Buffer.byteLength(next, 'utf8') > MAX_CONFIG_BYTES) throw new Error('managed Executor config is too large')

  const directory = dirname(path)
  const temporary = join(directory, `.${randomBytes(16).toString('hex')}.mcp-config.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, next, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    const current = lstatSync(path)
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== config.dev || current.ino !== config.ino) {
      throw new Error('managed Executor config changed before replacement')
    }
    if (process.platform !== 'win32' && (current.mode & 0o077) !== 0) throw new Error('managed Executor config permissions became unsafe')
    if (readSecureConfig(path).raw !== config.raw) throw new Error('managed Executor config changed before replacement')
    renameSync(temporary, path)

    // Flush the directory entry where supported. Some platforms (notably
    // Windows) do not permit opening directories, while the file itself is
    // still durably flushed above.
    if (process.platform !== 'win32') {
      try {
        const directoryFd = openSync(directory, constants.O_RDONLY)
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      } catch { /* the replacement and its contents are already atomically committed */ }
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* absent after a successful rename */ }
    throw error
  }
}
