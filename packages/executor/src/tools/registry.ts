/**
 * Tool registry: a `name → runner` map. Each runner is `(input, ctx) → string`.
 *
 * Runners must throw only for programmer errors; expected user errors
 * (ENOENT, EACCES, etc.) are returned as a string prefixed with `ERROR: <code>:`
 * and surfaced via `{ ok: false, content }` at the client boundary.
 */

import type { Sandbox } from '../sandbox.js'
import type { NetworkAuditEvent, NetworkPolicy } from '@agent-kernel/shared'

export type ToolContext = {
  readonly origin?: 'host'
  readonly sessionId: string
  readonly callId: string
  readonly sandbox: Sandbox
  readonly signal: AbortSignal
  /**
   * Session-level working directory for this call, as tracked by
   * `state.cwd` in the kernel and forwarded on `tool:call.cwd`. Tools that
   * resolve caller-supplied paths MUST pass this through as
   * `sandbox.resolve(path, { cwd: ctx.cwd })` so relative inputs behave
   * consistently across tools (e.g. `ls "."` and `bash pwd` see the same
   * directory). Undefined = the client didn't forward a cwd; fall back to
   * `sandbox.roots[0]` or `process.cwd()`.
   */
  readonly cwd?: string
  /**
   * Optional per-call process environment for shell-like tools. Omitted keys
   * inherit from the executor process only when the tool chooses to merge them.
   */
  readonly env?: NodeJS.ProcessEnv
  readonly networkPolicy?: NetworkPolicy
  readonly emitNetworkAudit?: (event: NetworkAuditEvent) => Promise<void>
}

export type ToolRunner = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>

export type Tool = {
  readonly name: string
  readonly run: ToolRunner
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ToolError'
  }
}

/**
 * Guard for cooperative cancellation. Tools that perform multiple awaits
 * (read → decide → write) MUST call this at each yield point so `cancel`
 * events from the kernel actually prevent side effects rather than being
 * silently ignored.
 */
export function throwIfAborted(ctx: ToolContext): void {
  if (ctx.signal.aborted) {
    throw new ToolError('ECANCELED', 'operation aborted by caller')
  }
}

export function createToolRegistry(tools: readonly Tool[]): Map<string, Tool> {
  const map = new Map<string, Tool>()
  for (const t of tools) {
    if (map.has(t.name)) {
      throw new Error(`duplicate tool: ${t.name}`)
    }
    map.set(t.name, t)
  }
  return map
}
