import type { ToolSchema } from '@agent-kernel/kernel'
import { createHash } from 'node:crypto'

export type ToolDisclosureMode = 'legacy_full' | 'progressive'
export type ToolDisclosureSnapshot = { catalogRevision: string; active: readonly string[] }

const WEB_SEARCH_INTENT = /(?:联网|上网|网络搜索|搜索(?:网页|网络|互联网)|网页检索|检索(?:资料|来源|新闻)|最新(?:信息|消息|资料)|来源链接|可点击(?:的)?链接|web\s*search|search\s+the\s+web|online\s+(?:search|research)|browse\s+the\s+web|current\s+(?:news|information))/iu

const DISCOVERY = new Set(['tool_search', 'tool_describe'])

export function toolCatalogRevision(tools: readonly ToolSchema[]): string {
  const serialized = JSON.parse(JSON.stringify(tools.map(stableTool)))
  return `sha256:${createHash('sha256').update(canonicalJson(serialized)).digest('hex')}`
}

export function visibleTools(tools: readonly ToolSchema[], _mode: ToolDisclosureMode, _active: ReadonlySet<string>): readonly ToolSchema[] {
  // Discovery changes its results, never the provider's cacheable tool prefix.
  return tools.map(withRequiredToolIntent)
}

export function withRequiredToolIntent(tool: ToolSchema): ToolSchema {
  const properties = tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object' && !Array.isArray(tool.inputSchema.properties) ? tool.inputSchema.properties as Record<string, unknown> : {}
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter((value): value is string => typeof value === 'string') : []
  if (properties._intent && required.includes('_intent')) return tool
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      type: 'object',
      properties: {
        ...properties,
        _intent: { type: 'string', minLength: 12, maxLength: 240, description: 'State in the user’s current language the concrete user- or product-facing objective this tool call advances and why this step is needed. Do not merely name the operation, paraphrase parameters, or include secrets.' },
      },
      required: [...new Set([...required, '_intent'])],
    },
  }
}



export function intentActivatedTools(tools: readonly ToolSchema[], messages: readonly import('@agent-kernel/kernel').Message[]): Set<string> {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')
  const text = latestUser?.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(' ') ?? ''
  const available = new Set(tools.map((tool) => tool.name))
  return WEB_SEARCH_INTENT.test(text) && available.has('websearch') ? new Set(['websearch']) : new Set()
}

export function searchToolCatalog(tools: readonly ToolSchema[], query: string, limit = 8): readonly ToolSchema[] {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return []
  return tools
    .filter((tool) => !DISCOVERY.has(tool.name))
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map((entry) => entry.tool)
}

export function activateTools(tools: readonly ToolSchema[], current: ReadonlySet<string>, names: readonly string[]): Set<string> {
  const available = new Set(tools.map((tool) => tool.name))
  const next = new Set(current)
  for (const name of names) {
    if (!available.has(name)) throw new Error(`tool is not in the locked catalog: ${name}`)
    next.add(name)
  }
  return next
}

function scoreTool(tool: ToolSchema, terms: readonly string[]): number {
  const name = tool.name.toLocaleLowerCase()
  const text = `${tool.name} ${tool.description} ${tool.toolsetId ?? ''} ${tool.risk ?? ''} ${tool.executionKind ?? ''}`.toLocaleLowerCase()
  let score = 0
  for (const term of terms) {
    if (name === term) score += 100
    else if (name.includes(term)) score += 25
    if (text.includes(term)) score += 5
  }
  return score
}

function stableTool(tool: ToolSchema): unknown {
  return {
    description: tool.description, inputSchema: withRequiredToolIntent(tool).inputSchema,
    name: tool.name, version: tool.version ?? null, schemaHash: tool.schemaHash ?? null,
    toolsetId: tool.toolsetId ?? null, toolsetVersion: tool.toolsetVersion ?? null,
    executionKind: tool.executionKind ?? null, executionHandler: tool.executionHandler ?? null,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
