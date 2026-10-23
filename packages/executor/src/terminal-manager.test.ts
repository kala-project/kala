import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ptySpawn = vi.fn()
vi.mock('node-pty', () => ({ spawn: ptySpawn }))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn> }
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdin = { write: vi.fn() }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
  }),
}))

import { spawn } from 'node:child_process'
import { createTerminalManager } from './terminal-manager.js'

const base = { workspaceId: 'ws', sessionId: 'session' }

describe('TerminalManager', () => {
  afterEach(() => {
    delete process.env.KALA_TERMINAL_DISABLE_PTY
    vi.clearAllMocks()
  })

  it('falls back when node-pty imports but its platform native module fails during spawn', async () => {
    ptySpawn.mockImplementationOnce(() => { throw new Error('Failed to load native module: conpty.node') })
    const manager = createTerminalManager({
      sandbox: { roots: [], resolve: async (path) => path },
      emitOutput: vi.fn(),
      emitExit: vi.fn(),
    })

    const created = await manager.create({ ...base, requestId: 'native-missing', cwd: '/tmp' })

    expect(created.error).toBeUndefined()
    expect(created.terminalId).toBeTruthy()
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('terminates Windows ConPTY without a signal for kill and session cleanup', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const originalShell = process.env.SHELL
    delete process.env.SHELL
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
    try {
      const native = {
        write: vi.fn(), resize: vi.fn(), kill: vi.fn((signal?: NodeJS.Signals) => {
          if (signal) throw new Error('Signals not supported on windows.')
        }),
        onData: vi.fn(), onExit: vi.fn(),
      }
      ptySpawn.mockReturnValue(native)
      const manager = createTerminalManager({ sandbox: { roots: [], resolve: async (path) => path }, emitOutput: vi.fn(), emitExit: vi.fn() })
      const first = await manager.create({ ...base, requestId: 'win-kill', cwd: 'C:\\workspace' })
      expect(first.error).toBeUndefined()
      expect(ptySpawn).toHaveBeenCalledWith('powershell.exe', [], expect.any(Object))
      expect(manager.kill({ ...base, requestId: 'win-killed', terminalId: first.terminalId! }).killed).toBe(true)
      expect(native.kill).toHaveBeenCalledWith()
      const second = await manager.create({ ...base, requestId: 'win-close', cwd: 'C:\\workspace' })
      expect(second.error).toBeUndefined()
      manager.closeSession(base)
      expect(native.kill).toHaveBeenCalledTimes(2)
      expect(native.kill).toHaveBeenLastCalledWith()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      if (originalShell === undefined) delete process.env.SHELL
      else process.env.SHELL = originalShell
    }
  })

  it('keeps one terminal per Session, replays a 1 MiB ring, and closes only that Session', async () => {
    process.env.KALA_TERMINAL_DISABLE_PTY = '1'
    const manager = createTerminalManager({
      sandbox: { roots: [], resolve: async (path) => path },
      emitOutput: vi.fn(),
      emitExit: vi.fn(),
    })

    const first = await manager.create({ ...base, requestId: 'r1', cwd: '/tmp' })
    expect(spawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? expect.any(String) : 'script',
      process.platform === 'darwin'
        ? ['-q', '/dev/null', expect.any(String)]
        : process.platform === 'win32'
          ? []
          : ['-qfec', expect.any(String), '/dev/null'],
      expect.objectContaining({ cwd: '/tmp', stdio: 'pipe' }),
    )
    const fallbackArgs = vi.mocked(spawn).mock.calls[0]![1] as string[]
    const resizePath = fallbackArgs.join(' ').match(/control='([^']+)'/)?.[1]
    if (process.platform !== 'win32') {
      expect(resizePath).toBeTruthy()
      manager.resize({ ...base, terminalId: first.terminalId!, cols: 148, rows: 46 })
      expect(readFileSync(resizePath!, 'utf8')).toBe('148 46\n')
    }
    const child = vi.mocked(spawn).mock.results[0]!.value as { stdin: { write: ReturnType<typeof vi.fn> }; stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }
    manager.input({ ...base, terminalId: first.terminalId!, data: 'echo works\r' })
    expect(child.stdin.write).toHaveBeenCalledWith(process.platform === 'win32' ? 'echo works\n' : 'echo works\r')
    child.stdout.emit('data', Buffer.from('a'.repeat(1_048_576) + 'tail'))

    const reused = await manager.create({ ...base, requestId: 'r2', cwd: '/elsewhere' })
    expect(reused).toMatchObject({ requestId: 'r2', terminalId: first.terminalId, reused: true })
    expect(Buffer.byteLength(reused.replay ?? '')).toBe(1_048_576)
    expect(reused.replay?.endsWith('tail')).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)

    const killed = manager.kill({ ...base, requestId: 'kill-1', terminalId: first.terminalId! })
    expect(killed.killed).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    if (resizePath) expect(existsSync(resizePath)).toBe(false)

    const restarted = await manager.create({ ...base, requestId: 'r3', cwd: '/tmp' })
    expect(restarted.terminalId).not.toBe(first.terminalId)
    expect(restarted.reused).not.toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
    manager.input({ ...base, terminalId: restarted.terminalId!, data: 'after restart\r' })
    const restartedChild = vi.mocked(spawn).mock.results[1]!.value as { stdin: { write: ReturnType<typeof vi.fn> } }
    expect(restartedChild.stdin.write).toHaveBeenCalledWith(process.platform === 'win32' ? 'after restart\n' : 'after restart\r')

    manager.closeSession(base)
  })

  it.each(['linux', 'darwin', 'win32'])('preserves control bytes in the %s fallback, with CR normalization only for Windows pipes', async (platform) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    process.env.KALA_TERMINAL_DISABLE_PTY = '1'
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    const manager = createTerminalManager({
      sandbox: { roots: [], resolve: async (path) => path },
      emitOutput: vi.fn(),
      emitExit: vi.fn(),
    })
    try {
      const created = await manager.create({ ...base, requestId: 'raw-bytes', cwd: '/workspace' })
      expect(created.error).toBeUndefined()
      const data = '\r\n\u0004\u0003\u001a\u0002\u000b\u0015\t\u001b\u001b[A\u001bOA'
      manager.input({ ...base, terminalId: created.terminalId!, data })
      const child = vi.mocked(spawn).mock.results.at(-1)!.value as { stdin: { write: ReturnType<typeof vi.fn> } }
      expect(child.stdin.write).toHaveBeenCalledWith(platform === 'win32' ? data.replaceAll('\r', '\n') : data)
    } finally {
      manager.closeAll()
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it.each(['closeSession', 'closeAll'] as const)('cancels a pending native create on %s without leaving a late PTY', async (operation) => {
    let complete!: (native: unknown) => void
    const delayed = new Promise((resolve) => { complete = resolve })
    ptySpawn.mockReturnValueOnce(delayed)
    const native = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    const manager = createTerminalManager({ sandbox: { roots: [], resolve: async (path) => path }, emitOutput: vi.fn(), emitExit: vi.fn() })
    const pending = manager.create({ ...base, requestId: 'pending', cwd: '/workspace' })
    await vi.waitFor(() => expect(ptySpawn).toHaveBeenCalledOnce())
    if (operation === 'closeSession') manager.closeSession(base)
    else manager.closeAll()
    complete(native)
    await expect(pending).resolves.toMatchObject({ error: 'terminal create cancelled' })
    expect(native.kill).toHaveBeenCalledOnce()
    expect(manager.activeCount()).toBe(0)
  })

  it('does not close a replacement terminal when an older cancelled create finishes', async () => {
    let complete!: (native: unknown) => void
    const delayed = new Promise((resolve) => { complete = resolve })
    const oldNative = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    const newNative = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    ptySpawn.mockReturnValueOnce(delayed).mockReturnValueOnce(newNative)
    const manager = createTerminalManager({ sandbox: { roots: [], resolve: async (path) => path }, emitOutput: vi.fn(), emitExit: vi.fn() })
    const pending = manager.create({ ...base, requestId: 'old', cwd: '/workspace' })
    await vi.waitFor(() => expect(ptySpawn).toHaveBeenCalledOnce())
    manager.closeSession(base)
    const replacement = await manager.create({ ...base, requestId: 'new', cwd: '/workspace' })
    complete(oldNative)
    await expect(pending).resolves.toMatchObject({ error: 'terminal create cancelled' })
    expect(oldNative.kill).toHaveBeenCalledOnce()
    expect(newNative.kill).not.toHaveBeenCalled()
    manager.input({ ...base, terminalId: replacement.terminalId!, data: 'still alive\r' })
    expect(newNative.write).toHaveBeenCalledWith('still alive\r')
    manager.closeAll()
  })

  it('caps live terminal output and terminates chatty sessions', async () => {
    process.env.KALA_TERMINAL_DISABLE_PTY = '1'
    const emitOutput = vi.fn()
    const manager = createTerminalManager({
      sandbox: { roots: [], resolve: async (path) => path },
      emitOutput,
      emitExit: vi.fn(),
      maxOutputBytes: 64,
    })

    const created = await manager.create({ ...base, requestId: 'capped', cwd: '/tmp' })
    const child = vi.mocked(spawn).mock.results[0]!.value as { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }
    child.stdout.emit('data', Buffer.from('x'.repeat(100)))

    expect(emitOutput).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: 'x'.repeat(64) }))
    expect(emitOutput).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: '\n[terminal output truncated after 64 bytes]\n' }))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    const reused = await manager.create({ ...base, requestId: 'replay', cwd: '/tmp' })
    expect(reused.replay).toBe(`${'x'.repeat(64)}\n[terminal output truncated after 64 bytes]\n`)
    manager.closeAll()
  })
})
