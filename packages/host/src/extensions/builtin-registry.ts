import { runWebSearch } from '../web-search/index.js'
import { interruptSubAgentsForParent, runAgentTool } from './agent-tool.js'
import { runCompact } from './compaction.js'
import { selectHooks, type HookPayload } from './hooks.js'
import { runPostToolHooks, runPreToolHooks } from './hooks-runner.js'
import { isSkillManager, runSkillTool } from './skills.js'
import { runTodoGraphTool } from './todo-graph.js'
import { consolidateMemory } from './memory-consolidation.js'
import { runToolCatalogTool } from './tool-catalog.js'
import { runDagPlanTool } from '../dag/tool.js'
import { runDagWorkerTool } from '../dag/worker-tool.js'
import { createExtensionRegistry, type HostExtension, type SessionLifecycleContext } from './registry.js'

export const BUILTIN_HOST_TOOL_HANDLERS = [
  'ask_user_choice',
  'websearch',
  'agent',
  'todo_graph',
  'tool_search',
  'tool_describe',
  'skill',
  'dag_plan',
  'dag_report_progress',
  'dag_request_decision',
  'dag_replace_self',
] as const

export function createBuiltinExtensionRegistry(additional: readonly HostExtension[] = []) {
  const registry = createExtensionRegistry([
    {
      id: 'kala.session-modes',
      version: '2026-09-29',
      sessionModes: [{
        id: 'chat',
        label: 'Standard Chat',
        description: 'A conversational Kala Session driven one turn at a time.',
      }, {
        id: 'dag',
        label: 'DAG-First',
        description: 'A durable dependency graph whose nodes run as child Kala Sessions.',
      }],
      lifecycle: {
        onSessionLoaded({ deps, record }) {
          if (record.executionMode === 'dag') deps.dagScheduler?.schedule(record.sessionId)
        },
      },
    },
    {
      id: 'kala.builtin.host-tools',
      version: '2026-09-29',
      toolHandlers: {
        async ask_user_choice({ deps, sessionId, effect }) {
          if (!deps.askUserChoice) return { ok: false, content: 'ask_user_choice is not configured on this host' }
          return await deps.askUserChoice.ask(sessionId, effect)
        },
        async websearch({ deps, sessionId, effect }) {
          if (!deps.webSearchCredentials) return { ok: false, content: 'web search credential store is not configured' }
          return await runWebSearch(effect.input, {
            credentials: deps.webSearchCredentials,
            sessionId,
            callId: effect.callId,
            audit: deps.audit,
          })
        },
        async agent({ deps, sessionId, effect, aborts, loop, runtimeController }) {
          return await runAgentTool(deps, sessionId, effect, aborts, loop, runtimeController)
        },
        async todo_graph({ deps, sessionId, effect }) {
          return await runTodoGraphTool(deps, sessionId, effect)
        },
        async tool_search({ deps, sessionId, effect }) {
          const record = deps.store.get(sessionId)
          if (!record) return { ok: false, content: 'Session is unavailable' }
          return await runToolCatalogTool(record, 'tool_search', effect.input, deps.store)
        },
        async tool_describe({ deps, sessionId, effect }) {
          const record = deps.store.get(sessionId)
          if (!record) return { ok: false, content: 'Session is unavailable' }
          return await runToolCatalogTool(record, 'tool_describe', effect.input, deps.store)
        },
        async skill({ deps, sessionId, effect }) {
          if (!deps.skills) return { ok: false, content: 'skills are not configured on this host' }
          return await runSkillTool(
            isSkillManager(deps.skills)
              ? await deps.skills.refreshSession(deps.store.get(sessionId)!)
              : deps.skills,
            effect.input,
          )
        },
        async dag_plan(context) {
          return await runDagPlanTool(context)
        },
        async dag_report_progress(context) {
          return await runDagWorkerTool(context)
        },
        async dag_request_decision(context) {
          return await runDagWorkerTool(context)
        },
        async dag_replace_self(context) {
          return await runDagWorkerTool(context)
        },
      },
    },
    {
      id: 'kala.command-hooks',
      version: '2026-09-29',
      lifecycle: {
        async onSessionCreated(context) {
          await runSessionHooks('session_start', context)
        },
        async onSessionDeleted(context) {
          await runSessionHooks('session_end', context)
        },
        async beforeToolDispatch({ deps, sessionId, effect }) {
          const blocked = await runPreToolHooks(deps, sessionId, effect)
          return blocked ? { ok: false, content: blocked } : null
        },
        async afterToolDispatch({ deps, sessionId, effect }, result) {
          await runPostToolHooks(deps, sessionId, effect, result)
        },
      },
    },
    {
      id: 'kala.compaction',
      version: '2026-09-29',
      maintenance: {
        compact: runCompact,
      },
      lifecycle: {
        async beforeModelCall(context) {
          if (!context.requiresCompaction) return context.messages
          const applied = await context.compact().catch(() => false)
          return applied ? context.messagesAfterCompaction() : context.messages
        },
        async afterTurn(context) {
          await context.autoCompact()
        },
      },
    },
    {
      id: 'kala.skills',
      version: '2026-09-29',
      lifecycle: {
        async onSessionLoaded({ deps, record }) {
          if (isSkillManager(deps.skills)) await deps.skills.refreshConfig(record)
        },
        async beforeStateTransition({ deps, record, event }) {
          if (event.kind !== 'cancel' && isSkillManager(deps.skills)) await deps.skills.refreshConfig(record)
        },
      },
    },
    {
      id: 'kala.memory',
      version: '2026-09-29',
      maintenance: {
        consolidateMemory,
      },
    },
    {
      id: 'kala.subagents',
      version: '2026-09-29',
      lifecycle: {
        async onCancel({ deps, aborts, sessionId }) {
          await interruptSubAgentsForParent(deps, aborts, sessionId)
        },
      },
    },
    {
      id: 'kala.durable-work-recovery',
      version: '2026-09-29',
      lifecycle: {
        async afterTurn(context) {
          await context.resumeDurableWork()
        },
      },
    },
    ...additional,
  ])
  registry.seal()
  return registry
}

async function runSessionHooks(
  event: 'session_start' | 'session_end',
  { deps, record }: SessionLifecycleContext,
): Promise<void> {
  if (!deps.hooks || !deps.hookRunner || deps.hooks.length === 0) return
  const matching = selectHooks(deps.hooks, event)
  if (matching.length === 0) return
  const payload: HookPayload = {
    event,
    sessionId: record.sessionId,
    ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
  }
  for (const hook of matching) {
    try {
      await deps.hookRunner.run(hook, payload)
    } catch {
      // Session hooks are advisory and cannot roll back a durable lifecycle event.
    }
  }
}
