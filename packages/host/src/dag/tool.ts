import type { ToolSchema } from '@agent-kernel/kernel'
import type { DagGraphPatch, DagPlanEdgeInput, DagPlanNodeInput } from '@agent-kernel/shared'

import type { HostToolContext } from '../extensions/registry.js'

export const DAG_PLANNER_INSTRUCTION = `You are operating a DAG-First Kala Session.
Before doing any actionable work, including read-only investigation, call dag_plan with a complete acyclic graph.
Only answer without a graph when the user is merely conversing or when clarification is required before planning.
Each node must be independently executable by a child Kala Session. Declare conservative
repository-relative write_scopes for nodes that may modify files. Keep verification nodes
dependent on the implementation they verify. Treat edges as both execution dependencies and
result handoffs: connect every producer whose result a downstream node needs, or require an
intermediate node to carry those values forward explicitly. Declare exactly one terminal result_node_id;
that node must produce the complete user-facing answer, not notes for another agent. You are the planner/controller only: never execute
workspace, shell, web, editing, or delegated-agent work yourself. After dag_plan succeeds, stop;
the durable scheduler owns all execution and results. Do not use todo_graph as the execution authority.`

export const DAG_PLAN_TOOL: ToolSchema = {
  name: 'dag_plan',
  description: 'Create a new durable execution Run for the current user objective.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['objective', 'result_node_id', 'nodes', 'edges'],
    properties: {
      objective: { type: 'string', minLength: 1 },
      result_node_id: { type: 'string', minLength: 1, maxLength: 128 },
      expected_graph_version: { type: 'integer', minimum: 0 },
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
            write_scopes: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', maxLength: 1024 },
            },
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
  executionHandler: 'dag_plan',
}

export async function runDagPlanTool(context: HostToolContext): Promise<{ ok: boolean; content: string }> {
  const { deps, sessionId, effect } = context
  const record = deps.store.get(sessionId)
  if (!record) return { ok: false, content: 'Session is unavailable' }
  if (record.executionMode !== 'dag') return { ok: false, content: 'dag_plan is only available in DAG-First Sessions' }
  if (!deps.dagStore) return { ok: false, content: 'DAG store is unavailable' }
  try {
    const objective = requiredString(effect.input.objective, 'objective')
    const resultNodeId = requiredString(effect.input.result_node_id, 'result_node_id')
    const nodes = parseNodes(effect.input.nodes)
    const edges = parseEdges(effect.input.edges)
    const run = await deps.dagStore.createRun(sessionId, objective, `${effect.callId}:run`)
    const expectedGraphVersion = optionalInteger(effect.input.expected_graph_version) ?? 0
    if (expectedGraphVersion !== 0) throw new Error('initial DAG plans require expected_graph_version 0')
    const patch: DagGraphPatch = { expectedGraphVersion, resultNodeId, nodes, edges }
    const updated = await deps.dagStore.installGraph(run.id, patch, `${effect.callId}:graph`)
    deps.publishDagRun?.(sessionId)
    deps.dagScheduler?.schedule(sessionId)
    return {
      ok: true,
      content: JSON.stringify({
        runId: updated.id,
        graphVersion: updated.graphVersion,
        status: updated.status,
        nodes: updated.nodes.map((node) => ({ id: node.id, status: node.status })),
        schedulerOwnsExecution: true,
        instruction: 'The scheduler owns execution. Stop now and do not run any tools or claim task completion.',
      }),
    }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) }
  }
}

function parseNodes(value: unknown): readonly DagPlanNodeInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('nodes must contain 1-100 entries')
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid DAG node')
    const node = entry as Record<string, unknown>
    const writeScopes = node.write_scopes === undefined
      ? undefined
      : stringArray(node.write_scopes, 'write_scopes', 64)
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
    return {
      source: requiredString(edge.source, 'edge source'),
      target: requiredString(edge.target, 'edge target'),
    }
  })
}

function stringArray(value: unknown, label: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`)
  return value.trim()
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error('expected_graph_version must be a non-negative integer')
  return Number(value)
}
