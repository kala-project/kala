import { appendRuntimeMetadataEntry, readSessionLog } from '../store/log.js'
import type { SessionRecord, SessionStore } from '../store/session.js'
import { activateTools, searchToolCatalog, toolCatalogRevision } from '../tool-disclosure.js'

type ToolCatalogStore = Pick<SessionStore, 'appendRuntimeMetadata' | 'findLatestRuntimeMetadata'>

export async function activeToolsFor(record: SessionRecord, store?: ToolCatalogStore): Promise<Set<string>> {
  const revision = toolCatalogRevision(record.config.tools)
  const active = new Set<string>()
  const entries = store
    ? [await store.findLatestRuntimeMetadata(record.sessionId, 'tools_activated')].filter((entry) => entry !== undefined)
    : (await readSessionLog(record.logPath)).runtimeMetadata
  for (const entry of entries) {
    if (entry.action !== 'tools_activated' || entry.payload.catalogRevision !== revision || !Array.isArray(entry.payload.names)) continue
    for (const name of entry.payload.names) if (typeof name === 'string') active.add(name)
  }
  return active
}

export async function runToolCatalogTool(record: SessionRecord, name: string, input: Record<string, unknown>, store?: ToolCatalogStore): Promise<{ ok: boolean; content: string }> {
  try {
    const revision = toolCatalogRevision(record.config.tools)
    const current = await activeToolsFor(record, store)
    let selected
    if (name === 'tool_search') {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      if (!query) return { ok: false, content: 'query is required' }
      selected = searchToolCatalog(record.config.tools, query, typeof input.limit === 'number' ? input.limit : 8)
    } else {
      const names = Array.isArray(input.names) ? input.names.filter((value): value is string => typeof value === 'string') : []
      if (names.length === 0) return { ok: false, content: 'names must contain at least one Tool name' }
      const byName = new Map(record.config.tools.map((tool) => [tool.name, tool]))
      selected = names.map((toolName) => byName.get(toolName)).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
      if (selected.length !== names.length) return { ok: false, content: 'one or more Tools are not in the locked Session catalog' }
    }
    const shouldActivate = input.activate !== false
    if (shouldActivate && selected.length > 0) {
      const next = activateTools(record.config.tools, current, selected.map((tool) => tool.name))
      const added = [...next].filter((toolName) => !current.has(toolName))
      if (added.length > 0) {
        const payload = { catalogRevision: revision, names: [...next] }
        if (store) await store.appendRuntimeMetadata(record.sessionId, { action: 'tools_activated', payload })
        else await appendRuntimeMetadataEntry(record.logPath, { sessionId: record.sessionId, action: 'tools_activated', payload })
      }
    }
    return { ok: true, content: JSON.stringify({ catalogRevision: revision, activated: shouldActivate ? selected.map((tool) => tool.name) : [], tools: selected.map((tool) => ({ name: tool.name, description: tool.description, version: tool.version, schemaHash: tool.schemaHash, risk: tool.risk, executionKind: tool.executionKind, ...(name === 'tool_describe' ? { inputSchema: tool.inputSchema } : {}) })) }, null, 2) }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) }
  }
}
