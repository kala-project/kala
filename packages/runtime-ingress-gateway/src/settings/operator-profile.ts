import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schema } from '@agent-kernel/shared'
import type { SecretResolver } from '@agent-kernel/shared/secret-resolver'
import { OperatorPlanError } from './operator-plan.js'

/** Snapshot an existing protected file; do not follow a substituted final symlink. */
export async function readOperatorProtectedFile(path: string, maximumBytes = 1024 * 1024): Promise<Buffer> {
  if (!isAbsolute(path) || path.includes('\0') || process.platform === 'win32'
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024) {
    throw new OperatorPlanError('invalid_profile')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new OperatorPlanError('invalid_profile') })
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n) !== 0n
      || before.size < 1n || before.size > BigInt(maximumBytes)) throw new OperatorPlanError('invalid_profile')
    const data = Buffer.alloc(maximumBytes + 1)
    let length = 0
    while (length < data.length) {
      const read = await handle.read(data, length, data.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (length !== Number(before.size) || length > maximumBytes
      || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new OperatorPlanError('invalid_profile')
    }
    return Buffer.from(data.subarray(0, length))
  } catch {
    throw new OperatorPlanError('invalid_profile')
  } finally { await handle.close().catch(() => { throw new OperatorPlanError('invalid_profile') }) }
}

export async function readOperatorProfile(path: string): Promise<schema.SettingsOperatorProfile> {
  try {
    const value: unknown = JSON.parse((await readOperatorProtectedFile(path)).toString('utf8'))
    const parsed = schema.SettingsOperatorProfileSchema.safeParse(value)
    if (!parsed.success) throw new Error()
    return parsed.data
  } catch { throw new OperatorPlanError('invalid_profile') }
}

export async function resolveOperatorSecret(reference: string, resolver?: SecretResolver): Promise<string> {
  try {
    let value: string
    if (reference.startsWith('file:')) {
      const url = new URL(reference)
      if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw new Error()
      value = (await readOperatorProtectedFile(fileURLToPath(url), 64 * 1024)).toString('utf8').trim()
    } else if (reference.startsWith('bao:') && resolver) {
      value = (await resolver.resolve(reference)).trim()
    } else throw new Error()
    if (!value || Buffer.byteLength(value) > 64 * 1024 || value.includes('\0')) throw new Error()
    return value
  } catch {
    // Resolver/filesystem errors can contain credential material and protected paths.
    throw new OperatorPlanError('invalid_profile')
  }
}
