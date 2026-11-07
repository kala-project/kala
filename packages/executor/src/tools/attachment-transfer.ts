import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink, link } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Sandbox } from '../sandbox.js'
import { isPathInsideRoot } from '../sandbox.js'
import type { Tool, ToolContext } from './registry.js'

const MAX_FILE = 16 * 1024 * 1024
const MAX_CHUNK = 256 * 1024
const MAX_STAGED = 64 * 1024 * 1024
const MAX_TRANSFERS = 4
const TTL = 60 * 60 * 1000

type Request = {
  action: 'begin' | 'chunk' | 'finish' | 'abort' | 'status'
  transferId: string
  path: string
  bytes: number
  sha256: string
  overwrite?: boolean
  offset?: number
  data?: string
}
type Result = { ok: boolean; state?: string; nextOffset?: number; path?: string; bytes?: number; sha256?: string; error?: string }
type Transfer = {
  id: string
  sessionId: string
  generation: string
  path: string
  bytes: number
  sha256: string
  overwrite: boolean
  stage: string
  offset: number
  updated: number
}

const active = new Map<string, Transfer>()
const finished = new Map<string, Transfer & { state: 'completed' | 'aborted' }>()
const stagingDirs = new Set<string>()
let queue: Promise<void> = Promise.resolve()
export async function attachmentTransferOwnerMatches(
  sandbox: Sandbox, transferId: unknown, sessionId: string, generation?: string,
): Promise<boolean> {
  if (typeof transferId !== 'string') return true
  const root = await realpath(sandbox.roots[0] ?? process.cwd())
  const entry = active.get(`${root}\0${transferId}`) ?? finished.get(`${root}\0${transferId}`)
  return !entry || (entry.sessionId === sessionId && entry.generation === (generation ?? ''))
}
function stateOf(entry: Transfer): string {
  return 'state' in entry ? String(entry.state) : 'active'
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task)
  queue = result.then(() => undefined, () => undefined)
  return result
}

function parse(input: Record<string, unknown>): Request {
  const { action, transferId, path, bytes, sha256, overwrite, offset, data } = input
  if (!['begin', 'chunk', 'finish', 'abort', 'status'].includes(String(action))
    || typeof transferId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(transferId)
    || typeof path !== 'string' || path.length === 0 || path.length > 4096
    || !Number.isSafeInteger(bytes) || (bytes as number) < 1 || (bytes as number) > MAX_FILE
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
    || (overwrite !== undefined && typeof overwrite !== 'boolean')
    || (offset !== undefined && (!Number.isSafeInteger(offset) || (offset as number) < 0))
    || (data !== undefined && typeof data !== 'string')) throw new Error('invalid transfer request')
  if (action === 'chunk' ? offset === undefined || data === undefined : offset !== undefined || data !== undefined) {
    throw new Error('invalid action fields')
  }
  return { action: action as Request['action'], transferId, path, bytes: bytes as number, sha256,
    ...(overwrite !== undefined ? { overwrite } : {}),
    ...(offset !== undefined ? { offset: offset as number } : {}),
    ...(data !== undefined ? { data } : {}) }
}

async function optionalStat(path: string) {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function targetPath(input: string, sandbox: Sandbox): Promise<{ root: string; path: string }> {
  const root = await realpath(sandbox.roots[0] ?? process.cwd())
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input)
  if (!isPathInsideRoot(absolute, root) || absolute === root
    || isPathInsideRoot(absolute, join(root, '.kala', 'attachment-transfers'))
    || basename(absolute) === '.' || basename(absolute) === '..') {
    throw new Error('target is outside workspace')
  }
  const parts = relative(root, absolute).split(sep)
  let cursor = root
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part)
    const info = await lstat(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('target parent must be a real directory')
  }
  const existing = await optionalStat(absolute)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('target cannot be a symlink or non-file')
  if (await sandbox.resolve(absolute) !== absolute) throw new Error('target resolves through a symlink')
  return { root, path: absolute }
}

async function stageDirectory(root: string): Promise<string> {
  const kala = join(root, '.kala')
  if (!await optionalStat(kala)) await mkdir(kala, { mode: 0o700 })
  const kalaInfo = await lstat(kala)
  if (!kalaInfo.isDirectory() || kalaInfo.isSymbolicLink()) throw new Error('invalid workspace staging directory')
  const dir = join(kala, 'attachment-transfers')
  if (!await optionalStat(dir)) await mkdir(dir, { mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid attachment staging directory')
  stagingDirs.add(dir)
  return dir
}

async function sweep(dir: string): Promise<{ count: number; bytes: number }> {
  for (const [key, entry] of active) {
    if (Date.now() - entry.updated > TTL) {
      await rm(entry.stage, { force: true })
      active.delete(key)
    }
  }
  for (const [key, entry] of finished) {
    if (Date.now() - entry.updated > TTL || finished.size > 128) finished.delete(key)
  }
  let count = 0, bytes = 0
  for (const name of await readdir(dir)) {
    if (!/^transfer-[a-f0-9-]{36}\.part$/u.test(name)) continue
    const path = join(dir, name)
    const info = await optionalStat(path)
    if (!info) continue
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe attachment staging entry')
    if (Date.now() - info.mtimeMs > TTL && ![...active.values()].some((entry) => entry.stage === path)) {
      await unlink(path)
      continue
    }
    count++
    bytes += info.size
  }
  return { count, bytes }
}

const reaper = setInterval(() => {
  void serialized(async () => {
    for (const dir of stagingDirs) await sweep(dir)
  }).catch((error: unknown) => {
    console.warn('[attachment-transfer] staging cleanup failed', error)
  })
}, 60_000)
reaper.unref()

async function syncDirectory(path: string): Promise<void> {
  // Windows does not permit Node to open directories for fsync; NTFS journals
  // directory updates, while the staged file itself is explicitly synced.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function matchesPublished(path: string, req: Request): Promise<boolean> {
  const info = await optionalStat(path)
  if (!info || !info.isFile() || info.size !== req.bytes) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: MAX_CHUNK })) hash.update(chunk as Buffer)
  return hash.digest('hex') === req.sha256
}

export function createAttachmentTransferTool(): Tool {
  return {
    name: '__workspace_attachment_transfer',
    async run(input, ctx) {
      try {
        const req = parse(input)
        if (ctx.origin !== 'host') throw new Error('Host admission required')
        const generation = ctx.ownerGeneration ?? ''
        return JSON.stringify(await serialized(async (): Promise<Result> => {
          if (ctx.signal.aborted) throw new Error('transfer canceled')
          const { root, path } = await targetPath(req.path, ctx.sandbox)
          const key = `${root}\0${req.transferId}`
          const existing = active.get(key) ?? finished.get(key)
          if (existing && (existing.sessionId !== ctx.sessionId || existing.generation !== generation
            || existing.path !== path || existing.bytes !== req.bytes || existing.sha256 !== req.sha256
            || (req.overwrite !== undefined && existing.overwrite !== req.overwrite))) {
            throw new Error('transfer identity conflict')
          }
          if (req.action === 'status') return existing
            ? { ok: true, state: stateOf(existing),
              nextOffset: existing.offset, path, bytes: existing.bytes, sha256: existing.sha256 }
            : await matchesPublished(path, req)
              ? { ok: true, state: 'completed', nextOffset: req.bytes, path, bytes: req.bytes, sha256: req.sha256 }
              : { ok: true, state: 'absent', nextOffset: 0 }
          if (req.action === 'begin') {
            if (existing) return { ok: true, state: stateOf(existing),
              nextOffset: existing.offset, path, bytes: req.bytes, sha256: req.sha256 }
            if (await matchesPublished(path, req)) {
              finished.set(key, { id: req.transferId, sessionId: ctx.sessionId, generation,
                path, bytes: req.bytes, sha256: req.sha256, overwrite: req.overwrite ?? false,
                stage: '', offset: req.bytes, updated: Date.now(), state: 'completed' })
              return { ok: true, state: 'completed', nextOffset: req.bytes,
                path, bytes: req.bytes, sha256: req.sha256 }
            }
            const dir = await stageDirectory(root)
            const usage = await sweep(dir)
            if (usage.count >= MAX_TRANSFERS || usage.bytes + req.bytes > MAX_STAGED) throw new Error('transfer capacity exceeded')
            if (await optionalStat(path) && !req.overwrite) throw new Error('target already exists')
            const stage = join(dir, `transfer-${randomUUID()}.part`)
            const handle = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
            try { await handle.sync() } finally { await handle.close() }
            await syncDirectory(dir)
            active.set(key, { id: req.transferId, sessionId: ctx.sessionId, generation,
              path, bytes: req.bytes, sha256: req.sha256, overwrite: req.overwrite ?? false,
              stage, offset: 0, updated: Date.now() })
            return { ok: true, state: 'active', nextOffset: 0, path, bytes: req.bytes, sha256: req.sha256 }
          }
          if (!existing) {
            if (req.action === 'abort') return { ok: true, state: 'absent', nextOffset: 0 }
            if (req.action === 'finish' && await matchesPublished(path, req)) {
              return { ok: true, state: 'completed', nextOffset: req.bytes,
                path, bytes: req.bytes, sha256: req.sha256 }
            }
            return { ok: false, state: 'absent', error: 'unknown transfer' }
          }
          if ('state' in existing) return { ok: req.action !== 'chunk', state: stateOf(existing),
            nextOffset: existing.offset, path, bytes: req.bytes, sha256: req.sha256,
            ...(req.action === 'chunk' ? { error: 'transfer is closed' } : {}) }
          existing.updated = Date.now()
          if (req.action === 'abort') {
            await rm(existing.stage, { force: true })
            active.delete(key)
            finished.set(key, { ...existing, state: 'aborted' })
            return { ok: true, state: 'aborted', nextOffset: existing.offset }
          }
          if (req.action === 'chunk') {
            const encoded = req.data!
            if (encoded.length === 0 || encoded.length > Math.ceil(MAX_CHUNK / 3) * 4
              || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
              throw new Error('invalid base64 chunk')
            }
            const data = Buffer.from(encoded, 'base64')
            if (data.length === 0 || data.length > MAX_CHUNK || data.toString('base64') !== encoded
              || req.offset! + data.length > req.bytes) throw new Error('invalid chunk size or encoding')
            if (req.offset! < existing.offset && req.offset! + data.length <= existing.offset) {
              const handle = await open(existing.stage, 'r')
              try {
                const previous = Buffer.allocUnsafe(data.length)
                const { bytesRead } = await handle.read(previous, 0, data.length, req.offset)
                if (bytesRead !== data.length || !previous.equals(data)) throw new Error('retry data conflict')
              } finally { await handle.close() }
              return { ok: true, state: 'active', nextOffset: existing.offset }
            }
            if (req.offset !== existing.offset) throw new Error(`unexpected offset; expected ${existing.offset}`)
            const handle = await open(existing.stage, 'r+')
            try {
              let written = 0
              try {
                while (written < data.length) {
                  if (ctx.signal.aborted) throw new Error('transfer canceled')
                  const result = await handle.write(data, written, data.length - written, existing.offset + written)
                  if (!result.bytesWritten) throw new Error('short transfer write')
                  written += result.bytesWritten
                }
                await handle.sync()
                if (ctx.signal.aborted) throw new Error('transfer canceled')
              } catch (error) {
                await handle.truncate(existing.offset)
                throw error
              }
            } finally { await handle.close() }
            existing.offset += data.length
            return { ok: true, state: 'active', nextOffset: existing.offset }
          }
          if (existing.offset !== existing.bytes) throw new Error('transfer is incomplete')
          const hash = createHash('sha256')
          let size = 0
          for await (const chunk of createReadStream(existing.stage, { highWaterMark: MAX_CHUNK })) {
            if (ctx.signal.aborted) throw new Error('transfer canceled')
            size += (chunk as Buffer).length
            hash.update(chunk as Buffer)
          }
          if (ctx.signal.aborted) throw new Error('transfer canceled')
          if (size !== existing.bytes || hash.digest('hex') !== existing.sha256) {
            throw new Error('attachment size or SHA-256 mismatch')
          }
          await targetPath(req.path, ctx.sandbox)
          if (ctx.signal.aborted) throw new Error('transfer canceled')
          if (existing.overwrite) await rename(existing.stage, existing.path)
          else {
            await link(existing.stage, existing.path)
          }
          active.delete(key)
          finished.set(key, { ...existing, updated: Date.now(), state: 'completed' })
          await syncDirectory(dirname(existing.path))
          if (!existing.overwrite) await unlink(existing.stage)
          await syncDirectory(dirname(existing.stage))
          return { ok: true, state: 'completed', nextOffset: existing.bytes,
            path, bytes: existing.bytes, sha256: existing.sha256 }
        }))
      } catch (error) {
        return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Result)
      }
    },
  }
}
