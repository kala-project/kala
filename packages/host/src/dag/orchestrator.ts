import { randomUUID } from 'node:crypto'
import type { CallToolEffect } from '@agent-kernel/kernel'
import type { DagNode, DagRun, DagToolActivity, DagToolActivityCategory } from '@agent-kernel/shared'

import type { HostLoopDeps, LoopHandle } from '../loop-types.js'
import { runAgentTool, type SubAgentRuntimeController } from '../extensions/agent-tool.js'
import type { DagStorage } from './storage.js'
import { bindDagWorkerSession, unbindDagWorkerSession } from './worker-tool.js'

const DEFAULT_CONCURRENCY = 4
const LEASE_MS = 60_000
const RECOVERY_POLL_MS = 1_000

export class DagOrchestrator {
  private readonly workerId = `dag-${process.pid}-${randomUUID()}`
  private readonly active = new Map<string, Promise<void>>()
  private readonly aborts = new Map<string, AbortController>()
  private closing = false

  constructor(
    private readonly store: DagStorage,
    private readonly deps: HostLoopDeps,
    private readonly loop: LoopHandle,
    private readonly runtimeController?: SubAgentRuntimeController,
    private readonly runNode: typeof runAgentTool = runAgentTool,
  ) {}

  schedule(parentSessionId: string): void {
    if (this.closing) return
    void this.scheduleAsync(parentSessionId).catch((error: unknown) => {
      this.deps.broadcast.onError(parentSessionId, error instanceof Error ? error.message : String(error))
    })
  }

  private async scheduleAsync(parentSessionId: string): Promise<void> {
    for (const run of await this.store.runsForSession(parentSessionId)) {
      if (
        run.status !== 'running'
        || !run.nodes.some((node) => node.status === 'ready' || node.status === 'running')
        || this.active.has(run.id)
      ) continue
      const work = this.run(parentSessionId, run.id).finally(() => {
        if (this.active.get(run.id) === work) this.active.delete(run.id)
        if (!this.closing) this.schedule(parentSessionId)
      })
      this.active.set(run.id, work)
      void work.catch((error: unknown) => {
        this.deps.broadcast.onError(parentSessionId, error instanceof Error ? error.message : String(error))
      })
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.active.values()])
  }

  private async run(parentSessionId: string, runId: string): Promise<void> {
    await this.deps.store.load(parentSessionId, { recoverDangling: false }).catch(() => undefined)
    while (!this.closing) {
      const run = await this.store.getRun(runId)
      if (!run || run.status !== 'running') return
      const nodes = await this.store.claimReadyNodes(run.id, this.workerId, DEFAULT_CONCURRENCY, LEASE_MS)
      if (nodes.length === 0) {
        if (!run.nodes.some((node) => node.status === 'running')) return
        await new Promise<void>((resolve) => setTimeout(resolve, RECOVERY_POLL_MS))
        continue
      }
      this.deps.publishDagRun?.(parentSessionId)
      await Promise.all(nodes.map(async (node) => {
        const callId = `dag:${run.id}:${node.id}:${node.attempt}`
        const renewal = setInterval(() => {
          void Promise.resolve(this.store.renewLease(run.id, node.id, this.workerId, LEASE_MS, new Date(), node.leaseGeneration)).catch(() => {
            clearInterval(renewal)
          })
        }, LEASE_MS / 3)
        renewal.unref?.()
        const effect: CallToolEffect = {
          kind: 'call_tool',
          callId,
          name: 'agent',
          input: {
            prompt: workerPrompt(run, node),
            description: node.title,
            intention: `Execute DAG node ${node.id}`,
          },
        }
        let childSessionId: string | undefined
        try {
          const workerConfig = this.deps.dagWorkerConfig?.()
          if (!workerConfig) throw new Error('DAG worker runtime configuration is unavailable')
          const result = await this.runNode(
            this.deps,
            parentSessionId,
            effect,
            this.aborts,
            this.loop,
            this.runtimeController,
            {
              configOverride: workerConfig,
              onChildCreated: async (child) => {
                childSessionId = child.sessionId
                await this.store.attachChildSession(run.id, node.id, this.workerId, child.sessionId, new Date().toISOString(), node.leaseGeneration)
                bindDagWorkerSession(child.sessionId, {
                  parentSessionId,
                  runId: run.id,
                  nodeId: node.id,
                  attempt: node.attempt,
                  workerId: this.workerId,
                  leaseGeneration: node.leaseGeneration,
                })
                this.deps.publishDagRun?.(parentSessionId)
              },
            },
          )
          const current = (await this.store.getRun(run.id))?.nodes.find((candidate) => candidate.id === node.id)
          if (!current || current.status === 'waiting_user' || current.status === 'replaced') return
          if (current.status !== 'running') return
          await this.store.completeNode(
            run.id,
            node.id,
            this.workerId,
            result.ok
              ? {
                  status: 'succeeded',
                  result: normalizeWorkerResult(result.content),
                  toolActivity: workerToolActivity(childSessionId ? this.deps.store.get(childSessionId)?.state.messages : undefined),
                }
              : {
                  status: 'failed',
                  error: result.content,
                  toolActivity: workerToolActivity(childSessionId ? this.deps.store.get(childSessionId)?.state.messages : undefined),
                },
            `${callId}:complete`,
            new Date().toISOString(),
            node.leaseGeneration,
          )
        } catch (error) {
          const current = (await this.store.getRun(run.id))?.nodes.find((candidate) => candidate.id === node.id)
          if (current?.status === 'running') {
            await this.store.completeNode(
              run.id,
              node.id,
              this.workerId,
              {
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
                toolActivity: workerToolActivity(childSessionId ? this.deps.store.get(childSessionId)?.state.messages : undefined),
              },
              `${callId}:failed`,
              new Date().toISOString(),
              node.leaseGeneration,
            )
          }

        } finally {
          clearInterval(renewal)
          if (childSessionId) unbindDagWorkerSession(childSessionId)
          this.deps.publishDagRun?.(parentSessionId)
        }
      }))
    }
  }
}

export function normalizeWorkerResult(content: string): string {
  const match = content.match(/<result>\s*([\s\S]*?)\s*<\/result>/u)
  return (match?.[1] ?? content).trim()
}

export function workerToolActivity(messages: unknown): DagToolActivity[] {
  if (!Array.isArray(messages)) return []
  const calls = new Map<string, DagToolActivity>()
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const value = part as Record<string, unknown>
      const callId = typeof value.callId === 'string'
        ? value.callId
        : typeof value.id === 'string' ? value.id : undefined
      if (!callId) continue
      if (value.type === 'tool_call' && typeof value.name === 'string') {
        calls.set(callId, {
          callId,
          name: value.name,
          category: toolCategory(value.name, value.input),
          status: 'unknown',
          summary: toolSummary(value.name, value.input),
        })
      } else if (value.type === 'tool_result') {
        const existing = calls.get(callId)
        if (existing) calls.set(callId, { ...existing, status: value.ok === false ? 'failed' : 'succeeded' })
      }
    }
  }
  return [...calls.values()].slice(-200)
}

function toolCategory(name: string, input: unknown): DagToolActivityCategory {
  const normalized = name.toLowerCase()
  const serialized = JSON.stringify(input ?? {})
  if (/install|package_install/u.test(normalized) || /\b(?:apt(?:-get)?|npm|pnpm|yarn|bun|pip|cargo)\s+(?:add|install)\b/iu.test(serialized)) return 'install'
  if (/system|service|daemon/u.test(normalized) || /\b(?:systemctl|service|docker|podman)\b/iu.test(serialized)) return 'system'
  if (/write|edit|patch|delete|move|mkdir/u.test(normalized)) return 'write'
  if (/web|fetch|search_url|http/u.test(normalized) || /\b(?:curl|wget)\b/iu.test(serialized)) return 'network'
  if (/shell|bash|terminal|exec|run_command/u.test(normalized)) return 'shell'
  if (/read|glob|grep|search|list|^ls$/u.test(normalized)) return 'read'
  return 'other'
}

function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return name
  const record = input as Record<string, unknown>
  const preferred = ['command', 'path', 'pattern', 'query', 'message']
    .map((key) => record[key])
    .find((value) => typeof value === 'string')
  const raw = typeof preferred === 'string' ? preferred : JSON.stringify(input)
  return redactToolSummary(raw).slice(0, 500)
}

function redactToolSummary(value: string): string {
  return value
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/giu, '$1=[REDACTED]')
    .replace(/("(?:token|secret|password|api[_-]?key)"\s*:\s*)"[^"]*"/giu, '$1"[REDACTED]"')
    .replace(/(\b(?:authorization|proxy-authorization|x-api-key)\s*:\s*)[^"'\r\n]*/giu, '$1[REDACTED]')
    .replace(/(\s--?(?:password|passwd|token|access[-_]?token|api[-_]?key|secret|client[-_]?secret)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/giu, '$1[REDACTED]')
    .replace(/(\s-u\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gu, '$1[REDACTED]')
}

function workerPrompt(run: DagRun, node: DagNode): string {
  const directDependencies = new Set(run.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source))
  const prerequisiteIds = new Set<string>()
  const pending = [...directDependencies]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (prerequisiteIds.has(id)) continue
    prerequisiteIds.add(id)
    for (const edge of run.edges) {
      if (edge.target === id) pending.push(edge.source)
    }
  }
  const dependencies = run.nodes
    .filter((candidate) => prerequisiteIds.has(candidate.id))
    .sort((left, right) => Number(!directDependencies.has(left.id)) - Number(!directDependencies.has(right.id)))
    .map((dependency) => `- ${dependency.id} (${dependency.title}): ${dependency.result ?? dependency.error ?? dependency.status}`)
  const decision = run.decisions
    .filter((candidate) => candidate.nodeId === node.id && candidate.status === 'answered')
    .at(-1)
  return [
    'You are a DAG worker Session. Execute only the assigned node using the standard Chat tools available to you.',
    `Top-level objective: ${run.objective}`,
    `Graph version: ${run.graphVersion}`,
    `Node: ${node.id} — ${node.title}`,
    `Task:\n${node.instructions}`,
    `Completed prerequisite results (direct dependencies first, followed by their completed ancestors):\n${dependencies.length > 0 ? dependencies.join('\n') : '(none)'}`,
    decision
      ? `Latest answered decision:\nQuestion: ${decision.question}\nAnswer: ${decision.answer ?? ''}\nContext: ${decision.context}`
      : 'Latest answered decision: (none)',
    'Use dag_report_progress for meaningful progress updates.',
    'Use dag_request_decision when user input is required; after it succeeds, stop this attempt.',
    'Use dag_replace_self if the node must be decomposed; after it succeeds, stop this attempt.',
    'Do not call dag_plan and do not delegate to nested agents.',
  ].join('\n\n')
}
