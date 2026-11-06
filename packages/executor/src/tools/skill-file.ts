import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import type { Tool } from './registry.js'
import type { ToolContext } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_BYTES = 256 * 1024
const inFlight = new Map<string, Promise<void>>()

export async function workspaceSkillTarget(name: string, cwd: string, sandbox: ToolContext['sandbox']): Promise<string> {
  return await sandbox.resolve(join(cwd, '.agent', 'skills', name, 'SKILL.md'), { cwd })
}

async function withSkillLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(path)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  inFlight.set(path, current)
  if (previous) await previous
  try {
    return await operation()
  } finally {
    if (inFlight.get(path) === current) inFlight.delete(path)
    release()
  }
}

async function readSkillFile(path: string): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > MAX_SKILL_BYTES) throw new ToolError('E2BIG', 'workspace skill exceeds size limit')
    const bytes = Buffer.alloc(MAX_SKILL_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_SKILL_BYTES) throw new ToolError('E2BIG', 'workspace skill exceeds size limit')
    return bytes.subarray(0, length)
  } finally {
    await file.close()
  }
}

export const skillFileTool: Tool = {
  name: 'skill_file',
  async run(input, ctx) {
    const name = input.name
    const action = input.action
    if (typeof name !== 'string' || name.length > 64 || !SKILL_NAME.test(name) ||
      !['read', 'create', 'replace', 'delete'].includes(String(action))) {
      throw new ToolError('EINVAL', 'invalid workspace skill action or name')
    }
    if (!ctx.cwd || !isAbsolute(ctx.cwd)) throw new ToolError('EACCES', 'workspace skill requires an absolute Executor cwd')
    const skillPath = await workspaceSkillTarget(name, ctx.cwd, ctx.sandbox)
    return withSkillLock(skillPath, async () => {
      const skillDir = dirname(skillPath)
      throwIfAborted(ctx)

      let existing: Buffer | undefined
      try {
        existing = await readSkillFile(skillPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const revision = existing ? createHash('sha256').update(existing).digest('hex') : undefined
      if (action === 'read') {
        return JSON.stringify(existing
          ? { exists: true, content: existing.toString('utf8'), revision }
          : { exists: false })
      }

      const expectedRevision = input.expected_revision
      if (action === 'create' && expectedRevision === undefined && existing) {
        throw new ToolError('EEXIST', 'workspace skill already exists')
      }
      if (action !== 'create' && !existing) throw new ToolError('ENOENT', 'workspace skill does not exist')
      if (action === 'replace' || action === 'delete' || expectedRevision !== undefined) {
        if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision) ||
          expectedRevision !== revision) throw new ToolError('ESTALE', 'workspace skill changed; read it again before writing')
      }
      throwIfAborted(ctx)
      if (action === 'delete') {
        await rm(skillPath)
        try { await rmdir(skillDir) } catch (error) {
          if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
        return JSON.stringify({ status: 'deleted' })
      }
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_SKILL_BYTES) {
        throw new ToolError('EINVAL', 'invalid workspace skill content')
      }
      await mkdir(skillDir, { recursive: true })
      throwIfAborted(ctx)
      if (!existing) {
        await writeFile(skillPath, input.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } else {
        const temporary = `${skillPath}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, input.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
          throwIfAborted(ctx)
          await rename(temporary, skillPath)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      return JSON.stringify({ status: existing ? 'replaced' : 'created' })
    })
  },
}
