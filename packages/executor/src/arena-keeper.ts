import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import { leaderIdentity, type ArenaProcessGroup } from './tools/arena-process-groups.js'

export async function assertArenaKeeper(identityFile: string | undefined): Promise<ArenaProcessGroup> {
  if (process.platform !== 'linux' || !identityFile || !isAbsolute(identityFile)) {
    throw new Error('Arena admission requires an independently operated Linux PID-namespace keeper')
  }
  const info = await lstat(identityFile)
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('Arena keeper identity must be an owner-only regular file')
  }
  const identity = JSON.parse(await readFile(identityFile, 'utf8')) as ArenaProcessGroup
  if (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 0
    || identity.pgid === process.pid
    || !/^\d+$/u.test(identity.leaderStartTicks) || !/^pid:\[\d+\]$/u.test(identity.pidNamespace)
    || !/^[a-f0-9-]{36}$/u.test(identity.bootId)) {
    throw new Error('Arena keeper identity is malformed')
  }
  const actual = await leaderIdentity(identity.pgid)
  const stat = await readFile(`/proc/${identity.pgid}/stat`, 'utf8')
  if (/^[ZX](?:\s|$)/u.test(stat.slice(stat.lastIndexOf(') ') + 2))) {
    throw new Error('Arena PID-namespace keeper exited')
  }
  const self = await leaderIdentity(process.pid)
  if (actual.leaderStartTicks !== identity.leaderStartTicks || actual.bootId !== identity.bootId
    || actual.pidNamespace !== identity.pidNamespace || self.pidNamespace !== identity.pidNamespace) {
    throw new Error('Original Arena PID-namespace keeper is not healthy')
  }
  return identity
}

/** Run independently of the Executor service; an unexpected exit leaves a stale, rejected identity. */
export async function runArenaKeeper(identityFile: string): Promise<void> {
  if (process.platform !== 'linux' || !isAbsolute(identityFile)) {
    throw new Error('Arena keeper requires Linux and an absolute identity file')
  }
  const directory = await lstat(dirname(identityFile))
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) {
    throw new Error('Arena keeper directory must be owned and accessible only by the service user')
  }
  const identity = await leaderIdentity(process.pid)
  const next = `${identityFile}.next-${randomUUID()}`
  const file = await open(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(`${JSON.stringify(identity)}\n`); await file.sync() }
  finally { await file.close() }
  try {
    await rename(next, identityFile)
    const heartbeat = setInterval(() => {}, 60_000)
    try {
      await new Promise<void>((resolve) => {
        process.once('SIGTERM', resolve)
        process.once('SIGINT', resolve)
      })
    } finally { clearInterval(heartbeat) }
  } finally { await unlink(next).catch(() => undefined) }
}
