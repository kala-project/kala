import process from 'node:process'
import { spawn as spawnChild } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type {
  ClientTerminalCloseSession,
  ClientTerminalCreate,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  ServerTerminalExit,
  ServerTerminalOutput,
  TerminalCreateResult,
  TerminalKillResult,
} from '@agent-kernel/shared'

import type { Sandbox } from './sandbox.js'

type TerminalProcess = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: NodeJS.Signals): void
  onData(cb: (data: string) => void): void
  onExit(cb: (event: { exitCode: number; signal: number | string | null }) => void): void
}

type NodePtyModule = {
  spawn(
    shell: string,
    args: readonly string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: NodeJS.ProcessEnv
    },
  ): TerminalProcess
}

function terminalDiagnostic(phase: string): void {
  if (process.env.KALA_TERMINAL_DIAGNOSTICS === '1') process.stderr.write(`[kala-terminal] ${phase}\n`)
}

function terminateTerminal(terminal: TerminalProcess): void {
  // node-pty defaults to SIGHUP on Unix: interactive shells may ignore SIGTERM.
  // ConPTY rejects explicit signals; the pipe fallback supplies its own SIGTERM.
  terminal.kill()
}

async function tryLoadNodePty(): Promise<NodePtyModule | undefined> {
  if (process.env.KALA_TERMINAL_DISABLE_PTY === '1') return undefined
  try {
    terminalDiagnostic('loading node-pty')
    const mod = await import('node-pty') as NodePtyModule | { default?: NodePtyModule }
    terminalDiagnostic('node-pty loaded')
    return 'spawn' in mod ? mod : mod.default
  } catch {
    terminalDiagnostic('node-pty import unavailable')
    return undefined
  }
}

function createFallbackTerminal(input: {
  shell: string
  cwd: string
  cols: number
  rows: number
  env: NodeJS.ProcessEnv
}): TerminalProcess {
  // Release executors are shipped as a single CJS/SEA artifact. Native
  // node-pty cannot always be loaded beside that artifact, so on Unix use the
  // ubiquitous `script` utility as a real PTY bridge instead of launching the
  // shell over plain pipes. A pipe-backed shell does not echo keystrokes and
  // made the dashboard look completely unable to accept input.
  const resizeDir = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'kala-terminal-'))
  const resizePath = resizeDir ? join(resizeDir, 'size') : undefined
  if (resizePath) writeFileSync(resizePath, `${input.cols} ${input.rows}\n`, { mode: 0o600 })
  const shellCommand = resizePath
    ? [
        `control=${quoteShell(resizePath)};`,
        `(last=''; while sleep 0.05; do current=$(cat "$control" 2>/dev/null) || continue; [ "$current" = "$last" ] && continue; set -- $current; stty cols "$1" rows "$2" < /dev/tty 2>/dev/null || true; last=$current; done) &`,
        'watcher=$!',
        `${quoteShell(input.shell)}; status=$?`,
        'kill "$watcher" 2>/dev/null || true',
        'wait "$watcher" 2>/dev/null || true',
        'exit "$status"',
      ].join(' ')
    : input.shell
  const command = process.platform === 'win32' ? input.shell : 'script'
  const args = process.platform === 'darwin'
    ? ['-q', '/dev/null', shellCommand]
    : process.platform === 'win32'
      ? []
      : ['-qfec', shellCommand, '/dev/null']
  let cleaned = false
  const cleanup = () => {
    if (cleaned || !resizeDir) return
    cleaned = true
    rmSync(resizeDir, { recursive: true, force: true })
  }
  let child
  try {
    child = spawnChild(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: 'pipe',
    })
  } catch (error) {
    cleanup()
    throw error
  }

  return {
    write(data) {
      // Windows pipe shells and the last-resort non-PTY path do not have a
      // terminal line discipline to translate Return (CR) into newline (LF).
      // Normalize here as well; it is harmless for `script` and makes Enter
      // execute commands even before an older Executor is upgraded to PTY.
      child.stdin.write(data.replaceAll('\r', '\n'))
    },
    resize(cols, rows) {
      if (resizePath && !cleaned) writeFileSync(resizePath, `${cols} ${rows}\n`, { mode: 0o600 })
    },
    kill(signal = 'SIGTERM') {
      child.kill(signal)
      cleanup()
    },
    onData(cb) {
      child.stdout.on('data', (chunk) => cb(String(chunk)))
      child.stderr.on('data', (chunk) => cb(String(chunk)))
    },
    onExit(cb) {
      child.on('exit', (exitCode, signal) => {
        cleanup()
        cb({ exitCode: exitCode ?? 0, signal })
      })
    },
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function spawnTerminal(input: {
  shell: string
  cwd: string
  cols: number
  rows: number
  env: NodeJS.ProcessEnv
}): Promise<TerminalProcess> {
  const nodePty = await tryLoadNodePty()
  if (nodePty) {
    try {
      terminalDiagnostic('starting native PTY')
      const terminal = nodePty.spawn(input.shell, [], {
        name: 'xterm-256color',
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env: input.env,
      })
      terminalDiagnostic('native PTY started')
      return terminal
    } catch {
      terminalDiagnostic('native PTY spawn unavailable')
      // node-pty's JavaScript can load from a single-file CJS release while its
      // platform native module (for example conpty.node on Windows) is absent.
      // That failure happens at spawn(), not import(), so fall back here instead
      // of surfacing a broken Terminal to the user.
    }
  }
  terminalDiagnostic('starting fallback terminal')
  return createFallbackTerminal(input)
}

export type TerminalManager = {
  activeCount(): number
  create(payload: ClientTerminalCreate): Promise<TerminalCreateResult>
  input(payload: ClientTerminalInput): void
  resize(payload: ClientTerminalResize): void
  kill(payload: ClientTerminalKill): TerminalKillResult
  closeSession(payload: ClientTerminalCloseSession): void
  closeAll(): void
}

const TERMINAL_REPLAY_MAX_BYTES = 1024 * 1024
const TERMINAL_SESSION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

function appendReplay(current: Buffer, data: string): Buffer {
  const next = Buffer.concat([current, Buffer.from(data)])
  return next.byteLength <= TERMINAL_REPLAY_MAX_BYTES
    ? next
    : next.subarray(next.byteLength - TERMINAL_REPLAY_MAX_BYTES)
}

export function createTerminalManager(input: {
  sandbox: Sandbox
  emitOutput(payload: ServerTerminalOutput): void
  emitExit(payload: ServerTerminalExit): void
  maxOutputBytes?: number
}): TerminalManager {
  type TerminalRecord = {
    workspaceId: string
    sessionId: string
    terminalId: string
    cwd: string
    terminal: TerminalProcess
    exited: boolean
    replay: Buffer
    outputBytes: number
    outputTruncated: boolean
  }
  const terminals = new Map<string, TerminalRecord>()
  const sessionTerminals = new Map<string, TerminalRecord>()
  const pendingCreates = new Map<string, { promise: Promise<TerminalCreateResult>; state: { cancelled: boolean } }>()

  const keyOf = (workspaceId: string, sessionId: string, terminalId: string): string => `${workspaceId}:${sessionId}:${terminalId}`
  const sessionKeyOf = (workspaceId: string, sessionId: string): string => `${workspaceId}:${sessionId}`

  const closeRecord = (record: TerminalRecord): void => {
    if (!record.exited) terminateTerminal(record.terminal)
    terminals.delete(keyOf(record.workspaceId, record.sessionId, record.terminalId))
    if (sessionTerminals.get(sessionKeyOf(record.workspaceId, record.sessionId)) === record) {
      sessionTerminals.delete(sessionKeyOf(record.workspaceId, record.sessionId))
    }
  }

  return {
    activeCount() {
      return terminals.size + pendingCreates.size
    },
    async create(payload) {
      const sessionKey = sessionKeyOf(payload.workspaceId, payload.sessionId)
      const existing = sessionTerminals.get(sessionKey)
      if (existing && !existing.exited) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          terminalId: existing.terminalId,
          cwd: existing.cwd,
          reused: true,
          replay: existing.replay.toString(),
        }
      }
      const pending = pendingCreates.get(sessionKey)
      if (pending) {
        const result = await pending.promise
        return { ...result, requestId: payload.requestId, reused: result.terminalId !== undefined }
      }
      const state = { cancelled: false }
      const creating = (async (): Promise<TerminalCreateResult> => {
        const requestedCwd = payload.cwd?.trim() || process.cwd()
        try {
        terminalDiagnostic('resolving sandbox cwd')
        const cwd = await input.sandbox.resolve(requestedCwd)
        if (state.cancelled) return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'terminal create cancelled' }
        terminalDiagnostic('sandbox cwd resolved')
        const terminalId = ulid()
        const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh')
        const terminal = await spawnTerminal({
          shell,
          cols: payload.cols ?? 80,
          rows: payload.rows ?? 24,
          cwd,
          env: {
            ...process.env,
            TERM: process.env.TERM || 'xterm-256color',
          },
        })
        if (state.cancelled) {
          terminateTerminal(terminal)
          return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'terminal create cancelled' }
        }
        const record: TerminalRecord = { workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, cwd, terminal, exited: false, replay: Buffer.alloc(0), outputBytes: 0, outputTruncated: false }
        terminals.set(keyOf(payload.workspaceId, payload.sessionId, terminalId), record)
        sessionTerminals.set(sessionKey, record)
        terminal.onData((data) => {
          const incoming = Buffer.byteLength(data)
          const maxOutputBytes = input.maxOutputBytes ?? TERMINAL_SESSION_MAX_OUTPUT_BYTES
          const remaining = Math.max(0, maxOutputBytes - record.outputBytes)
          if (remaining <= 0) {
            if (!record.outputTruncated) {
              record.outputTruncated = true
              const marker = `\n[terminal output truncated after ${maxOutputBytes} bytes]\n`
              record.replay = appendReplay(record.replay, marker)
              input.emitOutput({ workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, data: marker })
              terminateTerminal(record.terminal)
            }
            return
          }
          const chunk = incoming > remaining ? Buffer.from(data).subarray(0, remaining).toString('utf8') : data
          record.outputBytes += Buffer.byteLength(chunk)
          record.replay = appendReplay(record.replay, chunk)
          input.emitOutput({ workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, data: chunk })
          if (incoming > remaining && !record.outputTruncated) {
            record.outputTruncated = true
            const marker = `\n[terminal output truncated after ${maxOutputBytes} bytes]\n`
            record.replay = appendReplay(record.replay, marker)
            input.emitOutput({ workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, data: marker })
            terminateTerminal(record.terminal)
          }
        })
        terminal.onExit(({ exitCode, signal }) => {
          record.exited = true
          terminals.delete(keyOf(payload.workspaceId, payload.sessionId, terminalId))
          if (sessionTerminals.get(sessionKey) === record) sessionTerminals.delete(sessionKey)
          input.emitExit({ workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, exitCode, signal: signal === 0 ? null : String(signal) })
        })
        return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId, cwd }
        } catch (err) {
          return {
            requestId: payload.requestId,
            workspaceId: payload.workspaceId,
            sessionId: payload.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })()
      pendingCreates.set(sessionKey, { promise: creating, state })
      try {
        return await creating
      } finally {
        if (pendingCreates.get(sessionKey)?.promise === creating) pendingCreates.delete(sessionKey)
      }
    },
    input(payload) {
      const record = terminals.get(keyOf(payload.workspaceId, payload.sessionId, payload.terminalId))
      if (!record || record.exited) return
      record.terminal.write(payload.data)
    },
    resize(payload) {
      const record = terminals.get(keyOf(payload.workspaceId, payload.sessionId, payload.terminalId))
      if (!record || record.exited) return
      record.terminal.resize(payload.cols, payload.rows)
    },
    kill(payload) {
      const key = keyOf(payload.workspaceId, payload.sessionId, payload.terminalId)
      const record = terminals.get(key)
      if (!record) return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'terminal not found' }
      // Retire the record before acknowledging Kill. Restart creates a new PTY
      // immediately after this ACK; waiting for the asynchronous child exit
      // event leaves the old record reusable and sends input to a dying PTY.
      record.exited = true
      terminals.delete(key)
      const sessionKey = sessionKeyOf(payload.workspaceId, payload.sessionId)
      if (sessionTerminals.get(sessionKey) === record) sessionTerminals.delete(sessionKey)
      terminateTerminal(record.terminal)
      return { requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: true }
    },
    closeSession(payload) {
      const sessionKey = sessionKeyOf(payload.workspaceId, payload.sessionId)
      const pending = pendingCreates.get(sessionKey)
      if (pending) {
        pending.state.cancelled = true
        pendingCreates.delete(sessionKey)
      }
      const record = sessionTerminals.get(sessionKey)
      if (record) {
        closeRecord(record)
      }
    },
    closeAll() {
      for (const pending of pendingCreates.values()) pending.state.cancelled = true
      pendingCreates.clear()
      for (const record of [...terminals.values()]) closeRecord(record)
      terminals.clear()
      sessionTerminals.clear()
    },
  }
}
