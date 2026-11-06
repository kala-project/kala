import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { throwIfAborted } from './registry.js'
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalString,
  requireString,
} from './schema.js'
import {
  killBackgroundShell,
  listBackgroundTasks,
  readBackgroundShell,
  writeBackgroundShell,
} from './background-shell.js'

const VALID_ACTIONS = new Set(['list', 'poll', 'write', 'kill'])
const VALID_SIGNALS = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL', 'SIGINT'])

export const processTool: Tool = {
  name: 'process',
  async run(input, ctx) {
    const action = optionalString(input, 'action') ?? 'poll'
    if (!VALID_ACTIONS.has(action)) {
      throw new ToolError('EINVAL', `invalid action "${action}": expected list, poll, write, or kill`)
    }

    if (action === 'list') {
      throwIfAborted(ctx)
      const tasks = listBackgroundTasks(ctx.sessionId)
      return JSON.stringify({
        sessionId: ctx.sessionId,
        count: tasks.length,
        tasks,
      })
    }

    const taskId = optionalString(input, 'task_id') ?? optionalString(input, 'taskId') ?? requireString(input, 'task_id')
    throwIfAborted(ctx)

    if (action === 'poll') {
      const offset = optionalPositiveInt(input, 'offset', 0) ?? 0
      const block = optionalBoolean(input, 'block') ?? false
      const waitForOutput = optionalBoolean(input, 'wait_for_output') ?? true
      const timeoutMs = Math.min(
        optionalPositiveInt(input, 'timeout_ms', 1) ?? optionalPositiveInt(input, 'timeoutMs', 1) ?? 30_000,
        300_000,
      )
      try {
        const out = await readBackgroundShell({
          taskId,
          sessionId: ctx.sessionId,
          offset,
          block,
          waitForOutput,
          timeoutMs,
          maxBytes: 1_000_000,
          signal: ctx.signal,
        })
        throwIfAborted(ctx)
        return JSON.stringify({
          taskId,
          ...out,
        })
      } catch (err) {
        throwIfAborted(ctx)
        throw new ToolError(
          'EINVAL',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    if (action === 'write') {
      const rawInput = input['input']
      if (rawInput !== undefined && typeof rawInput !== 'string') {
        throw new ToolError('EINVAL', 'input must be a string')
      }
      const eof = optionalBoolean(input, 'eof') ?? false
      if ((rawInput === undefined || rawInput.length === 0) && !eof) {
        throw new ToolError('EINVAL', 'write requires a non-empty input string or eof=true')
      }
      try {
        const result = await writeBackgroundShell({
          taskId,
          sessionId: ctx.sessionId,
          input: rawInput,
          eof,
          signal: ctx.signal,
        })
        throwIfEffectAborted(ctx.signal, 'write', taskId)
        return JSON.stringify(result)
      } catch (err) {
        throwIfEffectAborted(ctx.signal, 'write', taskId)
        throw new ToolError(
          'EINVAL',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // action === 'kill'
    const signalStr = optionalString(input, 'signal') ?? 'SIGTERM'
    if (!VALID_SIGNALS.has(signalStr as NodeJS.Signals)) {
      throw new ToolError('EINVAL', `invalid signal "${signalStr}": expected SIGTERM, SIGKILL, or SIGINT`)
    }
    try {
      const killed = await killBackgroundShell(taskId, ctx.sessionId, signalStr as NodeJS.Signals)
      throwIfEffectAborted(ctx.signal, 'kill', taskId)
      return JSON.stringify({
        taskId,
        signal: signalStr,
        killed,
      })
    } catch (err) {
      throwIfEffectAborted(ctx.signal, 'kill', taskId)
      throw new ToolError(
        'EINVAL',
        err instanceof Error ? err.message : String(err),
      )
    }
  },
}

function throwIfEffectAborted(signal: AbortSignal, action: 'write' | 'kill', taskId: string): void {
  if (signal.aborted) {
    throw new ToolError('ECANCELED', `process ${action} cancelled; taskId: ${taskId}; outcome unknown — inspect before retrying`)
  }
}
