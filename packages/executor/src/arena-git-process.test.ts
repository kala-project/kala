import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startExecutor } from './client.js'
import { assertGroupStopped } from './tools/arena-process-groups.js'
import { arenaGitInitTool } from './tools/arena-git-mutation.js'
import type { ArenaProcessGroup } from './tools/arena-process-groups.js'

describe('Arena Git process-group journal', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('durably records each Git group before worktree mutation and verifies it stopped', async () => {
    const root = mkdtempSync(join(process.cwd(), 'arena-group-'))
    dirs.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    writeFileSync(join(root, 'a.txt'), 'base\n')
    git('add', 'a.txt')
    git('commit', '-m', 'base')
    const events = new EventEmitter()
    const socket = {
      io: new EventEmitter(), connected: true, auth: undefined,
      emit: () => true,
      on: (name: string, handler: (...args: unknown[]) => void) => { events.on(name, handler) },
      off: (name: string, handler: (...args: unknown[]) => void) => { events.off(name, handler) },
      disconnect() { this.connected = false },
      trigger(name: string, ...args: unknown[]) { events.emit(name, ...args) },
    }
    const receiptStorePath = join(root, 'receipts.json')
    const handle = startExecutor({
      host: 'http://localhost', workspaceId: 'arena-group', executorId: 'group',
      sandboxRoots: [root], receiptStorePath, tools: [arenaGitInitTool], ioFactory: (() => socket) as never,
    })
    try {
      const ack = vi.fn()
      socket.trigger('tool:call', {
        origin: 'host', sessionId: 'session', callId: 'arena-init-GROUP',
        name: 'arena_git_init', ownerGeneration: '1',
        input: { ownerGeneration: '1', arenaId: 'group', baseRef: 'HEAD', candidates: ['one'] },
      }, ack)
      await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true })), { timeout: 15_000 })
      const result = JSON.parse(readFileSync(receiptStorePath, 'utf8')) as Record<string, {
        processGroups?: ArenaProcessGroup[]; result?: { ok: boolean }
      }>
      const receipt = result['session:arena-init-GROUP']!
      expect(receipt.result?.ok).toBe(true)
      expect(receipt.processGroups?.length).toBeGreaterThan(2)
      for (const group of receipt.processGroups ?? []) await expect(assertGroupStopped(group)).resolves.toBeUndefined()
      await expect(assertGroupStopped({ ...receipt.processGroups![0]!, pidNamespace: 'pid:[0]' }))
        .rejects.toThrow('PID namespace')
    } finally { await handle.close() }
  }, 20_000)
})
