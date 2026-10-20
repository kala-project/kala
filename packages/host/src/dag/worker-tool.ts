import { randomUUID } from 'node:crypto'
import type { ToolSchema } from '@agent-kernel/kernel'
import type { DagGraphPatch, DagPlanEdgeInput, DagPlanNodeInput, DagRiskLevel } from '@agent-kernel/shared'

import type { HostToolContext } from '../extensions/registry.js'

type ActiveDagWorker = {
  parentSessionId: string
  runId: string
  nodeId: string
  attempt: number
  workerId: string
  leaseGeneration?: number
}

const activeWorkers = new Map<string, ActiveDagWorker>()

export const DAG_WORKER_TOOLS: readonly ToolSchema[] = [
  {
    name: 'dag_report_progress',
    description: 'Publish concise progress for the current DAG node.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string', minLength: 1, maxLength: 4_000 } },
    },
    requiresApproval: false,
    executionKind: 'host',
    executionHandler: 'dag_report_progress',
  },
  {
    name: 'dag_request_decision',
    description: 'Pause the current DAG node and request a durable user decision.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'context', 'choices', 'allow_freeform'],
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 4_000 },
        context: { type: 'string', maxLength: 20_000 },
        choices: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1_000 } },
        allow_freeform: { type: 'boolean' },
        recommendation: { type: 'string', maxLength: 4_000 },
        reason: { type: 'string', maxLength: 8_000 },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
    },
    requiresApproval: false,
    executionKind: 'host',
    executionHandler: 'dag_request_decision',
  },
  {
    name: 'dag_replace_self',
    description: 'Replace the current node with a more detailed acyclic subgraph.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['entry_node_id', 'result_node_id', 'nodes', 'edges', 'expected_graph_version'],
      properties: {
        entry_node_id: { type: 'string', minLength: 1, maxLength: 128 },
        result_node_id: { type: 'string', minLength: 1, maxLength: 128 },
        expected_graph_version: { type: 'integer', minimum: 1 },
        nodes: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'instructions'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 128 },
              title: { type: 'string', minLength: 1, maxLength: 240 },
              instructions: { type: 'string', minLength: 1, maxLength: 20_000 },
              write_scopes: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 1024 } },
            },
          },
        },
        edges: {
          type: 'array',
          maxItems: 500,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['source', 'target'],
            properties: {
              source: { type: 'string', minLength: 1, maxLength: 128 },
              target: { type: 'string', minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    },
    requiresApproval: false,
    executionKind: 'host',
    executionHandler: 'dag_replace_self',
  },
]

export function bindDagWorkerSession(childSessionId: string, worker: ActiveDagWorker): void {
  activeWorkers.set(childSessionId, worker)
}

export function unbindDagWorkerSession(childSessionId: string): void {
  activeWorkers.delete(childSessionId)
}

export async function runDagWorkerTool(context: HostToolContext): Promise<{ ok: boolean; content: string }> {
  const worker = activeWorkers.get(context.sessionId)
  if (!worker || !context.deps.dagStore) {
    return { ok: false, content: 'DAG worker tools are only available to an active leased DAG child Session' }
  }
  const record = context.deps.store.get(context.sessionId)
  if (!record || record.parentSessionId !== worker.parentSessionId || record.parentCallId !== `dag:${worker.runId}:${worker.nodeId}:${worker.attempt}`) {
    return { ok: false, content: 'DAG worker Session authority is invalid' }
  }
  try {
    let updated
    if (context.effect.name === 'dag_report_progress') {
      updated = await context.deps.dagStore.updateNodeProgress(
        worker.runId,
        worker.nodeId,
        worker.workerId,
        requiredString(context.effect.input.message, 'message'),
        new Date().toISOString(),
        worker.leaseGeneration ?? worker.attempt,
      )
    } else if (context.effect.name === 'dag_request_decision') {
      const riskLevel = optionalRiskLevel(context.effect.input.risk_level)
      await context.deps.dagStore.createDecision({
        id: randomUUID(),
        runId: worker.runId,
        nodeId: worker.nodeId,
        workerId: worker.workerId,
        leaseGeneration: worker.leaseGeneration ?? worker.attempt,
        question: requiredString(context.effect.input.question, 'question'),
        context: optionalString(context.effect.input.context) ?? '',
        choices: stringArray(context.effect.input.choices, 'choices', 20),
        allowFreeform: requiredBoolean(context.effect.input.allow_freeform, 'allow_freeform'),
        ...(optionalString(context.effect.input.recommendation) ? { recommendation: optionalString(context.effect.input.recommendation)! } : {}),
        ...(optionalString(context.effect.input.reason) ? { reason: optionalString(context.effect.input.reason)! } : {}),
        ...(riskLevel ? { riskLevel } : {}),
      })
      updated = await context.deps.dagStore.getRun(worker.runId)
    } else if (context.effect.name === 'dag_replace_self') {
      const nodes = parseNodes(context.effect.input.nodes)
      const entryNodeId = requiredString(context.effect.input.entry_node_id, 'entry_node_id')
      const resultNodeId = requiredString(context.effect.input.result_node_id, 'result_node_id')
      if (!nodes.some((node) => node.id === entryNodeId)) throw new Error('entry_node_id must identify a replacement node')
      if (!nodes.some((node) => node.id === resultNodeId)) throw new Error('result_node_id must identify a replacement node')
      const edges = parseEdges(context.effect.input.edges)
      const targets = new Set(edges.map((edge) => edge.target))
      const entries = nodes.filter((node) => !targets.has(node.id))
      if (entries.length !== 1 || entries[0]!.id !== entryNodeId) {
        throw new Error('entry_node_id must be the replacement graph’s single entry node')
      }
      const patch: DagGraphPatch = {
        expectedGraphVersion: requiredInteger(context.effect.input.expected_graph_version, 'expected_graph_version'),
        resultNodeId,
        nodes,
        edges,
      }
      updated = await context.deps.dagStore.expandNode(
        worker.runId,
        worker.nodeId,
        worker.workerId,
        patch,
        context.effect.callId,
        new Date().toISOString(),
        worker.leaseGeneration ?? worker.attempt,
      )
    } else {
      return { ok: false, content: 'Unknown DAG worker tool' }
    }
    context.deps.publishDagRun?.(worker.parentSessionId)
    return {
      ok: true,
      content: JSON.stringify({
        runId: worker.runId,
        nodeId: worker.nodeId,
        status: updated?.nodes.find((node) => node.id === worker.nodeId)?.status,
        graphVersion: updated?.graphVersion,
      }),
    }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) }
  }
}

function parseNodes(value: unknown): readonly DagPlanNodeInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('nodes must contain 1-100 entries')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid DAG node')
    const node = entry as Record<string, unknown>
    const writeScopes = node.write_scopes === undefined ? undefined : stringArray(node.write_scopes, 'write_scopes', 64)
    return {
      id: requiredString(node.id, 'node id'),
      title: requiredString(node.title, 'node title'),
      instructions: requiredString(node.instructions, 'node instructions'),
      ...(writeScopes ? { writeScopes } : {}),
    }
  })
}

function parseEdges(value: unknown): readonly DagPlanEdgeInput[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('edges must be an array with at most 500 entries')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid DAG edge')
    const edge = entry as Record<string, unknown>
    return { source: requiredString(edge.source, 'edge source'), target: requiredString(edge.target, 'edge target') }
  })
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function stringArray(value: unknown, label: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  return value.map((entry) => entry.trim())
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

function optionalRiskLevel(value: unknown): DagRiskLevel | undefined {
  if (value === undefined) return undefined
  if (value === 'low' || value === 'medium' || value === 'high') return value
  throw new Error('risk_level must be low, medium, or high')
}
