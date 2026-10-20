import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { createConfig, createInitialState } from '@agent-kernel/kernel'

const io = vi.hoisted(() => ({
  directory: '',
  logPath: '',
  modes: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const path = String(args[0])
      const mode = String(args[1])
      if (path === io.directory && mode === 'r') throw Object.assign(new Error('directory fsync unsupported'), { code: 'EPERM' })
      if (path === io.logPath) {
        io.modes.push(mode)
        if (mode === 'r') throw Object.assign(new Error('read-only fsync unsupported'), { code: 'EPERM' })
      }
      return await actual.open(...args)
    },
  }
})

import { SessionStore } from './session.js'
import { appendSnapshotEntry, snapshotSidecarPath, writeHeader } from './log.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  io.directory = ''
  io.logPath = ''
  io.modes.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('flushes durable queue metadata through a writable log handle on Windows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kala-windows-queue-'))
  roots.push(root)
  const store = new SessionStore(root)
  const record = await store.create({ sessionId: 'windows-queue', config: createConfig({ tools: [] }) })
  io.logPath = record.logPath
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await store.appendRuntimeMetadata(record.sessionId, { action: 'message_queue_snapshot', payload: { items: [] } }, { durable: true })
  expect(io.modes).toContain('r+')
  expect(io.modes).not.toContain('r')
})

it('flushes the snapshot file but skips the unsupported Windows parent-directory fsync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kala-windows-snapshot-'))
  roots.push(root)
  const logPath = join(root, 'session.jsonl')
  const state = createInitialState(createConfig({ tools: [] }))
  await writeHeader({ path: logPath, sessionId: 'windows-snapshot', config: createConfig({ tools: [] }), initialState: state })
  io.directory = root
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await appendSnapshotEntry(logPath, 0, state)
  expect(JSON.parse(await readFile(snapshotSidecarPath(logPath), 'utf8'))).toMatchObject({ seq: 0, logSize: expect.any(Number) })
})

it('still propagates POSIX parent-directory fsync failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kala-posix-snapshot-'))
  roots.push(root)
  const logPath = join(root, 'session.jsonl')
  const state = createInitialState(createConfig({ tools: [] }))
  await writeHeader({ path: logPath, sessionId: 'posix-snapshot', config: createConfig({ tools: [] }), initialState: state })
  io.directory = root
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  await expect(appendSnapshotEntry(logPath, 0, state)).rejects.toMatchObject({ code: 'EPERM' })
})
